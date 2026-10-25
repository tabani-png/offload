# DESIGN-REVIEW-3: independent design critique, round 3

Reviewer: EvidenceQA (independent, no code edits). Date: 2026-10-25.
I scored this round before opening DESIGN-REVIEW-1 or -2. I opened -2 only afterwards, for section 4.

Evidence read: every PNG in `app/snapshots/` (dark and light) and in `app/snapshots/live/`, including the dashboard
captures retaken at 07:41-07:43. References: `13-design-getone.md`, `14-video-one-teardown.md`, `11-rea-clicky.md`,
`12-rea-cua.md` and `assets/getone/01-hero.png` and `04-how-it-works.png`. I spot-read the source in
`Sources/Core/Tokens.swift`, `Design/Glass.swift`, `Surfaces/DashboardView.swift` and `App/OffloadApp.swift`.

Bar applied: dark hero; white is the only accent; color only means state; rings, not shadows; radii 24/16/12;
out-expo easing at 150-300 ms; keyboard first. On top of that bar, the screen has to tell the demo story
(65% of the week, connect, tone, dry run, approval, hours saved) without a narrator.

---

## 1. Per-screen scores

| # | Screen | Score | Justifying PNG(s) |
|---|---|---|---|
| 1 | Rail | 3.5 | `snapshots/rail-dark.png`, `snapshots/live/e2e-rail.png` |
| 2 | Suggestion card | 4.0 | `snapshots/card-dark.png`, `snapshots/live/e2e-card.png`, `snapshots/card-undo-dark.png` |
| 3 | Evidence / maths | 3.5 | `snapshots/card-evidence-dark.png`, `snapshots/live/dashboard-week.png` |
| 4 | Connect (Gmail MCP / Composio) | 1.5 | `snapshots/live/e2e-review-approved.png`, `snapshots/live/e2e-card.png` |
| 5 | Tone ("Your voice") | 2.5 | `snapshots/review-dark.png` vs `snapshots/live/e2e-review-drafting.png` |
| 6 | Dry run | 3.0 | `snapshots/review-dryrun-dark.png` (about 4) vs `snapshots/live/e2e-review-dryrun.png` (about 2) |
| 7 | Approval (confirm, arm, undo) | 4.0 | `snapshots/review-confirm-dark.png`, `snapshots/review-confirm-ready-dark.png`, `snapshots/review-armed-dark.png`, `snapshots/live/review-confirm.png` |
| 8a | Dashboard, light | 3.5 | `snapshots/dashboard-light.png`, `snapshots/live/dashboard-light.png` |
| 8b | Dashboard, dark | 3.0 | `snapshots/dashboard-automations-dark.png`, `snapshots/live/dashboard-automations.png`, `snapshots/live/dashboard-autosend.png` |
| 9 | Timeline ("This week") | 3.0 | `snapshots/timeline-light.png`, `snapshots/live/dashboard-week.png`, `snapshots/live/dashboard-evidence-pointer.png` |
| 10 | Onboarding / permissions | 3.5 | `snapshots/onboarding-permissions-dark.png`, `snapshots/live/onboarding-permissions-live.png`, `snapshots/live/dashboard-observing.png` |
| 11 | Empty states | 2.5 | `snapshots/card-empty-dark.png` (about 3.5) vs `snapshots/live/dashboard-automations.png` (1) |

**Overall: 3.2 / 5.** The rendered snapshots on their own would earn about 3.7. The live captures pull the score
down. The connect step is a dead end, live tone is empty, live sample drafts are much worse than what the user
really sent, the live Automations tab is a blank table, and one live dashboard capture shows a blank overlay. The
build is not at the 4.5 bar. It is a good static design system with broken or missing live states at the exact
moments the demo depends on.

### What is genuinely good (so it is not regressed)
- The card's receipt maths ties: 495 x 3.0 min = 24.75 h, shown as 24.8; 495 x 20 s = 2.75 h, shown as 2.8; saved
  22.0 h, which is 88.9%, shown as 89%. The snapshot set also ties (24.6 - 2.7 = 21.9). Per-email dry-run savings tie
  too (3.2 min - 20 s = 2.87, shown as 2.9).
