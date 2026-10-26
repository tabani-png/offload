-- S2-01 wave A (ADR 0111): PKCE-bound enrollment codes, directory webhook dedupe, external audit anchors.

-- Loopback PKCE (ADR 0111 §1): codes minted by /auth/callback carry the Mac's S256 code_challenge; admin-issued codes
-- leave it null.
ALTER TABLE enrollment_codes ADD COLUMN code_challenge text CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$');

-- Directory Sync webhooks are processed once per WorkOS event id.
CREATE TABLE directory_events (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
);

-- Audit anchors: the chain head (seq, hash, time) copied out of reach of the app role. Only offload_anchor inserts;
-- nobody updates or deletes. A signed checkpoint file exported from here is the copy outside the database.
CREATE TABLE audit_anchors (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id bigint GENERATED ALWAYS AS IDENTITY,
  head_seq bigint NOT NULL CHECK (head_seq > 0),
  head_id text NOT NULL CHECK (head_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  head_hash text NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  anchored_at_ms bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, head_seq)
);

CREATE FUNCTION audit_anchors_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_anchors is append-only';
END
$$;
CREATE TRIGGER audit_anchors_no_update BEFORE UPDATE OR DELETE ON audit_anchors
  FOR EACH ROW EXECUTE FUNCTION audit_anchors_append_only();
CREATE TRIGGER audit_anchors_no_truncate BEFORE TRUNCATE ON audit_anchors
  FOR EACH STATEMENT EXECUTE FUNCTION audit_anchors_append_only();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['directory_events', 'audit_anchors']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END
$$;

-- offload_anchor: a distinct role for the anchoring job and verify-chain. Reads the chain, appends anchors, nothing else.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'offload_anchor') THEN
    CREATE ROLE offload_anchor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
DO $$ BEGIN EXECUTE format('GRANT USAGE ON SCHEMA %I TO offload_anchor', current_schema()); END $$;
-- It walks every tenant, so it may list tenant ids (and nothing else about them).
GRANT SELECT (id) ON tenants TO offload_anchor;
CREATE POLICY anchor_enumerate ON tenants FOR SELECT TO offload_anchor USING (true);
GRANT SELECT ON audit_events TO offload_anchor;
GRANT SELECT, INSERT ON audit_anchors TO offload_anchor;

GRANT SELECT ON audit_anchors TO offload_app;
GRANT SELECT, INSERT ON directory_events TO offload_app;
