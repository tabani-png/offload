# Store contract (observer -> brain)

- Home: `$OFFLOAD_HOME`, default `~/Library/Application Support/Offload`.
- Events: one JSON object per line per `schemas/event.schema.json`, one file per local day:
  `$OFFLOAD_HOME/days/YYYY-MM-DD.jsonl.enc`. Each line is base64 of AES-256-GCM `nonce(12) | ciphertext | tag(16)`
  over the UTF-8 JSON. One key per day, stored in `$OFFLOAD_HOME/keys/YYYY-MM-DD.key` (32 random bytes, mode 0600)
  for v1 dev mode; the Keychain-wrapped mode is a later slice. Deleting a day = delete the file AND its key.
- Plain mode for tests and fixtures: `$OFFLOAD_HOME/days/YYYY-MM-DD.jsonl` (no `.enc`), same lines unencrypted.
  The brain reads both. The observer writes plain only when `OFFLOAD_PLAIN=1`.
- Retention: days older than 7 local days are deleted at start and every hour. A purge appends a line to
  `$OFFLOAD_HOME/purge-log.jsonl` {day, deletedAt, events}.
- Pause: the observer writes `pause` / `resume` events and records nothing in between.
- Focus events fire on app activation, window title change, and URL change (polled every 2 s).
- Idle: `idle_start` after 120 s with no input (CGEventSource.secondsSinceLastEventType), `idle_end` on return.
- Input: one `input` event per minute with counts only, only when counts > 0.
- OCR: on focus change and at most every 30 s while focused, only if the text hash changed; masked with the
  Workpaper detectors before it is written. Apps in the exclusion list (password managers, banking) never get OCR,
  and their titles are replaced by the app name.
