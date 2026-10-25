# 05 · Overnight agent mode: precedents and safety patterns

Date: 2026-10-25. Scope: S2-07 (overnight), S2-05 (policies). Must keep ADR 0006 (one approval gate everywhere).
Tags: CONFIRMED = read in source (URL given) · INFERENCE = my reasoning · UNKNOWN = not found. "Secondary" = read in a third-party article citing the vendor's docs.

---

## Headline

- Every serious precedent separates **preparing** work (unattended) from **committing** it (gated): Devin opens pull requests and humans merge; Lindy parks side-effect actions as drafts; Zapier adds a Human-in-the-Loop step; Managed Agents makes tools "always ask" and caps spend per session.
- Offload's plan principle 4 matches the market. The extra value is the **morning digest as the approval surface**: one screen, every pending commit, batch approve.

---

## 1. Precedents

| Product | Unattended mechanism | Gate on side effects | Caps / kill | Tag | Source |
|---|---|---|---|---|---|
| **Claude Managed Agents** scheduled deployments | Cron expression + IANA timezone; each firing starts a fresh session; run record per firing (success/failure, typed errors); pause stops future triggers, unpause does not backfill; archive terminal; manual `run` for tests; up to 1,000 per org | Per tool: run automatically, always wait for approval, or check-then-run/deny/pause; MCP tools ask by default; network allowlists | Session `budget` (`max_list_cost` in cents); enforced between model requests; session goes idle with `budget_reached` and can resume; deployments apply the budget to each session; failed creation auto-pauses the deployment | CONFIRMED (marketing FAQ) + secondary (schedule/budget detail) | https://claude.com/platform/claude-managed-agents ; https://sobalabs.ai/blog/claude-managed-agents-what-you-still-own/ ; https://www.developersdigest.tech/blog/claude-code-routines-vs-managed-agents-schedules |
| **Claude Code Routines** | Saved prompt + repos + connectors on schedule, API or GitHub triggers; billed against the subscription with a daily cap on starts; 1-hour minimum interval for presets | — | daily run cap | Secondary | developersdigest link above |
| **Devin** | Scheduled sessions ("Schedule Devin"), playbooks, "Managed Devins" child sessions run in parallel | Output is a **pull request**; humans review/merge; Devin Review reviews PRs | **ACU limit per session**; cost column on scheduled sessions; analytics "ACUs per merged PR" | CONFIRMED | https://docs.devin.ai/release-notes/overview ; https://docs.devin.ai/work-with-devin/advanced-capabilities |
| **Lindy** | Always-on assistant agents | Per-action **"Ask for Confirmation"** on any action with side effects; pending action waits as a draft in the task view; approve there or from an email; **safe mode** asks before every side effect | — | Secondary (cites docs.lindy.ai/testing/human-in-the-loop) | https://gravity.fast/blog/best-relay-app-alternatives/ |
| **Relay.app** | Workflows with four human-in-the-loop step types (approval, data input, tasks, path selection); reviewer can approve, end, edit, or re-prompt | as left | — | Secondary. Reported **shut down 14 September 2026** | https://gravity.fast/blog/best-relay-app-alternatives/ ; https://stealwhatworks.com/blogs/news/relay-app-alternatives |
| **Zapier Agents** | Hosted agents with triggers | **Not by default**: you instruct the agent to ask, or use a separate Zap with "Human in the Loop" to pause pending review | — | Secondary | https://www.dooza.ai/blog/ai-agents-that-ask-for-approval ; Zapier help article referenced: https://help.zapier.com/hc/en-us/articles/38733184458765 |
| **cua** (for contrast) | — | Model safety checks are **auto-acknowledged** (confirm callback TODO); driver `standard` mode is promptless | BudgetManager stops on cost | CONFIRMED | teardown 12 C5, C9, C12 |

## 2. Safety patterns for unattended commits (proposed for S2-07)

Classify every step: **read** (fetch, search, summarise), **draft** (create an unsent artefact: email draft, doc revision, research note), **commit** (send, post, pay, launch, delete, change a record outside Offload).

| # | Pattern | Rule | Basis |
|---|---|---|---|
| P1 | **Default: drafts only overnight** | Reads and drafts run freely; commits queue for the morning digest | Lindy/Devin/Managed Agents precedent; plan principle 4 |
| P2 | **Pre-approved policy (opt-in per workflow)** | A commit may run unattended only if a written policy matches: allowlisted recipients or domains (or "replies to threads I started"), template/tone pack locked (hash pinned), max N commits per night, max N per recipient per week, business-hours send window in the recipient's timezone, no attachments unless allowlisted | INFERENCE (design) |
| P3 | **Caps** | Per run: step cap, token/$ budget (Managed Agents `budget`); per night per user: commits cap and $ cap; per tenant: $ cap. Hitting a cap pauses (resumable), never kills state | Managed Agents budget semantics (secondary) |
| P4 | **Kill switch** | One control per user, per workflow, per tenant ("stop all overnight"), reachable from phone (morning digest email link + app). Effect: pause scheduled deployments and interrupt running sessions; queued commits stay queued | Managed Agents pause/interrupt (CONFIRMED overview "Steer or interrupt"; pause from secondary) |
| P5 | **Dry run first** | A new overnight workflow runs in draft-only mode for its first K nights regardless of policy; the user sees what it would have sent | INFERENCE (mirrors Stage 1 dry-run) |
| P6 | **Morning digest** | One screen/email at the user's chosen time: what ran, what was drafted, what is waiting (batch approve/edit/reject), what auto-committed under policy (with undo where possible, e.g. Gmail undo window is short so prefer scheduled send), costs, errors, and suggestions for tonight | Lindy email approvals; Devin cost per session |
| P7 | **Scheduled send instead of immediate send** | Approved emails are scheduled for business hours, which also gives a last-minute cancel window | INFERENCE |
| P8 | **Circuit breakers** | Auto-pause a workflow on: bounce rate or reply-negative spike, any recipient outside allowlist, template hash mismatch, connection auth change, 2 consecutive failures | INFERENCE |
| P9 | **Identity** | Overnight commits go out as the user (their own connection) or a role identity, never as someone else; departed users' workflows never run (file 04) | plan principles 2-3 |
| P10 | **Audit** | Every commit logs: workflow version, policy id that allowed it (or approver + time), inputs hash, output, cost | ADR 0006 consistency |
| P11 | **DST and timezones** | Avoid 1-3 AM local schedules or use UTC: Managed Agents uses literal wall-clock matching (2 AM skipped on spring-forward, fires twice on fall-back) | Secondary (developersdigest) |

## 3. Suggestions engine ("2-3x yourself")

- Source of suggestions: Stage 1 pattern miner + calendar + inbox state (threads awaiting reply > N days, meetings tomorrow needing prep, docs with open comments). INFERENCE.
- Show each suggestion with its category (read/draft/commit), estimated minutes saved (file 06 method), and the policy it would need. User ticks what runs tonight.
- Start with low-risk, high-frequency jobs: meeting prep briefs, follow-up drafts, research summaries, doc revision drafts, CRM note drafts.

## TO CONFIRM
- TC1. Managed Agents permission-policy and scheduled-deployments docs on platform.claude.com (only secondary sources read for details).
- TC2. Lindy docs page directly.
- TC3. Zapier Agents current approval behaviour on help.zapier.com.
