-- The org hierarchy a snapshot was computed under (S2-05 follow-ups). A person changing department, a job role moving or
-- a rename changes which runs a department or job role holds, with no ingest: the nightly job took that for rows edited
-- outside ingest and raised recompute_mismatch. hier_digest is the digest of departments, job roles and people's
-- attribution at the time; when it moved, the job replaces the snapshot instead of alerting. Data edits under an
-- unchanged hierarchy are still mismatches.
ALTER TABLE metric_snapshots ADD COLUMN hier_digest text CHECK (hier_digest ~ '^[0-9a-f]{64}$');