- Concentric radii are real: `Tokens.Radius` card 24, well 16, row 12, and the well is inset 8 in `card-dark.png`.
  Easing is the `outExpo` timing curve at 100/150/200/300 ms (`Tokens.Duration`).
- The undo and arm countdowns (`card-undo-dark.png`, `review-armed-dark.png`) do exactly what getone does: blue
  "working" bar, "Undo esc", and the other rows muted.
- The confirm sheet lists all 8 named recipients and the sending address before anything runs. When Sheets is not
  connected, "Turn on" is disabled and "Connect Google Sheets ⌘↩" is the single white primary
  (`review-confirm-dark.png`). This is the best screen in the app.
- Keycaps are visible on nearly every action.

---

## 2. Findings ranked by impact

### MUST-FIX (each one blocks a 4.5)

**M1. Connect is a dead end, and it opens a modal on top of a modal.**
`live/e2e-review-approved.png`: pressing "Connect Gmail ⌘↩" in the confirm sheet opens an `NSAlert` stacked on the
sheet. It says "Connecting accounts from inside Offload is not ready yet: whoever set up Offload here can connect
Gmail" (`App/OffloadApp.swift:466`). The sheet text bleeds around the alert, and the alert has 8 lines of body with
a single OK. Nowhere in the app is there a Connect screen, a Gmail MCP or Composio mention, an OAuth handoff, or a
"connected" success state. The demo's step 3 ("suggests connecting tools") is therefore not designed.
Fix: build a real Connect sheet, opened from every "Connect…" chip and from the blocked primary. Show the tool icon,
one line on what Offload will read or send, "Connects through Composio" (or "Gmail MCP") as tertiary text, and a
white "Connect Gmail ⌘↩" that opens the browser handoff. Then show a waiting state with a blue spinner and the line
"Finish in your browser", and a green "Gmail connected" row that returns focus to the confirm sheet with "Turn on"
enabled. Never stack an `NSAlert` over the custom sheet.

**M2. The live dry run argues against the product.**
`live/e2e-review-dryrun.png`: the left column reads "I think it fits Bessemer Venture Partners. / Open to a short
call next week?". The right column is a 9-line real email with traction, a portfolio hook and a signature. Almost
every word on the left is underlined. The "Sample drafts" chip is honest, but an investor sees a tool that writes
worse than the user. The underline also reads as hyperlinks (snapshot `review-dryrun-dark.png`: "March.", "watches",
"Worth", "next").
Fix: (a) Make the offline sample model produce drafts shaped like the snapshot drafts (same structure, facts and
signature), or do not show a side-by-side until a real model has drafted. Show "Draft with your voice ⌘↩" instead.
(b) Replace the underline with a tinted highlight (white at 12% on dark, black at 8% on light) on changed phrases
only, and add a per-card "Same / Changed n phrases" tag.

**M3. Tone is not built in the live flow.**
`review-dark.png` shows "Measured from 40 sent emails: 45 to 80 words, 3 or 4 short paragraphs…", which is the
right idea. `live/e2e-review-drafting.png` shows an empty editor with the placeholder "Write a few lines on how
you sound." The product promise ("builds a workflow in the user's tone") is invisible live. Even in the snapshot,
tone is a grey prose block with no evidence.
Fix: render "Your voice" as a small fact sheet and not as free text. Use 3 or 4 measured rows (length, greeting,
sign-off, ask style), each with a tertiary "from 40 sent emails" source, one quoted line from a real sent email, and
an "Edit" link that reveals the text box. In live, if the voice has not been measured, show "Measuring your voice
from 40 sent emails…" with a blue spinner, not an empty box.

**M4. The live Automations tab is a blank table, with no empty state.**
`live/dashboard-automations.png`: a column header (Last run / Next run / Saved a week) over zero rows, followed by
"J K select · P point to what needs you · ↩ open", where there is nothing to select or point at. The sidebar
Automations badge is missing in the same capture, while `live/dashboard-light.png` shows "2". Cause:
`DashboardView.swift:288-310` (`AutomationsSection`) never checks `autos.isEmpty`. The "No automations yet."
`EmptyState` at `:121` only fires when the whole dashboard has no data.
Fix: in `AutomationsSection`, when `autos.isEmpty`, render `EmptyState(title: "No automations yet.", message: "Approve
a workflow from the inbox and it shows up here with the hours it saves.")` with a single white "Open the inbox ⌥Space"
button. Hide the column header and the J/K/P hint row.

