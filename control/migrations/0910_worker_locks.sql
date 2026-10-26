-- S2-09 follow-up (Codex on f229e62): a worker's sync lock and a tenant's provisioning lock are lease rows, not
-- transaction-scoped advisory locks. Holding them pins no pool connection: they are claimed and released by short
-- transactions, renewed while held, and expire if their holder dies. Names: `sync:<worker id>`, `provision`.
CREATE TABLE worker_locks (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  holder uuid NOT NULL,
  until timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, name)
);
ALTER TABLE worker_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON worker_locks
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON worker_locks TO offload_app;
