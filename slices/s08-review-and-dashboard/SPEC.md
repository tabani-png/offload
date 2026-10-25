# s08 workflow review and dashboard

Owner: UI. Depends: s06, s07, brain s05 routes (`brain/src/api/types.ts`: workflows, dry run, approve, connectors,
dashboard `state`). Paths: `app/` only, tests in `tests/`. Feel: `adam/memory/research/13-design-getone.md` (12
rules, screens C and D), `12-rea-cua.md` (run timeline), `11-rea-clicky.md` (pointer behaviour, clean-room).

## Goal
After "Build the workflow", the user reviews exactly what will run, sees it re-do last week's real emails next to
what they actually sent, approves with one key behind a confirmation and a 5-second Esc, then watches hours saved
on a dashboard that says honestly what is measured and what is estimated.

## s07 review fixes
1. **Glass legibility.** The material view is pinned to `.vibrantDark` / `.vibrantLight`. The veil opacity is solved
   (`GlassVeil`) for the worst backdrop (white under the dark card, black under the light one), so the faintest
   text keeps 4.5:1 (7:1 with Increase Contrast; opaque with Reduce Transparency). No pixels behind the panel are
   ever read. Material constants are fitted to live captures over our own white and near-black windows.
2. **Evidence titles.** Counterparty first (from the instance's `counterparties`), then the subject, tail
   truncation only. A copy of the counterparty already in the title is removed. The usual app is said once.
3. **Connector chips** read GET /connectors: green connected, amber "Add key…" (`missing_env`), grey "Connect…".

## Workflow review window (`ReviewWindowController`, `ReviewView`, `ApprovalFlow`)
- Normal titled window, unified toolbar (title "Review workflow", subtitle), no sidebar, content centred at most
  720 pt. Toolbar item: SKILL.md.
- Header: name, connectors (live state), schedule note and batch size, estimated saving.
- Steps: vertical list, one SF Symbol per step type; the approval gate is an amber band with a lock and an
  "Approval gate" tag, and every side-effect step sits after it.
- SKILL.md in a sheet (S read-only, E editable). Tone card editable inline (says so when the brain serves none).
- Dry run: per instance, counterparty and subject, "3.2 min by hand → 20 s to review", the saved minutes, and
  "Our draft" beside "What you sent" with diff-lite marks (changed words only, neutral mark, never whitespace).
- Actions: Discard ⌘⌫ (5 s, Esc undoes) · Run dry run again R · Edit E · Approve ⌘↩ (the one white button).
- Approve opens a confirmation with the first-run plan: "Send N emails to these recipients" (names, firms,
  addresses from the pending batch), the steps in order, and any connector after the gate that is not ready. ↩
  confirms (ignored for 0.5 s after opening), then a blue hairline counts 5 s; Esc cancels; only then is
  POST /workflows/:id/approve sent, with the dry run's `batchHash`.

## Dashboard window (`DashboardWindowController`, `DashboardView`)
- Opens from the rail "…" menu (Dashboard ⌘D) and with ⌘D while the card is open; ⌘D closes it.
- Hero: "Hours saved this week", measured when the brain has it (labelled Measured, with the share of the
  estimate), else Estimated with why there is no measurement yet.
- Automations: StatusDot, name, connectors, last run, next run, hours (estimated or measured, labelled); needs-you
  rows on top in amber. J/K select, P points, ↩ opens the review.
- This week: one row per day, a bar per span tinted by task (pastels, not status hues), time on an automated task
  after its activation hatched, a now-line, a legend. "Show the evidence" (2).
- Observing: state and days stored, next purge, pause/resume, permissions (amber only for a required one).

## Pointer (`PointerFlight`, `PointerOverlay`)
"Show the evidence" or P on a needs-you row: a blue arrow flies a quadratic arc (control lifted
min(d × 0.2, 80) pt, smoothstep, clamp(d / 800, 0.6, 1.4) s) to the element inside our own window, says one line,
holds 3 s, flies back. Reduce Motion: fade in place. It is a view inside our window: no overlay window, no
global coordinates, no other app.

## Done signal
`slices/s08-review-and-dashboard/verify.sh` exits 0: the app builds, at least 60 S08 tests and at least 80 tests in
total pass, a fresh 2x render contains review, review-dryrun, review-confirm, dashboard, timeline and pointer in
dark and light, the committed 1x set and the live captures exist in `app/snapshots/`, and DESIGN-REVIEW.md exists.
