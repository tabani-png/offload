# 0108 Monitoring compliance features

Date: 2026-10-25. Status: proposed. Evidence: research/stage2/02-monitoring-law.md (product requirements 1-12).
Not legal advice; the compliance pack is reviewed by counsel per launch market before sale (S2-12 gate).

## Context
Operator decision: working-time and per-person views are off by default with employee notice. Every target
jurisdiction treats the observer as electronic monitoring. Per-person efficiency and working time trigger DPIAs,
California risk assessments, Quebec profiling rules and German works-council agreements.

## Decision
1. **Jurisdiction per person** (`CA-ON`, `CA-QC`, `CA-BC`, `CA-AB`, `US-NY`, `US-CT`, `US-DE`, `US-CA`, other `US-*`,
   `GB`, `DE`, other ISO 3166-1/2 codes). Admin sets it; directory sync may prefill. Unknown = most restrictive set.
2. **Features**: `workflow_metrics` (always on; aggregates and workflow-level numbers), `per_person_views`,
   `working_time`. Each sensitive feature has a per-tenant enablement record per jurisdiction set:
   `enabledBy` (must be owner), `jurisdictions[]`, `legalBasis` (`legitimate_interest | contract | consent |
   works_agreement | other`), `dpiaAttestation { completedOn, documentRef (hash + filename, document stored by tenant
   or uploaded), signerName, signerTitle }`, `noticeVersionId`, `noticePeriodDays` (default 14, min 0 only where no
   rule requires notice, min 1 for NY/DE/CT), `worksAgreementRef` (required for `DE`), `quebecActivationAck`
   (required for `CA-QC`: s.8.1 means of activation described in the notice), `purposeLock` (`process_improvement`,
   fixed). Features are hidden, not just warned, for jurisdictions not enabled.
3. **Notice engine**: notice versions (Markdown, generated from `compliance/templates/` and edited by the tenant) list
   what is captured, why, who sees what, retention, how to pause, and which sensitive features are on. A new version
   that adds a feature requires a fresh ack. Acks record person, version, timestamp, channel (`mac_app | web`), and
   jurisdiction. Delaware option: daily banner on the Mac. NY: ack at hire. Version history kept ≥ 3 years after
   replacement (Ontario).
4. **Employee self-view** (`GET /v1/me/data`): every row the control plane holds about me, the hs-1 arithmetic behind
   my numbers, which features are on for me, my acks, and **who viewed my per-person data and when** (from the audit
   log). Export (`GET /v1/me/export`, JSON) and correction requests (`POST /v1/me/correction-requests`).
5. **Admin access audit log**: append-only `audit_events` (no UPDATE/DELETE grants), each row
   `prevHash`/`hash = sha256(prevHash || JCS(row))` per tenant chain; written in the same transaction as the read or
   mutation. Events: every per-person read (`person.read`), every admin mutation, sensitive feature changes, exports,
   support grants, kill switches, approvals. Readable by owner, admin, auditor; subject-filtered for self-view.
6. **Purpose lock**: product terms and UI copy state metrics are for process improvement and must not be the sole basis
   for pay, discipline or dismissal. No ranking endpoints; per-person views list a person's own workflows and hours,
   never sorted league tables across people.
7. **Retention defaults** (configurable downward only): raw on Mac 7 days (fixed); per-person aggregates 90 days;
   working-time aggregates 30 days; group aggregates 24 months; audit 6 years; notices 3 years after replacement.
8. **Works council mode** (DE): sensitive features stay off; aggregate views limited to what the uploaded agreement
   allows (tenant-configured list of enabled views).
9. **Compliance pack** (`compliance/`): notice templates (Ontario ESA policy fields, CT posting, NY notice + ack, DE
   daily notice, BC/AB notification, Quebec 8.1/8.2, California notice at collection, UK/EU transparency notice), DPIA
   template, CA risk assessment template, works agreement template (DE), data map, DPA with sub-processors (Managed
   Agents not ZDR, Composio, WorkOS, our host).

## Consequences
- Turning on a sensitive feature is a deliberate, attributable owner act with a waiting period employees can see.
- The product is sellable into Germany only with works council mode and a works agreement.
