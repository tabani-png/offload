# s08 design review: workflow review, dashboard, pointer, and the s07 fixes

Reviewed 2026-10-24 against the 12 feel rules in `adam/memory/research/13-design-getone.md`.
Evidence: `app/snapshots/*.png` (1x, offscreen) and `app/snapshots/live/*.png` (real windows on this Mac).
Snapshots draw the window frame (traffic lights, toolbar) and simulated glass, because offscreen rendering
cannot capture AppKit chrome or behind-window blur. Live captures are of our own windows only: titled windows by
window id (`screencapture -l`), the glass card over a backdrop window the app opens itself, one level below the
card, with the capture rect inside it. No other app's pixels were captured.

| File | What it shows |
|---|---|
| `review-{dark,light}` | header, 8 steps with the amber approval gate, the tone card |
| `review-dryrun-{dark,light}` | 3 of last week's emails: Our draft beside What you sent, diff-lite marks, time per item |
| `review-confirm-{dark,light}` | the confirmation: 8 recipients, the run in 4 steps, the Google Sheets blocker |
| `review-armed-{dark,light}` | 1.6 s after ↩: "Turning on in 4s", blue hairline, Esc |
| `review-skill-{dark,light}` | SKILL.md sheet |
| `dashboard-{dark,light}` | hero, automations (needs-you on top), this week, observing |
| `timeline-{dark,light}` | the 7-day timeline on its own |
| `pointer-{dark,light}` | "Show the evidence": pointer holding on Monday's first outreach block |
| `pointer-row-{dark,light}` | P on the needs-you row: pointer on HubSpot "Add key…" |
| `live/glass-*` | the s07 card live, dark and light, over our white and near-black windows |
| `live/review-confirm`, `live/review-skill`, `live/dashboard-pointer` | the real windows, real AppKit sheet, live flight |

## Rule by rule

1. **One accent, and it is white.** Each window has one solid white action: Approve (⌘↩), or Turn on (↩) in the
   confirmation. Iteration 1 caught two whites at once (Approve stayed bright behind the sheet); Approve now rests
   at 30% and is disabled while the confirmation is up. Saving is a green chip, not a banner.
2. **Colour means state.** Amber: the approval gate, needs-you rows, Ready for review, "Add key…", required
   permissions. Blue: the countdown and the pointer (Offload is acting). Green: connected, active, minutes saved.
   Diff marks are neutral ink, not a hue. Timeline task tints are desaturated pastels picked away from the four
   status hues, with a legend. Iteration 1 caught an amber "Microphone · Not allowed": the mic is optional, so it
   now reads grey "Off, optional"; amber is reserved for a required permission.
3. **Rings, not shadows.** Every box in the windows is a 1-px ring on the canvas; rows are separated by inset
   hairlines like a native grouped list. Only floating things (glass, sheets, the pointer label) carry shadows.
4. **Glass has three layers.** Unchanged recipe, now legible: see "Glass" below.
5. **Concentric radii.** Window boxes 12 → gate band and needs-you band 8 at a 4-pt inset → step icon tiles 7 →
   keys 5. Chips, buttons and the pointer label are pills.
6. **Two fonts, three weights, no bold.** Titles are 500 (the 26-pt workflow name, the 34-pt hero is the new `hero`
   token at 500 with −0.9 tracking). Hierarchy is ink opacity. Light mode's ladder moved from 86/56/46 to 86/72/63
   after the contrast measurements (below).
7. **Every action has a key.** Review: ⌘↩ approve, ↩ confirm, Esc, E edit, R run again, S SKILL.md, ⌘⌫ discard;
   all are shown as keycaps on their buttons. Dashboard: J/K, P, 2, ↩, ⌘D, with a hint line under the list. Typing
   in the tone card never triggers E or R (tested).
8. **Reversible by default.** Approve has two stops: the confirmation, then a 5-second countdown with Esc. A double
   ⌘↩ cannot approve (↩ is ignored for 0.5 s after the sheet opens). Discard also waits 5 s. The dry run's own gate
   log is shown: "6 sends and logs held by the gate".
9. **Ambient first, interrupt rarely.** Both windows open only on request (card choice, menu, ⌘D). The pointer is
   on demand and lives 3 s. The card now gets out of the way when the review window opens.
