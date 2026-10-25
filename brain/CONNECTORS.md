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
   Check the tool names against the server's README before the first live run; the gate classifies by name
   (read verbs only = read, anything else = side effect needing approval), so a renamed tool fails closed.

### B. Composio (you already have the `composio` CLI; tokens held by Composio, ADR 0004 trade-off)
1. `composio login`, then `composio link gmail` (and `composio link googlecalendar`, `composio link googlesheets`).
2. Check the account works: `composio execute GMAIL_FETCH_EMAILS -d '{ query: "in:sent", max_results: 3 }'`.
3. Create an MCP server for those toolkits in the Composio dashboard (MCP configs) and copy its URL.
4. Add it as the `composio` server above, with `export COMPOSIO_API_KEY=...` in the brain's environment.
   For the tone pack set `"mail": { "server": "composio", "listTool": "GMAIL_FETCH_EMAILS", "args": { "query": "in:sent" }, "limitArg": "max_results" }`.
   The send tool is `GMAIL_SEND_EMAIL` (recipient_email, subject, body); the gate matches it to the approved item.

## What happens on a run
- Dry runs never touch a connector: every side-effect step is denied by the gate and logged.
- A live batch can only be approved when its required connectors are `connected` (409 otherwise).
- The runner starts the Agent SDK with only the servers the workflow needs, built-in tools off, no settings files,
  and the approval gate as `canUseTool` and a `PreToolUse` hook. See `src/workflows/gate.ts`.
- The brain's own direct MCP calls (reading Sent mail) refuse any tool that is not a read.

Not verified on this machine: the exact Composio MCP URL format and the Gmail MCP server's current tool names. Both
need the human to connect an account once.
