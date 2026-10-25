# 0104 Workflow registry, job role ownership, promotion and SOP export

Date: 2026-10-25. Status: proposed. Evidence: research/stage2/04-continuity-offboarding.md §3.

## Context
Operator: workflows belong to job roles, not people, so the company keeps them after someone leaves, as knowledge
(SOPs) and as running automations. Stage 1 workflows live in `$OFFLOAD_HOME/workflows/<id>/` with typed steps in
`workflow.json`, `SKILL.md`, `facts.md`, `recipients.csv` and the gate allowlist.

## Decision
1. **States**: `personal` (Mac only, never synced) → `proposed` (employee shared a definition, ADR 0103 G4) →
   `role` (promoted) → `retired`. A proposal can be `declined` with a reason shown to the proposer.
2. **Definition** (`workflow-definition.schema.json`): typed steps (`read | draft | commit`), capability per step (s13
   vocabulary, e.g. `mail.send`, `sheet.append`), connection binding per step with ownership tag, gates, limits,
   SKILL.md text, facts template keys. `definitionHash = sha256(JCS(definition without metadata))`.
3. **Versions are immutable.** Editing makes a new version `n+1`; runs, baselines and outcomes reference
   `(workflowId, version)`. Baselines are frozen per version (ADR 0109); a new version starts with the previous
   version's baseline only if the steps' capabilities are unchanged, else grade C until re-observed with consent.
4. **Promotion** (dept_lead of the target department, or admin): picks a job role and department, reviews a diff
   from the proposal, confirms each connection binding is `company` (an org connection or role identity) or marks
   the step disabled. Promotion strips: facts values, recipient lists, tone examples, any `personal-forbidden` step.
5. **Ownership tags** on every connection binding: `company` (org OAuth, service account, shared mailbox, Company Page,
   CRM), `personal-allowed` (the running person's own account, under their own control, only while they are active),
   `personal-forbidden`. A version with a commit step bound to a `personal-forbidden` connection, or to connection kind
   `linkedin_personal` with any commit capability, is rejected (`409 forbidden_binding`). This is the "never automate a
   personal LinkedIn" rule, enforced at registry, broker and Mac runner.
6. **Who runs a role workflow**: members holding the job role (on their Mac, with their own `personal-allowed`
   connections or company connections), or a cloud worker under the job role's role identity (ADR 0105).
7. **SOP export**: `GET /v1/workflows/:id/versions/:v/sop?format=md|pdf` renders purpose, trigger, steps in plain
   words, decision rules, gates, connections by name (no tokens, no ids of secrets), owner job role, version history.
   Deterministic template (same input bytes → same Markdown bytes); PDF is rendered from the Markdown.
8. Registry events (`proposed`, `promoted`, `versioned`, `retired`, `declined`) are audit events.

## Consequences
- The company's knowledge survives departures as versioned SOPs even when no automation runs.
- The Mac app needs a "Share with my team" preview (S2-02 provides the brain route; UI later or in S2-08).
- Rejected: auto-syncing every personal workflow (surprising to employees, and facts can be personal).
