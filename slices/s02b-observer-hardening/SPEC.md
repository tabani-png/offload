---
id: s02b-observer-hardening
title: Observer hardening (Keychain-wrapped day keys, user exclusions, LaunchAgent, OCR off the tick, status --json)
depends_on: [s02-observer]
parallel_safe: true
human_gated: false   # the live Keychain test is opt-in (OFFLOAD_LIVE_KEYCHAIN=1); the LaunchAgent is never loaded
verify: bash slices/s02b-observer-hardening/verify.sh
---

# Observer hardening

## paths_in_scope
- `engine/Sources/**`, `engine/Tests/S02B/**`, `engine/README.md`, `slices/s02b-observer-hardening/**`

## Acceptance criteria (tests: `engine/Tests/S02B`, type prefix S02B)
1. **Keychain-wrapped day keys** (`Store/KeyVault.swift`, S02BKeyTests)
   - `OFFLOAD_KEYS` unset = `keychain` mode; `OFFLOAD_KEYS=file` = raw 32-byte key files, Keychain never touched.
   - Master key: 32 random bytes, login Keychain generic password, service `ai.offload.observer`, account
     `master-key`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Created on first need.
   - Wrapped key file (`keys/DAY.key`, 0600, 64 bytes): `"OKW1" | AES-GCM combined(nonce 12 | key 32 | tag 16)`,
     associated data `ai.offload.observer/day-key/v1/DAY`. Another master key or another day's name fails to open.
   - `run` wraps existing raw key files in place (temp file + rename, idempotent). Keychain mode also reads a raw
     key not yet migrated, without creating a master key. File mode reading a wrapped key fails with `keyWrapped`.
   - A failing Keychain fails the write; it never falls back to a raw key.
   - `export-day` works in both modes. Keychain access is behind `SecretStore`; tests use `MemorySecretStore`.
     One live test (`liveKeychainRoundTrip`) runs only with `OFFLOAD_LIVE_KEYCHAIN=1`, on a throwaway account.
2. **User exclusions** (`Capture/UserExclusions.swift`, S02BExclusionTests)
   - `$OFFLOAD_HOME/exclusions.json` `{bundleIds, hosts, titleContains}` (missing keys = empty) is merged with the
     built-ins (built-ins cannot be removed). Hosts match subdomains; titles match case-insensitive substrings
     (reason `deny_title`). Excluded = no OCR, title becomes the app name, URL dropped.
   - CLI: `exclude list` (prints the file as JSON), `exclude add|remove --app ID | --host H | --title S`
     (dedupe case-insensitive, hosts normalized from URLs, blank rejected, file 0600, atomic write).
   - The running observer re-reads the file every 2 s: an edit applies within 5 s; a broken file keeps the last
     good policy (logged once).
3. **LaunchAgent** (`Observer/LaunchAgent.swift`, S02BLaunchAgentTests)
   - `install-agent [--home DIR]` writes `~/Library/LaunchAgents/ai.offload.observer.plist`
     (`OFFLOAD_LAUNCH_AGENTS_DIR` overrides the dir for tests): Label, ProgramArguments
     `[abs exe, run, --home, HOME]`, RunAtLoad, KeepAlive `{SuccessfulExit: false}`, ThrottleInterval 10,
     LimitLoadToSessionType Aqua, StandardOut/ErrorPath in `$OFFLOAD_HOME/logs`, OFFLOAD_KEYS/OFFLOAD_PLAIN copied
     when set. Creates `logs/`. Relative executable refused. Prints the `launchctl bootstrap` line; never runs it.
   - `uninstall-agent` removes the plist (idempotent) and prints the `launchctl bootout` line.
4. **OCR off the tick** (`Observer/OCRExecutor.swift`, S02BOCRQueueTests)
   - The observer submits OCR jobs to an `OCRExecutor` and applies finished results on later ticks. Live:
     `QueuedOCRExecutor`, one serial GCD queue, at most 2 waiting jobs (oldest dropped, `ocrDropped`), bounded
     outbox. Tests without an executor get `InlineOCRExecutor` (same results as s02).
   - With a recognizer blocked indefinitely, focus and pause events still arrive on their ticks (< 0.5 s wall).
   - Results asked for before a pause/resume, or for a window excluded since, are discarded (`ocrDiscarded`).
5. **`status --json`** (`Observer/Status.swift`, S02BStatusTests)
   - `status` and `status --json` print the same JSON; the s02 fields stay. Added, `schemaVersion: 1`:
     `permissions` {screenRecording, accessibility, inputMonitoring} + `permissionsSource`
     (heartbeat when the observer runs, else probe of the calling process), `paused`, `days` [{day, events,
     encrypted, plain}], `nextPurgeAt` (epoch ms, running observer only), `nextExpiry` {day, at} (oldest day
     leaves the 7-day window), `keysMode`, `keyFiles` {raw, wrapped}.

## Done signal
`bash slices/s02b-observer-hardening/verify.sh`: builds, runs the FULL engine suite (S01, S02, S02B), requires at
least 70 tests, and greps `engine/Sources` for network code, key-value access and process spawning.

## Notes for other slices
- Brain reader (`brain/src/store/reader.ts`) opens `keys/DAY.key` as raw 32 bytes. In keychain mode the files are
  64-byte wrapped keys: the brain must call `offload-observer export-day DAY` (or run the observer with
  `OFFLOAD_KEYS=file`). `docs/store-contract.md` still describes raw keys and needs that line updated.
