-- S2-07 policies + commit broker (ADR 0105 §3, ADR 0106). Range 0700-0799.
-- Same rules as S2-01: tenant_id leads every key, composite foreign keys, RLS enabled + forced, offload_app gets no
-- DELETE (revocation and clearing are updates, so the history stays).

CREATE TABLE role_policies (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  job_role_id uuid NOT NULL,
  allowed_capabilities jsonb NOT NULL CHECK (jsonb_typeof(allowed_capabilities) = 'array'),
  approvers text NOT NULL CHECK (approvers IN ('runner', 'dept_lead', 'runner_or_dept_lead')),
  session_budget_cents integer NOT NULL CHECK (session_budget_cents BETWEEN 1 AND 100000),
  daily_budget_cents bigint NOT NULL CHECK (daily_budget_cents >= 0),
  max_items_per_batch integer NOT NULL CHECK (max_items_per_batch BETWEEN 1 AND 500),
  model_design text NOT NULL,
  model_steps text NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, job_role_id),
  FOREIGN KEY (tenant_id, job_role_id) REFERENCES job_roles (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, updated_by) REFERENCES people (tenant_id, id)
);

CREATE TABLE overnight_policies (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  mode text NOT NULL CHECK (mode IN ('drafts_only', 'preapproved')),
  recipients jsonb NOT NULL,
  template_hash text CHECK (template_hash ~ '^[0-9a-f]{64}$'),
  max_commits_per_night integer NOT NULL CHECK (max_commits_per_night BETWEEN 0 AND 500),
  max_per_recipient_per_week integer NOT NULL CHECK (max_per_recipient_per_week BETWEEN 0 AND 7),
  send_window jsonb NOT NULL,
  attachments_allowed boolean NOT NULL DEFAULT false,
  budget_cents_per_night bigint NOT NULL CHECK (budget_cents_per_night >= 0),
  dry_run_nights integer NOT NULL CHECK (dry_run_nights BETWEEN 0 AND 30),
  dry_run_nights_done integer NOT NULL DEFAULT 0 CHECK (dry_run_nights_done >= 0),
  circuit_breakers jsonb NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'tripped', 'paused')),
  tripped_reason text CHECK (length(tripped_reason) <= 200),
  owner_person_id uuid NOT NULL,
  consecutive_failures integer NOT NULL DEFAULT 0,
  -- Fingerprint of the commit connection seen on the last overnight batch (a change trips the policy).
  connection_fingerprint text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_person_id) REFERENCES people (tenant_id, id),
  CHECK (mode = 'drafts_only' OR template_hash IS NOT NULL)
);
CREATE INDEX overnight_policies_workflow ON overnight_policies (tenant_id, workflow_id, version);

-- One row per policy and night (local date of now - 12 h in the tenant's reporting timezone).
CREATE TABLE overnight_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  policy_id uuid NOT NULL,
  night date NOT NULL,
  dry_run boolean NOT NULL,
  budget_cents bigint NOT NULL DEFAULT 0,
  sends integer NOT NULL DEFAULT 0,
  bounces integer NOT NULL DEFAULT 0,
  negative_replies integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, policy_id, night),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES overnight_policies (tenant_id, id)
);

CREATE TABLE batches (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  workflow_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  run_id text NOT NULL CHECK (run_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  runtime text NOT NULL CHECK (runtime IN ('mac', 'cloud')),
  identity_type text NOT NULL CHECK (identity_type IN ('person', 'role_identity')),
  identity_id uuid NOT NULL,
  job_role_id uuid NOT NULL,
  department_id uuid NOT NULL,
  runner_person_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  crm_sheet jsonb,
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'sending', 'done', 'rejected', 'expired')),
  rejected_reason text CHECK (length(rejected_reason) <= 200),
  replaced_by text,
  overnight_policy_id uuid,
  overnight_eval jsonb,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, hash),
  FOREIGN KEY (tenant_id, job_role_id) REFERENCES job_roles (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, runner_person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id),
  FOREIGN KEY (tenant_id, overnight_policy_id) REFERENCES overnight_policies (tenant_id, id)
);
CREATE INDEX batches_state ON batches (tenant_id, state, created_at);
CREATE INDEX batches_workflow ON batches (tenant_id, workflow_id);

-- One-use approval tokens. Only sha256(token) is stored; the token itself never leaves the broker's process.
CREATE TABLE approval_tokens (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  batch_hash text NOT NULL,
  item_keys jsonb NOT NULL CHECK (jsonb_typeof(item_keys) = 'array'),
  approver_kind text NOT NULL CHECK (approver_kind IN ('person', 'policy')),
  approved_by uuid NOT NULL,
  policy_id uuid,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_hash) REFERENCES batches (tenant_id, hash),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES overnight_policies (tenant_id, id),
  CHECK ((approver_kind = 'policy') = (policy_id IS NOT NULL))
);

-- The item journal (Stage 1 semantics): pending -> sending -> sent | unknown; pending -> failed_before_send.
CREATE TABLE batch_items (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  batch_hash text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  position integer NOT NULL,
  capability text NOT NULL,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
  item_hash text NOT NULL CHECK (item_hash ~ '^[0-9a-f]{64}$'),
  recipient text NOT NULL,
  recipient_tz text CHECK (length(recipient_tz) <= 64),
  state text NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed_before_send', 'unknown', 'rejected')),
  token_id uuid,
  scheduled_for timestamptz,
  policy_allowed_at timestamptz,
  policy_night date,
  tool text,
  error text CHECK (length(error) <= 500),
  sent_at timestamptz,
  released_at timestamptz,
  released_by uuid,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, batch_hash, key),
  UNIQUE (tenant_id, batch_hash, position),
  FOREIGN KEY (tenant_id, batch_hash) REFERENCES batches (tenant_id, hash),
  FOREIGN KEY (tenant_id, token_id) REFERENCES approval_tokens (tenant_id, id)
);
CREATE INDEX batch_items_due ON batch_items (tenant_id, state, scheduled_for) WHERE token_id IS NOT NULL;
CREATE INDEX batch_items_recipient ON batch_items (tenant_id, recipient);

-- Who was (or may have been) contacted: written in the same transaction that marks an item sending, before the call.
CREATE TABLE contacted_ledger (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  batch_hash text NOT NULL,
  item_key text NOT NULL,
  recipient text NOT NULL,
  policy_id uuid,
  at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('sending', 'sent', 'unknown')),
  released_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, batch_hash, item_key),
  FOREIGN KEY (tenant_id, batch_hash, item_key) REFERENCES batch_items (tenant_id, batch_hash, key)
);
CREATE INDEX contacted_ledger_recipient ON contacted_ledger (tenant_id, workflow_id, recipient);

CREATE TABLE kill_switches (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('tenant', 'person', 'workflow')),
  target_id uuid,
  active boolean NOT NULL DEFAULT true,
  set_by uuid NOT NULL,
  set_by_role text NOT NULL,
  set_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(reason) <= 200),
  cleared_at timestamptz,
  cleared_by uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, set_by) REFERENCES people (tenant_id, id),
  CHECK ((scope = 'tenant') = (target_id IS NULL))
);
CREATE UNIQUE INDEX kill_switches_active ON kill_switches (tenant_id, scope, coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE active;

CREATE TABLE breaker_trips (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) <= 200),
  batch_hash text,
  at timestamptz NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES overnight_policies (tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['role_policies', 'overnight_policies', 'overnight_counters', 'batches', 'approval_tokens',
    'batch_items', 'contacted_ledger', 'kill_switches', 'breaker_trips']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO offload_app', t);
  END LOOP;
END
$$;