**M5. A blank overlay in the live auto-send flow.**
`live/dashboard-autosend.png`: the whole window is dimmed and a label-less grey pill (about 930 x 95 pt at 2x) sits
over the Investor outreach row. It hides "Asks you before each batch · Send without asking…". The snapshot of the
same moment (`dashboard-autosend-dark.png`) is a proper "Send without asking?" dialog. Either the capture caught a
sheet mid-transition, or the sheet rendered with no content. Both are a defect for a demo capture.
Fix: reproduce the bug. If it is an animation frame, make the sheet's insertion transition opacity plus a 7-pt offset
(out-expo, 200 ms) so no frame shows an empty container, and re-capture. If the content is empty, the `autoSend: .offer`
state is not reaching the live sheet. Wire it the same way `Snapshotter.swift:222` does.

**M6. The timeline does not prove the headline, and two datasets are in circulation.**
`live/dashboard-week.png` says "38.1 h tracked". Its white "Outreach emails, by hand" bars, measured off the axis,
are about 6 h a day on 5 weekdays, so about 30 h, or about 80% of the week. The card says 65%. The same capture has
no "Offload ran it" legend, so the overview's "16.8 h a week, measured" (`live/dashboard-light.png`) has no visual
support. Two minutes earlier, `live/dashboard-evidence-pointer.png` showed a different week (Sat 17 to Fri 23,
"Investor outreach", green automation blocks). The snapshot fixture also contradicts itself: the card is still an
un-built insight (`card-dark.png`), while the timeline shows Offload already running it from Wed to Fri
(`timeline-light.png`).
Fix: drive the card, the timeline and the overview from one dataset per capture run. Add a test that sums the
by-hand bars and asserts it matches the card's percentage of `trackedHours` within ±2 points. Put the share on the
chart itself: a right-aligned "Outreach 24.8 h · 65%" total in the header row.

