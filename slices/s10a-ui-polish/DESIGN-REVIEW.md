# s10a self-review against DESIGN-REVIEW-1's rubric

Scale (same as DESIGN-REVIEW-1): 5 = could ship in a first-party Apple app; 4 = native with small slips; 3 = right
idea, visibly assembled; 2 = web dashboard or broken in places. Looked at every PNG in `app/snapshots/` (56, dark and
light, rendered 2x first and iterated, then committed at 1x) and the live captures from one stub-model e2e run
(`E2E=1 slices/s09a-wiring/verify.sh`, PASS, 2026-10-25). Three render-and-look rounds; what each round fixed is
listed under the screen.

| Screen | Was | Now | Evidence | What is left |
|---|---|---|---|---|
| Rail | 3 | 4.5 | `rail-*`, `scene-*`, `live/e2e-rail.png` | Two blue dots (observer + a running automation) still look alike at rest; the hover label now names them. |
| Insight card | 3 | 4.5 | `card-*`, `live/e2e-card.png` | Title still wraps to two lines at 400 pt. The live capture predates round 3 (receipt column not yet full width); the snapshot shows the fix. |
| Evidence | 3 | 4.5 | `card-evidence-*` | Two-line rows trade density for an unclipped subject. |
| Undo | 3 | 5 | `card-undo-*` | "4s" and an 80% bar, exactly; 16 pt below. |
| Empty | 4 | 4.5 | `card-empty-*` | The mark is still generic. |
| Onboarding | 3 | 4.5 | `onboarding-*` | Window resizes per step (animated); fine, but a fixed height would be calmer for some. |
| Review | 2 | 4.5 | `review-640/900/1280-*`, `review-*`, `live/e2e-review-drafting.png` | No clipping at 640; long schedule wraps. Live tone box is empty (no voice notes in the demo home) and shows a tall blank editor. |
| Dry run | 3 | 4.5 | `review-dryrun-*`, `review-dryrun-sample-*`, `live/e2e-review-dryrun.png` | Underlines on short stub drafts mark most words (expected for sample drafts). |
| Confirm | 3 | 4.5 | `review-confirm-*`, `review-confirm-ready-*`, `review-armed-*`, `live/e2e-review-confirm.png`, `live/e2e-review-approved.png` | Blocked reason is said twice (the amber blocker lines and the line above the buttons). |
| Dashboard | 2 | 4.5 | `dashboard-*`, `dashboard-before-*`, `live/e2e-dashboard.png` | "Nothing saved yet" live; one column kept on purpose (SPEC). |
| Timeline | 2 | 4.5 | `timeline-*`, live dashboard | Light mode: "CRM updates" and "Everything else" are close greys (both >= 3:1, labelled). |
| Pointer | 3 | 4.5 | `pointer-*`, `pointer-row-*` | Label still covers part of the next row for its 3 s, now opaque and shorter. |
| **Average** | **2.8** | **4.54** | | |

Weakest screens: the rail (identical-looking blue dots at rest, constrained by the s07 contract) and the timeline in
light mode (four grey steps are distinguishable but close).

## The ten fixes

1. Review overflow: fixed (FlowLayout, own schedule line, 720 column, min 640, renders at 640/900/1280; live clean).
2. One source of truth: Figures + presenters + `S10A one source of truth` suite (card, review, confirm and dashboard
   from one fixture; live brain fixtures print 22.0 on card and dashboard).
3. Hero: measured only; "Nothing saved yet" / "Nothing measured yet" with the estimate as secondary (live shows it).
4. Timeline: neutral ink steps, >= 3:1 tested, merged spans, legend uses the chart's BarView, axis labels its end.
5. Amber: selection neutral, gate neutral, counts merged, confirm tile removed.
6. Countdowns: hairline = shown seconds / window, tested.
7. Turn on: disabled with reason, Connect is the primary, keys guarded; live e2e shows the blocked sheet.
8. Internals: PlainWords over every brain string, tested on the real fixture; Steps view with View source.
9. Tokens: ramp, grid, sizes, radii; Surfaces grep in verify.sh is clean.
10. Keycaps: one component, J K order, Esc/E roles documented in SPEC; paused mic neutral.
