-- S2-07 follow-up: broker audit events are queued per transaction and written after its last row lock (broker.ts
-- lock order, step 10). A queue that is never written must not commit silently: the broker inserts one marker row
-- when it starts a transaction's queue and deletes it when it writes the queue; a deferred constraint trigger fails
-- the commit if the marker is still there. Range 0700-0799.
CREATE TABLE broker_audit_pending (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE broker_audit_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_audit_pending FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON broker_audit_pending
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON broker_audit_pending TO offload_app;

CREATE FUNCTION s207_audit_pending_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM broker_audit_pending WHERE tenant_id = NEW.tenant_id AND id = NEW.id) THEN
    RAISE EXCEPTION 'broker: audit events were queued in this transaction and never written (call flushAudits)'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER s207_audit_pending_check AFTER INSERT ON broker_audit_pending
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION s207_audit_pending_check();
