# 0113 Metrics: the group floor across reads, one run per run id, one working-time value per person-day

Date: 2026-10-26. Status: proposed (S2-05 builder, fix round after slices/S2-review/REVIEW-wave-B.md, PR #9). Amends
ADR 0103 §5 and ADR 0111 §4-5 where they were silent. Only S2-05 code changes; schemas, hs-1 and API shapes are
unchanged.

## 1. Complementary suppression holds across reads (ADR 0103 §5)
hs-1's `suppress()` floors one tree. A department or job role read on its own is floored where it sits in the company
tree (company → departments → the job roles of that department), not as a fresh root. If the company report hides a
department (under the floor, or as the complementary cell), `scope=department:<id>` is suppressed too, with the same
`group_floor` reason, its children suppressed and no top workflows. The same goes for a job role hidden in its
department's report.

A job role read directly counts every holder, including holders outside the role's department. When it has any
outside holder, the job role read is suppressed: job role minus department.job role gives the outside holders, and
taken from their own department's remainder it can single out the rest of that remainder (PR #9 round 4).

Each level is floored over its complete child set, before the report's children list is cut to the 500 the schema
holds (PR #9 round 4). Each level also floors its remainder, the rows of the parent in no child (people with no
department; people of a department with no job role of that department), as a child that is never shown, since the
parent minus the shown children equals it. On top of hs-1's rule, the hidden children of a level must together hold
0 or at least floor people; if not, the smallest visible child is hidden too. An empty child counts as under the floor
for `suppress()`, so without this an empty department stood in for the complementary cell of a small one.

A workflow in the top workflows of a department or job role is listed only when that workflow's own cell is visible
in the same tree built from that workflow's runs alone; otherwise the company's figure for it minus the department's
gives the workflow's seconds for the few people outside.

This applies to hours saved, adoption and working time alike. For adoption and working time the cell's size is the
number of people with data in the period.

Not covered: two group reads over overlapping periods (for example October and October plus one day) differ by the
people active only in the difference. Periods are free day ranges (ADR 0109), so this needs a product decision (fixed
reporting windows or noise) and is left open.

## 2. One run per run id (ADR 0111 §4)
Rows stay one per `(deviceId, runId)`, and a device's later envelope replaces its own row (latest seq). hs-1 takes one
run per run id, so when two devices report the same run id the metrics read keeps the copy received first: the first
copy stored inserts a claim on `(tenant, runId)` (`run_owners`, ON CONFLICT DO NOTHING), and the primary key settles
concurrent claims in commit order. No clock decides it; a transaction-start timestamp (`now()`) did, and let an
envelope that started first but stored its copy later take the run (PR #9 round 4). A second
device cannot replace a run by reusing its id. Run ids are ULIDs, so two honest devices do not collide. The kept copy
is chosen among every copy of the run id in the tenant before the period, person and workflow filters of a read, so a
later copy with another end date, person or workflow does not count where the kept one does not (PR #9 wave C).

## 3. One working-time value per person-day (ADR 0111 §5)
Working-time medians take one value per (person, day): the latest report by `createdAt`, then by the device's seq. Two
devices of one person, or a day sent again under a new object id, count once.

## 4. Staleness without locking snapshots (ADR 0109 §11)
An ingest that stores hs-1 inputs appends one `metric_dirty` row per transaction instead of updating snapshot rows.
The nightly job takes a per-tenant advisory lock, takes in the pending rows and marks snapshots stale before it reads
any input. A row that commits later stays pending for the next night. A month is `final` only while no row is
pending. `metric_dirty` has no person column and no DELETE grant. Pruning taken rows is a retention concern (S2-08).

## 5. Every value comes from inputs the floor lets through (PR #9 round 5)
A value in a metrics response (number, anomaly detail, digest, flag) is computed only from inputs whose contributors
pass the floor in the tree of the cell it is shown in.
- Adoption floors each field on its own contributors: people with data, active people, people with workflow activity,
  people with runs (rates, runs per week), people with a reviewed success (residual median). Each set is empty or at
  least the floor and visible in its own company tree, else the value is suppressed.
- Group views never list residual_zero_share (its detail is one person's counts). A workflow-keyed anomaly needs floor
  people behind it in scope and, below the company, a visible cell in the tree of those runs.
- `inputsDigest`: no inputs for a hidden cell; every run for the company; below it, the scope's own runs, their reviews
  and the baselines of their workflow versions.
- `final`: below the company, and for a suppressed company, it follows only the inputs behind the cell shown
  (`metric_snapshots.scope_digest`), never tenant-wide pending data. A visible company keeps §4.
- Baseline samples are workflow reference data (ADR 0109 §7) and stay outside this rule.
