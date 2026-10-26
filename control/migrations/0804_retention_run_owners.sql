-- S2-08 follow-up (merge of main with S2-05's migration 0505): run_owners references the owning copy of a run in
-- run_outcomes, so the retention pass deletes a run's claim with that copy (retention.ts RETENTION_TABLES). Same grant
-- as 0801 gives the other per-person tables; a tree without run_owners gets none and the pass fails closed.
DO $$
BEGIN
  IF to_regclass('run_owners') IS NOT NULL THEN
    GRANT SELECT, DELETE ON run_owners TO offload_retention;
  END IF;
END
$$;
