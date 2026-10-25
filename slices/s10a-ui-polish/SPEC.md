# s10a UI polish (after DESIGN-REVIEW-1)

Owner: UI. Paths: `app/` and `slices/s10a-ui-polish/`. Depends on s09b brain additions (taskId on automations, `model`
label on dry runs, `GET /workflows/:id/dry-runs/latest`, `serve --model stub`). Done-signal: `verify.sh`.

## What changed

- **One source of truth for numbers.** `Core/Figures.swift` is the one formatter for savings, hours and counts. Hours
  use the brain's own rule (one fixed decimal), and a saving is read from the digits the brain printed in its
  arithmetic ("saves 22.0 h/wk"), so a chip can never disagree with the line under it. `Core/Copy.swift` holds the
  presenters (`CardCopy`, `EvidenceCopy`, `ReviewCopy`, `ConfirmCopy`, `DashboardCopy`). Every surface reads its
  strings from them. The card no longer computes its own "25 h of 38.5 h tracked" line; it shows the brain's share
  display and the brain's arithmetic as a receipt (label, formula, result, "a week" once). The saving range moved into
  the evidence. `SampleWeek` is one consistent fixture (21.9 h a week, 8 a batch, 7 of 7 days) for `--mock`,
  snapshots and the tests.
- **No invented numbers.** The dashboard hero shows a number only when the brain measured it. Nothing on: "Nothing
  saved yet" plus "<name> would save about 22.0 h a week once you turn it on". On but unmeasured: "Nothing measured
  yet" plus the estimate. No `f(x)` glyph.
- **Review layout.** One column, at most 720 pt, centred, 32 pt margins, window minimum 640. Chips sit in a
  `FlowLayout` that wraps and is never wider than its column. The schedule is its own wrapping line, built by
  `ScheduleCopy` ("Weekdays at 09:00, up to 8 emails a batch.", no ". ·"). The status is said once, in the body;
  the subtitle is "Drafted from your week". Approve stays in the bar, disabled while drafting or a sheet is up.
  Snapshots at 640, 900 and 1280.
- **Colour = state.** Timeline tasks are neutral ink steps (`Core/TimelineInk.swift`, darkest = most time), each at
  least 3:1 on its box in both modes (tested). Spans are merged (`TimelineMerge`: same task under 3 min apart joins;
  a span under 3 min joins its neighbour). The legend draws the very same `BarView` as the chart, hatch included.
  The axis spans whole two-hour steps and labels its last hour. Selection is `fillStrong` + `ringStrong`, never
  amber; needs-you rows keep amber only on the dot and chip. "To review" and "needs you" are one amber count. The
  approval step is a lock and plain text, no amber. The confirm sheet has no amber tile. The paused rail's mic is
  neutral (the snapshot fixture had the mic live).
- **Honest countdowns.** `CountdownMath`: the hairline is the label's whole seconds over the window ("4s" of 5 =
  80%), stepping once a second with a 200 ms ease. Same rule for undo, arming and discarding (tested). Undo copy
  says what lands and when: "Drafting the workflow in 4s"; 16 pt below it.
- **Turn on.** While a connector a step after your approval needs is missing, Turn on is a disabled secondary with
  the reason beside it ("Connect Google Sheets first. Turn on needs every step able to run.") and the primary is
  "Connect Google Sheets" (or "Add the HubSpot key"). ↩ and ⌘↩ do not arm (`ArmGuard`); they put the reason in the
  action bar. Turn on and Approve share ⌘↩.
- **Plain words.** `PlainWords.clean` rewrites the brain's internal words (`facts.md` → "your facts", `crm-log.csv`
  → "the log", `recipients.csv` → "your recipient list", column-name parentheticals removed, "Auto-run is off"
  dropped, "approval gate" → "approval step"/"You approve"). A test greps every presenter string, including the real
  brain's workflow fixture, for a banned list. The toolbar's Steps button and S open a rendered steps sheet;
  SKILL.md is behind "View source". "Your voice" replaces "tone card", and "click to edit" is gone.
