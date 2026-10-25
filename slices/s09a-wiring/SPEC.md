# s09a wiring: the app on the real brain and the real observer

Owner: integration. Depends: s05 brain routes (`brain/src/api/types.ts`, API v1), s02b observer CLI
(`offload-observer status --json`, `pause`, `resume`), s07/s08 app. Paths: `app/`, `scripts/`, `slices/s09a-wiring/`.
Never edits `brain/` or `engine/`.

## Goal
Offload.app runs on the real brain and the real observer: it launches the brain, reads real insights, drafts and
dry-runs real workflows, shows the real permission state, pauses the real observer, and gets a new user from first
launch to a visible insight in one calm window. The mock stays for `--mock`, snapshots and tests.

## 1. HTTPBrainClient (`app/Sources/Core/HTTPBrainClient.swift`)
- Implements `BrainClient` over URLSession (ephemeral, no cache/cookies/proxy), base `http://127.0.0.1:PORT/`,
  `Authorization: Bearer <token>` on every call, no `Origin`. Timeouts: 10 s, 120 s for dry runs.
- Routes: GET /status, /insights, /insights/:id/evidence, /connectors, /workflows, /workflows/:id, /timeline?day=,
  /dashboard; POST /workflows/draft, /workflows/:id/dry-run `{limit}`, /workflows/:id/approve `{batchHash}` (then GET
  the detail, since approve returns a summary); DELETE /workflows/:id.
- The dashboard is composed (`DashboardComposer`): /dashboard + /status + /workflows + /connectors + one /timeline
  per stored day (at most keepDays); the top three tasks keep names and pastels, the rest are "Everything else";
  spans after a workflow's `activatedAt` are drawn automated; permissions come from the observer.
- Typed errors (`BrainError`): unreachable, starting, timedOut, unauthorized (401/403), notFound, conflict (409, the
  brain's own words), badRequest, server, badResponse. Each has one calm `userMessage` ("Brain is not running. Offload
  restarts it on its own; this clears in a few seconds."). The rail says "Brain is not running" / "Brain is starting".

## Token handoff and supervision (`app/Sources/Core/BrainSupervisor.swift`)
- The app generates a 256-bit token per launch and passes it as `OFFLOAD_TOKEN` in the child's env (brain/API.md:
  "The app passes its per-launch token in the env"). It never crosses stdout.
- Command: `bun run brain/src/cli.ts serve --home DIR --port 0`. The port comes from the child's first stdout line.
  Both formats are read: today's `brain listening on http://127.0.0.1:PORT/` (what committed `cli.ts serve` prints;
  no brain change was needed) and the s05c handshake now landing in types.ts, `OFFLOAD_BRAIN_READY
  {"port":N,"token":"..."}` (its token is adopted). A later `OFFLOAD_TOKEN=…` line is adopted too. Loopback only.
- Restart with backoff 1, 2, 4 … 30 s; a run of 60 s resets it. No first line within 25 s counts as a failed start.
- Stop on quit (`applicationWillTerminate`: TERM, 2 s, KILL). A shell guard (`sh -c GUARD sh <app pid> bun …`) also
  stops the brain within ~1 s if the app dies without quitting, so no orphan keeps listening.
- bun: `OFFLOAD_BUN`, `~/.bun/bin`, Homebrew, `/usr/local/bin`, PATH. Repo: `OFFLOAD_REPO` or up from the bundle.
  stderr goes to `~/Library/Logs/Offload/brain.err.log` (0600).
- Modes: default spawn; `--mock` (MockBrainClient); `--brain-url URL` + `OFFLOAD_TOKEN` attaches to a running brain.
  `--home DIR` > `OFFLOAD_HOME` > `~/Library/Application Support/Offload`. `--dry-run-limit N` /
  `OFFLOAD_DRYRUN_LIMIT` (1..50, default 5; each instance is one model call).

## s05c routes (brain 6fe3902)
- Handshake: the READY line (`OFFLOAD_BRAIN_READY {"port","token"}`, first stdout line) is parsed first; the v1
  `brain listening on` line stays supported for older brains.
- Tone card: the review window GETs `/workflows/:id/tone`, edits it inline and PUTs `{ text }` (checked against
  `maxBytes` first); an empty card says how to make one.
- SKILL.md: E opens an edit form for the description and each step's title and detail only (gate steps shown
  locked); the app checks the brain's rules (blank, length, one-line titles, no headings/---/fences) before PUT
  `/workflows/:id/skill` with only the changed fields, then re-reads the workflow. A 400 shows the brain's reason.
- Permissions: `GET /observer` first (dashboard, onboarding, rail pause flag); the observer CLI when the brain
  says `available: false` or is older (404). Pause/resume still go to the CLI (no route).
