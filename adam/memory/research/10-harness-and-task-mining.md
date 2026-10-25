# 10 - Harness, task mining, tone, and execution layer

Date: 2026-10-24. Tags: CONFIRMED = read in the source this session. INFERENCE = reasoning from sources. UNKNOWN = not verified.
Written from the research agent's report (the agent could not write it: disk full).

## 1. FinanceHarness (github.com/Yijia-Xiao/FinanceHarness)
Read from existing clone ~/builds/repo-tests/ib-harness/FinanceHarness (sha 1163c5e, already in REGISTRY.md).
- What: autonomous financial deep-research framework: plans, gathers evidence, runs analysis, writes a cited report. CONFIRMED (README).
- Paper arXiv 2607.27853 (30 Jul 2026), Google Cloud AI Research. Layered harness: env/data construction, agent loop, reward modeling, FinanceGym benchmark. Same open-weight model: rubric 25.3% -> 32.4%. CONFIRMED.
- License Apache-2.0. CONFIRMED.
- Architecture: providers/ (Gemini default, GPT, local Qwen via vLLM); runtime/ (agent loop, tool registry, skill registry, chaining.py, citations, context_budget, recovery, sessions); tools/ (7 always visible: search, visit, compose_citations, calc, update_plan, load_tool, load_skill; rest load on demand); skills/<name>/SKILL.md; service/ (HTTP+SSE on 127.0.0.1:8080). CONFIRMED.
- Harness idea: the model stays fixed; the harness (prompts, tools, memory, skills, chaining, context control) is what you improve. CONFIRMED.
- Reuse (INFERENCE): progressive tool disclosure for many connectors; `prev:<id>.<path>` reference chaining so 7 days of events never pass through model context (mechanism CONFIRMED in chaining.py); SKILL.md as the unit of a workflow; grounding, so every "65% of your time" figure links to event rows. Not reusable: finance tools, Gemini-first provider layer.

## 2. Which Google harness research
| Work | Who | Fit |
|---|---|---|
| FinanceHarness 2607.27853 | Google Cloud AI Research | strong, the repo the operator named |
| Harness^2 2610.14224 (9 Oct 2026) | Google Cloud AI Research | strongest; "harness" is the topic; github.com/google-research/harness2 |
| ScreenAI (2024) | Google Research | screen-understanding model, not a harness |
| Agent Workflow Memory 2409.07429 | CMU/MIT | workflow induction, not Google |
- Harness^2: weights fixed. Per task: Propose 2 edits, Probe each on the same task, Compose from behaviour differences. Across tasks: a library of reusable parts and lessons. CONFIRMED.
- Verdict (INFERENCE): Harness^2 most likely; else FinanceHarness. Use for us: lesson library = per-user workflow library; Propose-Probe-Compose = two draft workflows dry-run on last week's real instances, user keeps the better one.

## 3. Method: events -> tasks -> time -> score -> saving
Field:
- UiPath Task Mining: does NOT discover unknown tasks or rank candidates (an analyst does). CONFIRMED (UiPath docs). Automatic discovery + ranking is our gap.
- Workflow Induction Toolkit (arXiv 2510.22780, github.com/zorazrw/workflow-induction-toolkit, macOS recorder): merge repeated keys, split on screenshot change, model merges same-goal segments. CONFIRMED.
- Task Model Induction (arXiv 2608.20319): ground events with screenshots + OCR -> actions -> activities; assign to task profiles (summary + identifiers: files, URLs, people); global merge; goal tree + loop model. 0.974 grouping agreement. CONFIRMED. Code license UNKNOWN.
- Microsoft UFO/UFO2: execution agents, prefer APIs over clicking. CONFIRMED.
- Local: ~/screenwatch logs {t, app, window, url, img} every 5 s, 32 days on disk. CONFIRMED. Ready capture prototype.

Pipeline:
- S0 Capture (no model): app bundle id, window title, URL, focused AX element, keystroke COUNT (never keys), clicks, OCR on change, SQLite, 7-day delete, PII mask.
- S1 Sessionize (rules): focus spans = same app + title + URL host; idle > 2 min dropped; spans < 10 s merged.
- S2 Label (local 3-8B model): {verb, object, counterpart, artifact_ids[], category} + local embedding.
- S3 Group (TMI-style): nearest profile by embedding + shared identifiers, else new task; daily Claude merge and naming on profiles only.
- S4 Repeats (rules): instances/day, median duration, sameness, share of time. Every number linked to rows.
- S5 Score (Claude, top 10): volume, sameness, reachability (API/MCP exists), judgement load, risk. Score = vol x same x reach x (1 - judgement) x (1 - risk/2). INFERENCE.
- S6 Saving: instances/wk x median min x automatable share, minus review time (15-30 s/item, then measured). Example: 100 emails x 3 min = 5 h/day -> ~33 min review -> ~89% saved. Show a range; measured after week 1.

## 4. Tone
- LaMP (ACL 2024): retrieving the user's own past items improves personalized email generation; BM25 strong for email. CONFIRMED.
- Approach: Sent folder only -> strip quotes/signatures -> bucket by kind -> Claude writes an editable style card per bucket -> draft = card + 3-5 retrieved past emails + new facts -> learn from user edits -> blind test on 10 held-back sent emails; ship when the user cannot spot the draft more than 1 in 3. No fine-tuning in v1.

## 5. Task -> workflow
- Claude Agent SDK: tools, MCP, hooks, subagents, skills, permissions (canUseTool). CONFIRMED.
- Composio: one MCP endpoint for 1000+ apps, managed OAuth. Trade-off: tokens held by Composio. CONFIRMED / INFERENCE.
- n8n: Sustainable Use License forbids end users (or an AI acting for them) building workflows through your product and using users' own credentials. CONFIRMED. Do not use without Enterprise licence.
- v1: Agent SDK runner + SKILL.md workflows + Gmail MCP first, Composio for long tail. Approval gates via canUseTool.

## Open questions (UNKNOWN)
Which headline the operator saw; TMI/toolkit licences; local model speed on target Macs; Gmail limits at 100 sends/day.

## Recommended v1 pipeline
1. Capture app: app, title, URL, AX element, key/click counts, OCR on change; SQLite; 7-day delete; PII mask.
2. Rules sessionize into focus spans with active minutes.
3. Local small model labels spans + embeddings.
4. Task profiles group spans; Claude merges and names tasks daily from profiles only.
5. Count instances, median time, sameness, share of time; every number links to rows.
6. Claude scores and ranks the top 10 tasks.
7. Weekly saving shown as a range with the arithmetic.
8. Map apps to connectors (Gmail/Calendar MCP, then Composio); list what to connect.
9. Tone pack: style card + retrieved emails; blind test.
10. Claude drafts a SKILL.md workflow with approval gates and dry-runs it on last week's real instances, side by side with what the user sent.
11. User edits and approves; Agent SDK runs it; sends need approval until auto-send is enabled per workflow.
12. Dashboard row per workflow ("Email outreach: automated, saves X h/week"); measured time replaces the estimate; edits become lessons for the next domain.
