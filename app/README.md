# Offload app (SwiftUI + AppKit)

Menu-bar style app (`LSUIElement`, no Dock icon): an edge rail, an insight card, and two normal windows (workflow
review, dashboard). Built with plain `swiftc` (no SwiftPM, no Xcode, no asset catalogs).

```
scripts/demo.sh                 # build engine + app, fixture week in scratch/demo, open on the REAL brain
scripts/run.sh [--install-agent]  # real home, real brain; observer LaunchAgent only with --install-agent
scripts/verify-all.sh           # every slices/*/verify.sh, as a table
app/build.sh                    # build app/.build/Offload.app (bundles engine/.build/offload-observer when built)
app/build.sh test [--filter S08]  # Swift Testing suites from slices/s06, s07 and s08 tests
app/build.sh snapshot DIR       # build, then render every component and surface to PNGs (light + dark)
open app/.build/Offload.app     # run it
```

- **Hotkey:** ⌥Space opens and closes the insight card (Carbon hotkey, no permissions needed). If another app holds
  ⌥Space, the card still opens from the rail's inbox capsule. Keys on the card: 1/2/3, J/K, E, Esc.
- **Snapshot mode:** `Offload.app/Contents/MacOS/Offload --snapshot DIR [--scale N]` renders offscreen, no
  permissions. `app/snapshots/` holds the committed 1x review set; verify scripts render 2x into a temp dir.
- **Windows (s08):** choosing 1 on the card opens the workflow review after the undo window (⌘↩ approve, ↩ confirm,
  Esc cancel within 5 s, E edit, R run the dry run again, S SKILL.md, ⌘⌫ discard). The dashboard opens from the
  rail's … menu or ⌘D while the card is open (J/K select, P point, 2 show the evidence, ↩ open).
- **QA hooks:** `--open-card` opens the card at launch; `OFFLOAD_DEMO_KEYS="2,j,1"` replays keys one per second
  through the real key path. `--open-review`, `--open-dashboard [--qa-pointer]`, `OFFLOAD_REVIEW_KEYS="approve,confirm"`.
  `--qa-glass white|dark [--qa-appearance light|dark]` opens the card over a backdrop window of the app's own and
  writes a capture rect that lies on it to `$OFFLOAD_QA_FILE` (window numbers too), so live checks never capture
  other apps.

Layout: `Sources/Core` (Foundation only: models, brain wire mirror, formatting, keyboard and undo state machine,
token values) · `Sources/Design` (theme, motion, glass, components) · `Sources/Surfaces` (rail, card, panels) ·
`Sources/App` (entry point, hotkey, snapshotter). s08 adds `Core/{Workflow,WorkflowWire,Approval,Dashboard,DiffLite,
Pointer,MockWorkflows}.swift`, `Design/{WindowKit,PointerOverlay}.swift` and `Surfaces/{Review*,Dashboard*,Windows}.swift`.

**Brain and observer (s09a).** By default the app launches the brain itself (`bun run brain/src/cli.ts serve --home
DIR --port 0`, a fresh per-launch `OFFLOAD_TOKEN` in its env, the port from its first stdout line), restarts it with
backoff (1 → 30 s) and stops it on quit; a shell guard stops it if the app dies. `--mock` runs on the sample week;
`--brain-url URL` (token in `OFFLOAD_TOKEN`) attaches to a running brain; `--home DIR` or `OFFLOAD_HOME` picks the
store; `OFFLOAD_DRYRUN_LIMIT` caps dry-run instances (each one is a model call). Brain stderr:
`~/Library/Logs/Offload/brain.err.log`. Observer state and permissions come from `offload-observer status --json`;
Pause calls `pause`/`resume`. First launch shows the 3-step welcome (`--onboarding` forces it, "Use demo week" seeds
`scratch/demo`). Live e2e: `slices/s09a-wiring/e2e.sh` (one model call), captures in `app/snapshots/live/e2e-*.png`.
The review window edits the tone card (PUT /workflows/:id/tone) and the SKILL.md words (PUT .../skill); permissions
come from GET /observer, else the CLI. s09a adds `Core/{HTTPBrainClient,BrainSupervisor,BrainEdits,ObserverControl,Onboarding,ReviewMessages}.swift` and
`Surfaces/OnboardingWindow.swift`.