10. **Recommend, don't decide.** The confirmation states exactly what happens and what is not ready; nothing turns
    on until ↩ and the countdown both pass.
11. **Fast and decelerating.** Countdown and section changes use the out-expo tokens. The pointer follows the
    Clicky behaviour (smoothstep arc, 0.6 to 1.4 s, 1.3× mid-flight pulse); under Reduce Motion it fades in place
    (tested).
12. **Plain, short copy.** "Send 8 emails to these recipients." "Google Sheets is not connected. Log each send to the
    pipeline waits until you connect it." "Nothing was sent." "Not measured yet. That takes a full day on each side
    of turning it on." The sample drafts are 45 to 70 words, one ask, signed "Muhammad".

## Iterations (what the PNGs caught)
1. First render. Fixed: workflow name said twice (window title and H1; the window is now "Review workflow" with a
   subtitle); two white buttons behind the sheet; amber optional permission; light-mode status text at about
   2.2:1 (amber #E29A00 on its own tint fails AA; `statusInk` gives darker text inks, which also fixes s07's
   "Recommended" tag); the pointer landing on the row below a 14-pt timeline bar (Clicky's fixed 12-pt drop is now
   capped at half the target's height, tested); the pointer aiming at the HubSpot name instead of "Add key…".
2. Second render and live run. Fixed: card evidence subjects starved by a repeated "Chrome" column (the usual app is
   now said once in the header, rows name an app only when it differs); the SKILL.md sheet blank offscreen; the
   window subtitle missing live (SwiftUI scene bridging reset it; `sceneBridgingOptions = []`); the tone editor
   clipping its second paragraph; the card staying on top of the review window after "Build the workflow".

## Glass (s07 fix a), measured
Method: the app opens the card over a white or a near-black (#121214) window of its own, captures that rect, and a
small pixel probe reads WCAG contrast of the faintest text (the 11-pt tertiary arithmetic on the well) against
its own background. Three rounds:

| Round | Dark card over white | Dark over dark | Light card over white | Light over dark |
|---|---|---|---|---|
| s07 as shipped (veil fixed at 58%) | 2.88:1 (secondary 3.99) | not measured | not measured | not measured |
| solver with fitted dark constants, veil 0.88 | 4.71:1 | 5.77:1 | 4.15:1 | 3.73:1 |
| + light refit, light ink 63/72%, render loss folded in | 4.71:1 | 5.77:1 | 4.84:1 | 4.65:1 |

What changed: the material view uses the vibrant appearance of the card's own scheme, and the veil is solved by
`GlassVeil` (pure, tested) for the worst backdrop. The `.hudWindow` constants were guesses at first (30% pass);
fitted from the white and dark captures, the dark HUD passes about 73% of what is behind it and the light one 38%.
Thin dark-on-light text measured about 15% below its nominal contrast (anti-aliasing), so light mode solves for 5.3
nominal. The result: a dark veil of 0.88 and a light one of 0.51 (both 1.0 with Increase Contrast). Over a calm wallpaper the card now reads as graphite glass
with its blur only at the edges; that is the price of 4.5:1 over a white page without reading the screen.

## Known gaps
- The brain does not serve the tone card, last or next run times, or a "done by Offload" span flag. The app shows
  "the brain does not send it yet", "On schedule" and hatches time on an automated task after its activation.
- Tone and SKILL.md edits stay in the window: there is no write route in s05 yet.
- The live client is still `MockBrainClient`; the wire mirror for every s05 route is written and tested against
  fixtures shaped like `types.ts`, but no HTTP client calls the brain yet.
- The veil cannot adapt to what is actually behind the card (that would mean reading other apps' pixels). It adapts
  to appearance, Increase Contrast and Reduce Transparency only.
- Timeline task tints are a deliberate exception to rule 2 (categorical, not state); the legend carries meaning.

## Weakest spot
The glass is now legible but much less glassy: a 0.88 veil over the HUD material is close to an opaque graphite
panel, and the constants behind it come from two captures on one Mac, one wallpaper, one display. A different
display profile or a busy photo backdrop could shift them. The honest next step is a true vibrancy path (AppKit
text inside the effect view, so the system adapts per pixel) or a per-region veil only behind small text.
