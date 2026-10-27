# Store contract (observer -> brain)

- Home: `$OFFLOAD_HOME`, default `~/Library/Application Support/Offload`.
- Events: one JSON object per line per `schemas/event.schema.json`, one file per local day:
  `$OFFLOAD_HOME/days/YYYY-MM-DD.jsonl.enc`. Each line is base64 of AES-256-GCM `nonce(12) | ciphertext | tag(16)`
  over the UTF-8 JSON. One key per day in `$OFFLOAD_HOME/keys/YYYY-MM-DD.key`.
  Default (keychain mode): the key file is 64 bytes, "OKW1" + AES-GCM of the day key under a master key in the
  login Keychain (service "ai.offload.observer"), with the day name bound in. Readers that are not the observer
  get plain lines with `offload-observer export-day YYYY-MM-DD` (stdout jsonl). `OFFLOAD_KEYS=file` = legacy
  raw 32-byte key files (mode 0600), for tests and fixtures only. Deleting a day = delete the file AND its key.
- Brain keys: the brain keeps its own 32-byte keys in `$OFFLOAD_HOME/keys/brain-NAME.key`, wrapped like day keys
  ("OKW1", same Keychain master key, the name bound in). `offload-observer wrap-key --name NAME` stores one (base64 on
  stdin with `--import`, or none to generate; a piped key without `--import` exits 2) and `unwrap-key --name NAME`
  returns it; both print only the base64 key on stdout and never replace a stored key. This replaces raw brain key
  files. Names that are local dates (`brain-YYYY-MM-DD`) follow the 30-day rule: retention deletes them, and
  wrap/unwrap of an expired date runs the purge and exits 3. Other names are kept and listed as `otherBrainKeys`.
- Idle: `idle_start` is stamped when idle is DETECTED (threshold 120 s after the last input). Readers backdate it
  by the threshold.
- Plain mode for tests and fixtures: `$OFFLOAD_HOME/days/YYYY-MM-DD.jsonl` (no `.enc`), same lines unencrypted.
  The brain reads both. The observer writes plain only when `OFFLOAD_PLAIN=1`.
- Retention: days older than 30 local days are deleted at start and every hour (day file, day key AND the day's
  `frames/DAY/` folder). A purge appends a line to `$OFFLOAD_HOME/purge-log.jsonl` {day, deletedAt, events}, plus
  `frames` (keyframe blobs deleted) when the day had keyframes.
- Keyframes (s11, ADR 0007): on the OCR trigger, when the throttle allows (at least 20 s apart, at most 60 per rolling
  hour, not within 40 dHash bits of the last 16 kept), the observer keeps a JPEG (quality 0.6, long edge at most
  1280 px, no metadata beyond colour space and size) of the focused window. Never for excluded apps, hosts, titles or
  private windows, never while Secure Event Input is on, idle or paused. Before encoding, every OCR line the Masker
  flags and every `AXSecureTextField` rectangle is filled black. Files:
  `$OFFLOAD_HOME/frames/YYYY-MM-DD/<frameId>.enc` = AES-256-GCM `nonce(12) | ciphertext | tag(16)` (raw bytes, not
  base64) of the JPEG under the DAY KEY of that local day, associated data `offload/frame/v1/<frameId>`;
  `$OFFLOAD_HOME/frames/YYYY-MM-DD/index.jsonl.enc` = day-file line format (base64 sealed lines, no associated data),
  one JSON object per frame `{frameId, ts, app, appName, host, phash, width, height, bytes, maskedRegions}` (`phash`
  = 64-bit dHash, 16 hex chars; `frameId` = ULID). Frames are encrypted in `OFFLOAD_PLAIN=1` mode too. Dirs 0700,
  files 0600. Readers that are not the observer use `offload-observer list-frames YYYY-MM-DD` (index lines on
  stdout) and `offload-observer export-frame FRAMEID` (JPEG bytes on stdout); both exit 3 after purging when the day
  is older than 30 local days, 2 on a bad day or id, 1 when not found or not decryptable. Same trust model as
  `export-day` (any same-user process). `OFFLOAD_KEYFRAMES=0` turns keyframes off.
- Frame notes (brain, s11): `$OFFLOAD_HOME/frame-notes/YYYY-MM-DD.jsonl.enc`, the brain's sealed-file format
  (`OBV1 DAY` + one AES-GCM line) under `brain-DAY` of the frame's capture day, one `schemas/frame-note.schema.json`
  object per line, text masked. Deleted by the brain purge after 30 days; the observer deletes the expired brain key.
- Pause: the observer writes `pause` / `resume` events and records nothing in between.
- Focus events fire on app activation, window title change, and URL change (polled every 2 s).
- Idle: `idle_start` after 120 s with no input (CGEventSource.secondsSinceLastEventType), `idle_end` on return.
- Input: one `input` event per minute with counts only, only when counts > 0.
- OCR: on focus change and at most every 30 s while focused, only if the text hash changed; masked with the
  Workpaper detectors before it is written. Apps in the exclusion list (password managers, banking) never get OCR,
  and their titles are replaced by the app name.
