---
id: s17-connect-anything
title: Connect anything Composio supports, set it up once, build the workflow from it
depends_on: [s13-connector-chain, s14-any-task-workflows, s16-commit-schemas]
parallel_safe: false (touches allowlist.ts policy lookup, composio.ts, chain-executor.ts, plan/tools.ts)
human_gated: false (the real smoke below is opt-in and read-only)
verify: bash slices/s17-connect-anything/verify.sh
---

# s17 Connect anything

Operator: "17 tools isn't enough. See what Composio offers and leverage it so we integrate with all. If an app is not
connected, help them do a one-time account setup (API or MCP), give them a safe place to put it in, then Offload does
the workflow building, testing and so on."

Sources: ADR 0006 (every external action passes the approval gate), ADR 0007 point 6 (chain: MCP, Composio, API,
computer use), ADR 0009 (router), s13 (chain, capability catalog, Composio CLI path), s14 (builder, plan, tools,
dry run), s16 (hand-written commit policies, the reply/draft name rule).

## Decisions
1. **Composio universe = a local, read-only, versioned index.** `brain/src/connectors/universe.ts` lists every
   toolkit with `composio dev toolkits list --limit 1000` (the CLI caps one call at 1000, so the sync unions a fixed
   list of seed queries `--query <q>` until no new toolkit appears) and every toolkit's tools with
   `composio tools list <toolkit> --limit 1000`. Kept per tool: toolkit, slug, name, description (cut to 400
   characters), Composio's hint tags (`readOnlyHint`, `createHint`, `updateHint`, `destructiveHint`,
   `idempotentHint`, `openWorldHint`) and the class below. Input schemas are fetched on demand with
   `composio execute <SLUG> --get-schema` (the only `execute` form the guard allows besides s13's) and cached one file
   per tool with a sha256 of the canonical schema. `$OFFLOAD_HOME/composio-universe/index.json` (0600, version 1,
   `syncedAt`, CLI version, `complete`), `schemas/<SLUG>.json`. Stale after 24 h: the real-model brain refreshes it in
   the background once a day; every reader works from the cache when the CLI is missing or offline. A failed sync
   never replaces a good index; a toolkit whose listing fails keeps its previous tools. Nothing is executed, no
   `--dry-run` is ever run, no account is touched: `isReadOnlyComposioArgv` is the single guard and the sync runs
   through `readOnlyRunner`.
2. **Class per tool, deterministic, fail closed.** `denied`: the `composio` meta toolkit, `COMPOSIO_*`, multi-execute,
   execute, bash, shell, workbench, proxy, eval, run, forward (s05b `NEVER_RE`), the s16 "still denied on purpose"
   list (campaign-wide launches, bill payments, ...), and reply tools (their real recipients come from the thread on
   the server, which no argument shows). `draft`: a create-draft tool; usable only through the s16 reviewed names
   (Gmail, Outlook), otherwise listed but denied. `read`: `readOnlyHint` and no create / update / destructive hint.
   `commit`: everything else, including tools with no hints at all. `destructiveHint` is kept and shown at review.
3. **Generic exact-approval policy** (`brain/src/workflows/generic.ts`) for any `commit` tool without a hand-written
   policy. The approved item carries `commit = { verb: "composio:<SLUG>", fields: [["schema", <schema sha256>],
   ["args", <canonical JSON of the complete arguments>]] }`, so the batch hash covers every argument and the schema the
   user saw. The canonical form: arguments validated against the cached input schema (unknown keys refused at every
   level that declares properties, required keys present, JSON types and enums checked, `__proto__` / `constructor`
   refused), strings NFC with CRLF as LF, keys sorted. The gate allows `mcp__composio_cli__<SLUG>` only when: not a
   dry run, the batch is live and intact, the run holds the approval token (or auto-run), a send step through that
   connection is declared, the policy's schema hash (fetched FRESH when the run starts) equals the hash in the item
   (else "the tool's fields changed since you approved it"), and the canonical hash of the full call equals the
   item's, once per item (the s05b journal: `sending` before the call, never twice). Missing schema = no policy =
   denied. Hand-written s16 policies take precedence: a slug that has one never gets a generic policy. Meta tools,
   nested tool calls (s05b `NESTED_KEY_RE` on the input) and the reply/draft/forward name rule run before any policy.
   Reads through the CLI are not added to the gate here (reads in plan workflows come from what was observed).
4. **Review shows every field.** `genericReview(item, schema)` turns the approved arguments into one row per leaf
   (`path`, plain label, value, `highlight: recipient | amount | id | null`, required, schema description), empty
   lists and objects included. Nothing is folded or hidden; the rows are derived from the same canonical bytes that
   are hashed. Recipients (to/cc/bcc/emails/phone/channel/assignee/user/member/attendee keys or any address-shaped
   value), amounts (amount/price/total/quantity/cost/fee/refund/balance) and ids (`*_id`, `*_ids`, `id`) are
   highlighted. A destructive tool carries one plain warning line.
5. **Recommendations reach any app, ranked below the verified ones.** `plan/tools.ts` fills a step's options (after
   the s13 catalog candidates, before the on-screen last resort, never above a hand-verified tool) with universe tools
   whose class is `commit` and whose name / description match the step's capability family, or whose toolkit matches
   the app the step targets. A universe option has id `composio:<SLUG>`, `connectorId: "tk-<toolkit>"`, `via:
   "composio"`, `verified: false` and a needs-you line until it is set up. The dry run's commit for such an option is
   the generic preview: output fields matched to schema properties by name, text into the body-like property, required
   properties that could not be filled listed as `missing`, plus the review rows.
