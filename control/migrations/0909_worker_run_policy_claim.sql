-- S2-09 follow-up (Codex on a7fad80): a run's report to its overnight policy is claimed before any broker call
-- (`policy_claimed_at`, a lease a crashed reporter's claim expires from), so finish and recovery never both report it.
-- `policy_result_at` marks the run result as reported, so a retry after a partial report sends only the cost.
ALTER TABLE worker_runs ADD COLUMN policy_claimed_at timestamptz;
ALTER TABLE worker_runs ADD COLUMN policy_result_at timestamptz;
UPDATE worker_runs SET policy_result_at = policy_reported_at WHERE policy_reported_at IS NOT NULL;

-- An event is claimed before it is acted on (`claimed_at`, a lease) and marked handled after: two consumers of one
-- session (two processes) never act on the same event twice; a consumer that crashed mid-event leaves it to the next
-- one once the lease expires.
ALTER TABLE session_events ALTER COLUMN handled_at DROP NOT NULL;
ALTER TABLE session_events ADD COLUMN claimed_at timestamptz;
