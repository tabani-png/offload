-- S2-09 follow-up (Codex on 04078b6): a remote create is never repeated blindly, and a session's first message is
-- persisted so recovery can send it.
--   deployments.create_key        set (with create_started_at) BEFORE deployments.create, sent as metadata
--                                 offload_create_key, cleared when the answer is recorded. Still set after the call:
--                                 the platform may hold a deployment Offload does not know, so no second create runs
--                                 and a person is alerted (create_alerted_at, audit worker.deployment_unconfirmed).
--   worker_runs.first_message     the run's first user.message, stored with the session id
--   worker_runs.first_sent_at     when it was sent (or found in the session's events)
ALTER TABLE deployments
  ADD COLUMN create_key uuid,
  ADD COLUMN create_started_at timestamptz,
  ADD COLUMN create_alerted_at timestamptz;
ALTER TABLE worker_runs
  ADD COLUMN first_message jsonb CHECK (first_message IS NULL OR jsonb_typeof(first_message) = 'object'),
  ADD COLUMN first_sent_at timestamptz;

-- Rows from before this migration: their sessions got the first message in memory.
UPDATE worker_runs SET first_sent_at = started_at WHERE session_ref <> '';
