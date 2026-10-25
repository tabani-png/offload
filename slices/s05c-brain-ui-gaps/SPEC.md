# s05c: brain UI gaps and the H4 close-out

Owner: brain (TS). Paths: `brain/`, this folder. Types change additively only (`brain/src/api/types.ts`, v1).
Inputs: s05b SPEC (H4 disputed: brain key in a raw file), engine `wrap-key` / `unwrap-key` (a94ef45),
s08 DESIGN-REVIEW "Known gaps" (tone card, SKILL.md writes, last/next run), the app's need for a handshake and the
observer's permissions.

## Acceptance
1. **H4 closed.** Brain artefact keys come from `offload-observer wrap-key / unwrap-key --name YYYY-MM-DD --home HOME`
   (binary `OFFLOAD_OBSERVER_BIN`), stored Keychain-wrapped by the observer in `keys/brain-DAY.key`. No raw key is
   written by default. `OFFLOAD_KEYS=file` keeps the s05b raw files (tests, fixtures; `brain/tests/preload.ts` sets it
   for `bun test`). A missing or failing observer fails sealing loudly and never makes the purge delete live
   artefacts. Raw s05b key files are wrapped with the same bytes and deleted at `serve` start and lazily; a conflict
   keeps the raw file and still opens old artefacts. Expired wrapped keys are deleted by the brain's purge.
   Tests: `brain/tests/s05c-keys` (`H4c: *`, fake observer `fake-observer.sh`).
2. **Ready line.** `serve` prints `OFFLOAD_BRAIN_READY {"port":N,"token":"..."}` as its first stdout line, nothing
   before it (logs on stderr), port 0 = free port, token printed only there. Tests: `brain/tests/s05c-serve` (`READY: *`).
3. **Routes.** `GET/PUT /workflows/:id/tone` (`ToneCardDTO`, `ToneCardUpdate`, 16 KB limit, 413 above, kept on
   rebuild), `GET/PUT /workflows/:id/skill` (`SkillDTO`, `SkillUpdate`: description and step title/detail only; a PUT
   cannot add a tool, add/remove/retype a step or touch the gate), `lastRunAt` / `nextRunAt` on `AutomationDTO` and
   `WorkflowSummaryDTO` (newest live batch; next cron due time while active), `GET /observer` (`ObserverResponse`,
   proxy of `status --json`, permissions included). Tests: `brain/tests/s05c-routes` (`TONE: *`, `SKILL: *`,
   `RUNS: *`, `OBSERVER: *`).
4. `verify.sh`: all brain tests pass, at least 285, `tsc --noEmit` clean, every s05c tag has passing tests, and the
   real `serve` prints the ready line first.

## Decisions
- Brain key names are the local day (`2026-10-19`), valid for the observer's `a-z 0-9 -` names.
- Purge decides "key gone" by the key FILE, never by asking the observer, so a locked Keychain cannot purge live data.
- `nextRunAt` is when the schedule is due. Nothing fires schedules yet; the app (or a later slice) calls `run`.
- s05 and s05b verify scripts now run their fixture CLI with `OFFLOAD_KEYS=file` (one token each): without it they
  would ask the real observer (and the Keychain) for brain keys, which is the new default.
- `brain listening on <url>` stays as the second stdout line for the current app parser; the `OFFLOAD_TOKEN=` line is gone.
