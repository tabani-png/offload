# s10e UI round 4 (after DESIGN-REVIEW-3)

Owner: UI (app/, scripts/live-captures.sh, slices/s10e-ui-round4/) and brain (brain/, scripts/demo.sh).
Done-signal: `verify.sh`. Input: `slices/s10-review/DESIGN-REVIEW-3.md` (scored 3.2/5; target 4.5 per screen).
Design tokens unchanged: dark hero, white only for the one primary, colour = state, rings not shadows, radii 24/16/12,
out-expo 150-300 ms, keyboard first.

## MUST-FIX

### M1 Connect is a real flow (no NSAlert, no dead end)
- Brain (additive, API v1): `POST /connectors/:id/link` starts a link, `GET /connectors/:id/link` polls it, both return
  `ConnectLinkDTO { connectorId, name, via: composio|gmail-mcp, state: idle|waiting|connected|failed, url, simulated,
  message, startedAt, connectedAt }`. Stub model: deterministic simulation (waiting, then connected after
  `OFFLOAD_STUB_LINK_MS`, default 2000 ms; persisted in `connect-sim.json`; counted as connected only while the brain
  runs the stub model). Real model: `composio link <toolkit> --no-browser --no-wait` through an injectable runner
  (never run in tests), URL handed to the app, polled until the catalog says connected. A simulated connection can
  never send: nothing is executed through it. `gate.ts` and `allowlist.ts` are byte-identical to the s10d commit.
