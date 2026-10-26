---
id: s27-workflow-reads
title: Workflows fetch their own data - the read step is learned from the recordings, read through the connector chain read-only, and feeds the live batch
depends_on: [s13 (chain, gate, computer use), s14 (general plan, dry run), s17 (Composio reads), s26 (live batches for general plans, row key, done log)]
parallel_safe: true (seams in runner.ts, gate.ts, drafter.ts, plan/dryrun.ts, workflows/dryrun.ts, service.ts, workflow-routes.ts, server.ts)
human_gated: false
verify: bash slices/s27-workflow-reads/verify.sh
paths_in_scope: [brain/tests/s27-workflow-reads/**, slices/s27-workflow-reads/**, brain/src/plan/read-source.ts (new), brain/src/workflows/read-fetch.ts (new), brain/src/workflows/gate.ts (read mode only), brain/src/workflows/types.ts (additive), brain/src/workflows/drafter.ts (read step on build), brain/src/workflows/plan-live.ts, brain/src/workflows/runner.ts (prepareLiveBatch seam), brain/src/workflows/dryrun.ts (read preview, totals), brain/src/plan/dryrun.ts (source fields, read minutes), brain/src/workflows/service.ts (estimate and measured with reading), brain/src/api/workflow-routes.ts (pass the fetcher), brain/src/api/server.ts (readers option), brain/src/api/types.ts (additive), brain/src/api/s14-types.ts (additive), brain/src/workflows/batch.ts (additive `source`), brain/src/api/scheduler.ts (pass the fetcher), brain/src/understanding/surfaces.ts (one known product: PostHog), brain/src/connectors/api.ts (round 2: shared read resolver), brain/src/workflows/executor.ts (Claude key via apiKeyHelper), brain/tests/s05b-privacy/privacy.test.ts (one assertion, scope change below), brain/src/connectors/computer/{ax-text.ts (new), driver.ts, osa-driver.ts} (round 8: one accessibility-line format), brain/API.md, plan/plan.md (s27 row, ADR line), plan/adr/0015-read-steps.md]
paths_out_of_scope: [engine/**, app/**, control/**, web/**, packet/**, schemas/**, brain/src/builder/** (the builder stays off), brain/fixtures/**, brain/src/connectors/** (read-only use, except the one shared read resolver `apiReadOperations` in connectors/api.ts, round 2), every other slice's tests]
---

# s27 workflows fetch their own data (read steps)

## Operator intent (binding, 2026-10-26)
"Once installed it records, and then fetches the data." Offload must learn from the recordings WHERE a repeated
task's values come from, and then read them itself, instead of the person filling a file. s26 left this open: the
live items of a general workflow come from the person's `items.csv`, so for "Team metrics into a Google Sheet" the
only saving was the typing.

## Design
1. **Understanding: the source step** (`plan/read-source.ts`, pure code over the Analysis, ADR 0005). For every
   instance of the task, the spans just before it (same day, ending at most 3 minutes before it starts, at most the 2
   nearest, not part of the task, not the task's own app or site) are candidate sources, keyed by site (host) or app.
   The values the person typed are read from the commit screen's masked OCR (a table header with a row of values, or
   `Label: value` lines). A candidate is the source when it comes right before at least half of the instances (and at
   least 2), and on at least half of those (and at least 2) the typed values were on its screen (its OCR, or its frame
   notes: activity, object, inputs, outputs, identifiers). Values match as whole tokens (`3` never matches inside
   `43`). Each field read = the commit label + the label shown before the value on the source (majority vote), kept
   when it was found on at least half of the matching instances. Labels must be plain words (letters and spaces, up to
   4 words): no value, number or address is ever stored. The result is stored on the workflow (`workflow.json`
   `read`, additive): target id and name, app / host, fields, instances seen, reading seconds per instance and reading
   hours per week (code arithmetic), evidence span / event / frame ids. No source is invented: nothing qualifies =
   no `read`.
2. **Plan: a read step before the commit.** Both plan variants get the step `read_source` (type read, capability
   role read, never gated: it changes nothing) as their first step; the legacy steps, SKILL.md and the capability
   resolution follow. The step reads through the connector chain in its order (MCP -> Composio -> direct API ->
   computer use, the last resort: a read-only screen read).
3. **Read-only, enforced in the gate.** Every read call goes through a gate in the new mode `read`
   (`createGate({ mode: "read" })`): anything that is not an allowlisted read (a send, a log, a draft, a computer-use
   input or commit, an unknown tool) is denied with "a read step only reads: it never writes, saves or sends", before
   any other rule, and logged. A refused call stops the read (it is never retried through another method); a method
   that fails moves on to the next one (`markFailed`). Readers never run a call the gate did not allow.
   Readers per method (`workflows/read-fetch.ts`): mcp = one allowlisted read tool of the server the probe found; composio
   = `composio execute <read slug>`; api = a configured read operation (GET); computer = open the app or site and read
   the window's accessibility text (no planner, no clicks, no typing). Tests inject fake readers and probes.
4. **Live batch.** For a workflow with a read source and a fetcher, `POST /workflows/:id/run` reads the source first;
   its values become the items (`commit.fields` = the commit labels with the fetched values, copied by code), so the
   approval hash covers the exact fetched values. The s26 row key, done log, live batches and ledger still stop
   repeats ("nothing new at <source> since the last run"). `items.csv` is the fallback only when no source is known or
   the source cannot be read; the run response says which (`source: {kind: read | list, name, via, message}`), and
   every item of a fallback batch with a known source carries a plain warning.
5. **Dry run.** For a workflow with a read source, each past instance is filled from what the source screen showed
   right before it (code), compared with what the person typed; the response carries `read`: the values fetched now
   (read-only, through the same gate) or why nothing was fetched.
6. **Honest numbers.** The reading time counts as saved only when the read is automated (the last read through the
   chain succeeded): dry-run instances add their measured reading minutes, the dashboard estimate adds the reading
   hours per week (with the arithmetic), and the measured saving adds the reading time on the source before the task's
   instances (before) against all time on the source (after, conservative). When it is not automated, none of it is
   counted.
7. **Round 1 (PR #35 review, operator decisions 2026-10-26, ADR 0015).**
   - Read arguments are LEARNED: `read.query` = the report (page title without the product name), the fields (source
     labels) and the filters seen on screen (period "last 7 days"), code only. Shown in the dry run (`read.query`),
     part of the hashed item text of dry-run and live batches (every approval covers it), sent as the read's
     arguments. No setup step.
   - Offload builds its OWN view of the data: the page address is never stored; reads go through a connector or API
     query built from `read.query`. The screen read stays the last resort and opens only the site.
   - Done rows are dropped before any limit (the fetcher keeps only rows not done; the batch size applies after);
     an answer too large is refused, never cut.
   - A pause or delete during a read stops the chain: checked before every method and call, in the read gate's cancel
     callback, and by the built-in readers (signal); the method is not marked failed.
8. **Round 2 (PR #35 review).** A dry run's read is cancelled like a live run's (`registerPreview` in runner.ts:
   pause and delete abort it; the dry run answers 409 and nothing else is tried). A direct connection's read
   operations (configured reads and OpenAPI GETs) come from ONE resolver, `apiReadOperations`, used by the probe, the
   gate policies and the reader; read tools are recognised with the same naming as the probe (dotted operation ids).
9. **Round 3 (PR #35 review).** A direct read fills its path arguments (`{report}`) from the learned query and sends
   only the other arguments as the query string; a path argument Offload has not learned refuses that way plainly
   (no empty segment) and the chain moves on. Answers are read through their envelopes (up to 4 levels: data.results,
   items, data.rows, a single object, `columns` + `rows` tables); with several lists the one whose keys match the
   most fields wins (ties: shallower, then key order); camelCase keys match; a null is missing, never a value. An
   answer that says it has more pages (`next`, `next_cursor`, `has_more`, `links.next`, ...) is flagged: live items
   carry a warning and "nothing new" says only the first page was read. Following later pages is not built.
10. **Round 4 (PR #35 review): a read claims only what it can confirm.** The screen read accepts values only when the
   learned report and every learned filter (period) are visible on screen; otherwise that way is refused ("could not
   confirm the 'Weekly metrics' report for last 7 days on screen") and the chain falls back. It never navigates or
   changes a filter. A connector answer that names another report or filter value is refused (the method is marked
   failed); one that does not say is accepted with a plain note that it did not confirm the report or period. Rows
   with a missing, null or unreadable value are SKIPPED: named in the dry run (`read.skipped`) and the run
   (`source.skipped`, message, a warning on every item), never entered and never in the done log; "nothing new" says
   how many were skipped and why.
11. **Round 5 (PR #35 review): one answer normaliser, with invariants.** A connector answer is parsed in one pass:
    normalise (every list of objects, `columns` + `rows` table and single object up to 4 levels, each with the
    context of the envelopes around it) -> pick the collection (scored over ALL its rows: best field match, then how
    many rows reach it, then shallower, then walk order) -> validate the context (envelopes and every row against the
    learned report and filters; any conflict refuses the whole answer for that method) -> validate each row (complete
    = row, else skipped with the fields it lacks). Invariants, tested over 50+ generated shapes
    (`brain/tests/s27-workflow-reads/parser-table.test.ts`): I1 a wrong context never becomes a row; I2 a valid row is
    never lost silently; I3 an incomplete row is never a row and is always named.
12. **Round 6 (PR #35 review): explicit outcomes.** `readValues` returns `ok(rows, skipped)` | `empty` |
    `wrong_context(reason)` | `unreadable(reason, missing)`. Every context declaration in the whole answer (any depth,
    any row, table columns, every key alias) is collected and checked BEFORE a collection is chosen or a row flattened
    (I4: a conflict anywhere refuses). A read with 0 complete rows and N skipped is ok (the person sees them); a
    recognised empty collection (`[]`, `{results: []}`, an empty table) is `empty` = nothing new (I5). Chain mapping
    (`chainStep`, `marksFailed`, tested): ok and empty stop the chain and never fall back to the list; wrong_context
    marks the method failed and tries the next; unreadable tries the next; the list is used only when every method
    is exhausted.
13. **Round 7 (PR #35 review): text answers, exact values.** Text answers (screen text, plain-text connector answers)
    become the same structure as JSON and go through the same pipeline and invariants I1-I5. I6 value fidelity: every
    accepted value equals the source text exactly (sign, symbols, separators, zeros; JSON numbers keep their own text),
    tested in `text-table.test.ts` (text renderings: | and tab tables, "Label: value", "Label = value", "Label value",
    screen outlines, mixed) and JSON number cases. A screen that shows some fields but not all is now a read with that
    row skipped (round 6 rule), no longer a fall back to the list (the round 1 FETCH test was updated to this).
14. **Claude key for workflow runs (queued item, PR #35).** The Agent SDK child gets the key only through
    `settings.apiKeyHelper`: `executorCredential` reuses the builder's `writeCredentialHelper` (a 0700 script in a
    fresh 0700 folder that reads the Keychain item named by OFFLOAD_ANTHROPIC_KEYCHAIN, or a key in the brain's env
    from a 0600 file), removed after the run. ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are no longer passed in the
    child env. Scope change: `brain/tests/s05b-privacy/privacy.test.ts` L5 asserted the child env carried
    ANTHROPIC_API_KEY; it now asserts it does not (the key still reaches Claude Code, through the helper).
15. **Round 8 (PR #35 review): repeated keys and accessibility lines.** Every declaration is kept (a multimap): one
    conflicting repeat of a report or filter refuses the answer (I4). I7: a repeated key never silently picks one
    value: two different values for one field in one row (text repeats, a table header twice, a literal JSON
    duplicate key, a nested copy, snake/camel twins, the source label and the commit label disagreeing) skip that
    row as ambiguous, named. JSON is parsed by an exact parser (numbers keep their text, duplicates kept). Accessibility
    text has ONE format, `connectors/computer/ax-text.ts` (`<role> "<label>" = "<value>"`, JSON-quoted; curly quotes
    read too): the stub driver and the real driver write it, the read step parses it.
16. **Round 9 (PR #35 review).** Workflow run sign-in (manager decision, BYOK API key first): an API key (Keychain
    reference, or the brain's own env) goes through `settings.apiKeyHelper` with no key and no OAuth token in the
    child env; with no API key but a Claude Code OAuth token, the token goes in the child env exactly as before this
    slice (never through apiKeyHelper, which is API-key auth) and the brain logs one warning line; with neither, the
    run is refused before anything starts ("add a key in Settings"). The builder's `writeCredentialHelper` has the
    same OAuth-as-API-key mix-up; it is not changed here (the builder is off and keeps every secret out of its
    sandbox env by design; reported). Composio answers reach the shared exact parser as the CLI's raw text (no
    JSON.parse/stringify round trip). Reader audit: MCP returns the tool's text content as sent, the direct API
    returns `res.text()`, the screen returns the accessibility text; none re-encodes values.
17. **Round 10 (PR #35 review): I8 formatting is never data.** Table delimiter and border lines (Markdown `---`,
    `:---:`, `|---|`, ASCII `+---+` and `|===|`, box-drawing lines) are dropped before parsing, in the read step and in
    the commit-screen parse; Markdown tables with or without outer pipes, ASCII boxes and box-drawing tables are read
    (outer borders are dropped only when the header has them, so a trailing `|` stays an empty cell); a cell of only
    punctuation, dashes or box characters is not a value, so such a row is never a row (it is skipped, named).
18. **Round 11 (PR #35 review).** The Composio read child gets `linkEnv` (the allowlist the Composio probes and
    executors use: PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, LANG, LC_*), never OFFLOAD_TOKEN, a model login or a
    connector secret; its output cap is the read limit + 1 (`MAX_ANSWER_CHARS + 1`) and an answer over the limit is
    refused explicitly, never cut and parsed. The brain-wide audit of child processes is in the PR thread.
19. **Round 12 (PR #35 review).** A configured direct read keeps its `map` (read with the send side's `mapArgs`; a
    read's map holds fixed values only). Merge rule: configured fixed values win on every clash (ids and scope always;
    report, fields and filters when the configuration pins them); the learned query fills only the arguments the
    configuration does not set; path arguments are filled from the merged set, the rest go in the query string. An
    MCP answer reaches the parser from its text blocks (and embedded resources with text) as sent; when there are none,
    or they do not read as rows, its structuredContent is used, re-serialized, and the read says its number
    formatting comes from the connector software.
20. **Round 13 (PR #35 review): one sign-in function for every Agent SDK caller.** `models/agent-auth.ts
    agentSdkAuth` returns `{env, settings.apiKeyHelper?, cleanup}` (API key -> helper; OAuth only -> token in env +
    one warning; neither -> NoClaudeKeyError, "add a key in Settings"). The workflow executor and AgentSdkModel (the
    Claude Code model backend) both use it; `executorEnv` is gone: the pure allowlist is `models/child-env.ts
    baseChildEnv`, which never decides sign-in (connector runners and the builder start from it; import-only changes in
    connectors/link.ts and builder/sandbox.ts). The builder keeps its own sandboxed key path (builds/<run>/cred, no
    secrets in its env by design); its OAuth-as-API-key mix-up is reported, not changed. Scope changes:
    `tests/s10b-review2/child-env.test.ts` and `tests/s05b-privacy/privacy.test.ts` now read the child env from
    agentSdkAuth / baseChildEnv (same assertions: no OFFLOAD_*, no connector secret, no key in the env).
21. **Round 14 (PR #35 review).** An answer in several parts (MCP text blocks, resource text, structuredContent) is
    read as ONE answer (`readValueParts`): every part's context is checked before rows are chosen (I4 for split
    answers). A collection is chosen by field PRESENCE (a key that is there counts even when null); validity is the
    row pass's job, so rows of nulls are skipped rows (I3), not unreadable. The order is always: collect every
    declaration of every part -> check context -> collect and pick the collection -> check each row.
22. **Round 15 (PR #35 review).** Table rows are split into cells before anything is trimmed (empty first, last and
    middle cells keep their place; a header may have an unnamed first column). A row with empty field cells is a
    skipped row; a row with the wrong number of cells is skipped and named ("row 2 has 3 cells, the table has 2") and
    never ends the table; only a line with no cell delimiter ends it. The commit-screen parse splits before trimming too.
23. **Round 16 (PR #35 review).** One row rule for every table (`tableRow`), text or JSON `columns + rows`: exactly one
    cell per column (too many or too few: skipped and named, later rows continue); object rows inside a columns table
    may only use the declared columns (else skipped and named); a table's rows are read only through the table, never
    also as a plain list; empty, formatting-only and repeated cells are judged the same way in both.
24. **Models.** No new model call: understanding, parsing and values are code. Computer-use reads use no planner. The
   router and the person's own key (Keychain, BYOK) stay as they are; there is no cloud path; the builder stays off.

## Tests (tag = test name prefix in `brain/tests/s27-workflow-reads/`)
Hermetic: real brain routes, stub model, fake clock, stub chain plus fake MCP / Composio probes and readers, an
in-memory computer-use driver (a dashboard and a sheet). No network, no real model, nothing sent.

| tag | what is checked |
|---|---|
| SOURCE | recordings show dashboard -> sheet: the read source is found (PostHog, 4 fields, reading time), stored on the workflow, evidence ids resolve; noise before some instances does not win; the plain neutral week finds none |
| STEP | the plan has `read_source` before the commit in both variants, not gated, role read; legacy steps and SKILL.md show it |
| GATE | a read gate denies send, log, draft, input and commit and any unknown tool, allows allowlisted reads; a reader that tries to write is refused, its call never runs, no other method is tried, nothing reaches items |
| FETCH | the chain order: fake MCP reads the values; MCP failing falls to Composio; only a screen read possible reads the dashboard's text without a click or a keystroke |
| DRYRUN | the dry run shows the fetched values and fills past instances from the source; saved minutes include the reading minutes only when the read is automated |
| LIVE | items come from the fetched values with their exact commit; the hash covers them (another value = another hash); the response says the source; with no source known it falls back to items.csv and says so plainly; a source that cannot be read falls back with a warning |
| EXECUTE | approve -> commit through computer use with exactly the fetched values -> sent -> done log -> the next run does not repeat it |
| METRIC | the dashboard estimate adds the reading hours only when automated; the measured saving counts the reading time |

## Cannot pass vacuously
The path test fails when any step returns nothing: a source with 4 fields and > 0 reading seconds, a live batch of 1
item whose fields equal the fake connector's values, exactly one Save pressed with those values, a refused write with
its call never run, a screen read with zero clicks and zero typed keys. verify.sh counts tests per tag; a tag with 0
passing tests fails.

## Done-signal
`slices/s27-workflow-reads/verify.sh`: brain typecheck; the s27 suite (>= 20 tests) with every tag present and
passing; the s26 suite still passes; the full brain suite; the builder flag is untouched; no s27 change touches an
out-of-scope path.
