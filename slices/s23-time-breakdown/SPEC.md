---
id: s23-time-breakdown
title: Lead with where your time goes - breakdown by task, app and kind of work; findings with code-computed hours; fix kind; workflows last
depends_on: [s03-brain-core (spans, tasks, evidence), s04-insights (insights, s04 saving estimate), s10f-ui-round5 (review screen, live captures)]
soft_depends_on: [s22-solution-designer (PR #17, not merged: fix kinds when present, none when absent)]
parallel_safe: false (touches api/server.ts, Dashboard.swift, Copy.swift, Figures.swift, scripts/live-captures.sh)
human_gated: false (the live capture needs an unlocked screen; CI skips it as s10f does)
verify: bash slices/s23-time-breakdown/verify.sh
paths_in_scope: [brain/src/time/**, brain/src/api/server.ts (one route seam for GET /time), brain/src/api/types.ts (additive Time* types), brain/API.md, brain/fixtures/gen-neutral.ts, app/Sources/Core/** (TimeBreakdown, HoursFormat, FixKind, TimeScreen, NeutralWeek, DashboardSection, BrainClient + HTTP + mock, ReviewCopy chips + dryRunWith, ReviewPrimary.done, ReviewFooterButtons, ReviewMessages, Figures.hours), app/Sources/Surfaces/** (TimeView, DashboardView, DashboardModel, ReviewView), app/Sources/App/Snapshotter.swift, app/Sources/App/OffloadApp.swift (QA lines only), app/build.sh (add the S23 test folder), app/snapshots/** (new and re-rendered PNGs), scripts/demo.sh (--neutral), scripts/live-captures.sh (time captures), slices/s10e-ui-round4/live-set.txt (add time-week, time-day), slices/s23-time-breakdown/tests/fixtures/** (recorded by record.ts only)]
paths_out_of_scope: [engine/**, packet/**, schemas/**, web/**, control/**, brain/src/insights/**, brain/src/solutions/** (s22 owns it), brain/fixtures/gen.ts, brain/fixtures/gen-domains.ts, brain/package.json, brain/bun.lock, every other test folder, the frozen contract files below]
frozen: [slices/s23-time-breakdown/SPEC.md, slices/s23-time-breakdown/verify.sh, slices/s23-time-breakdown/record.ts, slices/s23-time-breakdown/tests/S23Tests.swift, brain/tests/s23-time-breakdown/**]
---

# s23 time breakdown

## Operator intent (binding)
- The app LEADS with where the user's time goes: a breakdown by task, by app and by kind of work, as metrics for the
  selected week or day.
- Next: what could be more efficient and how many hours that frees. Every hour figure is computed in code (ADR 0005)
  and links to its events.
- Next: the best KIND of fix per finding (workflow, custom tool, setup change, remove the step, leave alone), from the
  s22 solution designer (PR #17). If s22 is not merged the finding is shown without a fix kind, never a fake one.
- Workflows come last, as the answer to a finding. The goal is helping people get the most from their time, not
  pushing automations.
- Demo data is NEUTRAL mixed work (coding-agent sessions, docs, meetings, spreadsheets, browsing, some email). The
  outreach-heavy s09 week is not the default for this screen.
- No inflated saving claims on this screen (no 87-90% "read + approve" percentages).

Sources: ADR 0003 (metadata first: the breakdown reads spans, never content), ADR 0005 (numbers by code, every number
links to event ids), ADR 0006 (nothing here drafts, approves or sends), s22 SPEC on branch `s22-solution-designer`
(`SolutionKind`, `SolutionSet.top`, `observedWeeklyHours`), PR #13 review follow-ups.

## Brain

### `GET /time[?day=YYYY-MM-DD][&window=week]` → `TimeBreakdownResponse`
Types in `brain/src/api/types.ts` (additive, API v1): `TimeBreakdownResponse`, `TimeMetric`, `TimeRow`, `TimeFinding`.
Documented in `brain/API.md` under a `## GET /time` heading (rounding rule and the fix-kind fallback included).

```ts
interface TimeMetric { value: number; unit: "minutes" | "hours_per_week"; display: string; eventIds: string[] }
interface TimeRow { id: string; name: string; minutes: TimeMetric; share: number; spanIds: string[] }
interface TimeFinding {
  id: string; taskId: string; insightId: string; name: string;
  taskMinutes: TimeMetric;          // the task's minutes in the window: same value and display as its byTask row
  observedHoursPerWeek: TimeMetric; // task week minutes / 60 x 7 / window days (s22's observed formula)
  hoursFreed: TimeMetric;           // see "Hours freed"; never above observedHoursPerWeek
  arithmetic: string;               // the inputs and the result, ending with hoursFreed.display
  fixKind: "workflow" | "tool" | "setup" | "remove_step" | "leave_alone" | null;
  workflowInsightId: string | null;
}
interface TimeBreakdownResponse {
  version: 1;
  window: { kind: "week" | "day"; days: string[] };
  total: TimeMetric;                       // minutes
  byTask: TimeRow[]; byApp: TimeRow[]; byKind: TimeRow[];
  findings: TimeFinding[];
  fixKinds: "s22" | "absent";
  rounding: "tenths-half-up";
}
```

- No `day`: the week (the store's window, 7 days). `day=`: that stored day only (400 malformed, 404 not stored).
  `window` other than `week` is 400. GET only (405 otherwise); same token, Host and Origin policy as every route.
- Totals tie to events: `total.value` = the active minutes of every span (sessionized as `analyze.ts` does);
  `total.eventIds` = exactly the event ids behind those spans.
- Each dimension partitions the spans: every span is in exactly one row; a row's `minutes.value` = the sum of its
  spans' active minutes; its `eventIds` = the union of its spans' event ids; `share` = minutes / total. The unrounded
  minutes of each dimension sum to `total.value` (within 1e-6). Rows sort by minutes, most first, ties by id.
  - `byTask`: one row per task (`t_...`); spans in no task go to one row `id: "unsorted"`.
  - `byApp`: one row per app bundle id; `name` is the app name.
  - `byKind`: fixed ids in this order, `WORK_KINDS` in `brain/src/time/kinds.ts`, with these names:
    `code` Coding, `docs` Docs, `meeting` Meetings, `sheet` Spreadsheets, `email` Email, `chat` Chat,
    `browse` Browsing, `other` Other. `kindOfSpan(span)` is deterministic (app bundle id, host, URL path, no model):
    Terminal / VS Code / Cursor / Xcode = code; Google Docs (`docs.google.com/document`), Notion, Pages, Word = docs;
    Google Sheets (`docs.google.com/spreadsheets`), Excel, Numbers = sheet; Zoom, Meet, Teams, Calendar = meeting;
    Gmail, Mail, Outlook = email; Slack, Messages, Discord = chat; any other site in a browser = browse; else other.
    The known answers are in `breakdown.test.ts` (KINDS).
- Every `{value, display}` in the response carries `eventIds`; non-empty when the value is above zero; all in the store.

### Rounding (one rule everywhere)
Hours are shown to a tenth, half up: `tenths = floor(hours x 10 + 0.5 + 1e-9)`, display `"<tenths/10 with 1 decimal> h"`.
`brain/src/time/format.ts` exports `hoursTenths(hours)` and `formatHours(hours)`. Every `display` in the response is
`formatHours(value)` (minutes are shown as hours: `formatHours(value / 60)`). Known answers: 24.65 h (1479 min) → 24.7 h
(printf `%.1f` says 24.6), 24.705 h → 24.7 h, 24.75 h → 24.8 h, 0.05 h → 0.1 h, 2.45 h → 2.5 h. The same quantity has
one figure: a finding's `taskMinutes` equals its task row (value and display), and the finding's observed hours come
from those minutes, never from instances x median (the source of "24.6 h/wk" next to "24.7 h" on the outreach week).
The app uses the same rule (`HoursFormat`), and `Figures.hours` follows it.

### Findings and hours freed (ADR 0005)
Findings are the analysis's insights (same ids and task ids; nothing invented), sorted by `hoursFreed`, most first.
`brain/src/time/breakdown.ts` exports
`timeBreakdown(a: Analysis, opts?: { day?: DayLabel; fixOf?: FixOf | null }): Promise<TimeBreakdownResponse>` with
`type FixOf = (insight: Insight) => Promise<{ kind: SolutionKind; weeklyHoursSaved: number } | null>`.
- `fixOf: null` (or s22 absent): `fixKind: null`, `fixKinds: "absent"`,
  `hoursFreed = min(observedHoursPerWeek, insight.saving.weeklyHoursSaved)`.
- A fix source answer: `fixKind` = its kind if it is one of the five, else null (never guessed);
  `hoursFreed = min(observedHoursPerWeek, answer.weeklyHoursSaved)`; `fixKinds: "s22"`.
- `fixOf` undefined (the API): s22 if `brain/src/solutions/` exists (the top option of the rules' solution set, the
  same `top` and `weeklyHoursSaved` as `GET /insights/:id/solutions`), else absent. GET /time makes NO model call
  (no Opus wording pass), and two calls give the same body.
- No saving percentage, range, `savingPct` or s04 review chain ("→ review ... h/wk") on a finding; no `%` in any
  finding string; no "read + approve" wording; nothing in the response claims an 85-100% saving.
- `workflowInsightId` = `insightId` only when `fixKind` is null or `"workflow"`; else null. The response has no
  workflow, automation or suggestion list of its own. Reading time drafts nothing (no workflow folder appears).

### Neutral demo week
`brain/fixtures/gen-neutral.ts` exports `generateNeutralWeek(opts?: FixtureOptions): FixtureDay[]` (deterministic per
seed; default start Mon 2026-10-12, 7 days) in the store format of `gen.ts` (written with `writeFixture`), and has a
CLI like gen.ts: `bun run brain/fixtures/gen-neutral.ts --out DIR [--seed N] [--encrypted] [--start D]`. On seed 42:
weekdays 5-9 active hours, weekend under 3 h, over 25 h in total; by kind: code >= 15% (Claude Code sessions in a
terminal >= 5% of the week), docs >= 8%, meetings >= 8%, spreadsheets >= 5%, browsing >= 5%, email > 0 and <= 15%, no
kind above 40%; no event text matching the outreach words (outreach, investor, cold email, prospect, fundraising,
seed round, Instantly, Apollo, Smartlead, lemlist); at least two findings that free time, none of kind
`email.outreach`. `scripts/demo.sh --neutral` seeds it (`scratch/demo-neutral`); the default demo stays as it is for
the review flow captures.

## App

### Model and client (Core)
- `TimeBreakdown` (Equatable, `static func decode(_ data: Data) throws -> TimeBreakdown`, `static let empty`):
  `window` (`kind: .week | .day`, `days`), `total`, `byTask`, `byApp`, `byKind` (`TimeRow`: `id`, `name`,
  `minutes: TimeMetric`, `share`, `spanIds`), `findings` (`TimeFinding`: `id`, `taskId`, `insightId`, `name`,
  `taskMinutes`, `observedHoursPerWeek`, `hoursFreed`, `arithmetic`, `fixKind: FixKind?`, `workflowInsightId`),
  `fixKindsAvailable` (`fixKinds == "s22"`). An unknown fix kind on the wire decodes to nil.
- `FixKind`: `workflow`, `tool`, `setup`, `removeStep` = `remove_step`, `leaveAlone` = `leave_alone`; labels
  "Workflow", "Custom tool", "Setup change", "Remove the step", "Leave it alone".
- `BrainClient.timeBreakdown(day: String?)`: HTTP `GET /time` (`?day=` when given); `MockBrainClient` returns
  `NeutralWeek.breakdown`, a neutral sample that obeys the brain's invariants (sums tie, one rounding rule, hours
  capped, event ids present). The outreach `SampleWeek` is not used by this screen.
- `HoursFormat.tenths(hours:)`, `.display(hours:)`, `.display(minutes:)`: the rounding rule above. `Figures.hours`
  gives the same string for the same hours.

### First screen: `TimeScreen(_ b: TimeBreakdown)`
- `sections`: `[.breakdown, .findings, .workflows]` (`.workflows` only when a finding has a workflow answer);
  `[.breakdown]` for an empty week, with `emptyLine`. `qaSections` = the raw values joined by commas.
- `dimensions` `[.task, .app, .kind]`, titles "By task", "By app", "By kind of work"; `rows(_:)` per dimension, each
  row's `hours` is the brain's display; `totalLine` contains the total's display.
- `findings` in the brain's order: `parts` `[.name, .hours, .fixKind]`, or `[.name, .hours]` with no fix kind;
  `hoursLine` contains `hoursFreed.display`; `taskHours` equals the task row's `hours`; `fixLabel` (nil when absent);
  `allStrings`. No `%`, no "read + approve" in any finding string.
- `workflows`: one per finding with `workflowInsightId` whose fix kind is nil or `.workflow` (`findingId`,
  `insightId`), after all findings. A finding whose fix is not a workflow is never answered with one.
- `DashboardSection.time` is the first case and `DashboardSection.home` (title "Your time", ⌘1); the dashboard opens
  on it (`DashboardModel` starts on `DashboardSection.home`). `TimeView` draws the sections in `TimeScreen.sections`
  order.

### PR #13 follow-ups (folded in)
- F1 runsWith: the dry-run header names the tools the run used (`runsWith`): "With Gmail and Google Sheets" on the
  outreach tools sample, never "Instantly" while Gmail does the sending.
- F2 one rounding rule: `Figures.hours` = `HoursFormat` on the known answers (no 24.6 / 24.7 / 24.8 drift).
- F3 Sheets chip: `ReviewCopy.chips` (`[ConnectorChipModel]`) agree with the tool picker: the Google Sheets chip is
  green (`.done`) exactly when step s7's Google Sheets option is connected.
- F4 after Turn on: for an active workflow `ReviewPrimary.forWorkflow` is `.done` ("Done") with or without a sample;
  `ReviewFooterButtons.secondary(_:sample:)` has no Approve and no "Run with my voice"; the status line reads
  "Turned on. First run tomorrow ..." (lower case today / tomorrow mid-sentence).
- F5 capture size budget: every s23 PNG (snapshot and live) <= 400 KB; every PNG in `app/snapshots/live` <= 1024 KB;
  `app/snapshots/live` <= 10 MB in total.

### Snapshots and live captures
- `--snapshot` renders `time-week`, `time-day`, `time-nofix`, `time-empty` in dark and light from `NeutralWeek`
  (never `SampleWeek`), committed under `app/snapshots/`.
- `scripts/live-captures.sh --only time` (and the full run) seeds the neutral week (`scripts/demo.sh --neutral`),
  starts the app on it with the REAL brain on the offline sample model, captures our window as
  `app/snapshots/live/time-week.png` and `time-day.png`, and writes `app/snapshots/live/time-week.qa.txt` from the
  app's QA file with these lines: `demo=neutral`, `sections=<TimeScreen.qaSections>`, `total=<total line display>`,
  `brain-total=<GET /time total.display read by the script from the brain>`, `findings=<count>`,
  `fix-kinds=s22|absent`. Both names join `slices/s10e-ui-round4/live-set.txt`.

## Acceptance (tags)
Brain (test name prefix in `brain/tests/s23-time-breakdown/`, each must exist and pass):
- TOTAL: the week and day totals tie to the events, recomputed from the store; day totals add up to the week.
- SUMS: each dimension partitions the spans; rows recompute from their spans; sorted; unsorted row.
- REFS: row event ids = union of span event ids; every number has event ids; findings point at their own task.
- KINDS: fixed kind list and names; known answers per app and site.
- ROUND: the rounding rule's known answers; every display = formatHours(value); same quantity, same figure.
- FREED: findings = insights; observed formula; min(observed, s04) without s22; capped even against a greedy fix
  source; arithmetic ends with the display; no model call; deterministic.
- NOCLAIM: no percentage, range or review chain; no 85-100% claims; neutral findings are not outreach.
- FIXKIND: absent → null and "absent"; unknown kinds → null; injected kind passes through with capped hours; the API
  matches s22's `top` when merged.
- WORKFLOW: workflow only for workflow / unknown fixes; nothing drafted; no workflow list of its own.
- NEUTRAL: the neutral week's shape, determinism, no outreach words, CLI and `demo.sh --neutral`.
- API: route, params, errors, network policy, API.md, exported types.

App (Swift Testing suites in `tests/S23Tests.swift`, each suite must run and pass, >= 26 tests):
- `S23 wire` [WIRE], `S23 rounding` [ROUND], `S23 first screen order` [ORDER], `S23 fix kind` [FIXKIND],
  `S23 no inflated claims` [NOCLAIM], `S23 neutral demo` [NEUTRAL], `S23 home` [HOME], `S23 PR13 follow-ups` [F1-F4].

verify.sh steps:
- `contract`: the frozen files exist; only `test(s23-time-breakdown)` commits touch them.
- `brain`: no new dependency; typecheck; the s23 suite (>= 45 tests, every brain tag passing); the full brain suite.
- `fixtures`: `record.ts --check`: the committed app fixtures are the brain's own answer, byte for byte.
- `app`: build; `S23` suites (>= 26 tests, every suite passed); every app suite (>= 430 tests).
- `views`: `TimeView.swift` exists and reads `TimeScreen`; the dashboard opens on `DashboardSection.home`; no
  `SampleWeek` in `TimeView.swift` or the time snapshot scenes; no `savingPct` or `%` literal in `TimeView.swift`.
- `snapshots`: a fresh 2x render has `time-week|day|nofix|empty` in dark and light, committed, each <= 400 KB.
- `live` (skipped when `CI=true`): `time-week.png` and `time-day.png` exist, each <= 400 KB; `time-week.qa.txt` says `demo=neutral`, `sections=breakdown,findings...`
  (breakdown first, workflows last if present), `total` = `brain-total`, `findings` >= 2, and has no outreach word;
  both names are in the live set.
- `budget` (F5): every PNG in `app/snapshots/live` <= 1024 KB, the folder <= 10 MB.
- `scope`: files touched by s23 commits since BASE are in scope.

## Cannot pass vacuously
- An empty or missing store fails TOTAL (> 600 min, > 50 spans), SUMS (>= 5 / 6 rows), REFS (> 20 numbers walked),
  FREED (>= 2 findings freeing time) and the app WIRE checks (fixtures > 2 KB, >= 2 findings).
- The rounding table is checked against the written rule inside the test (refTenths), so a wrong table fails too.
- The fix-kind tests run both paths whatever is merged: the absent path through `fixOf: null`, the present path
  through injected answers; the API test follows `S22_PRESENT` and names which path it ran.
- The app fixtures cannot be hand-written: `record.ts --check` regenerates them from the brain and diffs bytes.
- verify.sh counts tests per brain tag and per Swift suite; a tag with 0 passing tests fails. A missing file fails its
  own check; every check runs and prints one FAIL line, so a red run shows every reason at once.

## Not done here
s22 itself (its rules, briefs and routes), the timeline page, changing the s04 estimator, sites inside a browser as
their own "apps", a month window, any change to what the observer records.
