---
id: s02-observer
title: Observer daemon (focus, idle, input counts, OCR on change, encrypted per-day store, 7-day purge, pause)
depends_on: [s01-engine-scaffold]
parallel_safe: true
human_gated: true   # live run needs Screen Recording, Accessibility and Input Monitoring granted by a human
verify: bash slices/s02-observer/verify.sh
---

# Observer

## Summary
`offload-observer run` records Events (schemas/event.schema.json) into `$OFFLOAD_HOME` per docs/store-contract.md
and deletes days older than 7 local days. All logic is in `OffloadCore/Observer/Observer.swift`, driven by an
injected Clock and four injected sources (workspace, idle, input counts, screen text) plus a pause state, so every
rule is tested headless with no permissions. `offload-observer/LiveSources.swift` is the thin macOS glue.

## paths_in_scope
- `engine/Sources/OffloadCore/**`, `engine/Sources/offload-observer/**`, `engine/Tests/S02/**`, `engine/README.md`,
  `slices/s02-observer/**`

## paths_out_of_scope
- `brain/`, `app/`, `plan/`, `packet/`, `schemas/`, `docs/`

## Rules (each has tests in engine/Tests/S02)
1. Focus (`S02FocusTests`, `S02URLTests`): the frontmost app is polled every 2 s. A `focus` event is written when the
   bundle id, the masked title, or the scrubbed URL changes. URLs lose query, fragment and user info; `host` is the
   lowercased host. A query-only change is not a change. An unparseable URL is dropped (no url, no host).
2. Idle (`S02IdleTests`): `idle_start` once when seconds since last input reaches 120; `idle_end` when it drops below.
3. Input (`S02InputTests`): every 60 s, one `input` event with `keys` and `clicks` COUNTS, only when > 0. The live
   counter uses NSEvent global monitors for keyDown and leftMouseDown and reads only the event type. Without Input
   Monitoring the source reports unavailable and no input event is ever written (no zeros, no estimates).
4. OCR (`S02OCRTests`): on a focus change and then at most every 30 s while focus stays, not while idle, not while
   Secure Event Input is on. Text is masked (Workpaper detectors: cards, CVV/expiry, SSN, SIN, ABA, account numbers,
   IBAN, CUSIP, ISIN, OTP, API keys/secrets) and cut to 8000 characters; `textHash` = first 16 bytes of SHA-256 of
   the masked text, hex. Same hash as last time = not written. Excluded = `ExclusionPolicy.standard`: password
   managers, Keychain Access, authenticators, banking apps (bundle ids), banking domains, private/incognito titles.
   Excluded windows are never OCR'd; their title is the app name; URL is dropped (a denied banking domain keeps
   `host`). Live OCR reads only the frontmost app's top normal window (`windowToRead`).
5. Store (`S02StoreTests`, `S02SchemaTests`): one file per local day. Encrypted line = base64(AES-256-GCM
   nonce(12)|ciphertext|tag(16)) of the JSON; per-day key `keys/DAY.key` = 32 random bytes, mode 0600; dirs 0700.
   `OFFLOAD_PLAIN=1` writes `days/DAY.jsonl` instead. JSON keys are exactly the schema's property names, nil fields
   omitted, `ts` epoch ms, `id` a monotonic ULID. A tampered line fails with its line number.
6. Retention (`S02RetentionTests`): a day is deleted when its local age (whole days to today) is > 7, so today and the
   7 days before it are kept. Day file(s) (enc and plain) and key are deleted; orphans too. Runs at `start()` and
   every 3600 s. Each purged day appends `{"day","deletedAt"(epoch ms),"events"(line count)}` to `purge-log.jsonl`.
7. Pause (`S02PauseTests`): `offload-observer pause` creates `$OFFLOAD_HOME/paused`, `resume` removes it. The running
   observer checks it every 1 s tick, writes `pause` / `resume`, and records nothing in between (input counts made
   while paused are discarded). After resume the current focus is written again.
8. CLI (`S02CLITests`): `run [--home DIR]`, `status` (JSON: running, paused, daysStored, heartbeat), `pause`, `resume`,
   `purge-now`, `export-day YYYY-MM-DD` (decrypted jsonl to stdout; exit 1 with a message when missing). Bad
   arguments exit 2.
9. Quality: no force unwraps on external data; every caught error is logged to stderr with a context tag and counted
   (`writeErrors`, `ocrErrors`); logs never contain titles, URLs, OCR text or key values; no network code.

## Done signal
`bash slices/s02-observer/verify.sh`: build, `--filter S02`, at least 25 tests ran and passed, no network code,
no key value access.

## Not in this slice
Keychain-wrapped day keys (later slice), user-editable exclusion list file, a LaunchAgent plist, audio.
