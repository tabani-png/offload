# s13 Connector chain: MCP -> Composio -> API -> computer use

Owner: TS engineer. Depends on s10e (Connect sheet with methods mcp | composio | api | computer and `next`).
Sources: plan/plan.md (s13 row), ADR 0006 (approval gates), ADR 0007 point 6 (chain per app), research
`adam/memory/research/pivot/12-rea-cua.md` (agent loop B1-B4, E1-E6; clean-room, no cua code) and `11-rea-clicky.md`
(pointer overlay, behaviour only). New dependency: ADR 0008 (`@anthropic-ai/sdk`, already in the lockfile as the
Agent SDK's peer).

Operator intent: "if we need Composio, if the MCP doesn't work, find solutions around it." Email is one example; the
chain works for any app a task profile touches (catalog ids and apps that are not in the catalog).

## paths_in_scope
`brain/src/connectors/**` (new: `chain.ts`, `targets.ts`, `mcp-probe.ts`, `composio.ts`, `api.ts`, `secrets.ts`,
`computer/*.ts`), `brain/src/workflows/{allowlist,gate,batch,executor,runner}.ts`, new
`brain/src/workflows/chain-executor.ts`, `brain/src/api/{server,workflow-routes,types}.ts`,
`brain/src/workflows/service.ts` (connectors response only), `brain/tests/s13-connector-chain/**`,
`brain/package.json` + `brain/bun.lock` (ADR 0008), `brain/CONNECTORS.md`, `brain/API.md`, `plan/adr/0008-*.md`,
`plan/plan.md` (ADR list), `brain/src/store/retention.ts` (purge of app targets), `brain/src/connectors/{api-config,
methods}.ts`, `slices/s13-connector-chain/**`.

## paths_out_of_scope
`engine/**`, `brain/src/vision/**` (s11), `brain/src/grouping/**`, `brain/src/understanding/**`,
`brain/fixtures/gen-domains.ts` (s12), `app/**` (the Connect sheet already decodes `method`, `methods`, `next`; new DTO
fields are additive and ignored by Codable until a UI slice renders them).

## Scope changes (tests and contracts outside this slice)
- `slices/s10e-ui-round4/verify.sh` pinned `gate.ts` and `allowlist.ts` byte-identical to the s10d commit `3fd90ab`
  to prove the UI round did not touch the gate. s13 must extend the gate. The check now proves the same thing
  exactly: no commit in s10e's own range (`3fd90ab..<last s10e commit>`) touched either file. No assertion removed.
- `brain/tests/s10e-ui-round4/connect-methods.test.ts` asserted that `api` and `computer` are unbuilt seams. s13
  fills both seams (the operator asked for it). The assertions are updated to the new truth (api and computer are
  available methods; `next` after composio is api; a seam still fails "not available yet" through
  `unavailableMethod`). Nothing else in s10e changes.

- Model choice (coordinator, 2026-10-25): s14 builds the shared router (`brain/src/models/router.ts`). s13 does not
  hardcode a model in the executor: the planner takes an injected `pickModel(route, ctx)` (route `computer.step`),
  default Sonnet 5.5 (`DEFAULT_COMPUTER_MODEL`), wired to the router at merge. s13 does not create router.ts.

## Design
### 1. Resolution chain (`connectors/chain.ts`)
- A **target** is what the chain resolves: a catalog connector, or an app a task profile touches that the catalog
  does not know (`targets.ts`: `app-<slug>` from the bundle id / app name, `web-<host>` for a browser host). Every
  target has a name, bundle ids, hosts, a Composio toolkit guess and a **capability vocabulary** (canonical action
  names, e.g. gmail reads `mail.search`, `mail.read`, writes `mail.send`; sheets writes `sheet.append`; any app
  through computer use reads `screen.read`, writes `ui.commit`).
- Order per target: `resolutionMethods()` (unchanged order; mcp first for Gmail, composio first for Composio
  catalog ids; for an app target `composio, api, computer`).
- Each method has a **probe** that returns `{ health: ok | failed | skipped, code, reason, capabilities: {reads,
  writes}, tools: {capability -> concrete tool}, latencyMs }`. `skipped` always carries a reason (no server
  configured, sign-in env var not set, no Composio toolkit for this app, no API set up, Accessibility not granted).
  - mcp: every connectors.json server that lists the target; env complete; a real MCP `tools/list` with a timeout
    (default 5 s). Capabilities = the allowlisted tools (allowlist.ts) the server really lists. A server that lists
    none of them is `failed` (`no_allowlisted_tools`): fail closed, never guessed from names.
  - composio: the Composio CLI (`composio`): toolkit = catalog toolkit or discovered (`composio tools list <slug>
    --limit 1000`, then `composio search "<app>"` whose toolkits match the app); `composio connections list
    --toolkit <slug>` must show an ACTIVE account; capabilities = toolkit tools that are allowlisted for the target
    (reads also when tagged `readOnlyHint`). Meta tools (`COMPOSIO_*`, multi-execute, workbench, bash, proxy) never
    count and stay denied. Only read-only CLI commands run during a probe.
  - api: `connectors.json` `apis.<target>` (new, optional): `baseUrl` (https; http only on 127.0.0.1), `auth`
    (`{ type: bearer | header, header?, fromEnv: NAME }` or `{ ..., keychain: { service, account } }`), `health`
    (`{ method: GET, path }`), `operations` (`{ <capability>: { operationId, method, path, role: read | send | log,
    fields: { <arg>: FieldSpec kind }, body: json | gmail-raw, map: { <arg>: "$item.to" | "$item.subject" |
    "$item.body" | literal } } }`) and optional `openapi` (a local OpenAPI 3 JSON file whose GET operations add read
    capabilities; its writes are never usable until named in `operations` with a field schema). Secrets are resolved
    in memory per request from the env var or `security find-generic-password -s <service> -a <account> -w`; they are
    never written, logged, put in an error, a DTO or a child env. Health = the health request answers 2xx.
  - computer: always the last resort. Probe: the driver reports Accessibility (and Screen Recording) granted and the
    app is on this Mac (bundle id) or the host can open in a browser. Capabilities: reads `screen.read`, writes
    `ui.commit` (every commit hash-bound to an approved item, section 2).
- **Decision**: the first method in order that is `ok` and offers every capability the caller needs. Cached in
  `$OFFLOAD_HOME/connector-chain.json` (0600, no secrets: method, health, codes, plain reasons, capability names, tool
  names, scrubbed last error, timestamps) with expiry (ok 10 min, failed 2 min). `markFailed(target, method, error)`
  invalidates and the next resolve skips to the next method; `next` names it.
- Stub model: deterministic probes (no spawn, no network, no UI): mcp ok when a server lists the target, composio ok
  for catalog ids and connect-sim ids, api ok when `apis` lists it, computer ok. `OFFLOAD_STUB_CHAIN_FAIL=mcp,composio`
  makes those probes fail. A simulated chain never sends (s10e rule kept: sendBatch never starts an executor for a
  demo sign-in).

### 2. Computer-use executor (`connectors/computer/`)
- Clean-room loop (research 12 B1-B4): observe (screenshot + AX) -> Claude plans -> each action is classified, sent
  through the gate, then dispatched -> re-observe. Claude Messages API through `@anthropic-ai/sdk`, model
  `claude-sonnet-5-5` for steps, tool `{ type: "computer_toolset_20260801", configs: drag, mouse down/up, hold_key and
  zoom disabled }` (no beta header; members arrive as `tool_use` blocks with `toolset_name: "computer"`; every result
  echoes it; after a denied or failed action the rest of that turn is answered "Not executed: an earlier computer
  action in this turn failed."), plus one custom read tool `read_ui` (AX of the focused window).
- Classification (`computer/actions.ts`), deterministic:
  - read: `screenshot`, `cursor_position`, `mouse_move`, `scroll`, `wait`, `read_ui`.
  - input (local, reversible; needs an approved or auto-run batch, never consumes the item): a click on an element
    whose AX role/title has no commit verb, focusing a text field, `type` into a focused editable text element (a
    newline only in a multi-line text area), navigation keys (Tab, arrows, Escape, Backspace/Delete inside text).
  - commit (one approved item, one use, full-argument hash like the send tool): any click on a control whose AX
    title/description/identifier matches a commit verb (send, submit, save, pay, purchase, buy, order, checkout,
    delete, remove, trash, post, publish, share, invite, confirm, ok, yes, accept, approve, apply, sign, transfer, book,
    reply, forward, schedule, upload, create, add, continue, done, finish, place), any Return/Enter key (any
    modifiers), Cmd+S, Delete outside a text element. The canonical commit is `{ app, verb, fields }` where `fields` are
    the editable values of the focused window read from AX at commit time (labels mapped per app profile: to,
    cc, bcc, subject, body; others kept by label; empty dropped). Expected per item: `item.commit` when the batch item
    carries one (hash-covered, see 3) or, for email items, `{ app: <target>, verb: "send", fields: to/subject/body }`.
    Key commits derive verb `submit` (Return/Enter), `save` (Cmd+S) or `delete`, so an approved send must be committed
    by the control named Send.
  - deny: an unknown member, drag, mouse down/up, hold_key, paste (Cmd+V), a click where AX cannot say what is under
    the pointer, `type` into a non-text element, a newline typed into a single-line field.
- Kill switch: `KillSwitch.stop(reason)` (menu/app: `POST /computer/stop`; the app maps Esc to it), the job's abort
  signal, and "you moved the pointer" (the driver's cursor moved away from where the executor left it) all stop the run
  before the next action. Pointer overlay hook: every dispatched pointer action emits `{ x, y, label, action, at }` to
  a `PointerSink` (Clicky-style glyph the app can render later); `GET /computer/session` reports the run, the last
  pointer event and the kill state.
- Stub mode: `StubDriver` (an in-memory app with an AX tree) and a scripted planner; deterministic, never touches the
  real UI. Real mode (`OsaDriver`: `screencapture`, `sips`, JXA/System Events) is opt-in only (`OFFLOAD_COMPUTER_REAL=1`)
  and is never run by `verify.sh`.

### 3. Gate extensions (`workflows/allowlist.ts`, `gate.ts`, `batch.ts`)
- `Role` adds `input` (computer use only). `Flavor` adds `composio-cli`, `api`, `computer`. `ToolPolicy.server` binds a
  dynamic policy to one server name; `GateContext.policies` adds dynamic policies (api operations, computer members);
  a server with bound policies resolves only those. Composio's deterministic CLI executor calls the gate as
  `mcp__composio_cli__<SLUG>` with the existing composio policies (GMAIL_SEND_EMAIL now also accepts `from_email`
  only empty and `include_signature` only `false`, verified against the live schema with `--get-schema`).
- Every write of every method maps to the item's single commit (`role: send`) or its log (`role: log`), checked with
  the canonical hash of the full arguments; the existing journal applies: the gate's `onAllow` writes `sending` and the
  contacted ledger BEFORE the tool runs; only a `pending` item can be committed; `unknown` is never retried
  automatically; Composio meta tools stay denied by name and by nested-call keys.
- `BatchItem.commit?: { verb, fields: [label, value][] }` for non-email items; when present it is part of the batch
  hash (existing hashes are unchanged).
- `input` needs a live, intact, approved (or auto-run) batch and is denied in dry runs; it never consumes the item.

### 4. Fallback executor (`workflows/chain-executor.ts`)
`ChainExecutor` runs the batch through the healthy methods in order with ONE gate and ONE item journal. After a
method throws or a call fails, the chain marks the method failed and hands only items still `pending` (never
attempted) to the next method (`ExecJob.only`). `sending`/`unknown` items are never retried; `sent` never again.
Deterministic executors for composio (CLI) and api; the Agent SDK executor for mcp; computer use last.
`sendBatch` builds the chain for the workflow's side-effect connectors.

### 5. API (additive)
- `GET /connectors`: `chains: ConnectorChainDTO[]` (catalog ids plus app targets of the current insights).
- `GET /connectors/:id/status`, `GET|POST /connectors/:id/link`: `chain: ConnectorChainDTO` (method, health,
  capabilities, lastError, next, methods[] with health/reason/capabilities/tools/checkedAt); `?refresh=1` re-probes.
  App targets (`app-…`, `web-…`) are valid ids once `GET /connectors` has seen them.
- `POST /computer/stop` (kill switch), `GET /computer/session`.

## Acceptance (tag = test name prefix in `brain/tests/s13-connector-chain/`)
- CHAIN: order, first healthy method with the needed capabilities, skip reasons, cache with expiry, markFailed moves
  to next, stub determinism, app targets for non-catalog apps.
- MCP: real `tools/list` against a spawned stdio MCP fixture (local, no network), timeout -> failed, unknown tools do
  not count, missing env -> skipped.
- COMPOSIO: discovery, connection status and schemas parsed from recorded CLI output (fake runner); probe runs only
  read-only commands; meta tools never in capabilities; CLI executor goes through the gate and refuses anything not
  approved.
- API: config parsing (no secrets, https), env and Keychain references resolved in memory only and never in logs,
  errors or DTOs, OpenAPI reads, health probe, gated executor (wrong args denied, one use per item), gmail-raw body.
- COMPUTER: classification table, commit hash binding (exact approved form passes once; changed field, extra cc,
  Return instead of Send, second commit -> denied), reads allowed in dry run, input needs approval, kill switch,
  pointer moved -> stop, pointer sink events, batch-turn "Not executed" rule, request shape (model, toolset, configs,
  toolset_name echoed) with a fake Messages client.
- GATE: every method's writes need approval and the exact hash; dynamic policies bound to their server; meta tools
  denied on every method; `input` denied in dry runs and without approval; commit-bearing items change the batch hash.
- FALLBACK: MCP fails mid-batch -> Composio retry sends only never-attempted items (no double send); unknown is never
  retried; the contacted ledger has every attempted address; denials do not trigger fallback; chain decision moves to
  the next method with lastError.
- ROUTES: `GET /connectors` chains, `GET /connectors/:id/status` chain DTO, `?refresh=1`, app target ids, computer
  stop/session routes, plain words (no banned internal words) in every reason.
- SMOKE (opt-in, `OFFLOAD_S13_SMOKE=1`, not in verify.sh): the real Composio CLI probe for gmail (read-only).

## Done-signal
`slices/s13-connector-chain/verify.sh`: brain typecheck; the s13 suite (>= 80 tests) passes with each tag present
and passing; the full brain suite passes; no test spawns the real `composio` (fake runner) or touches the real UI; the
s13 tests never set `OFFLOAD_COMPUTER_REAL`; the gate files keep the meta-tool deny; docs mention the chain.