6. **Universe targets in the chain.** A toolkit the catalog does not map gets the target id `tk-<toolkit>`
   (`isUniverseId`), capabilities `composio.read` / `composio.commit`, chain order composio, api, computer. The
   Composio probe gives a universe target those capabilities from the index (reads only when the account asks before
   every call). Catalog targets and app targets are unchanged.
7. **Connections center.** `GET /connections?q=` searches the catalog and the universe (catalog first, then name and
   slug matches, then description matches) and answers rows `{id, name, toolkit, status: connected | needs_you |
   not_set_up, verified, tools: {read, commit, denied}}`. `GET /connections/:id` adds the setup methods: `composio`
   (sign in once through Composio: s10e's `composio link` hand-off, reused, never duplicated), `api_key` (offered when
   Composio lists API_KEY / BEARER / BASIC auth for the toolkit, or always for a direct connection), `mcp` (a connector
   server: an https URL or a command). `POST /connections/:id/setup` starts one; `POST /connections/:id/test` tests it
   read-only; `POST /connections/:id/build` hands it to the s14 builder. State: `$OFFLOAD_HOME/connections.json`
   (0600, version 1). It never holds a secret.
8. **Secrets.** An API key is typed into a secure field in the app and written by the app straight into the macOS
   Keychain (Security framework, generic password, service `offload.connection.<id>`, account `api-key`), then the
   field is cleared and never shown again (the sheet says "Saved in your Keychain"). The brain receives only the
   reference `{ keychain: { service, account } }` (or `{ fromEnv }`). A body that carries anything that looks like a
   secret, or a `key` / `secret` / `token` / `password` / `value` field, is a 400 and nothing is stored or logged. A
   test reads the item only in memory for one request (`security find-generic-password ... -w`, s13's reader) or checks
   that it exists without reading it (`security find-generic-password -s -a`, no `-w`). Connector servers: https URL
   or a command with arguments, scanned with s05's secret patterns, headers and env values only as references; the
   test lists its tools (`tools/list`, nothing called).
9. **Build workflow, no extra steps.** `POST /connections/:id/build {insightId?}`: the insight is the given one, else
   the top insight whose task happens in that app (host / app name vs toolkit), else 409 with plain words. It drafts
   the workflow (s14 general plan, or the s05 template), picks the connection for the step it fits (the existing
   option, or the universe option for that toolkit added to the commit step), records it as the user's pick, runs the
   dry run (nothing is sent) and answers `{ workflow, dryRun: { instances, commit tool, missing } }`.
10. **Live wiring.** `sendBatch` passes the batch items into `buildChain`; the composio step fetches each generic
    item's schema fresh, builds one generic policy per slug bound to `composio_cli` and the target id, and the
    Composio CLI executor runs `composio execute <SLUG> -d <the approved arguments> --account <id>` only after the gate
    allows it. Plan workflows still have no live batches (s14 gap); this path is exercised with constructed batches.

## paths_in_scope
`brain/src/connectors/{universe,connections,composio,targets,chain,link,config}.ts`, `brain/src/workflows/generic.ts`,
`brain/src/workflows/allowlist.ts` (policy lookup only: generic fallback after the static table, export of the name
rules), `brain/src/workflows/chain-executor.ts`, `brain/src/workflows/drafter.ts` (universe passed to recommendations),
`brain/src/plan/{tools,commit-fields,dryrun}.ts`, `brain/src/api/{connections-routes,server,types,workflow-routes}.ts`,
`brain/src/cli.ts` (`universe` command), `brain/CONNECTORS.md`, `brain/API.md`, `brain/tests/s17-connect-anything/**`,
`app/Sources/Core/{Connections,BrainClient,BrainEdits,HTTPBrainClient}.swift`,
`app/Sources/Surfaces/{ConnectionsView,KeychainStore}.swift`, `app/Sources/App/{OffloadApp,Snapshotter}.swift`,
`app/build.sh` (test list), `app/snapshots/connections-*.png`, `slices/s17-connect-anything/**`.

## paths_out_of_scope
`brain/src/workflows/gate.ts` (the decision order is unchanged; see Scope changes),
`brain/src/workflows/runner.ts`, `batch.ts`, `executor.ts`, `engine/**`, `packet/**`, `schemas/**`, every other
slice's tests, `app/Sources/Surfaces/ConnectSheet.swift` and `Core/Connect.swift` (reused as they are).

## Scope changes
- `brain/src/workflows/gate.ts`: one line in `matchItem`. When a generic tool's arguments do not fit its fresh schema
  and an approved item carries an older schema hash, the deny reason is the schema change ("the tool's fields changed
  since you approved it") instead of the first validation error. The call is denied in both cases; nothing else in the
  gate changes.

## Acceptance (tag = test name prefix in `brain/tests/s17-connect-anything/` and `S17 ...` Swift suites)
- UNIVERSE: sync unions seed queries, lists every toolkit's tools, writes a versioned index, keeps the old index when
  the sync fails, keeps a toolkit's old tools when its listing fails, is stale after 24 h, works from the cache with
  no CLI, runs only read-only argv (a write command throws before spawning), caches schemas with their hash.
- CLASSIFY: meta / execute / bash / workbench / proxy / multi-execute / forward / reply / s16 denied list -> denied;
  draft tools -> draft; readOnlyHint only -> read; create / update / destructive / no hints -> commit.
- POLICY: exact args allowed once; every changed leaf denied (tamper); replay in the same run and across runs denied;
  dry run denied; schema drift denied; missing schema denied; unknown / extra keys denied (top level and nested);
  required key missing denied; meta tool and nested tool call denied; no approval denied; undeclared step denied;
  s16 precedence (a slug with a hand-written policy never matches a generic item); wrong server denied.
- REVIEW: every leaf is a row (nested, arrays, empty values), recipients / amounts / ids highlighted, destructive
  warning, rows come from the hashed canonical bytes.
- RECOMMEND: universe options appear after the catalog candidates and never above a verified tool; a step for an app
  the catalog does not know gets that app's universe tool; the dry run shows the generic commit preview with missing
  required fields.
- RESOLVE: `tk-<toolkit>` targets resolve through the index (knownTarget), probe composio with generic capabilities,
  reads only for an ask-every-call account.
- EXEC: the Composio CLI executor runs a generic item only after the gate allows it, with exactly the approved
  arguments; never for a denied, drifted or dry-run item (fake runner); buildChain refreshes the schema first.
- CONNECTIONS: search, detail with methods, setup (composio hand-off reuses the link route; api_key with a Keychain
  reference; connector server URL / command), read-only test per method, connections.json written 0600.
- SECRETS: a body with a secret-looking value or a key / secret / token / password / value field is refused and not
  stored; no secret value in connections.json, the index, logs or any DTO; the API key test reads it only in memory.
- BUILD: build hands the connection to the s14 builder, records the pick and returns the dry run; 409 when no
  insight happens in that app.
- App (Swift Testing, `S17 ...`): connections list state (search, status dots green / amber / grey, keyboard
  up / down / return / esc / cmd-F), the detail sheet's method choice and one primary button, the API key flow saves
  to the secret store and clears the field, never puts the value in a request body, copy lint, wire decoding.
- Snapshots: `connections`, `connections-search`, `connections-detail`, `connections-key`, `connections-server`,
  `connections-built` in dark and light (`app/snapshots/connections-*.png`).

## Done-signal
`slices/s17-connect-anything/verify.sh`: typecheck; the s17 suite (>= 70 tests) with every tag passing; the whole
brain suite; hermetic (no s17 test spawns the real `composio`, uses `SpawnLinkRunner`, `OFFLOAD_COMPUTER_REAL` or a
real model client); fixtures hold no secret-shaped string; the read-only guard rejects `execute` without
`--get-schema`, `link`, `run`, `proxy` and `--dry-run` for the sync's runner; app tests with >= 3 `S17` suites; fresh
and committed connections snapshots; CONNECTORS.md and API.md sections; the smoke counts below are filled in.

## Real smoke (opt-in, not in verify.sh)
`OFFLOAD_S17_SMOKE=1 bun run brain/src/cli.ts universe sync --home <tmp>` then `universe schema LINEAR_CREATE_LINEAR_ISSUE`.
Read-only commands only. Result on this Mac (composio CLI 0.4.2, 2026-10-25): **1,651 toolkits, 65,602 tools**,
complete (no toolkit failed), 1,687 read-only CLI commands, 3 min 16 s, index 29 MB. Classes: read 37,069, commit
27,634, draft 77, denied 822 (every tool of the `composio` helper toolkit, execute / bash / workbench / proxy /
forward / reply names, the s16 denied list). Schema fetch: `LINEAR_CREATE_LINEAR_ISSUE` 12 fields, required
`team_id`, `title`, sha256 `e8847a7d…59f2e`. Nothing was executed; no account was touched.

## Gaps (not done here)
- Plan workflows still have no live batches (s14): the generic commit is previewed in their dry runs, and executed
  only through live batches whose items carry a generic commit (tested with constructed batches).
- Generic reads are not run through the CLI in a workflow; reads come from what was observed.
- An API key connection without an operation schema (s13 `apis`) can be tested but commits nothing.
- Draft tools outside the s16 reviewed names and every reply tool stay denied.
- Composio's own semantic search (`composio search`) is not used for ranking; the local index is ranked by name,
  slug and description words.
