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

A job role read directly counts every holder, including holders outside the role's department. When those outside
holders are 1 to floor-1 people, the job role read is suppressed, since job role minus department.job role would
single them out.

This applies to hours saved, adoption and working time alike. For adoption and working time the cell's size is the
number of people with data in the period.

## 2. One run per run id (ADR 0111 §4)
Rows stay one per `(deviceId, runId)`, and a device's later envelope replaces its own row (latest seq). hs-1 takes one
run per run id, so when two devices report the same run id the metrics read keeps the copy received first. A second
device cannot replace a run by reusing its id. Run ids are ULIDs, so two honest devices do not collide.

## 3. One working-time value per person-day (ADR 0111 §5)
Working-time medians take one value per (person, day): the latest report by `createdAt`, then by the device's seq. Two
devices of one person, or a day sent again under a new object id, count once.

## 4. Staleness without locking snapshots (ADR 0109 §11)
An ingest that stores hs-1 inputs appends one `metric_dirty` row per transaction instead of updating snapshot rows.
The nightly job takes a per-tenant advisory lock, takes in the pending rows and marks snapshots stale before it reads
any input. A row that commits later stays pending for the next night. A month is `final` only while no row is
pending. `metric_dirty` has no person column and no DELETE grant. Pruning taken rows is a retention concern (S2-08).
