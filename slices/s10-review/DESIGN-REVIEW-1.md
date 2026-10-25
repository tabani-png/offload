# DESIGN-REVIEW-1: independent Apple-native design critique (s10)

Reviewer: independent design critic (Apple HIG lens), 2026-10-25. Read-only. I did not build this.
Brief read: `packet/PACKET.md` (must-be-true 6: "calm, keyboard-first, edge rail + cards"),
`adam/memory/research/13-design-getone.md` (12 feel rules), `14-video-one-teardown.md`, reference PNGs in
`adam/memory/research/assets/getone/` (01..05).
Looked at every PNG in `app/snapshots/` (42) and `app/snapshots/live/` (15). Read `app/Sources/Design/*` and
`app/Sources/Core/Tokens.swift`, and grepped `app/Sources/Surfaces` for hard-coded type, radii and padding.

Scale: 5 = could ship in a first-party Apple app; 4 = native with small slips; 3 = right idea, visibly
assembled; 2 = reads as a web dashboard or is broken in places; 1 = wrong.
Locations are approximate, in PNG pixel coordinates or by region.

---

## Token check (app/Sources/Design, Core/Tokens.swift)

- **Ink ladder disagrees with its own comment.** `Tokens.Ink` says "100 / 90 / 60 / 40" but ships
  `secondary 0.62, tertiary 0.50`, and `Palette.ink1` is `0.96`, not `primary 1.0`. There is no 90% step.
  The result: body copy inside cards sits at 62% where the reference uses 85-90%. Card descriptions read greyer
  than getone (compare `card-dark.png` subtitle with `03-hero-scroll-demo.png` question text).
- **Type tokens are bypassed.** `Surfaces/` has about 80 `.font(.system(size:))` calls (40 at 12, 13 at 13,
  9 at 11, plus 12.5, 14, 17, 22 and 26) against a TypeScale of 34/20/15/13/11/10. The review title is 26/500
  (`ReviewView.swift:67`), the confirm title 17 (`:407`), and body notes 12.5 (`:313, :423, :448, :454`). None
  of these sizes exist in the scale.
- **Spacing tokens are unused.** `Tokens.Space` is referenced 0 times in `Surfaces/`. Paddings include 3, 5, 7,
  11, 14, 18, 50 and 54, which are off the 4-pt grid.
- **Radii are mostly concentric, with a gap.** Card 24, well 16 at an 8 inset and rows 12 are correct when rows
  sit 12 in. But option rows sit about 11 in while the well sits 8 in (`card-dark.png`, x=37 vs x=40), so two
  left edges sit 3 px apart. The rail uses 14, the pointer label 13, the hint pill 15, and the timeline bars 3.
  None of those comes from a token.
- **Task tints break rule 2.** `WindowKit.swift:18` adds lavender, sea glass and rose "from the feature-title
  family". Rule 2 allows pastels on feature titles only, never on data. See Timeline.
- **Glass is well built.** It has three layers (material plus veil, edge ring, top specular), a solved veil
  opacity, and handles Increase Contrast and Reduce Transparency. This is the strongest part of the system.

---

## 1. Rail: 3/5
Evidence: `rail-dark.png`, `rail-light.png`, `scene-*.png`, `live/e2e-rail.png`, `live/glass-*.png`.
- `rail-dark.png`, paused variant (right column): the mic is **red** while watching is paused. Red means
  "recording", so a paused state shows the one colour that says "live". Use neutral ink for the mic when it is
  idle.
- `rail-*.png`, the dots capsule shows blue, blue and amber with no legend and no hover label in the capture.
  Two identical blue dots read as duplicates. getone shows one dot per agent with a known identity; ours has no
  identity, so the second blue dot is noise.
- `live/e2e-rail.png`: over a white desktop the capsules are near-opaque black with a wide, soft grey shadow of
  about 20 pt of blur. That is a CSS `box-shadow`, not the tight negative-spread contact shadow in rule 3. On a
  real desktop it reads as a web widget, not a HUD.
- `rail-*.png`: the "Watching · Day 4 of 7" tooltip pill floats about 40 px from the capsule with no anchor or
  arrow, and is vertically centred on nothing in particular.
- `live/glass-*.png`: the inbox badge "3" and the capsule edges are clipped at the right edge of the capture
  (x≈515). This is either a window-frame bug or a capture bug. Check the live rail panel bounds.
- Inbox badge digits are dark on amber. That is correct and legible.

