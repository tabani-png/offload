# DESIGN-REVIEW-2: independent Apple-native design critique, round 2 (after s10a)

Reviewer: independent design critic (Apple HIG lens), 2026-10-25. Read-only apart from this file. I did not build this.
I scored from the pixels and did not use the builder's self-score of 4.54 (`slices/s10a-ui-polish/DESIGN-REVIEW.md`).
Inputs: `packet/PACKET.md`, `adam/memory/research/13-design-getone.md` (12 feel rules), the getone reference PNGs
(`assets/getone/03-hero-scroll-demo.png`, `04-how-it-works.png`), all 56 PNGs in `app/snapshots/` and all 15 in
`app/snapshots/live/`, a grep of `app/Sources` for hard-coded sizes and colours, and pixel sampling for contrast.
The scale matches round 1: 5 = first-party Apple, 4 = native with small slips, 3 = right idea but visibly
assembled, 2 = web dashboard or broken, 1 = wrong.

**Evidence warning.** 7 of the 15 live captures predate s10a. They were taken at 23:42 on Oct 24 or 00:13 on Oct 25,
while the snapshots were taken at 01:27 on Oct 25. The stale files are `live/dashboard-pointer.png`,
`live/review-confirm.png`, `live/review-skill.png`, `live/glass-*.png` (4) and `live/onboarding-permissions-live.png`.
They still show lavender bars, "You spent 65%…", the amber gate and "Required". Round 1 found glass clipping, and
these captures cannot confirm the fix, so I score those items from the e2e captures (01:24 to 01:25) and the
snapshots only.

---

## A. Round-1 defects: status

