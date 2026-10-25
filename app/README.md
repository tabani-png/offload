# Offload app (SwiftUI + AppKit)

Menu-bar style app (`LSUIElement`, no Dock icon): an edge rail and an insight card. Built with plain `swiftc`
(no SwiftPM, no Xcode, no asset catalogs).

```
app/build.sh                    # build app/.build/Offload.app
app/build.sh test [--filter S07]  # Swift Testing suites from slices/s06-*/tests and slices/s07-*/tests
app/build.sh snapshot DIR       # build, then render every component and surface to PNGs (light + dark)
open app/.build/Offload.app     # run it
```

- **Hotkey:** ⌥Space opens and closes the insight card (Carbon hotkey, no permissions needed). If another app holds
  ⌥Space, the card still opens from the rail's inbox capsule. Keys on the card: 1/2/3, J/K, E, Esc.
- **Snapshot mode:** `Offload.app/Contents/MacOS/Offload --snapshot DIR [--scale N]` renders offscreen, no
  permissions. `app/snapshots/` holds the committed 1x review set; verify scripts render 2x into a temp dir.
- **QA hooks:** `--open-card` opens the card at launch; `OFFLOAD_DEMO_KEYS="2,j,1"` replays keys one per second
  through the real key path.

Layout: `Sources/Core` (Foundation only: models, brain wire mirror, formatting, keyboard and undo state machine,
token values) · `Sources/Design` (theme, motion, glass, components) · `Sources/Surfaces` (rail, card, panels) ·
`Sources/App` (entry point, hotkey, snapshotter).
