# s07 design review: rail and insight card

Reviewed 2026-10-24 against the 12 feel rules in `adam/memory/research/13-design-getone.md`.
Evidence: `app/snapshots/*.png` (1x, committed). Regenerate at 2x with `app/build.sh snapshot DIR`.
Snapshots draw glass with a simulated fill over our own gradient backdrop, because behind-window blur cannot be
captured offscreen. The real material was checked once on the live desktop (see "Live check").

| File | What it shows |
|---|---|
| `components-{dark,light}.png` | s06 kit: type ladder, keycaps, status dots, chips, option rows, buttons, hairlines, section header, empty state |
| `rail-{dark,light}.png` | rail at rest · rail with the status hover label · paused observer with the mic live |
| `card-{dark,light}.png` | outreach insight, 1 of 3, with the hint pill |
| `card-evidence-{dark,light}.png` | after pressing 2: six spans (time, title, app, minutes) |
| `card-undo-{dark,light}.png` | 1.6 s after pressing 1: staged row, countdown hairline, Esc to undo |
| `card-empty-{dark,light}.png` | calm empty state |
| `scene-{dark,light}.png` | the card docked beside the rail at the right screen edge |

## Rule by rule

1. **One accent, and it is white.** The card has no filled button at all; its choices are numbered rows. The kit's
   PrimaryButton is the only solid fill (white on dark, near-black on light, so it never disappears on light glass).
   Saving is a green chip, not a banner.
2. **Color means state.** The card header dot is amber (needs you). The staged row and countdown are blue (working,
   in flight). The saving chip is green (the good outcome). Red appears only on the live mic (`rail-*`, third rail).
   The share bar is neutral ink, not a status colour. One mapping (`StatusRole`) feeds every surface, and it is tested.
3. **Rings, not shadows.** Wells, rows, chips and keycaps are 1-px rings on translucent fills. Only floating glass
   (card, capsules, hint pill) carries a tight contact shadow.
4. **Glass has three layers.** Material (`.hudWindow`/`.popover`) plus veil, 1-px edge ring, and a top specular
   stroke that fades by a third of the height (visible on the card's top edge and each capsule).
5. **Concentric radii.** Card 24 → well 16 at an 8-pt inset → rows 12 at a 12-pt inset → keys 5. Capsules and chips
   are pills. `Tokens.Radius.concentric` is tested.
6. **Two fonts, three weights, no bold.** SF Pro Display at 20/500 for the headline, SF Pro Text 13/400 body, 11/500
   captions; 600 only in the badge digit. Hierarchy is ink opacity (96/62/50).
7. **Every action has a key.** Keycaps on every option, K/J and esc in the header (K dims on the first card), and the
   hint pill teaches "Press 1 2 3 to choose · E dismiss". The pending strip shows esc next to the seconds left.
8. **Reversible by default.** 1, 3 and E wait 5 s behind a blue hairline countdown (`card-undo`). Esc undoes. A
   second choice lands the first rather than dropping it. Clicking away does not cancel a staged action; it lands.
9. **Ambient first, interrupt rarely.** The rail is three small capsules; only the observer dot pulses. The card
   opens only on ⌥Space or a click on the inbox, shows one insight at a time, and stays out of full-screen Spaces.
10. **Recommend, don't decide.** "Build the workflow" carries a quiet amber Recommended tag. Nothing runs until a key
    is pressed and the undo window passes.
11. **Fast and decelerating.** Out-expo `cubic-bezier(0.16,1,0.3,1)` at 150-200 ms. Inserts rise 7 pt and fade; the
    press scale is 0.97 at 100 ms. Reduce Motion turns arrival into a fade, drops the press scale and freezes pulses
    (`MotionPlan`, tested). Nothing bounces.
12. **Plain, short copy.** "You spent 65% of your week on investor outreach emails." Then the arithmetic. The brain's
    saving line is verbatim, split only at its own → steps. Empty state: "Nothing to decide. Still watching. Offload
    speaks up when a task starts to repeat."

## Iterations (what the PNGs caught)
1. First render via `cacheDisplay`: hard tick marks at capsule corners and dark bands under capsules. Cause: AppKit
   offscreen caching clips SwiftUI shadows at layer bounds. Fix: render with `ImageRenderer` (still offscreen, no
   permissions); `OFFLOAD_RENDERER=cachedisplay` keeps the old path for comparison.
2. Glass read as an opaque slab; evidence titles truncated twice ("Intro: Offload se… Halden…") with heavy monospace
   times showing UTC (05:14); tertiary ink at 42% failed AA for 11-pt text; the staged row was grey. Fixes:
   lighter simulated fill, native middle truncation, tabular digits, local-time sample data, ink3 to 50%, chosen row
   tinted working-blue. Headline down from 22 to 20 pt.
3. Light mode wells and rows were black-tinted and looked dirty on white glass. Fix: white fills on light glass
   (Apple light keycaps and grouped rows). Also clipped "Wed 08:…" time column, a 1-px dark edge from fractional
   render sizes, and the brain's long arithmetic wrapping mid-expression (now one step per line).

## Live check
The app was run on the operator's desktop. Window list: the rail was 88×270 at layer 3 with its right edge 8 pt from
the screen edge. The card was 448×483 (with shadow padding), 8 pt left of the rail and top-aligned with the inbox.
Keys replayed through the real path: 2 opened the evidence, J paged, 1 staged, and the build committed after 5 s.
One live screenshot confirmed the real blur and rounded mask. It also showed that over a white page the `.hudWindow`
material with a 30% veil let the lower rows go grey-on-grey, so the dark veil is now 58% (light 50%). That change was
not re-photographed, because the operator was using the screen and live captures were stopped (privacy).

## Known gaps
- Glass in PNGs is simulated; contrast over busy or white content is the main live risk (see weakest spot below).
- The status hover label resizes the rail panel; there is a one-frame re-anchor when it appears.
- Connection state is not in API v1, so every connector chip reads "not connected" (grey dot).
- No multi-display logic yet: the rail always sits on `NSScreen.main`.

## Weakest spot
Legibility of the glass over arbitrary content. The veil is a fixed opacity; Apple's own HUDs adapt with vibrancy.
Next step: render the card's text with `NSVisualEffectView` vibrancy or an adaptive veil (sample the luminance behind
the panel), and verify it over a white page and a photo wallpaper.