| # | Round-1 defect | Status | Evidence |
|---|---|---|---|
| T1 | Ink ladder 100/90/60/40 not honoured | PARTLY | `Core/Tokens.swift:120` is now 0.96 / 0.78 / 0.52. Card body sits at 78%, still under the 85-90% reference. Light mode does not use the ladder at all: `Design/Theme.swift:11-15` hard-codes 0.86 / 0.72 / 0.63. |
| T2 | About 80 `.font(.system(size:))` calls | FIXED | 0 left in `Surfaces/`. `largeTitle` 26 and `sheetTitle` 17 were added to TypeScale. |
| T3 | Spacing off-grid, `Tokens.Space` unused | PARTLY | Paddings use tokens now. Literals remain at `ReviewView.swift:150` (200), `:192` (120/180), `:578/:586` (220), `:609` (120) and `:639` (420); `DashboardView.swift:316` (1.5) and `:368-369` (0.18, hatch 3.5/1.2); and `OnboardingWindow.swift:95` (mark 22). |
| T4 | Option rows inset 11 vs well inset 8 | FIXED | `card-dark.png`: well and rows share x=37. |
| T5 | Pastel task tints on data | FIXED | `timeline-*.png` uses a neutral ramp. |
| R1 | Red mic while paused | FIXED | `rail-dark.png`, right column: the mic is neutral grey. |
| R2 | Two identical blue dots with no identity | NOT FIXED | `rail-dark.png` / `scene-dark.png` (x≈932, y=137 and 155): still two identical blue dots at rest. The hover pill gives counts ("1 running") but no names. |
| R3 | Wide web-style shadow on the live rail | PARTLY | `live/e2e-rail.png` still shows a soft grey halo of about 12 px on white. The rail glass is tighter (`Glass.swift:93`, r8 y4), but window chrome still uses r24 y14 (`WindowKit.swift:276`). |
| R4 | Floating tooltip with no anchor | FIXED | `rail-dark.png`: the pill is centred on the dot capsule, about 12 px away. |
| R5 | Glass captures clipped at the right edge | UNVERIFIED | `live/glass-*.png` are stale (pre-s10a). |
| C1 | Three different savings figures in one card | FIXED | `card-dark.png`: the chip, the receipt and "Saved" all say 21.9 h. The range moved to the evidence section. |
| C2 | Arithmetic read like a debug print | FIXED | It is now a receipt table (By hand / Your review / Saved). The new nit "98.4/day" is listed under Card. |
| C3 | "↘" glyph in the green chip | FIXED | `card-*.png`. |
| C4 | Header keycaps K J esc; E vs Esc | PARTLY | Header is now J K. The hint pill still offers two dismissals, "E dismiss" and "esc close" (`card-dark.png`, bottom). The difference is documented in SPEC, not on screen. |
| C5 | "Connect…" read as truncated | FIXED | `live/e2e-card.png`: "Gmail │ Connect…" fits. The ellipsis follows the HIG convention for an action that opens more UI. |
| C6 | Title with a period, two-line wrap | PARTLY | The period is gone. "your week" still drops to an orphan second line (`card-dark.png` y≈110; `live/e2e-card.png` y≈210). |
| C7 | Light option rows about 1.1:1 | PARTLY | `card-light.png`: the rows now have a ring and grey fill, but the fill-to-card contrast is still minimal. |
| E1-E4 | Evidence alignment, a Numbers row, Chrome vs Gmail, clipped subjects | FIXED | `card-evidence-*.png`: two-line rows, "Recent emails in Gmail", and "Also 1 in Numbers" is a footnote. |
| U1-U3 | Countdown bar, tense, bottom padding | FIXED | `card-undo-dark.png`: the bar is 287/360 = 80% at "4s", the label reads "Drafting the workflow in 4s", and the bottom padding is 24. `review-armed-dark.png`: 410/512 = 80%. |
| M1 | Unlabelled esc on the empty card | FIXED | "Close esc". |
| M2 | Generic mark | NOT FIXED | Acknowledged by the builder. |
| O1 | Accessibility "Required" but skippable | PARTLY | Fixed in the snapshots ("Needed for insights / Recommended / Optional"). `live/onboarding-permissions-live.png` still says "Required" (stale capture). |
| O2 | ⌥Space keycap looked like a different component | FIXED | `onboarding-comeback-*.png`. |
| O3 | xmark glyphs | FIXED | Now minus.circle. |
| O4 | Dead space above the footer | FIXED in snapshots, NOT in live | The live onboarding capture has about 140 px of dead space (stale). |
| O5 | "Use demo week loads…" | FIXED | |
| O6 | "All set. Offload ticks these off…" redundant | NOT VERIFIED | Present only in the stale live capture. |
| V1 | CRITICAL live review overflow | FIXED | `live/e2e-review-drafting.png`: the full title shows, chips wrap, and the schedule has its own line. `review-640-*.png` is clean. |
| V2 | Live chip overlap | FIXED | |
| V3 | Duplicate step icon tiles | FIXED | Numbers only now. |
| V4 | Misaligned right column, unexplained grey dot | FIXED | Text right-aligned, "Google Sheets, not connected" spelled out. |
| V5 | Internal jargon | PARTLY | The review snapshots are clean. It survives in `dashboard-*.png` "Add key…", `pointer-row-*.png` "Add the HubSpot key here", `live/e2e-review-drafting.png` step 3 "investor-outreach voice notes", and the YAML in `review-skill-source-*.png` (`gates: [batch-approval]`, `autoRun: false`). |
| V6 | "click to edit" | FIXED | Now "type to change it". |
| V7 | Raw SKILL.md sheet | PARTLY | A rendered Steps sheet comes first and the YAML sits behind "View source" rather than in a Debug menu. The Steps sheet (`review-skill-dark.png`) repeats the same 8 steps that are already visible behind it. |
| V8 | ". · 20 a batch" | FIXED | `review-real-schedule-*.png`. 8 vs 20 is explained in section C. |
| V9 | Title bar repeated the status | FIXED | Subtitle is now "Drafted from your week". |
| V10 | Amber fill on the gate step | FIXED | Neutral, with a lock. A new alignment slip is listed under Review. |
| D1 | Grey diff boxes on both sides | FIXED | Underlines on the draft side only, plus a legend line. |
| D2 | "−2.9 min" in green | FIXED | Now "Saves 2.9 min". |
| D3, D4 | Gate jargon in the header and a footnote that repeated it | FIXED | Now "nothing was sent". |
| D5 | Live dry run used 1 example at an odd hour | NOT FIXED | `live/e2e-review-dryrun.png`: "1 of last week's emails · ran 01:24". Packet item 4 asks for last week's examples, plural. |
| F1 | Turn on enabled despite a blocker | FIXED | `review-confirm-dark.png`, `live/e2e-review-confirm.png`: Turn on is disabled and Connect is the primary. |
| F2 | Live "First run Not scheduled. … · 20" | FIXED | Now "Not scheduled yet. Weekdays at 09:00 …". |
| F3 | Numbered recipient list | FIXED | |
| F4 | Sender address shown twice | FIXED | |
| F5 | ↩ vs ⌘↩ | FIXED | Both use ⌘↩. The blocked primary "Connect Gmail →" has no keycap at all. |
| F6 | Sheet not attached; snapshot and live placement disagree | NOT FIXED | `review-confirm-dark.png`: the panel floats at y=92 with no scrim, and the content behind it ("Investo…", chips) reads through at the same value. `live/e2e-review-confirm.png`: the panel is centred at y≈443 px (about 220 pt below the title bar). It is still not an `NSWindow` sheet, and the two placements still disagree. |
| F7 | Amber unlock tile | FIXED | |
| B1 | Invented "22 h saved" | FIXED | `live/e2e-dashboard.png`, `dashboard-before-dark.png`: "Nothing saved yet". |
| B2 | Numbers disagree across screens | PARTLY | 21.9 now agrees across the card, review, confirm and dashboard, and "Day 7 of 7" matches "7 of 7 days stored". The tracked-hours mismatch survives in the snapshot data (see section C). |
| B3 | Amber selection | FIXED | Neutral ring and fill (`dashboard-*.png` y≈368-452). |
| B4 | "1 to review" + "1 needs you" | FIXED | Now "2 need you". |
| B5 | Dashboard copy | PARTLY | `f(x)` is gone and "HubSpot signed out" is good. "Add key…" remains. The "Measured compares…" footnote also appears in the "Nothing saved yet" state, where nothing has been measured. |
| B6 | One 720 column of stacked boxes, reads as a web page | NOT FIXED | Kept on purpose (SPEC). It still reads as a scrolling web page (`dashboard-dark.png`, 1,300 px tall). |
| B7 | Permissions label glyphs | FIXED | |
| TL1 | Four competing hues | FIXED, with a new problem | The new problem is in Timeline: categories are now four greys that are hard to tell apart. |
| TL2 | Legend did not match the chart | FIXED | The legend uses the same bar view. |
| TL3 | Live confetti | PARTLY | Merged spans now, but 1-3 px slivers still start every live bar (`live/e2e-dashboard.png` x≈300-318 on every row). |
| TL4 | "Everything else" below 3:1 | FIXED | Sampled 3.74:1 in dark and 3.23:1 in light against the panel. |
| TL5 | Axis cut off, UTC offset | FIXED | The snapshot axis runs to 22. Live runs 08-20 in local time. |
| TL6 | No "now" marker in live | NOT FIXED | `live/e2e-dashboard.png`, Sat 24 row: no marker. The snapshot has one. |
| P1 | Pointer label covers content | NOT FIXED | `pointer-row-*.png`: "Add the HubSpot key here" covers "Ready for re[view]" and "[Ne]ver" in the next row. `pointer-dark.png`: the label covers the Tue 20 bars from 09:00 to 15:00. |
| P2 | Label glass bled through in light mode | FIXED | Opaque now. |
| P3 | Points at a truncated, jargon label | PARTLY | Ellipsis now, but still "key". |

