# DESIGN-REVIEW-4: independent design critique, round 4

Reviewer: EvidenceQA (independent). Date: 2026-10-25.
Evidence: every PNG in `app/snapshots/` and `app/snapshots/live/`, read one by one, with the getone references
(`13-design-getone.md`, `14-video-one-teardown.md`, `11-rea-clicky.md`, `12-rea-cua.md`, `assets/getone/`).
I wrote the scores below before I opened DESIGN-REVIEW-1/2/3. Section 4 was written afterwards.

Bar applied: dark hero; white is the only accent (one white primary per view); color means state only (blue working,
amber needs you, green done, red recording); rings, not shadows; radii 24/16/12; out-expo easing 150-300 ms;
keyboard-first.

---

## 1. Per-screen scores

| # | Screen | Score | Justifying PNG(s) |
|---|---|---|---|
| 1 | Rail | 4.0 | `rail-dark.png`, `live/e2e-rail.png` |
| 2 | Suggestion card | 4.5 | `card-dark.png`, `live/e2e-card.png`, `card-undo-dark.png`, `card-light.png` |
| 3 | Evidence / maths | 4.0 | `card-evidence-dark.png`, `live/dashboard-evidence-pointer.png` |
| 4 | Connect (in-flow) | 4.0 | `review-connect-dark.png`, `review-connect-waiting-dark.png`, `review-connect-failed-dark.png`, `review-connected-dark.png`, `live/e2e-review-connect.png` |
| 5 | Connections center | 3.0 | `connections-dark.png`, `connections-search-dark.png`, `connections-detail-dark.png`, `connections-key-dark.png`, `connections-server-dark.png`, `connections-built-dark.png`, `connections-light.png` |
| 6 | Tone / voice | 3.5 | `review-dark.png`, `review-voice-edit-dark.png`, `live/e2e-review-dryrun.png`, `live/review-skill.png` |
| 7 | Plan + tool picker | 3.5 | `review-plan-dark.png`, `review-tools-dark.png`, `live/e2e-review-drafting.png` |
| 8 | Dry run (email + general) | 3.5 | `review-dryrun-dark.png` (4.0), `review-dryrun-general-dark.png` (4.0), `review-dryrun-sample-dark.png`, `live/e2e-review-dryrun.png` (3.0) |
| 9 | Approval / confirm | 4.0 | `review-confirm-dark.png`, `review-confirm-ready-dark.png`, `review-armed-dark.png`, `live/e2e-review-confirm.png`, `live/e2e-review-approved.png`, `live/dashboard-autosend.png`, `dashboard-autosend-on-dark.png` |
| 10a | Dashboard, light | 4.0 | `dashboard-light.png`, `live/dashboard-light.png`, `timeline-light.png` |
| 10b | Dashboard, dark | 4.0 | `dashboard-dark.png`, `dashboard-automations-dark.png`, `dashboard-models-dark.png`, `live/e2e-dashboard.png`, `live/dashboard-observing.png`, `live/dashboard-automations.png` |
| 11 | Timeline ("This week") | 3.5 | `timeline-dark.png`, `timeline-before-dark.png`, `pointer-dark.png`, `live/dashboard-week.png` |
| 12 | Onboarding incl. role/industry | 3.5 | `onboarding-watches-dark.png`, `onboarding-permissions-dark.png`, `live/onboarding-permissions-live.png`, `onboarding-context-dark.png`, `onboarding-context-filled-dark.png`, `onboarding-context-claude-light.png`, `onboarding-comeback-dark.png` |
| 13 | Empty states | 3.5 | `card-empty-dark.png`, `dashboard-automations-empty-dark.png`, `live/e2e-dashboard.png`, `components-dark.png` |

