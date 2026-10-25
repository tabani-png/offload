# Stage 2: Offload for a whole company

Date: 2026-10-25. Status: draft from operator brief, not started. Stage 1 (single user, s01-s15) ships first.

## The ask (operator, paraphrased)
- A company (e.g. Consultance AI) installs Offload for every employee, with role-based access.
- Admin dashboard: every employee's workflows, what is automated, hours saved and efficiency gained per
  person, per team, per department (finance, sales, ops...), rolled up for the founder/CEO.
- Optional: how much time people actually work.
- Continuity: when someone leaves, their workflows become company knowledge (SOPs) AND keep running —
  emailing, outreach, LinkedIn replies continue.
- Cloud workers: each person can have a virtual machine (cua-style sandbox) so agents run non-stop with
  browser/search access, not tied to their laptop.
- Overnight mode: a user can 2-3x themselves; Offload suggests overnight jobs (draft emails, revisions,
  research, follow-ups) and runs them while they sleep.

## Shape
```
Employee Mac (Stage 1 app)          Company control plane (new)            Cloud workers (new)
- watches, learns, local 7-day  --> - org, teams, roles (SSO/SCIM)     <-> - one VM per person/role
  store; raw screens never leave    - workflow registry (owned by org)     - runs workflows 24/7 and
- runs workflows                    - metrics: aggregates only             overnight; browser, search,
- sends only aggregates + workflow  - policies: allowed tools, approval    MCP, Composio, computer use
  definitions up                      rules, budgets                       - same approval gate
                                    - audit log, admin dashboard
```

## Principles (proposed)
1. Raw activity stays on the employee's Mac. The company sees workflows, outcomes and aggregates
   (hours saved, runs, approvals), never screenshots, keystrokes or window titles.
2. Workflows belong to a role, not a person. Credentials are role or service accounts held by the
   company (Composio org connections / company MCP), so work continues after someone leaves.
3. Continuing work after departure runs as the role or a named successor, never silently as the
   departed person. Their mailbox is handed over per the company's offboarding policy.
4. Overnight mode: drafts and reads run freely; any commit (send, post, pay, launch) needs either
   morning approval or a pre-approved policy (allowlisted recipients, caps per night, tone pack locked).
5. Same approval gate (ADR 0006) everywhere: Mac, cloud VM, overnight.
6. Working-time tracking is a separate, off-by-default feature with employee notice, per local law.

## Candidate slices (S2-xx)
| id | name |
|---|---|
| S2-01 | org model: tenants, teams, departments, roles, RBAC; SSO (Google/Microsoft) + SCIM |
| S2-02 | control plane API + sync from Macs (aggregates + workflow definitions, signed, encrypted) |
| S2-03 | workflow registry: promote a personal workflow to a role workflow; versioning; SOP export |
| S2-04 | admin dashboard: hours saved / efficiency by person, team, department, company; trends |
| S2-05 | policies: allowed tools per role, approval rules, budgets, model router limits |
| S2-06 | cloud workers: per-person / per-role VM (cua sandbox runtimes), browser + MCP + Composio |
| S2-07 | overnight mode: suggestions, schedule, pre-approved rules, morning report |
| S2-08 | continuity: offboarding hand-over, successor assignment, role identities |
| S2-09 | working-time insights (opt-in, notice, aggregates) |
| S2-10 | security review, compliance pack (SOC 2 path, data map, DPA), e2e |

## Open decisions (operator)
- Where the control plane runs: hosted by us (multi-tenant) vs inside each company's own cloud.
- Working-time tracking: off by default with notice (recommended) vs on.

Research brief: adam/memory/research/stage2/ (cua cloud sandboxes, RBAC/SCIM, monitoring law, continuity).

## Research outcome (2026-10-25, adam/memory/research/stage2/)
- Cua Cloud shut down 18 Oct 2026; cua-agent deprecated. Cloud workers v1 = Claude Managed Agents (one agent per role
  workflow, commit tools "always ask", session spend caps as nightly limits, cron deployments; $0.08/session-hour + tokens).
  Browserbase only for web tasks with no API. Cua MIT SDK kept as a later option. Always-on desktop per person deferred.
  Caveat: Managed Agents is not ZDR-eligible.
- Identity: WorkOS (AuthKit free; SSO/SCIM pass-through enterprise add-on). Roles: owner, admin, department lead, member,
  auditor, service identity.
- Monitoring: working-time and per-person views off by default; per-jurisdiction enablement + owner DPIA attestation;
  team aggregates with minimum group of 5; employee self-view; audit log of admin access; policy/notice templates
  (Ontario written policy, Quebec 8.1, NY/CT/DE notice, CPRA risk assessment, UK DPIA, German works council).
- Continuity: tag connections company vs personal; on leave freeze, assign successor/role identity, never send as the
  departed person, never automate a personal LinkedIn; workflows kept as SOPs without tokens.
- Hours saved: median observed manual time minus measured review/fix time, successful runs only, A/B/C confidence grade,
  evidence links, exactly recomputable.

Architecture, ADRs 0101-0110, contracts and slices: `plan/stage-2/plan.md` (2026-10-25).
