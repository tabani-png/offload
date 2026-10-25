# engine: the Offload Observer

Swift, macOS 26, arm64. Records Events (`../schemas/event.schema.json`) into a local encrypted store
(`../docs/store-contract.md`) and deletes days older than 7 local days. No network code (a test enforces it).

## Build and test
SwiftPM does not work on this machine (Command Line Tools PackageDescription mismatch), so `build.sh` calls `swiftc`.

```bash
engine/build.sh                    # .build/libOffloadCore.dylib, .build/offload-observer
engine/build.sh test               # + Swift Testing suite (S01*, S02*, S02B*, S02C*)
engine/build.sh test --filter S02  # one slice
OFFLOAD_BUILD_DIR=/tmp/x engine/build.sh   # separate build dir for parallel agents
bash slices/s02-observer/verify.sh # slice done-signal
bash slices/s02b-observer-hardening/verify.sh   # full suite, min 70 tests, no-network grep
bash slices/s02c-engine-review-fixes/verify.sh  # full suite, min 100 tests, no-network + no-spawn greps
OFFLOAD_LIVE_KEYCHAIN=1 .build/offload-tests --filter liveKeychainRoundTrip  # opt-in real Keychain test
```

Layout: `Sources/OffloadCore` (all logic, testable), `Sources/offload-observer` (CLI + macOS glue), `Tests/`.
Reused from Workpaper (`~/builds/workpaper/engine`): detectors and masker (codenames removed), Vision text
recognizer, perceptual hash, exclusion policy and window plan (finance preset removed), AES-GCM crypto, live source.

## Run
```bash
engine/.build/offload-observer run [--home DIR]       # foreground; Ctrl-C or SIGTERM stops it
engine/.build/offload-observer status [--json]        # JSON (schemaVersion 1): permissions, paused, days+event counts,
                                                      #   nextPurgeAt, nextExpiry, keysMode, keyFiles, heartbeat
engine/.build/offload-observer exclude list | add|remove --app ID | --host H | --title S
engine/.build/offload-observer install-agent [--home DIR]   # writes the LaunchAgent plist; does NOT load it
engine/.build/offload-observer uninstall-agent
engine/.build/offload-observer pause | resume         # running observer notices within 1 s
engine/.build/offload-observer purge-now
engine/.build/offload-observer export-day 2026-10-24  # decrypted JSON lines on stdout (for the brain and tests)
engine/.build/offload-observer wrap-key --name NAME   # brain key: base64 on stdin, or no stdin = new random key
engine/.build/offload-observer unwrap-key --name NAME # prints the stored brain key
```
Exit codes: 0 ok, 1 failure (message on stderr), 2 usage error, 3 `export-day` of a day older than 7 local days.
An expired `export-day` is refused even when the observer is not running, and it runs the retention purge first, so
the day file and key are gone afterwards (and logged in `purge-log.jsonl`).

Brain keys (`wrap-key` / `unwrap-key`, keychain mode only; `OFFLOAD_KEYS=file` refuses): a 32-byte key for the
brain's own sealed files, kept in `keys/brain-NAME.key` in the day-key OKW1 format (64 bytes) under the same
Keychain master key, with `ai.offload.observer/brain-key/v1/NAME` as associated data, so a file copied to another
name does not open. NAME is 1-32 of `a-z 0-9 -`, not starting with `-`. `wrap-key` reads one base64 line of exactly
32 bytes from stdin (a terminal or empty stdin = generate one), stores it 0600 without ever overwriting (two racing
callers end with one key), and prints the stored key as one base64 line. If a key is already stored it prints that
key, or exits 1 when stdin held a different one. `unwrap-key` prints the key; it never creates a master key. stdout
carries only the base64 key; stderr carries file names and status codes, never key bytes. Retention, migration and
`status` ignore brain keys (they are not day keys); they live until the brain deletes them.

Home: `--home`, else `$OFFLOAD_HOME`, else `~/Library/Application Support/Offload`. `OFFLOAD_PLAIN=1` writes plain
`days/DAY.jsonl` instead of encrypted `days/DAY.jsonl.enc` + `keys/DAY.key`.

