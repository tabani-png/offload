# PACKET: Offload (working name)

Drafted 2026-10-24 from the operator's request. The operator owns this file. Agents never edit it.

## The ask (operator's words, cleaned)
The goal was never an unusable copy of screenpipe. Restructure.
Build a tool that watches, locally, what the user does on their Mac. Keep that for 7 days.
It works out on its own where the time goes and does its own due diligence.
Example: for a few days I sent manual capital-raising emails, about 100 a day. It took 65% of my time.
The tool should notice this, see it can be made efficient, and suggest tools (like Clicky's proactive help).
It suggests a ~90% time saving by connecting MCP servers and other tools, and builds the whole
end-to-end workflow, already matching my tone. I get an option to have the workflow built and reviewed.
A general dashboard then says "email is now automated". It then does the same in other domains, at scale.

UI: Apple design matters most. Feel of One (getone.one + its demo video), Clicky, and cua.
Use the repos given earlier (REA for teardowns). Use Google's harness research (FinanceHarness / Harness^2).
Process: research, build, test, with engineer agents and dedicated UI agents. Do not be lazy on code quality.

## Users
v1: the operator (a founder running outreach, client work and builds on one Mac). Later: knowledge workers.

## Must be true at demo time
1. It records activity locally (app, window, URL, focus time, idle, input counts) and deletes it after 7 days.
2. From 7 days of activity it finds the top repeated tasks with time share, and every number traces to rows.
3. For the email-outreach case it shows: time spent, the estimated saving with its arithmetic, the tools to connect.
4. It drafts a workflow in the user's tone, dry-runs it on last week's real examples, and nothing is sent without approval.
5. A dashboard lists automations with status and hours saved.
6. The UI feels Apple-native: calm, keyboard-first, edge rail + cards.

## Refs
Research: `adam/memory/research/10..14` (harness + task mining, Clicky, cua, getone.one design, One video).
Reusable code: `~/builds/workpaper` (Swift capture, encrypted store, retention; Bun server shell).