- **Tokens everywhere.** Type ramp extended (largeTitle 26, sheetTitle 17, callout 12, calloutEmphasis 12,
  footnote 11, micro 10, key/keyWord, code); spacing grid gains 40 and 48 plus a 2-pt `nudge` for optical alignment
  only; size and radius tokens. `Surfaces/` has no `.font(.system(size:` and no `.padding(<number>)` (verify.sh
  greps). Dark secondary ink rose from 62% to 78% so card body copy reads as copy. Light fills are a faint grey well
  so rows separate from light glass.
- **Keycaps.** One `Keycap` everywhere, inside the white primary too, and ⌥ Space as two caps. See below.
- **Other per-screen fixes.** Evidence rows are two lines (who and when; subject and minutes), name the app a person
  knows ("Recent emails in Gmail"), and set other-app spans apart ("Also 1 in Numbers"). Onboarding: no "Required"
  on a skippable permission ("Needed for insights / Recommended / Optional"), minus glyphs instead of ×, window
  sized to each step, plain demo-week copy, "All set." alone. Dashboard: permissions and "Next deletion" share one
  label column with no glyphs; the pointer label is opaque and shorter. Dry run: only the draft side is marked
  (underline), with a caption; savings read "Saves 2.9 min"; header "nothing was sent"; sample drafts are labelled.
  Glass contact shadow is tight (8 pt, 4 down) instead of a wide blur. Rail hover label names the dots ("Watching ·
  Day 7 of 7 · 1 running · 2 need you").
- **s09b additions used.** Opening a review reads `GET /workflows/:id/dry-runs/latest` and only drafts when none is
  stored. A dry run with `model: "stub"` shows a "Sample drafts" chip and "Sample draft" columns. The demo week
  starts the brain with `serve --model stub` (`OFFLOAD_BRAIN_MODEL` overrides). Dashboard rows take the brain's
  `taskId`.
- **REVIEW-2 privacy (added mid-slice).** `~/Library/Logs/Offload/brain.err.log` rotates at 5 MB, keeping `.1` and
  `.2`, all 0600, checked at launch and every minute (`Core/LogRotation.swift`, tested). The app runs
  `bun run brain/src/cli.ts purge --home DIR` once at launch before serve, bounded at 10 s, but only when cli.ts has
  a `purge` command (it does now: s10b N4). Not yet exercised by a live e2e run; covered by a unit test of the
  detection and the arguments.

## Keycaps: the one order and set

J = next, K = previous, always shown **J K** (the order of the hint and the dashboard legend; vim reads down then
up, and there is no HIG rule that favours K J). The key with nowhere to go is dimmed, the way a disabled control is,
and has a tooltip. **Esc** undoes a pending choice; with nothing pending it closes (the card) or cancels (sheets).
**E** dismisses the insight on the card and opens Edit in the review window. The card header shows J K only; the hint
pill shows "1 2 3 choose · E dismiss · esc close"; the empty card shows "Close esc". Approve and Turn on are ⌘↩.

## Where I disagree with DESIGN-REVIEW-1

- **"Connect…" is not truncation.** The ellipsis is the HIG mark for a control that opens more UI (it opens the
  connect instructions). Kept; the s08 tests pin it too.
- **Sheets that "hang from the title bar".** Since macOS 11 `beginSheet` presents a rounded panel just below the
  toolbar; the live behaviour was already native. The snapshots now draw that modern sheet instead of the old drawer.
- **Dashboard sidebar.** Four sections of one week's status are an overview, not navigation. A sidebar would add a
  selection state and hide three of four sections. Kept one centred column, with every section title outside its box.
- **Two identical blue rail dots.** The dot list is pinned by the s07 contract (one per active automation). Instead
  of removing dots, the hover label now names them.
- **Dimming K at the first insight.** Kept: it is the disabled state, not decoration, and it has a tooltip.
- **Minimum drawn length of 10 min.** Merging at 3 min (as the brief says) already turns the live barcode into
  blocks; hiding 3 to 10 min spans would delete real evidence.
- **Live "1 of last week's emails · ran 00:09".** That is `OFFLOAD_DRYRUN_LIMIT=1` in the e2e (one model call), not
  a UI defect.
