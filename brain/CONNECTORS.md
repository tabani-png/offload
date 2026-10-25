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

**Not verified against a live account on this machine: every name in the table.** They come from the
`@gongrzhe/server-gmail-autoauth-mcp` README and Composio's toolkit docs. `append_row` and `find_free_slots` are
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
