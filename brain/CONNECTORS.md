# Connecting tools (MCP servers)

The brain reads `$OFFLOAD_HOME/connectors.json` to know which MCP servers you connected and which catalog ids
(`gmail`, `google-calendar`, `google-sheets`, `slack`, ...; see `src/connectors/catalog.ts`) each one covers.
`GET /connectors` shows what is connected and what each insight still needs.

## The one rule: no secrets in the file
`connectors.json` names env vars; it never holds a value. Raw `env` or `headers` keys, `Bearer ...`, `sk-...`,
long tokens and `?api_key=` in URLs are rejected. Put the secret in the environment the brain runs in (the app
passes it from the Keychain later; for now export it in your shell). Values are resolved in memory per run.

```json
{
  "version": 1,
  "servers": {
    "gmail": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
      "envFromEnv": {},
      "catalog": ["gmail"]
    },
    "composio": {
      "type": "http",
      "url": "https://<your Composio MCP server URL>",
      "headersFromEnv": { "x-api-key": "COMPOSIO_API_KEY" },
      "catalog": ["google-calendar", "google-sheets"]
    }
  },
  "mail": { "server": "gmail", "listTool": "search_emails", "args": { "query": "in:sent" }, "limitArg": "maxResults" }
}
```

- `stdio`: `command`, `args`, `envFromEnv` (child env var -> name of your env var). PATH and HOME are passed.
- `http`: `url` (https; plain http only on 127.0.0.1), `headersFromEnv` (header -> env var name).
- `catalog`: the catalog ids this server covers. A catalog id is `connected` when a server lists it and every env
  var it names is set, `missing_env` when the env var is missing, `missing` when no server lists it.
- `mail`: which server and read-only tool the tone pack reads your Sent mail from (`tone build --source mcp`).

## Gmail: two ways

### A. A Gmail MCP server on this Mac (tokens stay local)
1. Create a Google Cloud OAuth client (Desktop app) with the Gmail API enabled and download its JSON.
2. Follow the server's README to place the credentials and run its one-time auth (for
   `@gongrzhe/server-gmail-autoauth-mcp`: `npx -y @gongrzhe/server-gmail-autoauth-mcp auth`).
3. Add the `gmail` server above. Its read tool is `search_emails` (query `in:sent`), its send tool `send_email`.
   Check the tool names against the server's README before the first live run. The gate is an allowlist of exact
   tool names (below): a renamed or new tool is denied, never guessed from its name.

### B. Composio (you already have the `composio` CLI; tokens held by Composio, ADR 0004 trade-off)
1. `composio login`, then `composio link gmail` (and `composio link googlecalendar`, `composio link googlesheets`).
2. Check the account works: `composio execute GMAIL_FETCH_EMAILS -d '{ query: "in:sent", max_results: 3 }'`.
3. Create an MCP server for those toolkits in the Composio dashboard (MCP configs) and copy its URL.
4. Add it as the `composio` server above, with `export COMPOSIO_API_KEY=...` in the brain's environment.
   For the tone pack set `"mail": { "server": "composio", "listTool": "GMAIL_FETCH_EMAILS", "args": { "query": "in:sent" }, "limitArg": "max_results" }`.
   The send tool is `GMAIL_SEND_EMAIL` (recipient_email, subject, body); the gate matches its full arguments to the
   approved item. The Composio meta tools (`COMPOSIO_MULTI_EXECUTE_TOOL`, `COMPOSIO_REMOTE_BASH_TOOL`,
   `COMPOSIO_REMOTE_WORKBENCH`, search/execute helpers) are always denied, so expose the Gmail and Sheets toolkits
   as plain tools in the MCP config.

## Connecting from the app (s10e)
The app's "Connect Gmail" calls `POST /connectors/gmail/link` and polls `GET /connectors/gmail/link` (brain/API.md).
Connecting never sends anything: a send still needs an approved batch hash and the allowlist below.
It works the same for every catalog id (`/connectors/<id>/link`, poll `/connectors/<id>/status`). Each connector has
an ordered list of methods (`resolutionMethods` in `src/connectors/link.ts`): `mcp` (a connector server on this Mac),
`composio`, `api` (a direct connection, s13) and `computer` (computer use, s13). The app can pick one with
`{ "method": ... }`; when one fails the answer names the `next` method to offer (only a way that can work for that
connector right now: `api` only when `apis` lists it, `computer` only when computer use is on).
- `api` and `computer` (s13) answer at once from the chain's probe (below): connected, or failed with the reason
  ("No direct connection is set up for Gmail.", "Using apps on your screen is off until you turn it on.").
