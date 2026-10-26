-- S2-09 follow-up (Codex on 1f8bb13): a run ended because Offload lost its session (stream lost or unavailable, an
-- orchestrator error) may still be running on the platform. Its budget stays reserved (monthSpent) until the session
-- is confirmed stopped; then its final cost replaces the reservation.
ALTER TABLE worker_runs ADD COLUMN session_unsettled boolean NOT NULL DEFAULT false;
CREATE INDEX worker_runs_unsettled_idx ON worker_runs (tenant_id, id) WHERE session_unsettled;

-- Runs already ended that way: confirmed by the next sweep.
UPDATE worker_runs SET session_unsettled = true
 WHERE ended_at IS NOT NULL AND session_ref <> '' AND session_deleted_at IS NULL
   AND error_code IN ('stream_lost', 'stream_unavailable', 'orchestrator_error');
