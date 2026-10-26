-- S2-09 cloud workers (ADR 0105, ADR 0106 §4-7, ADR 0112). Range 0900-0999.
-- Same rules as S2-01: tenant_id leads every key, composite foreign keys, RLS enabled + forced. offload_app may DELETE
-- only session_cursors and session_events (retention of ended sessions); everything else keeps its history.

-- One Managed Agents environment per tenant (ADR 0105 §1).
CREATE TABLE worker_environments (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  environment_id text NOT NULL CHECK (length(environment_id) BETWEEN 1 AND 100),
  allowed_hosts jsonb NOT NULL CHECK (jsonb_typeof(allowed_hosts) = 'array'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id)
);

-- One vault per job role, read credentials only.
CREATE TABLE worker_vaults (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  job_role_id uuid NOT NULL,
  vault_id text NOT NULL CHECK (length(vault_id) BETWEEN 1 AND 100),
  credential_connection_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, job_role_id),
  FOREIGN KEY (tenant_id, job_role_id) REFERENCES job_roles (tenant_id, id)
);

CREATE TABLE workers (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  job_role_id uuid NOT NULL,
  department_id uuid NOT NULL,
  identity_type text NOT NULL CHECK (identity_type IN ('person', 'role_identity')),
  identity_id uuid NOT NULL,
  -- The person a scheduled run acts for: the identity itself, or (role identity) whoever created the worker.
  owner_person_id uuid NOT NULL,
  commit_connection_id uuid,
  state text NOT NULL CHECK (state IN ('provisioning', 'ready', 'paused', 'failed', 'retired')),
  failed_reason text CHECK (length(failed_reason) <= 300),
  paused_reason text CHECK (length(paused_reason) <= 200),
  session_budget_cents integer NOT NULL CHECK (session_budget_cents BETWEEN 1 AND 100000),
  agent_id text CHECK (length(agent_id) <= 100),
  agent_version integer CHECK (agent_version >= 1),
  environment_id text CHECK (length(environment_id) <= 100),
  vault_id text CHECK (length(vault_id) <= 100),
  -- read MCP servers: name -> {url, connectors[]} (ADR 0112 §1), fixed at provisioning.
  mcp_servers jsonb NOT NULL DEFAULT '{}'::jsonb,
  template_hash text NOT NULL CHECK (template_hash ~ '^[0-9a-f]{64}$'),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (id),
  FOREIGN KEY (tenant_id, job_role_id) REFERENCES job_roles (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES people (tenant_id, id)
);
CREATE INDEX workers_identity_idx ON workers (tenant_id, identity_id);

-- A worker's schedule and its Managed Agents deployment (ADR 0105 §5). desired vs remote: the reconcile step makes
-- the remote deployment match what the control plane wants (paused by a kill switch, archived on retire).
CREATE TABLE deployments (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  worker_id uuid NOT NULL,
  cron text NOT NULL CHECK (length(cron) <= 100),
  timezone text NOT NULL CHECK (length(timezone) <= 64),
  deployment_id text CHECK (length(deployment_id) <= 100),
  desired_status text NOT NULL CHECK (desired_status IN ('active', 'paused', 'archived')),
  remote_status text NOT NULL DEFAULT 'none' CHECK (remote_status IN ('none', 'active', 'paused', 'archived')),
  -- deployments replaced by a schedule change, still to be archived remotely.
  stale_deployment_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_run_seen_at text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, worker_id),
  FOREIGN KEY (tenant_id, worker_id) REFERENCES workers (tenant_id, id)
);

CREATE TABLE worker_runs (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  worker_id uuid NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'schedule')),
  runner_person_id uuid NOT NULL,
  -- the run's input set (ADR 0105 §7); null = none given, every recipient then waits for a person.
  input_recipients jsonb CHECK (input_recipients IS NULL OR jsonb_typeof(input_recipients) = 'array'),
  overnight boolean NOT NULL DEFAULT false,
  overnight_policy_id uuid,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  state text NOT NULL CHECK (state IN ('running', 'waiting_approval', 'idle', 'done', 'failed', 'capped', 'interrupted')),
  stop_reason text CHECK (stop_reason IN ('end_turn', 'requires_action', 'budget_reached', 'error')),
  error_code text CHECK (error_code ~ '^[a-z_]{1,64}$'),
  cost_cents bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  -- worst case a session may still spend: its budget until it ends (tenant monthly cap).
  budget_cents integer NOT NULL CHECK (budget_cents >= 1),
  summary text CHECK (length(summary) <= 2000),
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  session_ref text NOT NULL DEFAULT '' CHECK (length(session_ref) <= 100),
  deployment_run_ref text CHECK (length(deployment_run_ref) <= 100),
  interrupt_sent_at timestamptz,
  outcome_seq bigint NOT NULL DEFAULT 0,
  session_deleted_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, deployment_run_ref),
  FOREIGN KEY (tenant_id, worker_id) REFERENCES workers (tenant_id, id),
  FOREIGN KEY (tenant_id, runner_person_id) REFERENCES people (tenant_id, id)
);
CREATE INDEX worker_runs_worker_idx ON worker_runs (tenant_id, worker_id, started_at DESC);
CREATE INDEX worker_runs_started_idx ON worker_runs (tenant_id, started_at);

-- Batches a run proposed (the hashes are the broker's) and the breaker trips the orchestrator saw.
CREATE TABLE worker_run_batches (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  run_id text NOT NULL,
  batch_hash text NOT NULL CHECK (batch_hash ~ '^[0-9a-f]{64}$'),
  items integer NOT NULL CHECK (items >= 0),
  auto_approved integer NOT NULL DEFAULT 0 CHECK (auto_approved >= 0),
  policy_id uuid,
  at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, run_id, batch_hash),
  FOREIGN KEY (tenant_id, run_id) REFERENCES worker_runs (tenant_id, id)
);

CREATE TABLE worker_run_trips (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  run_id text NOT NULL,
  policy_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) <= 200),
  at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, run_id, policy_id, reason),
  FOREIGN KEY (tenant_id, run_id) REFERENCES worker_runs (tenant_id, id)
);

-- Lossless SSE consumption: the last event seen per session and every event already handled (exactly once).
CREATE TABLE session_cursors (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 100),
  run_id text NOT NULL,
  last_event_id text,
  last_processed_at text,
  reconnects integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, session_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES worker_runs (tenant_id, id)
);

CREATE TABLE session_events (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  session_id text NOT NULL,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 100),
  type text NOT NULL CHECK (length(type) <= 64),
  handled_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, session_id, event_id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES session_cursors (tenant_id, session_id) ON DELETE CASCADE
);

-- The revoked "Offload cloud" device per person that cloud run outcomes are stored under (ADR 0112 §5).
CREATE TABLE worker_cloud_devices (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  person_id uuid NOT NULL,
  device_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, person_id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['worker_environments', 'worker_vaults', 'workers', 'deployments', 'worker_runs',
    'worker_run_batches', 'worker_run_trips', 'session_cursors', 'session_events', 'worker_cloud_devices']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO offload_app', t);
  END LOOP;
END
$$;
GRANT DELETE ON session_cursors, session_events TO offload_app;