Tally by table row (grouped rows such as E1-E4 count once): 42 FIXED (2 of them with caveats), 13 PARTLY, 7 NOT FIXED, 2 unverified (stale captures).

---

## B. Per-screen scores and remaining defects

### 1. Rail: 3.5
- `rail-*.png`, `scene-*.png`: two identical blue dots at rest (R2). Only the hover pill tells the user that one is
  the observer and one is an automation, and it gives a count, not a name.
- `live/e2e-rail.png`: inbox badge "6" with a single amber dot underneath. Six things need the user, but the ambient
  layer shows one. It is also a soft halo on white (R3).
- The light-mode rail (`rail-light.png`) is good. The specular edge and dots read clearly.

### 2. Insight card: 4
- `card-dark.png` y≈130: "64.4% of your week" uses tenth-of-a-percent precision in a headline. getone copy is
  plain, so say "About 64% of your week". The title still wraps to an orphan "your week".
- y≈247: "98.4/day" is a fractional email count. Say "about 98 a day". It is honest arithmetic but reads as a computer
  talking.
- `card-light.png` "Recommended" chip: sampled (138,87,0) on (224,213,190) is about 4.2:1 at 11-12 pt, below 4.5:1.
- `live/e2e-card.png`: the receipt's right column ends at x≈692 inside a well that runs to 808. It is not full
  width, which means the live build lags the snapshot.
- The hint pill offers "E dismiss" and "esc close" side by side. Two dismiss verbs one key apart do not read as
  calm.

### 3. Evidence: 4
- `card-evidence-dark.png`: clean, aligned and honest. The range line "Likely 19.7–22.9 h a week, depending on
  review time" sits above the email list but describes the receipt above it. Move it into the receipt as a
  footnote.