- App: `ConnectFlow` (Core, pure: intro → starting → waiting → connected | failed, poll cadence, give-up after 5 min)
  and `ConnectCopy` (every string). `ConnectSheet` shows the tool symbol, what Offload reads and sends with it, the route
  as tertiary text ("Connects through Composio" / "Signs in with Google on this Mac"), and one white "Connect Gmail ⌘↩".
  Waiting: blue spinner + "Finish in your browser" (simulated: the brain's demo line). Connected: a green "Gmail
  connected" row, then the sheet returns to the confirm sheet with Turn on enabled. The browser opens only for a real
  (non-simulated) URL. Opened from the confirm sheet's blocked primary, every "Connect…" chip, the review footer's
  primary while a step is blocked, and the dashboard's needs-you action. Connecting never approves or sends.

### M2 Dry run reads like the user
- Brain stub drafts are full emails from the facts and the recipient, signed "Muhammad" (no number outside the facts).
- Diff: a tinted highlight (white 12% on dark, black 8% on light) on changed claim words, no underline anywhere; each
  draft column says "Same as what you sent" or "Changed n phrases".

### M3 "Your voice" is measured
- Brain: `ToneCardDTO.measured` (emails, median and p90 words, sentences, greeting and sign-off with counts, ask and
  exclamation shares, one quoted sentence from a real sent email, source). `demo.sh` builds the tone pack.
- App: `VoiceFacts` (Core) turns it into 4 rows (Length, Greeting, Sign-off, Ask), each with "from N sent emails", one
  quoted line, and "Edit notes" that reveals the text box. Loading: blue spinner "Measuring your voice from your sent
  mail…"; nothing measured: a plain sentence, never an empty box.

### M4 Automations empty state
`AutomationsSection` with no rows: `EmptyState("No automations yet.", "Approve a workflow from the inbox and it shows up
here with the hours it saves.")` and one white "Open the inbox ⌥Space". No column header, no J/K/P legend.

### M5 No blank sheet
Sheets are drawn inside the window by SwiftUI (`InWindowSheet`), attached under the toolbar, inserted with opacity
plus a 7-pt rise (out-expo 200 ms). The content is a function of the model, so no frame shows an empty container
(the old auto-send sheet sized itself in `$autoSend`'s willSet, before the value existed). Snapshot chrome uses the
same view. Scrim: 62% black dark, 38% light (background readable at about 25%; review E1/P8).

### M6 The timeline proves the card
- One dataset per world. Snapshots (`MockWeek`): `before` = Sat 10 to Fri 16, all by hand, the card's week (1,476 of
  2,292 min = 64.4%, 24.6 h of 38.2 h); `rows` = Sat 17 to Fri 23, outreach turned on Wed 21 09:00 (activation day left
  out); after it, one full day (Thu 22) at 94 min (78 by hand, 16 reviewing Offload's batch) = 7.8 h a week, so
  measured = 24.6 − 7.8 = 16.8 h, the overview's hero. The card's evidence spans are in the before week.
- Live (`scripts/live-captures.sh`): ONE demo home from `brain/fixtures/gen.ts` for the e2e, the review, the connect
  flow and every dashboard capture, in that order in one run. Nothing ran live, so live claims no measured hours
  and draws no Offload blocks.
- `TimelinePack.display` replaces the 10-minute fold: a bar's drawn length is its active minutes, same-class
  neighbours within 10 min join, a short foreign sliver between two same-class bars moves after them; every class's
  minutes are preserved exactly (tested). The header prints the focus task's share: "Outreach emails by hand 24.6 h ·
  64%". A "Week before Offload / This week" switch (W) shows both mock weeks; This week's footnote ties the overview
  ("Thu, the full day since: 1.6 h on outreach … 7.8 h a week, down from 24.6 h: saves 16.8 h, measured").
- Tests: by-hand bars of the card's week sum to the card's share within ±2 points (mock, and the live composer on the
  s09a timeline fixtures); measured in the mock = before rate − after rate; no Offload block before activation and no
  automation running for an un-built insight in any snapshot world.
- P3: by hand = ink 85% with a 1-px ring; Offload's run = a full-height block, 15% green fill, 1.5-px green ring, at
  least 16 pt; no hatch.

### M7 One state → colour map
`StatusMap` (Core): blue working now (observer watching, a draft or run in flight), amber needs you, green on and
healthy, grey paused, red only the live mic. Rail dots, the hover card, dashboard rows, the review header and the
sidebar badge all read it (`forAutomation(.running)` is green now). Paused is always grey with ▶; not recording is amber
with ↻ ("Start watching again"). The inbox badge is amber; its count is the inbox's own count and the hover card says
"N suggestions in your inbox".

### M8 One primary, on the unblocking action
- Review footer: while a step's connector is missing, the white primary is "Connect Google Sheets ⌘↩" and Approve is
  secondary. Onboarding: while Screen Recording is missing its "Open Settings ↩" is the primary and "Continue for now"
  is secondary; copy "…until you turn them on". Dashboard: overview's first needs-you action is the primary (else the
  first missing required permission); Observing: the first missing required permission's Open Settings is the primary,
  the observer row does not repeat it, optional permissions get a quiet text button.
- `PrimaryPlan` (Core) picks the one primary per view; tests assert at most one.

## POLISH taken
P1 secondary lines wrap to 2 lines; kept-files copy under 60 characters. P2 evidence rows show measured time per
email ("3 min 12 s"), footer "Plus 1 session in Numbers that was part of this task". P4 light option rows white 70% +
black 6% ring; Recommended ink #6E4500 tested ≥ 4.5:1. P6 the card's hint pill adds "J K move" with more than one card.
P7 steps editor: bottom fade on the scroll area. P9 timeline pointer label stays on the target's row (other rows are
obstacles). P10 empty glyph is the tray symbol; day 7 with nothing: "Week 1 done. Nothing repeated enough yet. Still
watching." P11 a row that never ran says "could save". P12 "Send without asking…" is a bordered ghost button.
Not taken: P6 E-for-discard in the review (E/S/⌘⌫ are pinned by s08 tests and the spec's key map; changing them is a
key-map decision, not polish). P5 window shadows are the OS's (live captures use `-o`).

## Test changes outside this slice
The s08/s10a/s10d fixtures encoded the round-3 contradiction (one week that is both the card's and the automation's).
Updated expectations, no assertion logic removed: S06/S07 `forAutomation(.running)` is `.done` (M7); S10D one-mock-week
tests read `MockWeek.before` (the card's week); S10D fold test now asserts the sum-preserving pack; S10A evidence bar
test reads the before week; S08 sample-week activation checks keep Wed 21 09:00. `s10d-ui-round3/verify.sh` accepts the
live names listed in `slices/s10e-ui-round4/live-set.txt`. Brain tests that pinned the old stub draft text were updated
to the new text only.
