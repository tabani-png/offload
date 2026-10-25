# Shared language, Stage 2 (adds to plan/CONTEXT.md)

- **Tenant**: one customer company. Every row in the control plane belongs to exactly one tenant.
- **Person**: an employee record in a tenant (from directory sync or invited). States: `active`, `leaving`, `frozen`, `departed`.
- **Department**: an org unit (finance, sales, ops). A person belongs to one primary department.
- **Access role**: the RBAC role of a principal: `owner`, `admin`, `dept_lead`, `member`, `auditor`, `service`.
  Never call this just "role".
- **Job role**: a function in the company ("SDR, Sales", "AP clerk, Finance"). Workflows belong to job roles. A person
  holds zero or more job roles.
- **Role identity**: a company-held sending identity for a job role (`sales@`, a shared mailbox, a Company Page). Used by
  role workflows after hand-over and by cloud workers.
- **Principal**: who is calling: a person session, a device, or a service identity.
- **Device**: one enrolled Mac, holding a P-256 signing key. Sends `SyncEnvelope`s.
- **Sync object**: one of the closed set of objects a device may send (ADR 0103). Nothing else ever leaves the Mac.
- **Workflow definition**: the typed steps, gates, connector capabilities and SKILL.md text of a workflow, without
  personal data or tokens. Immutable per version; identified by `definitionHash`.
- **Proposal**: a personal workflow the employee chose to share. Becomes a role workflow only when promoted.
- **Role workflow**: a promoted workflow version owned by a job role and a department.
- **SOP**: a human-readable export of a role workflow version.
- **Connection**: a credential binding used by a step, tagged `company`, `personal-allowed` or `personal-forbidden`.
- **Cloud worker**: a Managed Agents agent + environment for one role workflow version.
- **Commit broker**: the control-plane component that alone performs commits, with the Stage 1 hash and journal rules.
- **Batch**: the set of items a run wants to commit; identified by `batchHash` (Stage 1 definition).
- **Overnight policy**: the rule set under which commits may run unattended (ADR 0106).
- **Morning digest**: the one screen/email listing what ran overnight and what waits for approval.
- **Kill switch**: an immediate stop at tenant, person or workflow scope.
- **Hand-over**: the task created on offboarding to assign a successor or role identity per workflow.
- **Sensitive feature**: `per_person_views` or `working_time`. Off by default (ADR 0108).
- **Group floor**: the minimum number of distinct people (5) behind any team or department aggregate.
- **hs-1**: version 1 of the hours-saved computation (ADR 0109).