- "5 of 492" lists Halden Ventures twice (rows 1 and 5). That is fine as data, but with only 5 rows a repeat looks
  like a bug.

### 4. Undo: 4.5
- `card-undo-*.png`: the bar, the label, the padding and the muted rows are all right. The one nit: the chosen row
  uses the working blue fill, which is defensible because the row is about to run.

### 5. Empty: 4
- Unchanged and good. The mark is still generic (M2).

### 6. Onboarding: 4
- The snapshots are good: sized to content, consistent tags, keycaps and glyphs.
- `live/onboarding-permissions-live.png` was never re-captured and still shows the round-1 build ("Required",
  dead space, redundant footnote). Re-capture it before anyone demos from the live set.
- `onboarding-*-light.png`: the primary is a black pill. That is a reasonable light mirror of rule 1, but the
  Back/Continue keycap tile inside it (`↩` on dark grey) has much lower contrast than the label.

### 7. Review: 3.5
- `review-dark.png` step 5 (y≈592): the lock glyph pushes "You approve the batch" to x=183, while every other title
  starts at x=166. Hang the lock in the number column, or put it after the title.
- `review-640-dark.png` steps 2, 6 and 8: descriptions wrap at about 400 px to leave room for a right column, but
  step 5, which has no right column, runs full width. The ragged wrap widths make the list look loose.
- Step 2 says "Runs on this Mac." in its description, and its right column also says "On this Mac".
- `review-skill-dark.png`: the "Steps" sheet repeats the 8 steps already on screen behind it. Its only new
  content is "View source". Make the title-bar button open the source directly (Debug) or drop it.
