# Data map: what Offload holds about people, and where

> **Not legal advice; review by counsel before use.** This map is generated from the control plane's person-table
> registry (`control/src/modules/compliance/selfview.ts`, `PERSON_COLUMNS`); a test fails when a table that holds a
> person id is missing from that registry, and another fails when a table there is missing from this page.

## On the employee's Mac (never uploaded)
| data | kept | who sees it |
|---|---|---|
| Raw activity events, frame notes, on-screen text, keyframes, titles, URLs | 7 days, then deleted | the employee only |
| Workflow drafts, facts values, sent mail examples | until the employee deletes them | the employee only |
| Evidence key that maps hashed instance refs to real items | on the Mac | the employee only |

## In the control plane (hosted by Offload, per tenant, row-level security)
| table | person column | what it holds | in the employee's self-view | retention |
|---|---|---|---|---|
| `people` | `id` | name, email, department, access role, jurisdiction, state, notice acknowledged | `person` | while employed, then per offboarding |
| `job_role_holders` | `person_id` | which job roles the person holds | `person.jobRoleIds` | while held |
| `devices` | `person_id` | enrolled Macs: name, app version, public key, dates, state | `devices` | until revoked + tenant policy |
| `audit_events` | `subject_person_id` (and ids in list reads) | who did or read what about the person, hash chained | `accessLog` ("who looked") | 6 years |
| `notice_acks` | `person_id` | which notice version was acknowledged, when (server receipt; a device-reported time is kept alongside), how, in which jurisdiction | `acks` | kept as a legal record |
| `sessions` | `person_id` | web sign-in sessions (token hashes, times) | not shown: credentials | 12 hours, revoked on freeze |
| `enrollment_codes` | `person_id` | one-time device enrollment codes (hashed) | not shown: credentials | 10 minutes, single use |
| `connections` | `owner_person_id` | references to the person's own connected accounts (never secrets) | listed by `GET /v1/connections` | until deleted |
| `support_grants` | `granted_by` | an owner's grant of support access | in the audit log | until expiry |
| `notices` | `created_by` | who drafted a notice version | in the audit log | 3 years after replacement |
| `feature_enablements` | `enabled_by`, `disabled_by` | the owner's enablement act with DPIA attestation | shown to everyone in `GET /v1/compliance/features` | kept as a record |
| `correction_requests` | `person_id` | the person's correction requests | in the access log as `correction.request` | kept as a record |
| `run_outcomes` | `person_id` | outcome, item counts, cost and times of each workflow run the person's Mac synced (S2-05) | `runs` | 90 days (tenant setting) |
| `run_owners` | `person_id` | which device's copy of a run counts toward hours saved (the device that stored it first; S2-05) | not shown (the run is under `runs`) | deleted with its run, 90 days (tenant setting) |
| `review_events` | `person_id` | review, edit and fix seconds per run (S2-05) | not shown: an hs-1 input | 90 days (tenant setting) |
| `baseline_samples` | `person_id` | manual-time baseline windows per workflow (S2-05) | not shown: an hs-1 input | 90 days (tenant setting) |
| `baseline_sample_instances` | `person_id` | seconds per hashed instance inside a baseline sample (S2-05) | not shown: part of the sample | with its sample |
| `daily_aggregates` | `person_id` | one person-day of workflow activity (S2-05) | `dailyAggregates` | 90 days (tenant setting) |
| `daily_aggregate_workflows` | `person_id` | per-workflow runs and successes inside a day (S2-05) | `dailyAggregates[].workflows` | with its day |
| `working_time_aggregates` | `person_id` | active minutes and first/last active quarter-hour of a day, only when working time is on (S2-05) | `workingTime` | 30 days (tenant setting) |
| `workflows` | `proposed_by`, `promoted_by` | who proposed and who promoted a shared workflow (S2-06) | own proposals listed by `GET /v1/workflows`; promotion in the audit log | while the workflow exists |
| `workflow_versions` | `created_by` | who saved a workflow version (S2-06) | in the audit log | while the workflow exists |
| `proposals_declined` | `declined_by` | who declined a proposal (S2-06) | in the audit log | kept as a record |
| `batches` | `runner_person_id` | send batches the person ran (S2-07) | listed by `GET /v1/batches`; outcomes in `runs` | per broker policy |
| `overnight_policies` | `owner_person_id` | overnight policies the person owns (S2-07) | listed by `GET /v1/overnight-policies` | until deleted |
| `kill_switches` | `set_by` | who set a kill switch (S2-07) | in the audit log | kept as a record |
| `role_policies` | `updated_by` | who last changed a job role's policy (S2-07) | in the audit log | while the role exists |
| `handovers` | `person_id`, `successor_person_id` | one hand-over per role workflow of a leaver: state, successor (person or role identity), in-flight choice, inbox step, removed connection ids (S2-10) | in the access log as `handover.opened` / `assigned` / `accepted` / `resumed` / `closed` (the leaver is the subject); the named successor sees `handover.successor_named` (they are its subject) | kept as a record |
| `handovers` | `assigned_by`, `closed_by` | who assigned the successor and who closed the hand-over (S2-10) | not shown as an identity: identifies the actor (admin, owner or dept lead), not the employee; the act is in the access log | kept as a record |
| `offboardings` | `person_id` | the person's offboarding: state, reason, effective date, note, frozen / departed times (S2-10) | in the access log as `person.offboard` / `person.freeze` / `person.departed` (the free-text note stays on the row) | kept as a record |
| `offboardings` | `requested_by` | who offboarded the person (S2-10) | not shown as an identity: identifies the actor (admin or owner), not the employee; the act is in the access log | kept as a record |
| `removed_connections` | `person_id` | which personal connections were deleted or erased at freeze, LinkedIn included (S2-10) | in the access log as `connection.removed` | kept as a record |

The retention job (nightly, every tenant) deletes the S2-05 rows above once they are older than the tenant's retention
(child rows with their parent); a missing table fails the job rather than being skipped. Group totals are kept 24
months and never show fewer than 5 people.

## What never reaches the control plane
Message bodies, subjects, recipients, window titles, URLs, screenshots, OCR text, keystrokes, tool arguments.
