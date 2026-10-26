-- S2-05 metrics storage (ADR 0103 §1, ADR 0109): what the five metric sync kinds carry, column for column, plus the
-- monthly hs-1 snapshots the nightly recompute checks. Ids, enums, codes and numbers only; no free text.
-- person_id is the device's person (sync objects never name a person themselves).

CREATE TABLE run_outcomes (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  device_id uuid NOT NULL,
  run_id text NOT NULL CHECK (run_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  object_id text NOT NULL CHECK (object_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  person_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 1),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  workflow_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  runtime text NOT NULL CHECK (runtime IN ('mac', 'cloud')),
  started_at_ms bigint NOT NULL CHECK (started_at_ms >= 0),
  ended_at_ms bigint NOT NULL CHECK (ended_at_ms >= 0),
  outcome text NOT NULL CHECK (outcome IN ('success', 'failed', 'cancelled', 'rejected', 'capped')),
  items_total integer NOT NULL CHECK (items_total >= 0),
  items_sent integer NOT NULL CHECK (items_sent >= 0),
  items_failed_before_send integer NOT NULL CHECK (items_failed_before_send >= 0),
  items_unknown integer NOT NULL CHECK (items_unknown >= 0),
  items_pending integer NOT NULL CHECK (items_pending >= 0),
  batch_hash text CHECK (batch_hash ~ '^[0-9a-f]{64}$'),
  approver_kind text CHECK (approver_kind IN ('person', 'policy')),
  overnight_policy_id uuid,
  cost_cents bigint NOT NULL CHECK (cost_cents >= 0),
  error_code text CHECK (error_code ~ '^[a-z_]{1,64}$'),
  overnight boolean NOT NULL,
  received_at timestamptz NOT NULL,
  -- ADR 0111 §4: one row per (device, run); a later envelope replaces it.
  PRIMARY KEY (tenant_id, device_id, run_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);
CREATE INDEX run_outcomes_ended_idx ON run_outcomes (tenant_id, ended_at_ms);
CREATE INDEX run_outcomes_workflow_idx ON run_outcomes (tenant_id, workflow_id, version);

CREATE TABLE review_events (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  device_id uuid NOT NULL,
  object_id text NOT NULL CHECK (object_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  person_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 1),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  run_id text NOT NULL CHECK (run_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  review_seconds integer NOT NULL CHECK (review_seconds >= 0),
  edit_seconds integer NOT NULL CHECK (edit_seconds >= 0),
  fix_seconds integer NOT NULL CHECK (fix_seconds >= 0),
  items_edited integer NOT NULL CHECK (items_edited >= 0),
  decision text NOT NULL CHECK (decision IN ('approved', 'approved_with_edits', 'rejected', 'partial', 'policy_committed')),
  surface text NOT NULL CHECK (surface IN ('mac_review', 'web_digest', 'mac_fixup', 'broker')),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id, object_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);
CREATE INDEX review_events_run_idx ON review_events (tenant_id, run_id);

CREATE TABLE baseline_samples (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  device_id uuid NOT NULL,
  object_id text NOT NULL CHECK (object_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  person_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 1),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  workflow_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  window_start date NOT NULL,
  window_end date NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id, object_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);
CREATE INDEX baseline_samples_workflow_idx ON baseline_samples (tenant_id, workflow_id, version);

-- One row per instance, in the order the device sent them (idx).
CREATE TABLE baseline_sample_instances (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  device_id uuid NOT NULL,
  object_id text NOT NULL,
  idx integer NOT NULL CHECK (idx >= 0),
  person_id uuid NOT NULL,
  instance_ref text NOT NULL CHECK (instance_ref ~ '^[0-9a-f]{32}$'),
  active_seconds integer NOT NULL CHECK (active_seconds >= 0),
  day date NOT NULL,
  PRIMARY KEY (tenant_id, device_id, object_id, idx),
  FOREIGN KEY (tenant_id, device_id, object_id) REFERENCES baseline_samples (tenant_id, device_id, object_id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);

CREATE TABLE daily_aggregates (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  device_id uuid NOT NULL,
  object_id text NOT NULL CHECK (object_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  person_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 1),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  day date NOT NULL,
  active_workflows integer NOT NULL CHECK (active_workflows >= 0),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id, object_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);
CREATE INDEX daily_aggregates_day_idx ON daily_aggregates (tenant_id, day);

CREATE TABLE daily_aggregate_workflows (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  device_id uuid NOT NULL,
  object_id text NOT NULL,
  idx integer NOT NULL CHECK (idx >= 0),
  person_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  runs integer NOT NULL CHECK (runs >= 0),
  successes integer NOT NULL CHECK (successes >= 0),
  -- Device-computed, for the person's own view only; hs-1 numbers are always recomputed from run outcomes.
  saved_seconds_device integer NOT NULL CHECK (saved_seconds_device >= 0),
  PRIMARY KEY (tenant_id, device_id, object_id, idx),
  FOREIGN KEY (tenant_id, device_id, object_id) REFERENCES daily_aggregates (tenant_id, device_id, object_id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);

CREATE TABLE working_time_aggregates (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  device_id uuid NOT NULL,
  object_id text NOT NULL CHECK (object_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  person_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 1),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  day date NOT NULL,
  active_minutes integer NOT NULL CHECK (active_minutes BETWEEN 0 AND 1440),
  first_active_quarter integer NOT NULL CHECK (first_active_quarter BETWEEN 0 AND 95),
  last_active_quarter integer NOT NULL CHECK (last_active_quarter BETWEEN 0 AND 95),
  notice_version_id uuid NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id, object_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);
CREATE INDEX working_time_aggregates_day_idx ON working_time_aggregates (tenant_id, day);

-- Monthly hs-1 reports per group scope (ADR 0109 §11). `report` is the stored report the nightly job recomputes;
-- `stale` is set by ingest when new rows arrive, so a changed total after new data is not a mismatch.
CREATE TABLE metric_snapshots (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  scope_type text NOT NULL CHECK (scope_type IN ('company', 'department', 'job_role')),
  scope_id uuid,
  scope_key text GENERATED ALWAYS AS (scope_type || ':' || coalesce(scope_id::text, '')) STORED,
  inputs_digest text NOT NULL CHECK (inputs_digest ~ '^[0-9a-f]{64}$'),
  report jsonb NOT NULL,
  final boolean NOT NULL DEFAULT false,
  stale boolean NOT NULL DEFAULT false,
  computed_at timestamptz NOT NULL,
  checked_at timestamptz,
  PRIMARY KEY (tenant_id, month, scope_key),
  CHECK ((scope_type = 'company') = (scope_id IS NULL))
);

-- A recompute that disagrees with its snapshot without new data in between (ADR 0109 §11: an alert, never a fix).
CREATE TABLE metric_alerts (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (code IN ('recompute_mismatch')),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  scope_key text NOT NULL CHECK (scope_key ~ '^(company:|department:[0-9a-f-]{36}|job_role:[0-9a-f-]{36})$'),
  stored_digest text NOT NULL CHECK (stored_digest ~ '^[0-9a-f]{64}$'),
  fresh_digest text NOT NULL CHECK (fresh_digest ~ '^[0-9a-f]{64}$'),
  at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, month, scope_key, stored_digest, fresh_digest)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['run_outcomes', 'review_events', 'baseline_samples', 'baseline_sample_instances',
    'daily_aggregates', 'daily_aggregate_workflows', 'working_time_aggregates', 'metric_snapshots', 'metric_alerts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END
$$;

-- ADR 0101 §5 per-person visibility, as a RESTRICTIVE policy so it narrows tenant_isolation instead of widening it.
-- A row is visible to its own person; to everyone else only inside a transaction that set app.person_read (a per-person
-- read that authorize() allowed and the audit log recorded) or app.aggregate_read (the metrics group path, which only
-- returns group-floored aggregates). Writes are only ever the person's own device.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['run_outcomes', 'review_events', 'baseline_samples', 'baseline_sample_instances',
    'daily_aggregates', 'daily_aggregate_workflows', 'working_time_aggregates']
  LOOP
    EXECUTE format('CREATE POLICY person_visibility ON %I AS RESTRICTIVE USING (person_id = nullif(current_setting(''app.principal_person_id'', true), '''')::uuid OR current_setting(''app.person_read'', true) = ''on'' OR current_setting(''app.aggregate_read'', true) = ''on'') WITH CHECK (person_id = nullif(current_setting(''app.principal_person_id'', true), '''')::uuid)', t);
  END LOOP;
END
$$;

-- The nightly recompute walks tenants (ADR 0101 consequences: cross-tenant jobs iterate tenants explicitly). It sees
-- tenant rows only in a transaction that set app.job, and then sets app.tenant_id per tenant for the actual work.
CREATE POLICY metrics_job_tenants ON tenants FOR SELECT
  USING (nullif(current_setting('app.job', true), '') = 'metrics_recompute');

GRANT SELECT, INSERT, UPDATE ON run_outcomes, review_events, baseline_samples, baseline_sample_instances,
  daily_aggregates, daily_aggregate_workflows, working_time_aggregates, metric_snapshots TO offload_app;
GRANT SELECT, INSERT ON metric_alerts TO offload_app;