- Run times: `lastRunAt` / `nextRunAt` reach the dashboard rows and the workflow schedule.
- Demo homes always run with `OFFLOAD_KEYS=file` (demo.sh, "Use demo week", tests), so nothing touches the Keychain.

## 2. Observer lifecycle (`app/Sources/Core/ObserverControl.swift`)
- Binary: `OFFLOAD_OBSERVER_BIN`, then the copy in `Offload.app/Contents/MacOS` (app/build.sh bundles it with its
  dylib when engine/.build has it), then `engine/.build/offload-observer`.
- `status --json --home H` every 10 s: pause flag and permissions (`heartbeat` from the running observer, else a
  probe by the CLI). Pause/Resume on the rail and the dashboard call `pause` / `resume`, then re-read both sides.
- Permissions (dashboard "Observing" and onboarding): Screen Recording (required: screen text), Accessibility
  (required: titles and URLs), Input Monitoring (optional: counts). No microphone row: no feature records audio.
  Each row not yet allowed has Open Settings → `x-apple.systempreferences:com.apple.preference.security?
  Privacy_ScreenCapture | Privacy_Accessibility | Privacy_ListenEvent`. Unknown (no observer) is grey, never amber.

## 3. First-run onboarding (`Core/Onboarding.swift`, `Surfaces/OnboardingWindow.swift`)
One small titled window (520 pt), three steps, one primary, ↩ continues, Esc closes: 1 what it notices and what it
never keeps; 2 the three permissions, re-read every 1.5 s, ticking on as macOS grants them; 3 "Come back in a few
days" with **Use demo week**: runs the fixture generator into the demo home (`<repo>/scratch/demo`, never the real
home; `DemoWeek.isSafeDemoHome`) and restarts the brain on it. Shown once (UserDefaults `ai.offload.onboarded.v1`),
`--onboarding` forces it, QA and `--mock` runs skip it; reopen from the rail's … menu.

## 4. Scripts
- `scripts/demo.sh [--plain] [--no-open] [-- ARGS]`: builds engine and app, writes the 7-day fixture ending yesterday
  (`--encrypted`, i.e. `OFFLOAD_KEYS=file` raw key files; `--plain` for jsonl) into `scratch/demo`, opens the app on it
  with the real brain. Dry-run limit 3 unless `OFFLOAD_DRYRUN_LIMIT` is set.
- `scripts/run.sh [--install-agent] [-- ARGS]`: real home, real brain; the observer LaunchAgent is written and loaded
  only with `--install-agent`.
- `scripts/verify-all.sh [FILTER]`: every `slices/*/verify.sh`, a table of slice, result and seconds.

## 5. End to end (`slices/s09a-wiring/e2e.sh`, run live)
demo.sh → the card shows the outreach insight from the real brain → 1 → the review window gets a real dry run
(limit 1: one model call) → approve + confirm → the brain activates the dry-run batch and the window says calmly
"Turned on. Before it can send: Connect Gmail." (Gmail is not connected; nothing is sent) → dashboard (needs you:
connect Gmail). Captures our windows only (`screencapture -l <window number>`, numbers from `OFFLOAD_QA_WINDOWS`)
into `app/snapshots/live/e2e-*.png`; quits the app and checks the brain child is gone.

## Needs brain (found while wiring; none blocks this slice)
1. `serve` has no `--model stub|claude` (cli.ts always passes `AgentSdkModel` to the server). A one-line change in
   `runCommand` (`startBrainServer({ …, workflows: { model: modelOf(args) } })`) would let demos and e2e runs dry-run
   for free. Until then every dry-run instance from the app is a real model call; the app caps it with
   `OFFLOAD_DRYRUN_LIMIT`.
2. No GET for the last dry run of a workflow: reopening the review window always runs (and pays for) a new one.
3. No pause/resume route: the app calls `offload-observer pause|resume` itself (reads use `GET /observer`).
4. Dashboard automations carry no `taskId`; the app joins `/workflows` for it (timeline hatching).
   (`lastRunAt` / `nextRunAt` now come from the brain.)
5. `needsYou` strings are lower-case fragments ("connect Gmail first"); the app sentence-cases them.
6. Engine README documents `status --json`, but older built binaries reject `--json`; rebuild engine before running.

## Done signal
`slices/s09a-wiring/verify.sh` exits 0: app builds, at least 55 S09A tests and at least 130 app tests in total pass,
the fresh 2x render has onboarding-watches, onboarding-permissions, onboarding-comeback, dashboard-permissions and
review-real-schedule in both appearances, scripts exist and pass `bash -n`, `verify-all.sh` lists every slice, and the
live e2e captures exist (`E2E=1` re-runs the live e2e first; that spends one model call).
