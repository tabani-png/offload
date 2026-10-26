-- S2-01: tenant isolation (ADR 0101 §2-3). Every tenant table: RLS enabled + forced + tenant_isolation policy.
-- The settings are read with nullif(..., '') because a placeholder reverts to '' (not NULL) after SET LOCAL ends.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'offload_app') THEN
    -- Defaults: no superuser, no RLS bypass, no role or database creation.
    CREATE ROLE offload_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['departments', 'department_group_mappings', 'people', 'job_roles', 'job_role_holders',
    'connections', 'role_identities', 'support_grants', 'sessions', 'enrollment_codes', 'devices', 'device_nonces',
    'audit_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END
$$;

-- tenants has no tenant_id (global allowlist) but is still isolated: a tenant sees only itself.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Pre-authentication lookups, read-only and keyed by a value only the caller holds (an id from WorkOS or a device id
-- the device itself was issued). They resolve which tenant a credential belongs to; every later step runs under
-- app.tenant_id.
CREATE POLICY tenant_org_lookup ON tenants FOR SELECT
  USING (workos_org_id = nullif(current_setting('app.lookup_workos_org', true), ''));
CREATE POLICY tenant_directory_lookup ON tenants FOR SELECT
  USING (workos_directory_id = nullif(current_setting('app.lookup_workos_directory', true), ''));
CREATE POLICY device_lookup ON devices FOR SELECT
  USING (id = nullif(current_setting('app.lookup_device_id', true), '')::uuid);

-- offload_app: not owner, cannot bypass RLS; no DELETE on audit, people, sessions or devices (revoke instead).
DO $$ BEGIN EXECUTE format('GRANT USAGE ON SCHEMA %I TO offload_app', current_schema()); END $$;
GRANT SELECT, UPDATE ON tenants TO offload_app;
GRANT SELECT, INSERT, UPDATE ON people, sessions, devices, enrollment_codes, device_nonces, support_grants TO offload_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON departments, department_group_mappings, job_roles, job_role_holders,
  connections, role_identities TO offload_app;
GRANT SELECT, INSERT ON audit_events TO offload_app;