- Demo (`serve --model stub`): a simulated sign-in. No browser opens, no command runs; after about 2 seconds the id
  counts as connected (kept in `$OFFLOAD_HOME/connect-sim.json`). A demo sign-in has no server, so nothing is ever
  sent through it: a live batch cannot be approved on it, and the executor is never started for it. With the real
  model the file is ignored.
- Composio (real model): the brain runs `composio link <toolkit> --no-browser --no-wait` and hands the sign-in URL to
  the app, which opens it. It then polls `composio link <toolkit> --list`. When the account is active the id is
  connected only once a Composio server in `connectors.json` lists it (with its env var set); until then the app shows
  "Add it to the Composio server Offload uses".
- A connector on this Mac (method `mcp`, real model): the brain runs the stdio server's one-time auth command (`... auth`), which opens its own browser
  window; the id is connected when `connectors.json` lists the server.
- The commands get only PATH, HOME, user, shell, temp dir and locale; never `OFFLOAD_TOKEN` or a connector secret.

## The gate's allowlist (s05b, `src/workflows/allowlist.ts`)
A tool runs only when it is in this table for a connector the server lists in its `catalog`. Everything else is
denied outright, including unknown tools, meta or multiplexer tools (`*MULTI_EXECUTE*`, `*EXECUTE*`, `*BASH*`,
`*WORKBENCH*`, `*PROXY*`, any input carrying a nested tool name, command or code), `forward`, `reply` and every
`draft` tool. A dry run allows only the reads.

| connector | flavour | role | exact tool name | arguments the gate accepts |
|---|---|---|---|---|
| gmail | Gmail MCP | send | `send_email` | `to`, `subject`, `body` exactly as approved; `mimeType` only `text/plain`; `cc`, `bcc`, `htmlBody`, `attachments`, `threadId`, `inReplyTo`, `references`, `messageId` only empty |
| gmail | Gmail MCP | read | `search_emails`, `read_email`, `list_email_labels` | any |
| gmail | Composio | send | `GMAIL_SEND_EMAIL` | `recipient_email`, `subject`, `body` exactly as approved; `is_html` only `false`; `user_id` only `me`; `cc`, `bcc`, `extra_recipients`, `attachment`, `thread_id` only empty |
| gmail | Composio | read | `GMAIL_FETCH_EMAILS`, `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` | any |
| google-sheets | Composio | log | `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND` | `spreadsheetId`, `range` = `workflow.json` `inputs.crmSheet`; `values` = one row `[to, subject, batch hash (12), "sent"]`; `valueInputOption` `RAW` or `USER_ENTERED`; `insertDataOption` `INSERT_ROWS` |
| google-sheets | Sheets MCP | log | `append_row` | same as above |
| google-calendar | Composio | read | `GOOGLECALENDAR_FIND_FREE_SLOTS`, `GOOGLECALENDAR_EVENTS_LIST` | any |
| google-calendar | Calendar MCP | read | `find_free_slots` | any |

Arguments are canonicalised before the hash compare: keys sorted, unknown keys refused, addresses lowercased with
NFC and the domain in its ASCII (IDN/punycode) form, one plain address per entry (no display names, a comma or
semicolon makes it a list), text NFC with CRLF as LF and otherwise exact. A send is allowed once per item; the log
once per item and only after that item's send. Without `inputs.crmSheet` the sheet log is denied and the local
`crm-log.csv` is the only CRM record.