**Overall: 3.7 / 5.** (Mean of the 14 rows is 3.75; rounded down because two live captures, the dry run and the
tool picker, are weaker than their snapshots.) This is a Good build, not yet Excellent. The skeleton is right: the
insight card, the confirm sheet and the connect loop now read as one calm, keyboard-first product, and the getone
discipline (one white primary, amber means needs you, keycaps on every action) holds on most screens. It does not
reach 4.5 because of contradictory state copy on the riskiest screens (tool picker, confirm), a broken privacy
sentence in onboarding, a Connections center that looks like a settings list, and a live dry run that is still
the offline sample model.

### What is genuinely good (do not regress)
- `card-dark.png` / `live/e2e-card.png`: the insight card is the best screen. Evidence above the ask, the sum ties
  (492 x 3.0 min = 24.6 h, 492 x 20 s = 2.7 h, 24.6 - 2.7 = 21.9 h = 89%), a range line, numbered options,
  one amber Recommended tag, a detached hint pill. Light mode (`card-light.png`) now separates option rows.
- `card-undo-dark.png` and `review-armed-dark.png`: blue countdown bar with "Undo esc", exactly the getone
  "reversible by default" rule.
- `review-connect-*`: waiting (spinner), failed (amber, "Nothing was changed", one recovery primary), connected
  (green) form a complete state set inside one sheet.
- `review-dryrun-general-dark.png`: a non-email dry run with field-by-field "What Offload would do / What you did",
  and a real catch ("Your total was 2,951.00; the invoice says 2,915.00").
- `review-plan-dark.png`: "Two ways to do it" shows the formula (58 / (58 + 1 + 1) = 97%), which makes the pick
  auditable.
- Status colors are now consistent across rail, dashboard, connections and steps.

---

## 2. Findings

### MUST-FIX (each blocks 4.5)

**M1. Onboarding step 1: the privacy sentence is broken English.**
Screen: `onboarding-watches-dark.png` (footer). File: `Sources/Surfaces/OnboardingWindow.swift`.
It reads: "Everything is kept on this Mac, encrypted. With a Claude account set up, masked text, and masked screens,
go to that account to read and draft. Nothing else leaves." This is the single sentence that earns the right to
record the screen, and it does not parse.
Fix: "Everything stays on this Mac, encrypted. If you turn on Claude, only masked text and masked screenshots go to
your Claude account, to read and draft. Nothing else leaves this Mac."

**M2. Tool picker states contradict each other.**
Screens: `review-tools-dark.png` (step 6 and 7), `live/e2e-review-drafting.png`, `live/e2e-review-approved.png`.
File: `Sources/Surfaces/PlanViews.swift`.
- Instantly carries "In use" while the amber line under it says its create and launch actions are not approved,
  and the caption says "Sends through Gmail until Instantly is connected". Gmail, the tool that will actually send,
  has no "In use" mark. In `live/e2e-review-approved.png` the automation is Active with Instantly still "In use"
  and Gmail doing the work.
- Step 7 shows three competing markers at once: a blue ring on Attio (keyboard focus), "In use" on Google Sheets,
  and a sparkle line recommending Google Sheets. Blue is the "working" color; using it for focus breaks the color
  rule.
