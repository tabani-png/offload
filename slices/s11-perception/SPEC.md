# s11 perception: masked keyframes, local Captioner, Frame notes (ADR 0007)

Owner: engineer (Swift + TS). Paths: `engine/`, `brain/src/vision/`, `brain/src/store/vault.ts` (purge list),
`brain/src/api/` (status field), `brain/src/cli.ts` (serve flags), `docs/store-contract.md`, `brain/API.md`,
`slices/s11-perception/`. Not touched: `app/`, `brain/src/connectors`, `brain/src/workflows`, `brain/src/grouping`
(s12 reads frame notes through `brain/src/vision/notes.ts`; `maskText` is imported, not edited).

Goal (operator): Offload understands what is on screen all the time, in any domain, and writes its own internal
descriptions of it. This slice is perception only: keep masked keyframes, describe them locally, store the notes.

## Engine: keyframes (tag = Swift suite prefix `S11`)
1. K1 trigger. Keyframes ride the existing OCR trigger (focus change, at most every 30 s, never idle, never paused).
   An OCR job asks for pixels only when a keyframe could be kept now (`KeyframeThrottle.mightKeep`). A result is a
   keyframe candidate when its OCR text hash changed OR its perceptual hash moved at least `dedupeDistance` bits from
   the last kept frame.
2. K2 privacy before anything is kept. No pixels are requested or kept for an excluded window (ExclusionPolicy +
   `exclusions.json`, re-checked when the result arrives), while Secure Event Input is on, or for a result from before
   a pause/resume. Before encoding: every OCR line whose text the Masker flags (cards, SSN, IBAN, keys, OTP ...) is
   filled black (box padded 4 px), and every secure text field rectangle (AX `AXSecureTextField`) is filled black.
   Then the frame is downscaled so the long edge is at most 1280 px and JPEG-encoded (quality 0.6) in memory.
3. K3 throttle and dedupe. At least `minInterval` (20 s) between kept frames, at most `maxPerHour` (60) in any
   rolling hour, and no frame whose 1024-bit dHash is within `dedupeDistance` (40 bits) of any of the last 16 kept.
   Skips are counted (`framesKept`, `framesSkippedThrottle`, `framesSkippedDuplicate`, `framesSkippedPrivacy`).
4. K4 storage. `frames/YYYY-MM-DD/<frameId>.enc` = AES-256-GCM `nonce(12) | ciphertext | tag(16)` of the JPEG with
   the DAY KEY of the frame's local day (the same key as `days/DAY.jsonl.enc`, wrapped in keychain mode) and
   associated data `offload/frame/v1/<frameId>`, so a blob renamed to another id does not open. Metadata goes to
   `frames/YYYY-MM-DD/index.jsonl.enc`, one base64 sealed line per frame (day-file line format, no AAD):
   `{frameId, ts, app, appName, host, phash, width, height, bytes, maskedRegions}`; `phash` is the 64-bit dHash as 16
   hex chars. Frames are always encrypted, also in `OFFLOAD_PLAIN=1` mode. Dirs 0700, files 0600, atomic writes.
   `frameId` is a ULID (26 Crockford chars). `OFFLOAD_KEYFRAMES=0` turns keyframes off.
5. K5 retention. The 7-day purge deletes `frames/DAY/` with the day file and key; a day with only frames is a stored
   day too. The purge-log line gains `frames` (blob count) when the day had frames; lines without frames are unchanged.
6. K6 CLI, same trust model as `export-day` (any same-user process; README "Same-user trust boundary"):
   `offload-observer list-frames YYYY-MM-DD` prints the decrypted index lines; `offload-observer export-frame FRAMEID`
   writes the decrypted JPEG bytes to stdout and nothing else. Exit 0 ok, 1 not found / cannot decrypt, 2 usage
   (bad day or id), 3 the frame's day is older than 7 local days (the purge runs first, so the files are gone).
7. K7 no network, no key values, no spawning: the s10c greps still pass over `engine/Sources`.

## Brain: Captioner and pipeline (tag = test name prefix in `brain/tests/s11-perception/`)
8. C1 schema. `FrameNote` = `schemas/frame-note.schema.json`. `validateFrameNote` is driven by the schema file
   (required, const, additionalProperties false, string maxLength, array maxItems, number range). `coerceFields`
   trims model output into those limits (cut strings, slice arrays, clamp confidence) before validation.
9. C2 `Captioner` interface: `id`, `model`, `caption(input, signal) -> CaptionFields`, `health() -> CaptionerHealth`.
   `StubCaptioner` is deterministic (same frame bytes + metadata = same note) and offline.
10. C3 `OllamaCaptioner`: POST `/api/chat` with `format` = the JSON schema of the caption fields, `images` = the
    JPEG base64, `temperature 0`, `stream false`, `think false`; parses `message.content` as JSON, coerces and
    validates; retries (default 2) on network errors, 5xx and invalid JSON, with a per-attempt timeout (default 120 s)
    via AbortController; `redirect: "error"`. `health()` = GET `/api/tags` and whether the model is pulled.
11. C4 privacy: the base URL must be `http` on a loopback literal (`127.0.0.0/8`, `[::1]`, or `localhost`, which is
    rewritten to 127.0.0.1); anything else throws `NonLoopbackError` at construction, before any request. Images go
    only to that URL. Claude (`models/model.ts`) never receives images: no vision code imports it and a test greps it.
12. C5 prompt: domain-agnostic, no app or industry examples that steer the answer, asks for the schema fields
    (activity, verb, object, counterpart, surface, step, inputs, outputs, identifiers, confidence); optional user
    context (role/industry) and the frame's app/host are passed as hints. Text fields of the note are masked with
    `grouping/normalize.ts maskText` before storage.
13. C6 frame source: `ObserverFrameSource` lists frames per day and reads one: keychain mode through
    `offload-observer list-frames` / `export-frame` (observer child env only, REVIEW-2 N6); `OFFLOAD_KEYS=file`
    decrypts raw day keys in process (tests, fixtures). Expired days (exit 3) are skipped, never retried.
14. C7 notes store: `frame-notes/YYYY-MM-DD.jsonl.enc`, sealed with the brain key of the frame's capture day
    (`vault.ts sealText`, keychain-wrapped via `wrap-key`), one JSON frame note per line; `readFrameNotes(home, day)`
    returns valid notes for s12. The brain purge deletes expired note files (vault artefacts list).
15. C8 worker: polls (default 15 s) the last 8 days for frames without a note, queue capped at 32 (backpressure:
    the poll stops filling when full; the rest is picked up later), one caption at a time, a frame failing 3 times is
    skipped for the life of the process. Status: `{enabled, captioner, model, healthy, queueDepth, processed, failed,
    skipped, lastCaptionAt, lastLatencyMs, lastError}`; `lastError` is scrubbed (no note text).
16. C9 serve: `--captioner off|stub|ollama` (default off), `--vision-model TAG`, `--ollama-url URL`.
    `GET /status` gains `captioner` (additive). Documented in `brain/API.md`.
17. C10 bench: `slices/s11-perception/BENCH.md` with the chosen default model, latency and quality on 10+ UI
    screenshots, every claim tagged CONFIRMED / INFERENCE / UNKNOWN.

## Done signal
`bash slices/s11-perception/verify.sh`: engine suite (all, at least 160 tests, at least 5 `S11` suites passing),
s10c greps, brain suite (all pass, every C tag has passing tests), strict typecheck, a cross-language check (a frame
written by the Swift FrameStore is read back by the brain through the real `export-frame` and in-process), and
BENCH.md present with tags. `bash scripts/verify-all.sh` stays green.
