-- S2-01: web sessions, devices and the audit log (ADR 0102 §2-3, ADR 0108 §5).

CREATE TABLE sessions (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  workos_session_id text,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);

CREATE TABLE enrollment_codes (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code_hash text NOT NULL,
  person_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  PRIMARY KEY (tenant_id, code_hash),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);

CREATE TABLE devices (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  app_version text NOT NULL CHECK (length(app_version) <= 32),
  public_key_jwk jsonb NOT NULL,
  enrolled_at timestamptz NOT NULL,
  last_sync_at timestamptz,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);

CREATE TABLE device_nonces (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  nonce text NOT NULL,
  device_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  PRIMARY KEY (tenant_id, nonce),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id)
);

-- Append-only, hash chained per tenant: hash = sha256(prevHash || JCS(event without hash)).
CREATE TABLE audit_events (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  id text NOT NULL CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  at_ms bigint NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('person', 'device', 'service', 'support', 'system')),
  actor_id uuid,
  actor_role text,
  action text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  subject_person_id uuid,
  resource_type text NOT NULL,
  resource_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text,
  hash text NOT NULL,
  PRIMARY KEY (tenant_id, seq),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, prev_hash)
);
CREATE INDEX audit_events_subject_idx ON audit_events (tenant_id, subject_person_id, seq);
