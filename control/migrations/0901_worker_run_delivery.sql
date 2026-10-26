-- S2-09 follow-up (Codex on 1ff5f64): what the orchestrator asked for and what it confirmed are separate columns, so
-- nothing is marked done before the remote call succeeded and a restart can finish what was asked.
--   interrupt_sent_at       the interrupt was requested (kept name; durable intent, written in the deciding transaction)
--   interrupt_delivered_at  Managed Agents accepted the user.interrupt (or the session no longer exists)
--   interrupt_attempts / interrupt_next_at  failed deliveries and when the sweep tries again (backoff)
--   policy_reported_at      the ended run's result reached its overnight policy (reportRunResult / signals)
ALTER TABLE worker_runs
  ADD COLUMN interrupt_delivered_at timestamptz,
  ADD COLUMN interrupt_attempts integer NOT NULL DEFAULT 0 CHECK (interrupt_attempts >= 0),
  ADD COLUMN interrupt_next_at timestamptz,
  ADD COLUMN policy_reported_at timestamptz;

-- Rows from before this migration: their interrupts were sent and their results reported in memory.
UPDATE worker_runs SET interrupt_delivered_at = interrupt_sent_at WHERE interrupt_sent_at IS NOT NULL;
UPDATE worker_runs SET policy_reported_at = ended_at WHERE ended_at IS NOT NULL AND overnight_policy_id IS NOT NULL;

CREATE INDEX worker_runs_unfinished_idx ON worker_runs (tenant_id, id) WHERE ended_at IS NULL;
CREATE INDEX worker_runs_undelivered_idx ON worker_runs (tenant_id, id)
  WHERE interrupt_sent_at IS NOT NULL AND interrupt_delivered_at IS NULL;
