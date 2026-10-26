-- The final flag below the company (PR #9 round 5). A department's or job role's flag used to drop whenever anything
-- arrived anywhere in the tenant (metric_dirty) and to come back after the nightly job, so it told its reader that some
-- hidden group had sent data. scope_digest is the digest of the inputs behind the cell shown (hours.ts visibleDigest:
-- the scope's own runs, their reviews and baselines; a fixed digest when the cell is suppressed). The nightly job
-- re-checks a department or job role snapshot only when that digest moved, and a read calls it final only while the
-- digest still matches. The company keeps the tenant-wide rule (migration 0502): all data is in its total.
ALTER TABLE metric_snapshots ADD COLUMN scope_digest text CHECK (scope_digest ~ '^[0-9a-f]{64}$');
