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
| `notice_acks` | `person_id` | which notice version was acknowledged, when, how, in which jurisdiction | `acks` | kept as a legal record |
| `sessions` | `person_id` | web sign-in sessions (token hashes, times) | not shown: credentials | 12 hours, revoked on freeze |
| `enrollment_codes` | `person_id` | one-time device enrollment codes (hashed) | not shown: credentials | 10 minutes, single use |
| `connections` | `owner_person_id` | references to the person's own connected accounts (never secrets) | listed by `GET /v1/connections` | until deleted |
| `support_grants` | `granted_by` | an owner's grant of support access | in the audit log | until expiry |
| `notices` | `created_by` | who drafted a notice version | in the audit log | 3 years after replacement |
| `feature_enablements` | `enabled_by`, `disabled_by` | the owner's enablement act with DPIA attestation | shown to everyone in `GET /v1/compliance/features` | kept as a record |
| `correction_requests` | `person_id` | the person's correction requests | in the access log as `correction.request` | kept as a record |

Planned by the ingest slice (S2-05), pruned by the retention job when present: `daily_aggregates` (90 days),
`run_outcomes`, `review_events`, `baseline_samples` (90 days), `working_time_aggregates` (30 days). Group totals are
kept 24 months and never show fewer than 5 people.

## What never reaches the control plane
Message bodies, subjects, recipients, window titles, URLs, screenshots, OCR text, keystrokes, tool arguments.
