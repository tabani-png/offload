# Shared language

- **Event**: one raw observation (app focus change, window/title/URL change, idle start/end, input counts per minute, OCR snapshot on change).
- **Span**: a continuous focus interval on one app + title + URL host, with active minutes (idle removed).
- **Task**: a group of spans with the same goal (e.g. "outreach email to investor"). One instance = one occurrence.
- **Task profile**: summary + identifiers (people, domains, files, subjects) used to group spans.
- **Insight**: a ranked task with time share, instance count, median duration, sameness, and a saving estimate.
- **Saving estimate**: instances/week × median minutes × automatable share − review time. Always shown with its arithmetic and as a range.
- **Connector**: a tool the workflow needs (Gmail MCP, Calendar, Composio app, local script).
- **Tone pack**: style card per message kind + retrieved examples from the user's Sent mail.
- **Workflow**: a SKILL.md recipe plus small scripts, run by the Claude Agent SDK. Has approval gates.
- **Dry run**: running a workflow on last week's real instances without side effects, shown next to what the user really did.
- **Approval gate**: a step where nothing external happens until the user says yes (enforced in code via canUseTool).
- **Rail**: the thin always-on-top edge bar (status dots, inbox).
- **Card**: the suggestion / question surface (numbered options, Recommended, keycaps, Esc to undo).
- **Dashboard**: the window listing automations, hours saved, and the 7-day timeline.
