---
id: s31-local-jobs
title: Local background jobs run in the INSTALLED app (bundled brain, no repo, no bun on PATH) - proven job by job, repo paths fixed
depends_on: [s25-standalone-install (bundled brain, --brain-check, PROOF recipe), s28-dmg, s09b (run loop), s11 (caption worker), REVIEW-2 (purge), ADR 0014]
parallel_safe: true
human_gated: false (observer start at login needs an operator decision; see "Operator decision")
verify: bash slices/s31-local-jobs/verify.sh
paths_in_scope: [app/Sources/Core/BrainSupervisor.swift, app/Sources/Core/BrainCheck.swift, app/Sources/App/OffloadApp.swift, app/build.sh (test file list only), brain/src/store/observer.ts, brain/tests/s31-local-jobs/**, slices/s31-local-jobs/**]
paths_out_of_scope: [control/**, web/**, schemas/**, packages/**, engine/** (read only here), brain/src/builder/** (builder stays off)]
---

# s31-local-jobs

## Operator intent (binding)
For ONE person on their own laptop, every local background job must really run in the installed app (the s25/s28
bundle: pinned bun + brain JS inside Offload.app, no repo, no bun on PATH), not only in tests or a dev checkout.
Company control-plane jobs (control/, and the brain's S2-02 company sync, a no-op until a company is connected) are
out of scope. No prod-only knobs: short intervals only through hooks that already exist (`--model stub`,
`--captioner stub`, OFFLOAD_KEYS=file, OFFLOAD_LAUNCH_AGENTS_DIR) and the s25 check mode.

## Job inventory (who starts it, how often, sleep/wake, reboot/login, quit)
| job | starts it | interval | after sleep/wake | after reboot/login | app quit |
|---|---|---|---|---|---|
| brain supervision + restart | app launch (`BrainSupervisor`) | on crash: 1,2,4..30 s backoff | process suspended, resumes | only when the app is opened (no login item) | brain stopped (TERM, orphan guard kills it within 1 s if the app dies) |
| key-change restart (s29) | Claude key saved/removed | on change | n/a | n/a | n/a |
| captioner opt-in restart (s14) | Claude vision toggled | on change | n/a | n/a | n/a |
| purge at app launch (REVIEW-2) | `purgeOnce` before serve | once per launch | n/a | next app launch | n/a |
| brain purge schedule | serve start | at start + hourly | monotonic timer resumes; next run within an hour | with the brain | stops |
| run loop (cron workflows, auto-run) | serve start | first tick at once, then 30 s | missed 09:00 slot handled once on the next tick | with the brain; missed slot handled once | stops; slots missed while closed are handled once at next start |
| live-batch prep + auto-run send | run loop tick (due slot) | per due slot | as run loop | as run loop | in-flight send journalled (s10b) |
| caption worker (s11) | serve `--captioner` (app: auto/claude when available) | at start + 15 s | resumes; picks up frames captured meanwhile | with the brain | stops |
| Composio universe refresh (s17) | serve `--model real` | at start + hourly (stale after a day) | resumes | with the brain | stops |
| time breakdown, metrics, dashboard | on request (GET /time, /dashboard) | app refresh: 10 s observer, 30 s inbox | Foundation timers fire once on wake | with the app | stop |
| brain log rotation (app) | app launch | 60 s | resumes | with the app | stops |
| observer capture (engine) | LaunchAgent `ai.offload.observer` (RunAtLoad, KeepAlive on crash) | 1 s tick; OCR 30 s; purge hourly; log rotate 60 s | wall-clock checks, resumes | ONLY if the agent was installed + loaded | independent of the app |

## Findings and fixes
1. **Purge child had no observer binary (FIX, app).** `purgeOnce` ran `cli.ts purge` with the app's plain
   environment: no `OFFLOAD_OBSERVER_BIN`, no `OFFLOAD_HOME`. In the bundle the brain's fallback is
   `Resources/offload/engine/.build/offload-observer`, which does not exist, so in Keychain mode the purge could not
   seal legacy plaintext (`purge could not seal a legacy file`). Now `BrainLaunch.purgeSpec(location:home:...)` builds
   the purge launch like the serve launch (bundled bun, cwd the bundle root, Helpers first on PATH, the observer the
   app found, `OFFLOAD_HOME`); the app and the check mode both use it.
2. **The brain's observer fallback pointed into the repo (FIX, brain).** `store/observer.ts observerBin`: when the
   repo path `engine/.build/offload-observer` does not exist and the brain runs from a bundle
   (`X.app/Contents/Resources/offload/brain/src/store`), it uses `X.app/Contents/MacOS/offload-observer`.
3. **`--brain-check` did not launch the brain like the app (FIX, app).** It now runs the app's purge first, passes
   the observer the app would find, and (check mode only) can hold the brain: `--hold SECONDS` keeps the supervised
   brain up, prints each state change (`brain state: ...`, `brain endpoint: URL`), writes the per-launch token to
   `HOME/.brain-check-token` (0600), restarts it on SIGUSR1 (the key-change path) and stops it on SIGTERM.
   `--captioner stub|off` (check mode only) adds the existing brain flag. Nothing changes for a normal launch.
4. **The observer never starts in the installed app (NOT FIXED: operator decision).** Nothing in app/ installs or
   loads the observer LaunchAgent or starts `offload-observer run`; only `scripts/run.sh --install-agent` (dev) does.
   An installed app therefore records nothing. `install-agent` run from the bundle writes a plist whose program is
   inside the bundle (proved). See "Operator decision".
5. **The app is not a login item.** Brain jobs (09:00 cron slots, purge, captions) run only while Offload is open.
   A slot missed while closed is handled once at the next start (proved). Same consent question.

## Acceptance (tags: Swift test names in tests/S31Tests.swift, brain tests in brain/tests/s31-local-jobs/, verify.sh)
- PURGESPEC (Swift): the purge launch uses the bundled bun on the bundled cli.ts, cwd the bundle root, Helpers first
  on PATH, `OFFLOAD_OBSERVER_BIN` = the observer given, `OFFLOAD_HOME` = home; nil when the brain has no purge.
- OBSLOC (Swift): with no env the app finds `Contents/MacOS/offload-observer` of its own bundle, never the repo path.
- CHECKOPTS (Swift): `--hold N`, `--captioner stub|off` parse; other captioners and bad holds are refused; the check
  spec carries the observer and the captioner flag; without them it equals the s25 check spec.
- OBSBIN (brain): the fallback resolves inside the bundle when the module lives in an app bundle and the repo path
  is missing; the repo path stays first in a checkout; OFFLOAD_OBSERVER_BIN still wins.
- verify.sh, on the app built outside the repo, copied to a temp folder, made read-only, run with `env -i`, temp
  HOME, PATH without bun, no OFFLOAD_REPO, OFFLOAD_KEYS=file (never the real Keychain), a seeded home
  (`seed.ts`, repo bun: test state only):
  - PURGE: the app's launch purge (check mode, before serve) deletes `frame-notes/` and `frames/` files older than
    7 days and keeps a 6-day-old one.
  - SCHED: a weekday 09:00 slot missed while the app was closed drafts exactly one pending live batch on the first
    tick ("A new batch of 3 is ready for review."); nothing is sent.
  - CAPTION: the stub captioner captions both keyframes; a sealed `frame-notes/<today>.jsonl.enc` exists.
  - OBSERVER: GET /observer answers 200 (the bundled observer through the path the app passes).
  - TIME: GET /time answers 200 from the bundle.
  - WAKE: the brain is suspended (SIGSTOP) past one run-loop interval, a keyframe arrives, it resumes (SIGCONT): the
    same process captions it and keeps answering.
  - RESTART: the brain is killed; the supervisor starts a new one (new pid, new endpoint) and the pending batch is
    not duplicated.
  - KEYRESTART: SIGUSR1 (the s29 key-change path, `restart(home:spec:)`) replaces the brain process.
  - QUIT: the app process is killed (-9); the orphan guard stops the brain within 5 s.
  - AGENT: `offload-observer install-agent` from the copy writes a lint-clean plist (RunAtLoad, KeepAlive on crash)
    whose program is inside the copy; `offload-observer status --json` runs from the copy.
  - CONSENT: app/Sources still has no observer auto-start (no install-agent, launchctl or SMAppService call).
- `app/build.sh test`, the brain suite, s25 verify and s28 verify pass (run separately).

## Operator decision
Should the observer start at login after install? It should only with the person's consent, and today there is no
consent step for it (onboarding step 1 "Offload watches how you work, on this Mac" explains, step 2 asks for the
three permissions; neither starts anything). Proposed (not built here):
- Onboarding step 1 becomes the consent: buttons "Start watching" and "Not now". "Start watching" registers the
  observer as a login agent with `SMAppService.agent(plistName: "ai.offload.observer.plist")` (plist shipped in
  `Contents/Library/LaunchAgents`, `BundleProgram Contents/MacOS/offload-observer`, so it follows the app when it
  is moved, and it shows in System Settings > Login Items where the person can switch it off). "Not now" starts
  nothing; the dashboard shows "Not watching" with the same button.
- A dashboard switch "Open Offload at login" (`SMAppService.mainApp`, off by default) so cron workflows run at
  09:00 without the person opening the app.
- Uninstall notes gain "Login Items: remove Offload". The current `install-agent` path stays for dev only.