**M7. Status colors disagree across surfaces.**
The same automation, "Investor outreach emails", is a blue dot labelled "running" on the rail (`rail-dark.png`
hover pill). It is green in the dashboard (`dashboard-automations-dark.png`, `live/dashboard-pointer.png`) and green
"1 active" in the overview. Rule 2 says one meaning per color everywhere. The live rail (`live/e2e-rail.png`) shows
badge "6" over one amber dot with a ▶ (paused) control, while the snapshot's paused state (`rail-dark.png`, column 3)
uses a grey dot. That gives two different encodings for paused.
Fix: pick one mapping and apply it in `InboxState` and the dashboard row dot alike. Use blue for working now (the
observer is watching, or a run is in progress), green for on and healthy, amber for needs you, and grey for paused.
Paused must always be grey, with the ▶ control. Make the inbox badge amber when anything needs you (getone: "yellow
badge when something waits"), not white.

**M8. Primary-action discipline breaks on two key screens.**
- `onboarding-permissions-dark.png` and `live/onboarding-permissions-live.png`: Screen Recording is labelled
  "Needed for insights" and is not granted, yet the single white primary is "Continue for now". The primary should be
  the thing that unblocks the product. Fix: while Screen Recording is missing, make its row's "Open Settings" the
  white primary with ↩, and demote "Continue for now" to secondary. Also fix the grammar: "Without Screen Recording
  and Accessibility, Offload sees less until you turn it on" should end "…until you turn them on".
- `review-dark.png`, `review-640-dark.png` and `review-real-schedule-dark.png`: "Approve ⌘↩" is the white primary
  while steps 1 and 7 read "Google Sheets, not connected" in amber. The user only learns about the block in the next
  sheet. Fix: when any step is blocked, the footer primary becomes "Connect Google Sheets ⌘↩" (the same as the
  sheet), and Approve becomes secondary.
- Dashboards (`dashboard-dark.png`, `live/dashboard-observing.png`) have no white primary at all. The observing tab
  has four identical grey "Open Settings" buttons. Fix: the first blocking item in "Needs you" (or the first missing
  required permission) gets the white button. Everything else stays secondary.

### POLISH (does not block 4.5 alone, but costs about 0.1 to 0.2 each)

**P1. Truncated sentences in live.** `live/dashboard-observing.png`: "…auto-run only sends to rows pinned when
you…" and "…Kept until you d…". `live/onboarding-permissions-live.png`: "to tell one email fro…".
`review-skill-dark.png`: "What it does" is a one-line field ending "the…". Fix: use `.lineLimit(2)` with
`.fixedSize(horizontal: false, vertical: true)` on secondary lines, and use a 2-3 line `TextEditor` for "What it
does". Shorten the kept-files copy to under 60 characters ("Who auto-send may write to. Yours to edit.").

**P2. Evidence rows all say "3 min".** `card-evidence-dark.png`: all five emails list exactly "3 min", which is the
model's average and not a measurement, so the list reads as fabricated. "Also 1 in Numbers, part of the same task"
is unclear. Fix: show the measured time per email (2 min 40 s, 3 min 50 s and so on). If none was measured, drop the
column and say "about 3 min each" once in the header. Reword the footer to "Plus 1 session in Numbers that was part
of this task".

**P3. White used as a data color.** `timeline-dark.png` and `live/dashboard-week.png` use solid white for the "by
hand" bars, and the card's share bar is white (`card-dark.png` y≈158). Rule 1 reserves white for the single primary
button, so here the chart outshouts the button. The "Offload ran it" hatch is still 8-10 pt and reads as noise.
Fix: draw the focus task at ink 85% with a 1-px ring, and draw the automated span as a full-height block with a
1.5-px green ring and a 15% green fill, at least 16 pt wide.

**P4. Light mode loses hierarchy.** In `card-light.png` the option rows (grey on grey glass) are barely separate
from the card. The "Recommended" chip is brown on beige. In `live/glass-light-over-dark.png` the whole card is one
mid-grey. Fix: give rows a white 70% fill with a black 6% ring in light, and darken the Recommended ink to about
#6E4500 so it reaches at least 4.5:1.

**P5. Shadows on floating surfaces are wide in the live captures.** `live/e2e-card.png`, `live/e2e-rail.png` and
`live/glass-dark-over-white.png` show a soft halo about 30-40 pt wide. `Glass.swift:93` draws radius 8 at y 4, and
`Panels.swift:20` turns off the window shadow. So either the capture tool (`screencapture -w`) adds the OS window
shadow, or the panel used for the capture is a different class. Fix: capture with `-o` (no shadow) to judge the
product, and confirm every floating panel class sets `hasShadow = false`.

**P6. The keyboard map conflicts with the spec.** In `review-dark.png`, "E" means Edit. The spec and getone use E to
clear or discard a card, and this app uses ⌘⌫ for Discard. The insight card's hint pill (`card-dark.png`) teaches
"1 2 3 choose · esc close" but not J/K or E. Fix: keep E for discard everywhere (card and review), move Edit to ⌘E,
and add "J K move" to the card's hint pill when there is more than one card.

**P7. Live edit-sheet artifacts.** In `live/review-skill.png` the "What it does" field shows an uneven grey band
behind the first line (a stray selection highlight), and "Save ⌘↩" is grey, while the snapshot
(`review-skill-dark.png`) has a white Save. The scroll area also clips a field mid-height with no fade. Fix: clear
the selection on appear, make Save the primary once any field is dirty, and add an 8-pt bottom fade mask.

**P8. The sheets are not native sheets.** `review-confirm-dark.png`, `review-skill-dark.png` and
`dashboard-autosend-dark.png` are centered floating panels about 120-200 pt below the title bar. In
`live/review-confirm.png` the background "Ready for review / Investor outreach emails" is still fully readable at
about 40%. Fix: attach them under the title bar (`.sheet`) or dim the background to about 25%.

**P9. The pointer label still overlaps a row.** In `live/dashboard-evidence-pointer.png` and `pointer-dark.png`, the
"Mon 08:00 · 4 h of investor outreach, by hand" pill sits on the Sun 18 row line, and the pointer is below it on
Mon. Fix: anchor the label to the right of the bar end on the same row, or above the plot.

**P10. Empty-state glyph and copy.** `card-empty-dark.png` and `components-dark.png`: the mark (a pill over a U) does
not read as an inbox or as a mascot at 32 pt. "Watching · Day 7 of 7" on an empty inbox implies the learning week is
over with nothing found. Fix: use the SF Symbol `tray` (or a finished mascot), and when day 7 has passed with no
insight, say "Week 1 done. Nothing repeated enough yet. Still watching."

**P11. Never-run automations claim savings.** `dashboard-automations-dark.png`: Scheduling replies shows Last run
"Never", yet "Saved a week 4.6 h estimated". Fix: label that column "Could save" for rows that have not run, or use
"-" with a tertiary "est. 4.6 h".

**P12. "Send without asking…" is a web link.** `dashboard-automations-dark.png` and `live/dashboard-pointer.png`
style it as an underlined text link inside a table row. Fix: make it a small bordered `Toggle` or a ghost button
with the same label.

---

## 3. Top 5 MUST-FIX, in order

1. **M1 Connect flow:** a real Connect sheet with browser handoff and a connected state. No `NSAlert` over the sheet.
2. **M2 + M3 Live dry run and tone:** live drafts that match the snapshot quality, a measured voice fact sheet, and
   highlight-diff instead of underlines.
3. **M4 + M5 Live dashboard holes:** an Automations empty state (`DashboardView.swift:288`) and the blank overlay in
   `live/dashboard-autosend.png`.
4. **M6 Timeline proves the 65%:** one dataset per run, a sum test, and the share on the chart.
5. **M7 + M8 Color and primary discipline:** one status mapping (blue/green/amber/grey) and an amber badge. The
   primary is always the unblocking action (permissions, blocked Approve, dashboard needs-you).

---

## 4. Old findings (DESIGN-REVIEW-2) still open

I skimmed this section after scoring. Status is judged only from the current PNGs.

| R2 finding | Status | Evidence |
|---|---|---|
| E1. Confirm should be a real attached sheet with dimming | **Open (partial).** The blocker is now stated once, the disabled Approve keeps its label, and the blocked primary has ⌘↩. Placement is still a centered floating panel. | `review-confirm-dark.png`, `live/review-confirm.png` |
| E2. Demo-week identity and data trace | Identity **fixed** (live "What you sent" is signed Muhammad). Data trace **still open**: live week bars imply about 80%, not 65%, and the fixture card and timeline disagree on whether the automation is on. | `live/e2e-review-dryrun.png`, `live/dashboard-week.png`, `timeline-light.png` |
| E3. Pointer label collision | **Open (partial).** The row case is fixed (`pointer-row-light.png`). The timeline label still sits on the Sun 18 row. | `live/dashboard-evidence-pointer.png` |
| E4. Timeline legibility | Category greys **fixed** (3 classes) and the "now" marker is **fixed**. The tiny hatch is **still open**, and white as the data color is new. | `timeline-dark.png` |
| E5. Live dry run on real examples, flags, diff | The 3 examples and the "March" flag are **fixed**. The diff underlining is **still open**. The live sample drafts' quality is a **new, worse problem**. | `review-dryrun-dark.png`, `live/e2e-review-dryrun.png` |
| E6. Dashboard state copy ("Pause watching" when not recording, footnote, "Add key") | **Fixed.** It is now "Open Settings", the footnote is hidden before anything is measured, and the copy says "Sign in…". | `live/e2e-dashboard.png`, `dashboard-before-dark.png` |
| E7. Card headline rounding, orphan, light Recommended contrast, one dismiss verb | Rounding, orphan and dismiss verb are **fixed**. Light Recommended contrast is **still open**. | `card-light.png` |
| E8. Rail identity, step-5 lock, literals, stale live PNGs | Rail observer ring vs solid dot and the lock position are **fixed**. Rail "6" badge vs one amber dot is **still open** (`live/e2e-rail.png`). The live PNGs are refreshed, but `e2e-*` (02:34) predates the 07:41 dashboard set and shows a different data state. | `rail-dark.png`, `live/e2e-rail.png` |
| R/E bare shortcuts firing while typing in "Your voice" | **Unverified.** No capture shows this guarded. | n/a |
| Dashboard single 720 column | **Fixed** (sidebar layout). | `dashboard-dark.png` |

Re-test required after fixes: YES. Re-capture the whole `live/` set in one run, from one dataset, with
`screencapture -o`.
