# s02c-engine-review-fixes

Engine fixes from `slices/s10-review/REVIEW-1.md` and the s05b "disputed" note on brain keys. Owner: engine/ only.

1. M4: `export-day` refuses a day older than 7 local days (exit 3, one stderr line) and runs the retention purge.
   Tests: `S02CExportAgeTests`.
2. L4: at the first tick of a new local day while focused (not paused, not idle; idle waits for `idle_end`), the
   observer writes the current focus again, so each day file starts with it. Injected clock and time zone, including
   New York fall-back (25 h) and spring-forward (23 h) days and Santiago's skipped midnight. Tests: `S02CMidnightTests`.
3. H4 support: `offload-observer wrap-key|unwrap-key --name NAME` keeps a 32-byte brain key in
   `keys/brain-NAME.key` (OKW1, Keychain master key, name as associated data). stdout = base64 key only; never logged;
   never replaced. Tests: `S02CBrainKeyTests`. Documented in engine/README.md and docs/store-contract.md.

Done-signal: `bash slices/s02c-engine-review-fixes/verify.sh` (full engine suite, at least 100 tests, 3 S02C suites,
no network, no key-value access, no process spawning in engine/Sources).