**Composio names: verified on this Mac (s13, 2026-10-25, composio CLI 0.4.2, read-only):** `GMAIL_SEND_EMAIL`,
`GMAIL_FETCH_EMAILS`, `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID`, `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND`,
`GOOGLECALENDAR_FIND_FREE_SLOTS` and `GOOGLECALENDAR_EVENTS_LIST` exist with input schemas (`composio execute <SLUG>
--get-schema`). `GMAIL_SEND_EMAIL` also takes `from_email` and `include_signature`: the gate accepts them only empty /
`false` (a different sender or an appended signature is not what you approved). **Not verified: the MCP names**
(`send_email`, `search_emails`, `read_email`, `list_email_labels`, `append_row`, `find_free_slots`). They come from the
`@gongrzhe/server-gmail-autoauth-mcp` README. `append_row` and `find_free_slots` are
placeholders for whichever Sheets / Calendar MCP server you connect. If your server names a tool differently the gate
denies it (fail closed): add the exact name and its argument schema to `allowlist.ts` with a test, never a pattern.
Reply-in-thread (the scheduling workflow) has no allowlisted tool yet: it needs a reply tool whose `threadId` is bound
to the approved item, so live scheduling batches stay off.

## What happens on a run
- Dry runs never touch a connector: every side-effect step is denied by the gate and logged.
- A live batch can only be approved when its required connectors are `connected` (409 otherwise).
- The runner starts the Agent SDK with only the servers the workflow needs, built-in tools off, no settings files,
  strict MCP config (your other MCP servers are ignored), an environment with only PATH/HOME/locale and the Claude
  login variables (never `OFFLOAD_TOKEN` or connector secrets), and the approval gate as `canUseTool` and a
  `PreToolUse` hook. See `src/workflows/gate.ts`.
- The brain's own direct MCP calls (reading Sent mail) refuse any tool that is not an allowlisted read for that server.

Not verified on this machine: the exact Composio MCP URL format and the Gmail MCP server's current tool names. Both
need the human to connect an account once.

## Resolution chain (s13)
"If the MCP doesn't work, find a way around it." Per app, Offload tries the ways of reaching it in order and uses the
first healthy one that can do what the workflow needs (`src/connectors/chain.ts`):

1. **mcp**: a connectors.json server that lists the app. Probe: its env vars are set and a real MCP `tools/list`
   answers within 5 s. It counts only for the allowlisted tools it really lists (a server with none of them fails).
2. **composio**: the Composio **CLI** (no Composio MCP server needed). Probe, read-only commands only:
   `composio tools list <toolkit> --limit 1000` (for an app the catalog does not know, `composio search "<app>"` finds
   the toolkit), `composio connections list --toolkit <toolkit>` (an ACTIVE account; an `always_allow` one is
   preferred). An account that asks before every call (`ask_every_call`) is used for reads only, so a send can never
   hang on a prompt. Sends run deterministically: `composio execute <SLUG> -d <the approved arguments> --account <id>`,
   each call through the gate first as `mcp__composio_cli__<SLUG>`.
3. **api**: a direct HTTP connection you describe in `connectors.json` (`apis`, below). Probe: the health request
   answers 2xx.
4. **computer**: Offload uses the app on your screen (Accessibility + screenshots, Claude `claude-sonnet-5-5` with the
   `computer_toolset_20260801` toolset). Last resort, **off until you turn it on** (`OFFLOAD_COMPUTER_REAL=1` for now).
   Probe: Accessibility and Screen Recording are granted and the app is on this Mac (or its site opens in the browser).

Every method reports health (`ok | failed | skipped`), a plain reason when it is not ok, and its capabilities: canonical
actions such as `mail.search`, `mail.send`, `sheet.append`, and `screen.read` / `ui.commit` for any app. Decisions are
cached in `$OFFLOAD_HOME/connector-chain.json` (0600; no secret: methods, codes, reasons, capability and tool names,
a scrubbed last error) for 10 minutes (2 minutes when nothing works). A run that fails on a method marks it failed for
2 minutes and the next one is used. Apps from your task profiles that the catalog does not know (`app-<name>`,
`web-<host>`) are kept there 7 days from when they were last seen, then dropped with their decisions (the purge does
it too). The stub model (`serve --model stub`) uses deterministic demo probes (nothing runs) kept apart from real ones;
`OFFLOAD_STUB_CHAIN_FAIL=mcp,composio` makes those demo probes fail.

### Fallback never sends twice
One approval gate and one item journal cover every method of a run. Each item is written `sending` (and the contacted
ledger updated) before its call. When a method fails (it throws, or an allowed call fails), only the items still
`pending`, never attempted, go to the next method. An item that may have gone out is `unknown` and is never retried
automatically (release it yourself: `POST /workflows/:id/release`). A refusal by the gate is not a failure: nothing
falls back after a refusal.

