-- New hs-1 inputs (review wave B, PR #9 item 4). Ingest used to update every snapshot row of the tenant for every
-- metric object, inside the ingest transaction: concurrent envelopes queued on those rows and could deadlock with the
-- nightly job's FOR UPDATE. Instead an ingest that stored hs-1 inputs appends one row here per transaction (no row
-- of anyone else is locked). The nightly job, under a tenant advisory lock, sets taken_at on the rows it sees and marks
-- the snapshots stale before reading any input; a row committed after that stays pending for the next night. A month is
-- final only while no row is pending. Like every S2-05 table there is no DELETE grant (retention is S2-08's).
CREATE TABLE metric_dirty (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  taken_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX metric_dirty_pending_idx ON metric_dirty (tenant_id) WHERE taken_at IS NULL;

ALTER TABLE metric_dirty ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_dirty FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON metric_dirty
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON metric_dirty TO offload_app;