- The sparkle line repeats the card body word for word ("Use Instantly for sending: built for sending 100+ a
  day..." then the same text in the card). Live copy says "Connect its MCP server", which is jargon for a
  non-developer.
Fix: "In use" goes only on the tool that runs today (Gmail). A chosen-but-unconnected tool shows an amber
"Chosen, connect to use" chip. Keyboard focus is a 2 px white ring at 40% (getone focus ring), never blue. Cut the
sparkle line to the reason only ("Recommended: built for 100+ a day"). Replace "MCP server" with "Connect Instantly".

**M3. The live dry run is still the offline sample, and its diff under-reports.**
Screens: `live/e2e-review-dryrun.png`, `live/review-skill.png`; compare `review-dryrun-dark.png`.
File: `Sources/Surfaces/ReviewView.swift`.
The live card says "Sample drafts. Written by the offline sample model... not drafted from your voice", yet
Approve and Connect Gmail are fully enabled beneath it. The Sven card is marked "Changed 1 phrase" while the whole
personal line was replaced ("Bessemer ... backs tools teams use every day" vs "investment in Toast is why I'm
writing"), and the sign-off block ("Best, / Offload | offload.so") is not flagged at all. Per-word highlights
("backs", "tools", "teams", "use", "every", "day") are noise, not a diff.
Fix: until a voice-drafted run exists, show every card with an amber "Sample, not your voice" header and make the
footer primary "Run with my voice" instead of Connect. Count changes by sentence ("Changed 1 of 4 sentences"),
highlight contiguous spans, and flag sign-off and signature differences.

**M4. Connections center reads as a settings list and search returns non-matches.**
Screens: `connections-dark.png`, `connections-search-dark.png`, `connections-light.png`, `connections-detail-dark.png`.
File: `Sources/Surfaces/ConnectionsView.swift`.
- Searching "lin" returns Linear, Stripe and Shopify with no reason shown. Two of three results do not match.
- No app icons; nine rows of text with a dot. For "connect any app" this needs recognisable marks.
- "Checked by Offload" is drawn as a bordered pill identical to a button, in the same column where other rows show
  plain text ("18 ways to read, 21 actions you approve"). It reads as an action.
- Stripe's subtitle truncates ("Check the API key in Stripe...") on the one row that needs instructions.
- The setup sheet's status dot sits in a separate column left of the title (`connections-detail-dark.png`), off
  the text baseline.
- The dashboard sidebar (`dashboard-dark.png`) has Overview, Automations, This week, Observing, but no Connections,
  so the center is not reachable from the main window.
Fix: filter by app name; if a tool name matches, show "Matches: <tool>" in the subtitle. Add 20 pt app icons in a
12 radius tile. Render "Checked by Offload" as a caption with a checkmark seal, not a pill. Wrap Stripe's message to
two lines. Put the dot inline before the title. Add "Connections" to the sidebar (with a keyboard shortcut).

**M5. The confirm sheet says "Send" in the header and "nothing sends" in the body.**
Screens: `review-confirm-dark.png`, `review-confirm-ready-dark.png`, `review-armed-dark.png`.
File: `Sources/Surfaces/ReviewView.swift` / `Sources/Design/Sheets.swift`.
The recipient box header is "Send 8 emails to these recipients", directly above "Hold all 8 for you to approve as
a batch. Nothing sends before that." On the one screen where trust matters most, the header promises the opposite
of the body. `review-confirm-dark.png` also shows a disabled "Turn on" pill beside the white primary: two
commit-looking buttons.
Fix: header "First batch: 8 recipients (drafted, then held for you)". Remove the disabled Turn on when a
connection is missing; show it only when it can be pressed.

**M6. The general dry run marks mismatches on the wrong side and counts an unknown as a miss.**
Screen: `review-dryrun-general-dark.png`. File: `Sources/Surfaces/ReviewView.swift`.
Harbor Office Co is "4 of 5 match = 80%" because the user's due date is "filled, value not visible". An unreadable
value is not a mismatch, and no field is marked, so the user cannot see which field failed. On Lumen Freight the
amber dot sits only on the user's total, not on Offload's.
Fix: three outcomes per field: match, differs (amber dot on both sides of the row), unknown (grey, excluded from the
denominator: "4 of 4 readable fields match"). Recompute the footer total the same way.

**M7. No evidence that the glass is glass.**
Screens: `live/glass-dark-over-dark.png` and `live/glass-dark-over-white.png` are byte-identical (md5
a1e7a813...), as are the two light captures (md5 48c45d97...). A card captured over a white and a dark backdrop that
produces the same pixels shows no backdrop at all. Either the material is opaque, or the capture does not include
the backdrop. File: `Sources/Design/Glass.swift`, plus the capture script.
Fix: capture the card over a real colored wallpaper with the window composited, and check that the two captures
differ. If they are still identical, use an `NSVisualEffectView` (`.hudWindow` or `.popover`) with the edge ring and a
top specular inset, as in 13-design-getone section 2.

**M8. At 640 pt the single primary truncates.**
Screens: `review-640-dark.png`, `review-real-schedule-dark.png`: "Connect Googl..." in the white primary.
File: `Sources/Surfaces/ReviewView.swift` footer.
Fix: below about 720 pt, shorten the label to "Connect Sheets", or move Discard into an overflow so the primary
keeps its full label. A truncated primary is not acceptable on the commit bar.

### POLISH (about 0.1 each)

- **P1.** "E" means Edit on the review footer (`review-dark.png`); the spec and getone use E to discard or clear.
  Pick one meaning app-wide.
- **P2.** The sheets are custom rounded panels attached flush to the title bar with a square top edge
  (`review-connect-dark.png`, `connections-detail-dark.png`, `review-confirm-dark.png`). Use native sheet
  presentation or give the panel a top radius and an 8 pt gap.
- **P3.** Green is used as decoration: every dry-run card and the card itself carry a green "Saves ..." chip
  (`review-dryrun-dark.png` has three). Green should mean done. Use a neutral chip with a green number, or keep
  green only on the card's total.
- **P4.** The timeline's by-hand bars are near-white (`timeline-dark.png`, `live/dashboard-week.png`), which
  competes with the white primary. The live capture is ribbed with many sub-blocks per row. Merge adjacent same-class
  segments closer than 2 min, and use white at 70% for the data.
- **P5.** Timeline copy: "1.6 h a day on it, so 7.8 h a week" (`timeline-dark.png`). 1.6 x 5 = 8.0, so show 1.56
  or say "about 8 h".
- **P6.** The pointer label still overlaps content: in `live/dashboard-pointer.png` the "Investor outreach emails"
  label covers the Next run column. In `pointer-dark.png` it sits on the card border. Offset it below the target
  row, clamped inside the card.
- **P7.** Voice notes are truncated mid-word in `review-dark.png` ("never round u..."). "from 40 sent emails" is
  repeated on four rows under a header that already says "Measured from 40 sent investor emails". Drop the per-row
  repeats and wrap the notes.
- **P8.** Raw file names in user copy: `live/review-skill.png` shows "recipients.csv", "crm-log.csv", "facts.md",
  "investor-outreach style card". Use the names used elsewhere ("your recipient list", "your facts").
- **P9.** Onboarding step 3 (`onboarding-context-dark.png`) mixes the Claude screen-reading toggle into "What do
  you do?". The "Space" keycap on that toggle conflicts with typing in the two text fields above. Move the toggle to
  step 2 (permissions) and drop the Space binding there.
- **P10.** In dark mode the selected role chip (`onboarding-context-filled-dark.png`, Bookkeeper) is barely lighter
  than the others. Use a white 1.5 px ring, or white fill with dark text as in light mode.
- **P11.** Empty states: the Automations empty state reuses the inbox glyph (`dashboard-automations-empty-dark.png`).
  The live Overview says "Nothing needs you. Everything that is on is running." while Observing shows amber "Not
  recording" (`live/e2e-dashboard.png`). That is a needs-you state: list "Screen Recording is off" under Needs you.
- **P12.** "Review" vs "Review..." on adjacent rows (`dashboard-before-dark.png`). Pick one.
- **P13.** "Back to Turn on" (`review-connected-dark.png`) reads as a typo. Use "Done" or "Back to review".
- **P14.** "Auto-send is on" (`dashboard-autosend-on-dark.png`) offers only Done. Add a secondary "Turn off" so the
  reversal sits where the decision was made.
- **P15.** `dashboard-observing-dark.png` and `dashboard-permissions-dark.png` are byte-identical (md5 d02252ea...), so the permissions state has no distinct evidence. Capture it with a denied permission.
- **P16.** The Overview has no time-saved trend or per-automation breakdown (`dashboard-dark.png`). One sparkline of
  hours saved per week under the headline would make "hours saved" visible over time.

---

## 3. Top 5 MUST-FIX, in order

1. **M2 Tool picker:** "In use" only on the tool that runs; amber "Chosen, connect to use" for unconnected tools; a
   white focus ring, not blue; no duplicated copy; no "MCP server" jargon.
2. **M5 Confirm header:** replace "Send 8 emails to these recipients" with held-batch wording; no disabled Turn on
   next to the primary.
3. **M3 Live dry run:** sample runs labelled amber on every card, the primary becomes "Run with my voice", and the
   diff counts sentences plus the signature.
4. **M4 Connections center:** fix search filtering, add app icons, demote "Checked by Offload" from pill to caption,
   add Connections to the sidebar.
5. **M1 Onboarding privacy sentence:** rewrite it so it parses (proposed text in M1).

(M6 general dry-run field marking, M7 glass evidence and M8 truncated primary are next in line.)

---

## 4. Old findings still open (checked after scoring)

Checked against DESIGN-REVIEW-3, sections 2 and 4.

| Old ID | Finding | Status now | Evidence |
|---|---|---|---|
| M1 | Connect is a dead end / modal on modal | **Closed.** One sheet with waiting, failed, connected states | `review-connect-*.png`, `live/e2e-review-connect.png` |
| M2 | Live dry run argues against the product | **Open (partly).** Now honestly labelled "Sample drafts", but still sample-model, enabled Approve, weak diff (this review M3) | `live/e2e-review-dryrun.png` |
| M3 | Tone not built in live flow | **Not proven.** No live capture shows the "Your voice" table; live edit sheet references a style card | `live/review-skill.png` |
| M4 | Live Automations blank, no empty state | **Closed** | `dashboard-automations-empty-dark.png`, `live/dashboard-automations.png` |
| M5 | Blank overlay in live auto-send | **Closed** | `live/dashboard-autosend.png` |
| M6 | Timeline does not prove the headline | **Closed.** Share is on the chart ("24.7 h · 65%") | `live/dashboard-week.png` |
| M7 | Status colors disagree | **Closed** for state dots. New problem: blue used for focus in the tool picker (M2 here) | `rail-dark.png`, `review-tools-dark.png` |
| M8 | Primary discipline | **Mostly closed.** One white primary per view, except the disabled Turn on beside it (M5 here) and truncation at 640 (M8 here) | `review-dark.png`, `review-confirm-dark.png`, `review-640-dark.png` |
| P1 | Truncated sentences in live | **Open** in other places: voice notes, Stripe subtitle | `review-dark.png`, `connections-dark.png` |
| P2 | Evidence rows all "3 min" | **Closed** | `card-evidence-dark.png` |
| P3 | White used as a data color | **Open** (P4 here) | `timeline-dark.png` |
| P4 | Light mode loses hierarchy | **Closed** | `card-light.png` |
| P5 | Wide shadows on floating surfaces | **Open (minor).** Card and rail still cast a soft wide shadow on light backdrops | `live/glass-light-over-white.png`, `live/e2e-rail.png` |
| P6 | E conflicts with spec | **Open** (P1 here) | `review-dark.png` |
| P7 | Live edit-sheet artifacts | **Closed** visually; new issue is raw file names (P8 here) | `live/review-skill.png` |
| P8 | Sheets not native | **Open** (P2 here) | `review-confirm-dark.png` |
| P9 | Pointer label overlaps a row | **Open** (P6 here) | `live/dashboard-pointer.png` |
| P10 | Empty-state glyph and copy | **Closed** for the inbox; glyph reused on Automations (P11 here) | `card-empty-dark.png` |
| P11 | Never-run automations claim savings | **Closed** ("could save") | `dashboard-automations-dark.png` |
| P12 | "Send without asking..." is a web link | **Closed** (bordered button plus confirm sheet) | `live/dashboard-autosend.png` |

---
QA Agent: EvidenceQA. Status: **NEEDS WORK.** Re-test required after M1-M8.
Screenshots: `/Users/tabani/builds/offload/app/snapshots/` and `/Users/tabani/builds/offload/app/snapshots/live/`.