- `live/e2e-review-drafting.png`: "Your voice" is a tall empty editor with its instruction ("Write a few lines on
  how you sound.") below the box instead of inside it as placeholder text. Step 3 still says "your
  investor-outreach voice notes", which are empty.
- R and E are bare single-letter shortcuts in a window that contains an editable text box (`Your voice`). Typing
  in the box must never fire Run again or Edit, and the UI gives no sign that this is guarded.

### 8. Dry run: 3.5
- `live/e2e-review-dryrun.png` header (y≈765): "3.0 min b…". The time is truncated while the subject repeats
  the sender ("Acme seed round: Bessemer Venture Partners").
- Identity mismatch in live. "What you sent" is signed "Best, Sam / Acme | acme.io", while "Sample draft" and the
  confirm sheet sign and send as Muhammad. The demo week's sent mail belongs to a different person from the user
  the app drafts for. An investor demo will catch this immediately.
- Live has 1 example (D5).
- `review-dryrun-dark.png`: the draft adds "seed in March", which is not in what was sent, and it is not flagged.
  Step 4 promises that "a number that is not in your facts is flagged", and a date is the same class of
  invented fact. The word diff also underlines function words ("the", "our", "3 of"), so real changes do not
  stand out.
- The "Sample drafts" disclosure is honest and well placed.

### 9. Confirm / arm sheet: 3
- F6 is not fixed. In the snapshots it is a floating panel with no scrim, sitting 10 px under the title bar. In live
  it is a centred panel about 220 pt down. In both, the content behind is undimmed and the panel edge almost
  disappears on a dark window (`review-confirm-dark.png`, panel edge at x=202 against the review background).
- `live/e2e-review-confirm.png`: one blocker is stated twice in the sheet ("Gmail is not connected…" and "Connect
  Gmail and Google Sheets first…"). `live/e2e-review-approved.png` states it a third time in the window footer.
- `live/e2e-review-approved.png` bottom right (x≈1375-1600, y≈1740): the disabled Approve button renders as an
  empty pill with no label. A disabled control must keep its label.
- The blocked primary "Connect Google Sheets →" / "Connect Gmail →" is the only primary button with no keycap.
  Rule 7 says every action has a key.
- `live/e2e-review-confirm.png`: "Draft up to 20 emails" is a boxed card with a header and one paragraph, nested in
  the sheet. It is a card inside a card for two sentences.

### 10. Dashboard: 3.5
- `live/e2e-dashboard.png` bottom: "● Not recording · 7 of 7 days stored" in amber, next to a "Pause watching"
  button. You cannot pause something that is not recording. The button must say what fixes the state ("Resume" or
  "Open Settings").
- "Add key…" in the HubSpot chip (`dashboard-*.png` y≈434) is still jargon. Say "Sign in…".
- Single 720 column (B6). Four stacked boxed sections, about 1,300 px tall. A first-party app would use a sidebar or
  a grouped `Form`.
- The "Measured compares your time…" footnote shows in the "Nothing saved yet" state (`dashboard-before-dark.png`),
  where nothing is measured. Show it only once a measured figure exists.
- `live/e2e-dashboard.png`: "Show the evidence 2". What the 2 counts is not stated anywhere on screen.
- Rail "6" (insights waiting) vs dashboard "1 needs you" (automations) in live: both are amber "needs you" counts of
  different things. One sentence, or one shared count, would stop the user from wondering which is right.

### 11. Timeline: 3
- The four categories are now four greys. Sampled steps between neighbours are 1.62 / 1.52 / 1.51:1 in dark
  (237 / 188 / 152 / 121) and 2.15 / 1.57 / 1.42:1 in light. "CRM updates" vs "Everything else" (1.5:1 dark,
  1.4:1 light) cannot be told apart without the legend. Rule 2 is satisfied, but the chart now encodes three
  categories the eye cannot separate. Show the focus task in ink and everything else in one neutral, or label the
  bars directly.
- The hatch marks ("Offload ran it") are 8-10 px wide (`timeline-dark.png` Wed-Fri x≈160-172), too small to read
  as a pattern.
- Live: sub-minute slivers before every bar (TL3) and no "now" marker (TL6).

### 12. Pointer: 3
- P1 is not fixed. `pointer-row-light.png` and `pointer-row-dark.png`: the label covers the next row's status chip
  and "Never". `pointer-dark.png`: the label covers Tue 20. The label needs collision-avoiding placement (above the
  target, or on the side with free space).
- "Add the HubSpot key here": jargon (P3).

### Scores

| Screen | R1 | R2 |
|---|---|---|
| Rail | 3 | 3.5 |
| Insight card | 3 | 4 |
| Evidence | 3 | 4 |
| Undo | 3 | 4.5 |
| Empty | 4 | 4 |
| Onboarding | 3 | 4 |
| Review | 2 | 3.5 |
| Dry run | 3 | 3.5 |
| Confirm | 3 | 3 |
| Dashboard | 2 | 3.5 |
| Timeline | 2 | 3 |
| Pointer | 3 | 3 |
| **Average** | **2.8** | **3.6** |

The builder's 4.54 is about one point high. The gap is largest on Confirm (4.5 claimed vs 3: the sheet is still
unattached, the reason is said three times, and the disabled button is blank) and Pointer (4.5 vs 3: it still covers
content), and it is the same pattern on Timeline (4.5 vs 3: four greys at 1.5:1 cannot be told apart).

---

## C. Same number, shown differently: real or different data?

- **21.9 h (snapshots) vs 22.0 h (live): different data, not a bug.** The snapshots render the hand-written
  fixture `Core/SampleWeek.swift:15` and `Core/MockWorkflows.swift:104,228,244` (492 emails, 98.4/day, 21.9). The
  live e2e run renders the brain's demo week (495 emails, 99/day, 22.0). Within each set, the card, review, confirm
  and dashboard agree, and the arithmetic ties: 24.6 − 2.7 = 21.9 (89%) and 24.8 − 2.8 = 22.0 (89%, from
  24.75 − 2.75).
- **8 vs 20 a batch: different data.** The snapshots use 8 and the live brain uses 20. Each set is internally
  consistent.
- **Real inconsistency inside the snapshot fixture: tracked hours.** The card's 64.4% and 24.6 h imply about
  38.2 h tracked, and `SampleWeek.swift` stores `trackedHours: 38.1`. The dashboard timeline built from the same
  demo state says **"33.4 h tracked"** (`dashboard-*.png`, `timeline-*.png`), and its white "Investor outreach"
  bars add up to about 6 h, not 24.6 h. The timeline does not support the card's headline, which works against packet
  item 2 ("every number traces to rows"). In the same fixture, 24.6 / 38.1 = 64.6%, not 64.4%. The sample is
  hand-typed and the figures do not tie.
- **Live, minor:** 64.8% of 38.1 h = 24.7 h of observed time, vs a 24.8 h "By hand" estimate. These are two bases
  (observed vs modelled) and are defensible, but the card does not say which one the percentage uses.
- **Anything invented:** the live "What you sent" mail is signed by "Sam, Acme" while the app drafts and sends as
  Muhammad (wrong persona in the demo week). The snapshot draft adds "in March", which is not in the source mail.
  The component sheet still shows "6 of 500 emails" (`components-*.png`), a leftover round-1 number.

## D. Leftover hard-coded values (grep of `app/Sources`)

- Surfaces: `ReviewView.swift:150, 192, 324, 578, 586, 609, 639`; `DashboardView.swift:316, 368, 369`;
  `OnboardingWindow.swift:95`. Line 324 duplicates a hairline colour (`.black.opacity(0.55/0.10)`) that
  `WindowKit.swift:268` also hard-codes (0.5/0.1), and the two disagree.
- Design: light-mode inks `Theme.swift:11-15` (0.86/0.72/0.63 are literals, not `Tokens.Ink`); `Theme.swift:66`
  needs-you ink as an RGB literal; window shadow `WindowKit.swift:276` (r24, y14) and a 0.14 window ring at `:274`;
  pointer shadows `PointerOverlay.swift:87,102`; and `Components.swift:95`, where the Recommended chip ring is
  `opacity(0.0)`, an always-invisible ring.
- `Snapshotter.swift` has its own literals (72, 960×640, 24, r18 shadow). They are acceptable in a harness, but the
  r18 y10 shadow there is not the product's shadow, so the snapshot chrome is not what ships.

---

## E. Final 8 highest-impact fixes (ordered)

1. **Make the confirm a real sheet.** Present it with `.sheet` (attached under the title bar, system dimming) in
   both the snapshot and live builds. State the blocker once, as the amber lines, and delete "Connect … first. Turn on
   needs every step able to run." from the sheet and from the window footer. Give the blocked primary
   "Connect Gmail" the `⌘↩` keycap. Keep the disabled Approve label visible at reduced opacity, not a blank pill.
   Accept when `live/e2e-review-confirm.png` and `review-confirm-dark.png` show the same attached placement.
2. **Fix the demo-week identity and the data trace.** The demo week's sent mail must be signed by the same person
   the app drafts as (Muhammad, `muhammad@offload.so`), or the app must draft as Sam. Derive the snapshot
   fixture's tracked hours and time share from one source. Either the timeline sums to 38.1 h with about 24.6 h of
   outreach, or the card says 33.4 h and recomputes. Add a test that fails if `taskHours / trackedHours` does not round
   to the displayed percentage.
3. **Pointer placement.** Place the label in free space: above the target when a row sits below it, and to the right of the
   bar end on the timeline. Add a collision test against sibling frames, and fail the snapshot if the label's
   rect intersects any text rect. Change the copy to "Sign in to HubSpot here".
4. **Timeline legibility.** Draw the focus task in `ink1` and every other category in one neutral, label
   "Everything else" only, and drop the CRM and Scheduling greys (or label the bars inline). Make the "Offload ran
   it" mark a full-height hatched span of at least 16 pt or a 1 px green outline. In live, fold spans under 10 min
   into neighbours (the slivers at x≈300-318) and draw the "now" marker on today's row.
5. **Live dry run on real examples.** Run on at least 3 of last week's emails (packet item 4). Give the per-email
   header a fixed time column so "3.0 min by hand, 20 s to review" never truncates, and drop the sender from the
   subject. Flag any date, number or name in a draft that is not in the source or the facts (the "in March" case),
   and limit the underline diff to changed phrases, not function words.
6. **Dashboard state copy.** When the observer is not recording, the Observing row button must be "Resume" (or
   "Open Settings" when a permission is missing), never "Pause watching". Hide the "Measured compares…" footnote
   until a measured figure exists. Say what "Show the evidence 2" counts. Replace "Add key…" with "Sign in…"
   everywhere.
7. **Card headline and numbers.** Round headline shares to whole percent ("About 64% of your week") and rates to
   whole emails ("about 98 a day"), and keep the decimals in the receipt only. Fix the orphan line with a balanced
   wrap or a tighter title ("Outreach email is 64% of your week"). Raise the light-mode Recommended text to at least
   4.5:1 (darken to about #6E4500). Pick one dismiss verb in the hint pill. Re-run live so the receipt spans the
   well.
8. **Finish the system pass and refresh the evidence.** Give the rail's two blue dots identity (an observer ring
   vs a solid automation dot) or show one dot per state with a count. Hang the step-5 lock in the number column.
   Move the Review literals (200/120/180/220/420) and the duplicated hairline colours to tokens. Put light-mode inks
   on `Tokens.Ink`. Delete the zero-opacity Recommended ring. Re-capture the 7 stale live PNGs (glass-*,
   review-confirm, review-skill, dashboard-pointer, onboarding-permissions-live) so the live set matches the
   build, and confirm the round-1 glass clipping is gone.
