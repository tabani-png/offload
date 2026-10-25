# engine: the Offload Observer

Swift, macOS 26, arm64. Records Events (`../schemas/event.schema.json`) into a local encrypted store
(`../docs/store-contract.md`) and deletes days older than 7 local days. No network code (a test enforces it).

## Build and test
SwiftPM does not work on this machine (Command Line Tools PackageDescription mismatch), so `build.sh` calls `swiftc`.

```bash
engine/build.sh                    # .build/libOffloadCore.dylib, .build/offload-observer
engine/build.sh test               # + Swift Testing suite (S01*, S02*)
engine/build.sh test --filter S02  # one slice
OFFLOAD_BUILD_DIR=/tmp/x engine/build.sh   # separate build dir for parallel agents
bash slices/s02-observer/verify.sh # slice done-signal
```

Layout: `Sources/OffloadCore` (all logic, testable), `Sources/offload-observer` (CLI + macOS glue), `Tests/`.
Reused from Workpaper (`~/builds/workpaper/engine`): detectors and masker (codenames removed), Vision text
recognizer, perceptual hash, exclusion policy and window plan (finance preset removed), AES-GCM crypto, live source.

## Run
```bash
engine/.build/offload-observer run [--home DIR]       # foreground; Ctrl-C or SIGTERM stops it
engine/.build/offload-observer status                 # JSON: running, paused, daysStored, heartbeat, permissions
engine/.build/offload-observer pause | resume         # running observer notices within 1 s
engine/.build/offload-observer purge-now
engine/.build/offload-observer export-day 2026-10-24  # decrypted JSON lines on stdout (for the brain and tests)
```
Home: `--home`, else `$OFFLOAD_HOME`, else `~/Library/Application Support/Offload`. `OFFLOAD_PLAIN=1` writes plain
`days/DAY.jsonl` instead of encrypted `days/DAY.jsonl.enc` + `keys/DAY.key`.

Files in home: `days/`, `keys/` (0700 dirs, 0600 files), `purge-log.jsonl` (`{"day","deletedAt","events"}`,
`deletedAt` in epoch ms), `paused` (present = paused), `observer-status.json` (heartbeat every 5 s, removed on exit).

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
  windows) are never OCR'd, their title becomes the app name, and the URL is dropped. List: `ExclusionPolicy.standard`.
- OCR skipped while Secure Event Input is on and while idle. Key values are never read, only counted.
- Logs (stderr) carry context and error codes, never titles, URLs, text or keys.

## Known limits
- The first OCR after start loads Vision and can take several seconds; ticks wait for it.
- Banking bundle ids are best effort; the exclusion list is not yet user-editable.
- Day keys are files (dev mode). Keychain wrapping is a later slice. No LaunchAgent yet.
