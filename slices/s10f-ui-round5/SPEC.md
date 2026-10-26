# s10f UI round 5 (after DESIGN-REVIEW-4)

Owner: UI (app/, scripts/live-captures.sh, slices/s10f-ui-round5/). Done-signal: `verify.sh`.
Input: `slices/s10-review/DESIGN-REVIEW-4.md` (branch `design-review-4`, scored 3.7/5). Design tokens unchanged: dark
hero, white only for the one primary, colour = state, rings not shadows, radii 24/16/12, out-expo 150-300 ms,
keyboard first. Every check below is a Swift Testing test in `tests/S10FTests.swift` (tag in brackets) or a step in
`verify.sh` (marked `verify`). Checks were written before the code.

## MUST-FIX

### M1 Onboarding step 1 privacy sentence parses
- `OnboardingCopy.localNote` is exactly: "Everything stays on this Mac, encrypted. If you turn on Claude, only masked
  text and masked screenshots go to your Claude account, to read and draft. Nothing else leaves this Mac." [M1]

### M2 Tool picker states agree
- `ToolsCopy.Option.mark`: `.inUse` only on the option the runner uses today (`runsWith` is its id or connector id) and
  that is connected; `.chosenNeedsConnect` on a chosen option that is not connected ("Chosen, connect to use", amber);
  nothing on the rest. At most one `.inUse` per step. In the outreach sample: step 6 Gmail is In use, Instantly is
  "Chosen, connect to use"; step 7 nobody is In use, Google Sheets is "Chosen, connect to use". [M2]
- The suggestion line is the reason only: "Recommended: <first clause of the chosen tool's why>", never the card body
  word for word, never "MCP server", "Composio" or "via". [M2]
- Keyboard focus on a tool option is a white ring at 40%, 2 pt (`FocusRing`), never the blue working colour
  (`verify`: PlanViews.swift has no `status(.working)` on an option stroke). [M2]
- Brain: `viaWords` for an MCP option says "Connect <name>." instead of "Connect its MCP server." (`verify` grep).

### M3 Live dry run: sample labelled, sentence-level diff
- A sample dry run (`model == "stub"`): every draft card carries an amber "Sample, not your voice" header; the footer's
  white primary is "Run with my voice" (⌘↩ reruns the dry run; Run again is not shown twice); Approve and Connect are
  secondary. `ReviewPrimary.forWorkflow(_:sample:)` returns `.runWithVoice` first for a sample run. [M3]
- If a rerun is still a sample, the bar says why in plain words (the offline sample model is on), never silently. [M3]
- `SentenceDiff`: counts changed sentences ("Changed 1 of 4 sentences"); a reworded sentence counts once however many
  words changed; the sign-off block (trailing short lines: "Best," / a name / a signature line) is compared on its own
  and a difference adds "sign-off differs"; identical text says "Same as what you sent". Highlights are contiguous
  spans (one span per changed sentence, from its first to its last changed claim word), not single words. [M3]

### M4 Connections center
- Search filters by app name (and toolkit); a row that matched on a tool name says "Matches: <tool>" in its
  subtitle; a row the brain returned for its description says "Matches what it does: …". "lin" in the sample returns
  Linear only. [M4]
- Each row has a 32 pt app tile (radius 12, neutral fill and ring, a monogram from the app's name; no third-party
  logos, s06 rule 5). `AppMark.monogram` is tested. [M4]
- "Checked by Offload" is a caption with a checkmark seal, not a pill (`verify`: no `Chip(text: ConnectionsCopy.verifiedChip`). [M4]
- Row subtitles wrap to 2 lines (Stripe's instruction is readable); the sheet's status dot sits inline before the
  title (`verify` greps). [M4]
- The dashboard sidebar has a "Connections" entry with ⌘K that opens the Connections window
  (`DashboardSidebarLink.connections`). [M4]

### M5 Confirm sheet header and Turn on
- `FirstRunPlan.headline` with a gate: "First batch: 8 recipients (drafted, then held for you)"; without a gate:
  "First batch: 8 recipients". Never "Send … to these recipients". [M5]
- While a connection is missing the sheet shows Cancel and the white Connect only; the disabled Turn on is gone
  (`verify`: ReviewView.swift has no `.disabled(true)` Turn on). [M5]

## Next in line

### M6 General dry run: unknown is not a mismatch
- Each field is `.match`, `.differs` (amber dot on both sides of the row) or `.unknown` (grey dot, excluded from the
  denominator). Harbor Office Co: "4 of 4 readable fields match" and green; Lumen Freight: "5 of 6 fields match",
  dot on Offload's and your Total. The footer is recomputed the same way: "14 of 15 readable fields the same across
  3 bills = 93%". [M6]

### M7 Glass composites over the backdrop
- `scripts/live-captures.sh` captures the glass card as the composited screen rect (`screencapture -R`), not the
  window alone, over white, near-black and a coloured backdrop. `verify` (local, needs the live set): the over-white and
  over-dark captures differ (md5), for both appearances. If they were identical the material would be opaque.

### M8 640 pt keeps the primary whole
- Below 720 pt the footer uses `ReviewPrimary.title(compact: true)`: "Connect Sheets", "Sign in to HubSpot" stays,
  "Run with my voice" stays; the primary never truncates (fixed size, highest layout priority). [M8]

## Review-3 items still open (cheap)
- P1 truncation: the voice notes line wraps to 2 lines; "from N sent emails" is said once in the section header, not
  on every row (`verify`: no `Text(r.source)`). Stripe's row subtitle wraps (M4).
- P3 white/green as data colour: the per-draft and per-bill "Saves …" chips are neutral; green stays on the card's
  total (`verify` grep). The timeline's by-hand focus bar was already white at 70% (`TimelineInk.focusFill`, s10e).
- P6 E means Edit everywhere: no surface binds E to discard or clear (`verify` grep); the key map is unchanged.
- P9 pointer label: for a row target the label goes below the target's row (`PointerLabelPlacement.place(... row:)`),
  above it when nothing below is free, never on the row itself, clamped inside the bounds. [P9]

## MCP server run confirm (s17 security review)
- Before a connector server that is a command is started (the brain's setup lists its tools, which runs it), the sheet
  shows "This will download and run code on this Mac" (npx, uvx, bunx, docker, pipx) or "This will run code on this
  Mac" (node, python3, anything else) with the exact command line, Cancel as the default (↩ and esc cancel), and
  "Download and run" / "Run it" as a secondary button. An https server goes straight to the check. [MCP]
- `ConnectionSheetFlow`: `.enterServer` + command → `.confirmRun`; `primary()` there cancels back to `.enterServer`;
  only `confirmRun()` emits `.addServer`. [MCP]
- Snapshot `connections-run-confirm` (dark, light).

## Polish that fell out
- P13 "Back to Turn on" reads "Back to review" (`verify` grep). P12 the secondary "Review…" drops its ellipsis.

## Test changes outside this slice
Recorded in the commit: tests that pinned the old headline ("Send 8 emails to these recipients"), the old privacy
sentence, "In use" on the chosen tool, or the brain's "Connect its MCP server." are updated to the new wording only; no
assertion logic removed. The s10e live set (`slices/s10e-ui-round4/live-set.txt`) gains `glass-dark-over-color` and
`glass-light-over-color`.

## Not done
The other 15 polish items of review 4 (P2 native sheets, P4/P5 timeline, P7/P8 copy, P10-P16), except P13.
