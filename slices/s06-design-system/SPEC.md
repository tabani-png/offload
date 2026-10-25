# s06 design system

Owner: UI. Depends: s01. Paths: `app/Sources/Core/Tokens.swift`, `app/Sources/Design/`, tests in `tests/`.
Source of truth for the feel: `adam/memory/research/13-design-getone.md` (tokens, 12 rules), `12-rea-cua.md` (Apple-native).

## Goal
One small, testable token set and component kit, so every Offload surface looks and moves like a first-party Mac app.

## Must be true
1. **Tokens** (plain numbers, testable without a window server, `Tokens.swift`):
   - Spacing on the 4-pt grid: 4, 8, 12, 16, 20, 24, 32.
   - Concentric radii: card 24, well 16 (8-pt inset), row 12, key 5. `concentric(outer:inset:)` never goes negative.
   - Type: SF Pro via system fonts (Display/Text picked by size), weights 400/500 only, 600 reserved for badges.
     Display 20/500 with negative tracking; hierarchy by ink opacity (100/62/50), not weight.
   - Durations: press 100 ms; fast 150, base 200, slow 300 ms. Press scale 0.97. Insert rises 7 pt.
2. **Motion**: default curve is `cubic-bezier(0.16, 1, 0.3, 1)` (`CubicBezier.outExpo`, monotonic, no overshoot),
   plus a spring (response 0.3, damping 0.9). `MotionPlan` folds in Reduce Motion: arrival becomes a fade, press
   loses its scale, pulses freeze into a still halo.
3. **Colour means state** (`StatusRole`): working blue, needs-you amber, done green, recording red only while the mic
   is live, neutral grey. Observer `watching` pulses; nothing else does. System light/dark, dark is the hero.
4. **Glass** = NSVisualEffectView (`.hudWindow` cards, `.popover` capsules), masked to a continuous rounded rect, plus
   a veil, a 1-px edge ring, and a top specular highlight. Rings, not shadows: only floating glass gets a tight
   contact shadow.
5. **Components**: Keycap, StatusDot (pulse), Card, Well, OptionRow (numbered, Recommended tag, idle/highlighted/
   chosen/muted), PrimaryButton (the single white action; near-black in light), SecondaryButton, Chip (neutral/
   positive/recommended), ProgressHairline, SectionHeader, HintPill, EmptyState with our own code-drawn mark
   (`OffloadMark`: a tray with a block lifting off it). No assets, no third-party logos or copy.
6. **Snapshot**: `Offload --snapshot DIR` renders `components-{dark,light}.png` offscreen without permissions.

## Out of scope
Dashboard tables, the workflow-review timeline (s08), Dynamic Type scaling beyond system fonts.

## Done signal
`slices/s06-design-system/verify.sh` exits 0: app builds as a bundle with `LSUIElement=true`, at least 10 S06 tests
pass (whole suite at least 15), and the component sheet renders in both appearances.
