# 0008 The Anthropic SDK for computer use

Date: 2026-10-25. Status: accepted (s13).

## Context
ADR 0007 point 6 makes computer use the last resort of the connector chain. The Claude Agent SDK (ADR 0004) runs
Claude Code's harness with MCP tools; it has no computer-use tool. Computer use is a Messages API feature: on the
Claude API, Claude Sonnet 5.5 accepts it only as the `computer_toolset_20260801` toolset (GA, no beta header; members
arrive as `tool_use` blocks with `toolset_name: "computer"`, every result must echo it).

## Decision
Add `@anthropic-ai/sdk` 1.3.0 (pinned) as a direct dependency of the brain. It was already in `bun.lock` as the Agent
SDK's peer dependency, so no new package is downloaded and the lockfile only records it as a direct dependency. It is
used only by `brain/src/connectors/computer/claude.ts`, through a two-method interface (`MessagesApi.create`) so tests
pass a fake and never call the API. Model for steps: `claude-sonnet-5-5`.

## Consequences
- The real client is created on first use and only when computer use is turned on (`OFFLOAD_COMPUTER_REAL=1`).
- SDK 1.3.0 has no typing for the server-side `fallbacks` parameter; the computer loop does not send it. A refusal ends
  the item (the planner treats any stop other than `tool_use` as done), so nothing is committed.
- Upgrading the SDK is an ordinary pinned bump with the s13 request-shape tests as the guard.
