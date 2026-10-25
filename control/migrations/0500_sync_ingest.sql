-- S2-05 ingest (ADR 0103 §3): per-device envelope sequence and the idempotency ledger of sync objects.
-- No free text anywhere: ids, enums, codes and numbers only.

-- The last accepted envelope per device. `seq` strictly increases; an envelope at or below it is a replay.
CREATE TABLE device_seq (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  device_id uuid NOT NULL,
  last_seq bigint NOT NULL CHECK (last_seq >= 1),
  last_sent_at_ms bigint NOT NULL CHECK (last_sent_at_ms >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id)
);

-- Every object a device got accepted, keyed (tenant_id, device_id, object_id): a second copy is a duplicate.
-- digest = sha256(JCS(object)); a run_outcome may come again under its id with new content (ADR 0111 §4).
CREATE TABLE sync_objects (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  device_id uuid NOT NULL,
  object_id text NOT NULL CHECK (object_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  kind text NOT NULL CHECK (kind IN ('notice_ack', 'run_outcome', 'review_event', 'baseline_sample', 'daily_aggregate',
    'working_time_aggregate', 'workflow_proposal')),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  seq bigint NOT NULL CHECK (seq >= 1),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id, object_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['device_seq', 'sync_objects']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END
$$;

-- Sync tables are append/update only for the app (ADR 0101 §3: no DELETE on sync tables).
GRANT SELECT, INSERT, UPDATE ON device_seq, sync_objects TO offload_app;