Day keys (`OFFLOAD_KEYS`): default `keychain` = `keys/DAY.key` is 64 bytes, `"OKW1" | AES-GCM(nonce 12 | key 32 | tag 16)`
sealed with a 32-byte master key in the login Keychain (generic password, service `ai.offload.observer`, account
`master-key`, after-first-unlock, this device only) and the day name as associated data. On `run`, raw 32-byte key
files are wrapped in place. `OFFLOAD_KEYS=file` keeps raw key files and never touches the Keychain (tests,
fixtures). `export-day` decrypts in both modes; readers that open key files directly must handle only raw keys or
call `export-day`.

LaunchAgent: `install-agent` writes `~/Library/LaunchAgents/ai.offload.observer.plist` (RunAtLoad, KeepAlive only
after a non-zero exit, ThrottleInterval 10, Aqua session, logs in `$OFFLOAD_HOME/logs/observer.{out,err}.log`,
`OFFLOAD_KEYS`/`OFFLOAD_PLAIN` copied if set). Load it yourself: `launchctl bootstrap gui/$(id -u) <plist>`.

Files in home: `days/`, `keys/` (0700 dirs, 0600 files), `purge-log.jsonl` (`{"day","deletedAt","events"}`,
`deletedAt` in epoch ms), `paused` (present = paused), `observer-status.json` (heartbeat every 5 s, removed on exit),
`exclusions.json` (`{"bundleIds":[],"hosts":[],"titleContains":[]}`, 0600, merged with the built-ins, re-read every
2 s so edits apply within 5 s; a broken file keeps the last good list), `logs/` (LaunchAgent output).

## Permissions (System Settings > Privacy & Security)
When run from a terminal, macOS attributes the permission to the terminal app (Terminal, iTerm, Ghostty), so grant
it there. A signed app bundle will get its own entry later.

| Permission | Used for | Without it |
|---|---|---|
| Screen Recording | OCR of the focused window (ScreenCaptureKit + Vision); window-server titles as fallback | No `ocr` events; one stderr line, `ocrErrors` counts attempts. Focus, idle and input still work. |
| Accessibility | Window titles and browser URLs (AX focused window, AXWebArea URL) | Titles fall back to the window-server name (needs Screen Recording; else empty); no `url`/`host`. |
| Input Monitoring | Key and click COUNTS (NSEvent global monitors; only the event type is read) | No `input` events at all. Counts are omitted, never estimated. The observer asks once at start. |

`status` prints which of the three are granted (`heartbeat.permissions`).

## Privacy rules in code
- Titles and OCR text are masked before write (cards, CVV/expiry, SSN, SIN, routing, account, IBAN, CUSIP, ISIN,
  OTP, API keys and secrets). URLs lose query, fragment and user info.
- Excluded apps/windows (password managers, Keychain Access, authenticators, banking apps and domains, private
  windows) are never OCR'd, their title becomes the app name, and the URL is dropped. List: `ExclusionPolicy.standard`
  plus your `exclusions.json` (apps, hosts and their subdomains, title substrings, case-insensitive).
- OCR skipped while Secure Event Input is on and while idle. Key values are never read, only counted.
- Logs (stderr) carry context and error codes, never titles, URLs, text or keys.

Midnight: at the first tick of a new local day, a focused, unpaused, non-idle observer writes the current focus
again (app, title, URL, after exclusions and masking; the last snapshot if nothing is frontmost), so every day file
starts with the active focus. While idle it waits for `idle_end`. The day is the DayStore's local calendar, so DST
days of 23 or 25 hours still get one rollover each.

## Known limits
- OCR runs on its own serial queue (`QueuedOCRExecutor`, 2 waiting jobs max, oldest dropped). The first Vision load
  still takes seconds, but focus, idle, pause and input keep their timing; results from before a pause, or for a
  window excluded meanwhile, are discarded.
- Banking bundle ids are best effort.
- `uninstall-agent` removes the plist only; run `launchctl bootout gui/$(id -u)/ai.offload.observer` if it was loaded.
- A rebuilt (re-signed) binary may get a Keychain access prompt for the master key.
