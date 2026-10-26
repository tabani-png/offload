-- S2-09 follow-up (Codex on 86d4dd0): the cost of a run already counted on its overnight policy's night counter. A
-- cost that grows after that report (a lost session settling later) adds only the difference, in the same
-- transaction that moves this mark, so it is counted exactly once.
ALTER TABLE worker_runs ADD COLUMN policy_cost_cents integer CHECK (policy_cost_cents >= 0);

-- Runs already reported counted their cost as it is now.
UPDATE worker_runs SET policy_cost_cents = cost_cents WHERE policy_reported_at IS NOT NULL;
