-- One run per run id for hs-1 (review wave B, PR #9 item 7). Rows stay one per (device, run) and a device's later
-- envelope still replaces its own row (ADR 0111 §4). When two devices report the same run id, the metrics read keeps
-- the copy first received, so another device cannot replace a run by reusing its id. The upsert in ingest never
-- sets this column, so it keeps the time of the first insert.
ALTER TABLE run_outcomes ADD COLUMN first_received_at timestamptz NOT NULL DEFAULT now();
