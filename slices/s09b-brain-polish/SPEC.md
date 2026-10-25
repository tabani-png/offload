# s09b brain polish

Owner: TS engineer. Paths: `brain/`, `slices/s09b-brain-polish/`. Source: `slices/s09a-wiring/SPEC.md` "Needs brain",
`brain/API.md`, ADR 0006 (every external action passes an approval gate until auto-run is on per workflow).
Types in `brain/src/api/types.ts` change additively only.

## Acceptance (tag = test name prefix in `brain/tests/s09b-brain/`)
1. MODEL: `serve --model stub|real` (default real, `claude` alias). Stub = the deterministic test model. Every response
   carries `x-offload-model`, every 2xx JSON object body `model: "stub"|"real"`; a stored dry run keeps its own label.
2. LATEST: `GET /workflows/:id/dry-runs/latest` returns the last sealed dry run (opened for the response only, no model
   call); 404 when none or purged.
3. OBSCTL: `POST /observer/pause` and `/observer/resume` run the observer CLI and return a fresh `GET /observer`;
   failure is 409 with the reason.
4. TASKID: `AutomationDTO.taskId`.
5. NEEDSYOU: needsYou reasons are full sentences for a person ("Connect Gmail so this can send.",
   "A new batch of N is ready for review.").
6. TZ: timeline hours shift fixed at the source and tested in America/Toronto and Asia/Karachi (and UTC): a 09:00
   local span renders at 09:00, the fixture morning starts 08:30 local.
   Root cause: `brain/fixtures/gen.ts` built days from `Date.UTC` midnight + 8.5 h and labelled them with the UTC
   date, so fixture activity sat at 08:30 UTC (04:30 Toronto, 13:30 Karachi). Reader, sessionize and `/timeline` were
   already local and correct (a hand-written 09:00 local span rendered at 09:00 before the fix). The generator now
   builds local days like the observer does.
7. SCHED: the serve run loop (injected clock) starts a due cron slot only when the workflow is active, and then either
   drafts a pending batch (needs_you "A new batch of N is ready for review.") or, with auto-run on and connectors
   connected, approves that exact batch hash and sends it. Never sends without an approved batch hash.

## Done signal
`slices/s09b-brain-polish/verify.sh` exits 0: all brain tests pass (at least 320), `tsc --noEmit` clean, every tag
has passing tests, the brain suite passes under TZ=America/Toronto and TZ=Asia/Karachi, and the real
`serve --model stub` prints the ready line and labels `/status` stub.