### The gate for every method
Every write of every method is the item's one commit (role `send`) or its log (role `log`), compared by the canonical
hash of its full arguments with the approved item, once:

| method | tool the gate sees | the arguments it hashes |
|---|---|---|
| mcp | `mcp__<server>__send_email` (etc., table above) | the tool's arguments |
| composio | `mcp__composio_cli__GMAIL_SEND_EMAIL` (the Composio rows above) | `recipient_email`, `subject`, `body` |
| api | `mcp__api_<app>__<operationId>` | the operation's declared fields |
| computer | `mcp__computer_<app>__commit` | `{ app, verb, fields }`: the verb of the control and the form as Accessibility shows it at that moment |

Computer use, action by action: reads (screenshot, scroll, pointer moves, wait, the Accessibility outline) are allowed;
local edits (focus a field, type into it, a click on a control without a commit word, Tab and arrows) need the approved
batch and use nothing up; a **commit** is any click on a control whose title, description or identifier has a commit
word (send, submit, save, pay, order, delete, post, publish, share, invite, confirm, OK, yes, apply, schedule, reply,
forward, upload, create, add, continue, done, ...), any Return or Enter, Cmd+S, or Delete outside a text field. A commit
is allowed only when its verb and form equal the approved item (an email: verb `send`, fields to / subject / body), so a
changed field, an extra Cc, "Schedule send" or Return instead of Send are refused. Paste, drag, mouse down/up, held
keys, other shortcuts, a click where Accessibility cannot say what is under the pointer, and a newline in a one-line
field are refused. Composio's meta tools (`COMPOSIO_*`, multi-execute, workbench, bash, proxy) are denied on every
server. Stop: `POST /computer/stop` (the app maps Esc and its menu to it), pausing the workflow, or moving the pointer
yourself stops the run before its next action. The app can draw a pointer glyph from `GET /computer/session`.

### A direct connection (`apis`)
```json
{
  "version": 1,
  "servers": {},
  "apis": {
    "gmail": {
      "baseUrl": "https://gmail.googleapis.com",
      "auth": { "type": "bearer", "keychain": { "service": "offload.gmail", "account": "me" } },
      "health": { "method": "GET", "path": "/gmail/v1/users/me/profile" },
      "operations": {
        "mail.send": {
          "operationId": "users.messages.send", "method": "POST", "path": "/gmail/v1/users/me/messages/send",
          "role": "send", "body": "gmail-raw",
          "fields": { "to": "addresses", "subject": "text", "body": "text" },
          "map": { "to": "$item.to", "subject": "$item.subject", "body": "$item.body" }
        }
      },
      "openapi": "/Users/me/specs/gmail.json"
    }
  }
}
```
- `auth` names the secret, never holds it: `fromEnv: "NAME"` or `keychain: { service, account }` (a generic password
  item; Offload runs `security find-generic-password -s <service> -a <account> -w` per request and keeps the value in
  memory only). Raw values, `Bearer ...`, long tokens and `?api_key=` URLs are refused. `type: "header"` adds
  `header: "x-api-key"`.
- A write (`role` send or log) must give every argument a schema (`addresses`, `text`, `id`, `rows`, `empty`,
  `{ "fixed": [...] }`; never `any`) and say where each comes from (`$item.to`, `$item.subject`, `$item.body`,
  `$item.commit.<label>`, `$crm.row`, `$crm.spreadsheetId`, `$crm.range`, or a literal). `body: "gmail-raw"` builds the
  RFC 5322 message Gmail's `users.messages.send` takes.
- `openapi` (optional, a local OpenAPI 3 JSON file): its GET operations add read capabilities `api.<operationId>`.
  Writes are never taken from it.
- `baseUrl` is https (plain http only on 127.0.0.1); redirects are refused.

Not verified on this Mac: a direct Gmail API send (no OAuth access token is set up here), and the real computer-use
driver (`src/connectors/computer/osa-driver.ts`: `screencapture`, `sips`, JXA with the Accessibility bridge). Both are
covered by tests with fakes only.