## 2. Insight card: 3/5
Evidence: `card-dark.png`, `card-light.png`, `scene-*.png`, `live/e2e-card.png`, `live/glass-*.png`.
- **The numbers disagree with themselves.** In `card-dark.png` the chip says "Saves 20–24 h a week" and the
  arithmetic directly under it says "saves 22.5 h/wk (90%)". In `live/e2e-card.png` the subtitle says "24.7 h"
  while the arithmetic says "= 24.8 h/wk", and the chip says "18.6–22.7" while the arithmetic says "22.0". A
  user sees three different savings figures in one card.
- The arithmetic block (`card-dark.png`, y≈225-260) is three lines of `→`-prefixed formula in 11-pt tertiary
  ("100/day × 5 days × 3.0 min = 25.0 h/wk"). It reads like a debug print. Units also mix: "h a week",
  "h/wk" and "h of 38.5 h".
- The "↘" glyph in the green Saves chip reads as "decline". A saving shown with a down arrow in green sends
  two signals at once.
- `card-dark.png`, header right: the keycaps read **K J esc**. The order is backwards (J/K everywhere else),
  and `K` is dimmed as if disabled with no explanation. The header says `esc` but the hint pill says "E
  dismiss", so two keys are offered for the same thing.
- "Uses ● Gmail | Connect…" (y≈288): the action label is truncated with an ellipsis even though there is room.
  A truncated control label never appears in first-party UI.
- The title "You spent 65% of your week on investor outreach emails." is 20/500, but the period plus the
  two-line wrap make it read as a sentence of body copy. getone titles are short and have no period.
- Light (`card-light.png`): option rows (white at 55%) on light glass separate from the card by about 1.1:1.
  The rows are only visible through their ring. Dark parity is fine.
- Good: one white primary feel, numbered rows, a quiet Recommended tag and the detached hint pill. This is
  close to the getone question card.

## 3. Evidence (expanded card): 3/5
Evidence: `card-evidence-dark.png`, `card-evidence-light.png`.
- The sender column is not a column. Subjects start at x≈217, 225, 212, 308 and 225, set by the width of each
  sender name. Use a fixed sender width or a real grid so subjects align.
- Row 4 is "Investor pipeline.numbers / Numbers", which is an app and a file, not an email. It still sits under
  the header "6 of 500 emails", so the evidence contradicts its own label.
- The header says "Evidence · Chrome" while the card says it uses Gmail. Name the thing the user recognises
  (Gmail in Chrome), or drop the browser name.
- Subjects are cut mid-word ("Intro: Offload seed rou…", "Deck and data room ac…") while "3 min" holds a
  wide right column. Give the subject the slack and keep the time narrow.
- Light parity is good.

## 4. Undo (staged choice): 3/5
Evidence: `card-undo-dark.png`, `card-undo-light.png`.
- **The countdown bar does not match its label.** The label says "4s" of a 5 s window (`Tokens.undoSeconds`),
  but the bar is about 68% full (x 48→293 of 48→408). Remaining time should show 80%, elapsed time 20%. The
  same bug appears in `review-armed-*.png` ("Turning on in 4s", bar about 68%).
- "Drafting the workflow" is in the present tense during the undo window, which suggests it has already
  started. Say "Drafting in 4 s" or "Building the workflow…" only after the window closes.
- The undo row sits 6-8 px above the card's bottom edge, with the bar almost on the edge, while every other
  block has 12 px or more. The bottom padding looks cut off.
- Good: the chosen row turns blue with a check, and the other rows mute. The state is clear.

## 5. Empty state: 4/5
Evidence: `card-empty-dark.png`, `card-empty-light.png`.
- The best screen. The copy is short and dry ("Nothing to decide."), it uses one status line, and light and
  dark match.
- An `esc` keycap sits at top right with nothing to escape to besides closing. Where every other card shows
  K/J/esc, the empty card shows only esc, which is fine, but it is the only control and it carries no label.
- The mark (a tray with a block) is generic at 44 pt and does no work. It is not a defect, but it is not
  "personality" either (`14-video-one-teardown.md` asks for a calm state with personality).
- "Offload speaks up when a task starts to repeat." is good copy.

## 6. Onboarding: 3/5
Evidence: `onboarding-{watches,permissions,comeback}-{dark,light}.png`, `live/onboarding-permissions-live.png`.
- `onboarding-permissions-*.png`: Accessibility is labelled **Required**, yet the primary says "Continue for
  now" and the footnote says "Without Accessibility, Offload sees less. You can turn it on later". Either it is
  required or it is not. Label it "Recommended", or block Continue.
