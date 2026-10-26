-- Per-device rate limit on sync ingest (PR #9 wave C item 3, round 3 item 2). The budget counts accepted objects, not
-- distinct object ids: a run_outcome replaced under its id (ADR 0111 §4) overwrites its sync_objects row, so counting
-- that ledger would let one id be replaced without limit. Each envelope that got objects accepted appends one row here
-- with how many; ingest sums the rows of the last hour under the device_seq lock. Numbers only, no text. Like every
-- S2-05 table there is no DELETE grant (retention is S2-08's).
CREATE TABLE sync_accepts (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  device_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 1),
  at timestamptz NOT NULL,
  accepted integer NOT NULL CHECK (accepted >= 1),
  PRIMARY KEY (tenant_id, device_id, seq),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id)
);
CREATE INDEX sync_accepts_device_at ON sync_accepts (tenant_id, device_id, at);

ALTER TABLE sync_accepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_accepts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_accepts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON sync_accepts TO offload_app;
