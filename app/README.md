# Offload app (SwiftUI + AppKit)

Menu-bar style app (`LSUIElement`, no Dock icon): an edge rail, an insight card, and two normal windows (workflow
review, dashboard). Built with plain `swiftc` (no SwiftPM, no Xcode, no asset catalogs).

```
app/build.sh                    # build app/.build/Offload.app
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