- `onboarding-comeback-*.png`: the `⌥Space` keycap is a wide dark rectangle with a different radius, padding
  and size from every other Keycap. It is the one shortcut taught in onboarding, and it looks like a different
  component.
- `onboarding-watches-*.png`: the "What it never keeps" items use `xmark` glyphs. On macOS an × reads as a
  close or remove control. Use `minus.circle` or `nosign`, or plain bullets.
- All three pages leave 80-120 px of dead space above the footer while the content column is top-heavy. Centre
  the content block vertically, or shrink the window to fit (System Settings panes size to content).
- `onboarding-comeback-*.png`: "Use demo week loads a sample founder's week…" starts the sentence with the
  button's name. Write "Loads a sample week (100 outreach emails a day) into a separate folder…".
- `live/onboarding-permissions-live.png`: "All set. Offload ticks these off as soon as macOS turns them on."
  is redundant once every tick is green. "All set." alone is enough.
- Good: the left-aligned title bar text, "1 of 3" with the mark, and the green filled checks match System
  Settings.

## 7. Review window: 2/5 (3 in snapshots; the live build is broken)
Evidence: `review-{dark,light}.png`, `review-real-schedule-*.png`, `review-skill-*.png`,
`live/e2e-review-drafting.png`, `live/e2e-review-approved.png`, `live/review-skill.png`, `live/review-confirm.png`.
- **CRITICAL, live layout overflow.** In `live/e2e-review-drafting.png`, `e2e-review-dryrun.png` and
  `e2e-review-approved.png` the whole content column is shifted left and clipped. The title reads "utreach
  emails" and every step title is cut ("the investor list", "eview the batch"). The header chip row runs off the
  right edge ("↘ Sa"). The long schedule sentence was put in a chip ("Weekdays at 09:00 a new batch is drafted
  and waits for your review. · 20 a batch"), and that one chip is wider than the window.
- `live/review-confirm.png`, header: the "Google Sheets Connect…" chip overlaps the schedule chip at y≈183.
  This is the same overflow at a smaller width.
- Step icons do not mean anything. Steps 1, 2 and 3 share the same doc-magnifier glyph, and steps 7 and 8 share
  the same table glyph. Each step then shows a number and an icon tile, so it is indexed twice. Keep the number
  and drop the tiles, or give each step a distinct SF Symbol.
- The right column does not line up. "● Google Sheets" and "● Gmail" have dots, but "On this Mac" has none, so
  the text starts at three different x positions (`review-dark.png`, x≈695/720/745). A grey dot means "not
  connected", which nothing explains.
- Jargon on a user surface: "Runs as a script, no model.", "Tone card", "facts.md", "Approval gate", "8 steps ·
  1 approval gate", and in live "recipients.csv (an export of your investor sheet: email, first_name,
  last_name, notes)", "crm-log.csv" and "Auto-run is off".
- "Your voice" box: the section header says "From 40 sent emails · click to edit". "Click" in a keyboard-first
  app has no key. The box then repeats the header ("Investor outreach · your voice").
- `review-skill-*.png`: a raw YAML/Markdown file (`SKILL.md`, `autoRun: false`, `gates: [batch-approval]`)
  opens as a sheet in mono bold. The hard wraps break paths ("(scripts/ pick_recipients.ts)"), and the text
  ends in a literal "why.…". This is a developer view in a consumer window.
- `review-real-schedule-*.png`: "Weekdays at 09:00 a new batch is drafted and waits for your review. · 20 a
  batch" has a period before the middle dot. It also says 20 a batch where every other screen and the confirm
  sheet say 8.
- The title bar repeats the body. The subtitle says "Ready for review" and the body's first line says
  "● Ready for review". In `live/e2e-review-approved.png` the subtitle says "Needs you" while the footer says
  "Turned on." Pick one place for status.
- The step-5 approval gate uses an amber fill and an amber ring for a step that is not in a needs-you state. It
  is a design-time marker, so colour is carrying meaning that is not state (rule 2).
- During "Running…" (`live/e2e-review-drafting.png`) the Approve primary disappears and the footer reflows. Keep
  it in place, disabled, so the layout does not jump.
- Good: the bottom action bar on a hairline, a single white primary, and keycaps on every action.

## 8. Dry run: 3/5
Evidence: `review-dryrun-{dark,light}.png`, `live/e2e-review-dryrun.png`.
- The "diff" is neutral grey boxes on **both** columns, with no sign of what was added, removed or reworded.
  The boxes have 0 px horizontal padding and clip glyph sides ("seed in March." and "Offload:" in the left
  column at y≈263-281). In light mode they are about 1.15:1 against the page and almost invisible. Mark only the
  draft side, use an underline or a 2 px rounded highlight with 2 px padding, and say what the mark means.
- The savings chips read "−2.9 min" in green. A negative number in the success colour is ambiguous. Write "Saves
  2.9 min".
- Header: "3 of last week's emails · ran 10:52 · 6 sends and logs held by the gate". The last clause is jargon.
  Write "Nothing was sent."
- The footnote repeats it at length: "Every send and log in the dry run stopped at the gate and was written to
  its log."
- Live: "1 of last week's emails · ran 00:09". A single example run at 00:09 does not support "dry-run on last
  week's real examples" (packet item 4).
- Good: the side-by-side "Our draft" and "What you sent" layout with dates is the right evidence-before-ask
  shape.

## 9. Confirm / arm sheet: 3/5
Evidence: `review-confirm-*.png`, `review-armed-*.png`, `live/review-confirm.png`, `live/e2e-review-confirm.png`.
- **The primary action ignores a blocker.** "Google Sheets is not connected" (amber), and in live also "Gmail
  is not connected", yet "Turn on" stays the enabled white primary. In `live/e2e-review-approved.png` it then
  reports "Turned on. Before it can send: Connect Gmail." Turning on something that cannot run is not calm.
  Make "Connect Gmail" the primary, or disable Turn on with the reason shown inline.
- Live copy bug: "First run Not scheduled. Then weekdays at 09:00 a new batch is drafted and waits for your
  review. · 20 a batch." The words are capitalised mid-sentence, the punctuation is stacked, and the 20 does not
  match the 8 shown elsewhere.
- One sheet holds two numbered lists (recipients 1-8 and steps 1-4), and the card's options are also numbered
  1-3, where numbers mean "press this key". Numbers that are not keys dilute rule 7. Use plain rows for the
  recipients.
- The sender address appears twice ("from muhammad@offload.so" in the header and in step 3).
- Keycaps disagree. The sheet's Turn on shows "↩", the footer Approve shows "⌘↩", and Cancel shows "esc".
  Approve and Turn on are the same weight of action, so give them the same chord.
- Placement disagrees. In snapshots the sheet hangs from the title bar like an `NSWindow` sheet
  (`review-confirm-dark.png`). In live it floats as a centred panel about 180 px below the title bar
  (`live/review-confirm.png`, `live/e2e-review-confirm.png`). Use a real `.sheet` so it attaches.
- The amber unlock tile next to the title is decoration in a status colour.
- Good: the explicit recipient list with addresses is exactly what a careful user wants before sending.

## 10. Dashboard: 2/5
Evidence: `dashboard-{dark,light}.png`, `dashboard-permissions-*.png`, `live/e2e-dashboard.png`,
`live/dashboard-pointer.png`.
- **The hero shows an invented number.** `live/e2e-dashboard.png` shows "Hours saved this week **22 h**
  Estimated" next to "0 active" and "Not measured yet". The caption underneath says "Counts automations that ran
  this week", and none ran. Packet item 5 says "hours saved", and nothing was saved. Show "Nothing saved yet",
  with the estimate as secondary text.
- The numbers do not match other screens. The dashboard says "77% of the 21.9 h estimate", the review says
  "~21.9 h", the card says "20–24 h" and "22.5 h/wk", the dashboard says "33.4 h tracked" and the card says
  "38.5 h tracked". The rail says "Day 4 of 7" and the dashboard says "7 of 7 days stored".
- **Selection is shown with a status colour.** The selected row (`dashboard-dark.png`, y≈372-466) gets an amber
  fill and an amber 1 px ring, so selection and "needs you" are the same signal. Light mode
  (`dashboard-light.png`) turns it into a cream web-alert box. Selection should be the neutral `ringStrong`
  plus `fillStrong`, or the system accent, with amber left to the dot and chip.
- Two different states share one colour. "1 to review" and "1 needs you" are both amber in the summary
  (top right), and both amber dots appear in the rows. Either merge them ("2 need you") or follow
  `13-design-getone.md` §5, where a review is a needs-you state.
- Copy: "Stopped at the log step: HubSpot needs its key again. 2 notes are waiting." ("log step" and "key" are
  internal terms). Live shows "connect Gmail" as a lowercase sentence fragment. "Measured is your time on the
  task before turning it on, minus after." is hard to parse. "f(x) Estimated" uses a maths glyph as a badge.
- Layout: a single 720 px column about 1,300 px tall with four stacked boxed sections reads as a web page.
  First-party Mac apps put a sidebar (Automations / This week / Observing) or a grouped `Form` on this much
  content. Section titles also sit in two places: "Hours saved this week" is inside its box, while
  "Automations", "This week" and "Observing" are outside theirs.
- `dashboard-permissions-*.png`: in the left label column, "Next purge" and "Permissions" have glyphs (trash and
  hand) but "Watching" has none, so the column starts at two x positions. Using a trash glyph for scheduled
  retention reads as "delete now".
- Good: the J/K/P/↩ hint row under the table, and the right-aligned "Saved a week" column with measured and
  estimated sublabels.

## 11. Timeline: 2/5
Evidence: `timeline-{dark,light}.png`, `dashboard-*.png`, `live/e2e-dashboard.png`.
- **Four hues compete.** Lavender, sea glass, rose, grey and a hatch sit together (`timeline-dark.png`, legend at
  y≈325). Sea glass sits next to the status green, and rose next to the recording red. Rule 2 says colour means
  state. Use one ink for the task in focus and a neutral for the rest.
- **The legend does not match the chart.** The "Offload ran it, you reviewed" swatch is a grey/black hatch, but
  the chart draws lavender hatches (`timeline-dark.png`, Wed/Thu/Fri at x≈162). The hatched mark reads as a
  different, fifth task.
- **Live data turns to confetti.** `live/e2e-dashboard.png` draws every sub-minute segment, so each bar is a
  barcode of lavender, teal, rose and grey slivers. Merge same-task segments with gaps under 5 min, and set a
  minimum drawn length of about 10 min.
- Contrast: "Everything else" is white at 26% on about #202022 in dark (about 2.1:1) and black at 18% on white
  in light (about 1.5:1). Both fall below the 3:1 non-text minimum.
- The axis labels stop at "20", but the Sun 18 bar runs to about 21:00 past the last label and gridline
  (`timeline-dark.png`, x≈745-771). Live shows "04…18" with work starting at about 05:00, which suggests a
  timezone offset bug. Check whether it is UTC.
- Live legend: "Offload ran it, you reviewed" wraps onto two lines and "Scheduling meetings over email" is long.
  The live dashboard has no "now" marker on Sat 24.
- Good: the day rows, the gridlines and the bold "Fri 23" for today.

## 12. Pointer: 3/5
Evidence: `pointer-{dark,light}.png`, `pointer-row-{dark,light}.png`, `live/dashboard-pointer.png`.
- The callout covers the content it explains. In `pointer-row-*.png` the label "Add the HubSpot key here and the
  waiting run finishes" sits over the next row's "Ready for review" chip, "Never" and "After you approve". In
  `pointer-*.png` the timeline label covers the Tue 20 bars. Place the label on the side with free space, or
  above the target.
- Light (`pointer-row-light.png`, `pointer-light.png`): the label glass lets the covered text bleed through
  ("Never" and "After you approve" ghost through the label). The veil is too thin for text over text. Use the
  opaque `.toolTip` material or raise the veil.
- The pointer lands on a truncated label ("Add key…"), which pushes the user to press something that cannot say
  its own name.
- Good: a blue system-style arrow, one short sentence, and the "Mon 09:00 · 1 h 40 min of investor outreach, by
  hand" copy, which traces to a bar.

---

## Scores

| Screen | Score |
|---|---|
| Rail | 3 |
| Insight card | 3 |
| Evidence | 3 |
| Undo | 3 |
| Empty | 4 |
| Onboarding | 3 |
| Review | 2 |
| Dry run | 3 |
| Confirm | 3 |
| Dashboard | 2 |
| Timeline | 2 |
| Pointer | 3 |
| **Average** | **2.8** |

Overall: the component kit (glass, keycaps, option rows, hint pill, empty state) is close to getone and could
pass for native. The windows built from it (review, dashboard, timeline) are where it falls back to web habits:
overflowing chips, colour used for selection and decoration, file names in copy, and numbers that disagree from
screen to screen.

---

## 10 highest-impact fixes (ordered)

1. **Fix the live review layout overflow.** In `ReviewView` header, take the schedule sentence out of the chip
   row and put it on its own `Text` line (13/400, ink2) under the chips. Put the chip row in a wrapping layout
   (a `Layout` that wraps, or `ViewThatFits` falling back to two rows). Constrain the content column with
   `.frame(maxWidth: 720).frame(maxWidth: .infinity)` so it centres and never exceeds the window. Accept when
   `live/e2e-review-*.png` at the current window size shows the full title "Investor outreach emails" and no
   clipped step titles.
2. **Use one source of truth for every number.** Card, review, confirm and dashboard must read the same
   `Insight`/`Plan` values through one formatter. Show one savings figure, for example "Saves about 22 h a
   week", with the range only in the evidence. Compute the subtitle and the arithmetic from the same rounded
   value (no more 24.7 vs 24.8). Read the batch size (8 vs 20), the tracked hours (38.5 vs 33.4) and the day
   count ("Day 4 of 7" vs "7 of 7") from the same store. Add a snapshot test that greps all rendered strings for
   the savings figure and fails if two values appear.
3. **Never show hours saved that were not saved.** In `DashboardView` hero, when no automation has a measured
   run this week, render "Nothing saved yet" in the hero style, with "About 22 h a week once it runs" as ink2
   body, and hide the progress bar. Drop the `f(x)` glyph from the Estimated chip.
4. **Rebuild the timeline colours.** Delete `Palette.task` tints 0-2. Draw the insight's task in `ink1` at 70%,
   all other tasks in `ink3`, and "Offload ran it" as a `status(.done)` 1 px outline bar with no hatch. Make the
   legend swatch the exact same view as the bar. Merge same-task segments with gaps under 300 s, and do not draw
   segments under 10 min (they fold into neighbours). Raise "Everything else" to at least 3:1: white 40% in dark,
   black 32% in light. Extend the axis to the last hour that has data, and render times in the local time zone.
5. **Stop using amber for selection and for design markers.** Dashboard selected row: fill `p.fillStrong`, ring
   `p.ringStrong`, no amber. Review step 5: remove the amber row fill and ring, and keep a lock SF Symbol plus a
   neutral chip "You approve". Merge "to review" and "needs you" into one amber line, "2 need you", in the
   summary. Make the onboarding and confirm unlock tile neutral.
6. **Make the countdown bars honest.** In the undo row (`InsightCardView`) and the arming row (`ReviewView`
   confirm), set `ProgressHairline(fraction: remaining / Tokens.undoSeconds)` from the same value that renders
   "4s". Give the undo row 16 pt bottom padding, matching the other blocks.
7. **Do not let Turn on arm a workflow that cannot run.** When any connector a step needs is not connected, make
   the confirm sheet's primary "Connect Gmail" (or the first missing connector), and make "Turn on" a secondary
   button labelled "Turn on anyway, sends wait". Fix the live subtitle to "Not scheduled yet. Weekdays at 09:00
   after that, 8 a batch." (no "First run Not scheduled", no ". ·"). Present it with `.sheet` so it attaches
   to the title bar in live as it does in snapshots.
8. **Remove internals from user-facing copy.** Delete or rewrite every user-visible occurrence of `facts.md`,
   `crm-log.csv`, `recipients.csv`, "tone card", "approval gate", "held by the gate", "Runs as a script, no
   model", "Auto-run is off", "log step", "key again" and "click to edit". Suggested strings: "HubSpot signed
   out. 2 notes are waiting."; "Nothing was sent."; "Uses only facts you have written down."; "Press E to
   edit". Move the raw `SKILL.md` sheet behind a Debug menu item, and make the title-bar doc button open a
   rendered, human-readable steps view.
9. **Put type and spacing back on tokens.** Replace the roughly 80 `.font(.system(size:))` calls in `Surfaces/`
   with `textStyle(Tokens.TypeScale.*)`. Add `largeTitle` (26/500/-0.6) and `sheetTitle` (17/500/-0.3) to the
   scale if those sizes stay, and drop 12.5 and 14 entirely. Replace off-grid paddings (3, 5, 7, 11, 14, 18,
   50, 54) with `Tokens.Space`. Set `Ink.secondary` to 0.85 for in-card body copy, per the ladder comment. Inset
   the card's option rows by 8 pt so their left edge matches the well.
10. **Use one keycap, in one order, with one meaning.** Route `PrimaryButton`'s inline key, the onboarding
    `⌥Space` chip and every footer chord through `Keycap`. Order the card header as `J K esc`, not `K J`. Decide
    whether E or Esc dismisses, and show the same key in the header and the hint pill. Give Approve and Turn on
    the same chord (`⌘↩`). Stop numbering non-key lists (the recipients and steps in the confirm sheet). Also
    make the paused rail's mic neutral, not red.
