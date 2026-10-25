# s07 rail and insight card

Owner: UI. Depends: s06, brain API v1 (`brain/src/api/types.ts`). Paths: `app/Sources/Core/{InboxState,Format,
Models,BrainWire,BrainClient}.swift`, `app/Sources/Surfaces/`, `app/Sources/App/`, tests in `tests/`.

## Goal
Ambient first, interrupt rarely: a quiet edge rail that shows state, and one card that asks one question with a
one-key answer and an undo window.

## Rail (`RailView`, `RailController`)
- Borderless, non-activating `NSPanel` at `.floating`, pinned 8 pt from the right edge of the main screen's visible
  frame, vertically centred. Never becomes key or main, never activates the app; first click works on its buttons.
- Collection behaviour `canJoinAllSpaces, stationary, ignoresCycle`, and deliberately not `fullScreenAuxiliary`:
  it stays out of full-screen Spaces.
- Capsules: inbox (tray; amber badge with the waiting count, 9+ cap, hidden at 0) · status (observer dot first:
  watching = blue pulse, paused or no data = grey, stale = amber; then one dot per active automation, at most 5, then
  "+n") · tools (pause/resume, mic (red only while live), more menu). Hovering the status capsule shows
  "Watching · Day 4 of 7" beside it.

## Insight card (`InsightCardView`, `CardController`)
- Opens from the inbox capsule or the global hotkey **⌥Space** (Carbon `RegisterEventHotKey`: no Accessibility or
  Input Monitoring permission). Keyable non-activating panel: it takes keys, the app you were in stays active.
  Anchored left of the rail, top level with the inbox capsule; grows downward. A click outside closes it.
- Content: "You spent 65% of your week on investor outreach emails." · arithmetic "500 emails × ~3 min = 25 h of
  38.5 h tracked" · share hairline · saving chip (range) with the brain's arithmetic verbatim · connectors as chips
  · options 1 Build the workflow (Recommended) / 2 Show the evidence / 3 Not now.
- Keys (`CardKey`, `InboxState`): 1 and 3 and E stage an action behind a 5-second undo window with a blue hairline
  countdown; Esc inside the window undoes; after it the action lands and the next insight slides in. 2 toggles the
  evidence list (time, title, app, minutes per span). J/K page and stop at the ends. Esc peels one layer: undo, then
  evidence, then the card. A new choice while one is staged lands the staged one first. ⌘/⌃ chords pass through.
- Empty: "Nothing to decide. Still watching. Offload speaks up when a task starts to repeat." with the observer label.

## Data
`BrainClient` protocol; `MockBrainClient` serves three insights (outreach 65%, scheduling 14%, CRM updates 9%) with
evidence, status and automations. `BrainWire.swift` mirrors `types.ts` 1:1 (epoch ms, 0..1 ratios) and maps onto
the view models; the brain's saving arithmetic is shown verbatim, never recomputed (ADR 0005).

## Done signal
`slices/s07-rail-and-card/verify.sh` exits 0: app bundle builds, at least 15 S07 tests pass (whole suite at least
15), snapshot mode renders rail, card, card-evidence, card-undo, card-empty and scene in both appearances, the
committed review set exists in `app/snapshots/`, and `DESIGN-REVIEW.md` exists.
