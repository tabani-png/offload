---
id: s30-test-isolation
title: Brain test isolation - s24 /tmp leftovers checked per process; clock-dependent tests pinned (Asia/Karachi failures)
depends_on: [s05/s05b (runner), s10b (auto-run), s24 (brief runner)]
parallel_safe: true (tests, one line in brain/src/builder/supervisor.ts, one line in brain/API.md)
human_gated: false
verify: bash slices/s30-test-isolation/verify.sh
paths_in_scope: [brain/src/builder/supervisor.ts (socket folder name only), brain/API.md (one line), brain/tests/helpers.ts, brain/tests/s24-brief-runner/{setup,cleanup.test,verdict-channel.test,surfaces.test}.ts, brain/tests/s05-workflows/runner.test.ts, brain/tests/s05b-runner/idempotency.test.ts, brain/tests/s10b-review2/autorun.test.ts, slices/s30-test-isolation/**]
paths_out_of_scope: [app/**, engine/**, brain/src/workflows/** (s27 is working there), every other src file]
---

# s30 test isolation

The brain suite on main (0abc4e0) failed in two ways that had nothing to do with the code under test.

## Problem 1: s24 leftover checks saw other runs' folders

`SAFETY: no /tmp/ofl-* folder outlives a run` and every `RECORD: ... releases everything` test listed ALL `/tmp/ofl-*`
folders before and after a run and failed on any new one. A second brain test run on the same Mac (another agent,
another worktree) creates its own live `ofl-*` socket folder in that window, so the check failed whenever two runs
overlapped. `releaseTemps()` had the same flaw for `$TMPDIR/offload-s24-*` folders ("temp folders created by this run
were left behind" naming another process's folders).

Fix (the "nothing left behind" guarantee is unchanged, only attributed):
- `supervisorSocket()` names the folder `/tmp/ofl-<pid>-XXXXXX` (still in /tmp: the unix socket path must stay under
  104 bytes). A leftover now says which process made it.
- The tests check only folders of the process that ran the build: this test process, or the spawned CLI's pid for the
  SIGTERM test. They also prove the check is not vacuous: the run's own `sandbox.sb` names its socket folder, which
  carries the expected prefix and is gone afterwards; the SIGTERM test sees the CLI's folder while it runs.
- s24 `tmp()` folders carry `p<pid>-`; the stray check looks only at this process's folders.
- A mutant runner that does not remove the socket folder on a setup failure still fails the SAFETY test.

## Problem 2: Asia/Karachi failures were a real-clock dependence in the tests

The failing runner tests (s05 runner x2, s10b N1 and N5, s05b H2 x3, M2 x2, L1, L2, L5 x2) build a live batch at the
fixture time (2026-10-19), seal it under that local day, then call `executeBatch` / `readBatch` / `listBatches`
without a clock, so the product reads it at the REAL clock. The vault keeps today and the 7 local days before it
(`isExpired`: age > 7). On 2026-10-27 local the fixture day is 8 days old: the sealed batch is expired and deleted,
and the runner answers "no such workflow or batch". Karachi (UTC+5) reached 2026-10-27 at 19:00 UTC (15:00 Toronto),
which is why the same suite passed under Karachi earlier on 2026-10-26 and failed later the same day. Toronto would
have failed from 04:00 UTC on 2026-10-27, and every zone after that. The product rule is correct and the same in every
zone (a local-day keep window, matching the observer); the tests were time bombs.

Evidence (faked clock, the three files, TZ either side):

| real clock (UTC) | Toronto | Karachi |
|---|---|---|
| 2026-10-26 18:59 | 0 fail | 0 fail |
| 2026-10-26 19:01 | 0 fail | 13 fail |
| 2026-10-27 03:00 | 0 fail | 13 fail |
| 2026-10-27 04:01 | 13 fail | 13 fail |

Fix: `pinClock()` (brain/tests/helpers.ts) pins `Date.now()` to 2026-10-21 12:00 UTC for every test of those files
and restores it after each test.

Also found: `s24 CLI: build --solution held:1 --option 1` passed only on a local Monday. `founderLive()` writes the
founder week ending yesterday at the real clock, and the fixture's day content follows the weekday, so held-back task
#1 is the coding task (first option setup) only when that week starts on a Monday; on other days it is a calls task
whose first option is leave_alone. The test now picks the coding task by id, as the s22 CLI tests already do (its
first option is setup for all seven start weekdays).

## Done when (verify.sh)
1. Typecheck passes.
2. The s24 suite passes alone, and passes in two processes started at the same time (shared /tmp and TMPDIR).
3. The clock-pinned files pass with the whole process clock moved months ahead, under Asia/Karachi and America/Toronto.
4. The whole brain suite passes under the default TZ, America/Toronto and Asia/Karachi.
5. Only in-scope paths changed since 0abc4e0.
