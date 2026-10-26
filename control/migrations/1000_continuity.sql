-- S2-10 continuity (ADR 0107): offboardings, hand-overs, hand-over events, removed personal connections.
-- Same rules as S2-01: tenant_id leads every key, foreign keys are composite (tenant_id, id), RLS is enabled and
-- forced on every table, and offload_app gets only the grants it needs (no DELETE anywhere).

-- One row per person who is leaving or has left. The person's state itself lives in people.state (S2-01); this row
-- carries what the offboarding needs on top: why, since when, and the after-commit worker pause.
CREATE TABLE offboardings (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  person_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('leaving', 'frozen', 'departed')),
  reason text NOT NULL CHECK (reason IN ('directory_deactivated', 'admin', 'end_date')),
  effective_on date,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  requested_by uuid,
  created_at timestamptz NOT NULL,
  frozen_at timestamptz,
  departed_at timestamptz,
  -- ADR 0107 §7: the person's unpromoted proposals are kept until this time for the admin to promote or discard.
  proposals_kept_until timestamptz,
  -- Set in the freeze transaction, cleared by the after-commit WorkersPort.pauseFor call (or the sweep job).
  pause_pending boolean NOT NULL DEFAULT false,
  paused_at timestamptz,
  PRIMARY KEY (tenant_id, person_id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES people (tenant_id, id),
  CHECK (state = 'leaving' OR frozen_at IS NOT NULL),
  CHECK (state <> 'departed' OR departed_at IS NOT NULL)
);

-- One hand-over task per workflow the person ran or owned (ADR 0107 §3). department_id is the workflow's, for Dp scope.
CREATE TABLE handovers (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  job_role_id uuid NOT NULL,
  department_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'assigned', 'closed')),
  successor_type text CHECK (successor_type IN ('person', 'role_identity')),
  successor_person_id uuid,
  successor_role_identity_id uuid,
  -- A person successor consents (POST /accept); a role identity is the company's and needs no consent.
  accepted_at timestamptz,
  in_flight text NOT NULL DEFAULT 'pause' CHECK (in_flight IN ('pause', 'handover_message', 'stop')),
  inbox_step text CHECK (inbox_step IN ('google_migrate', 'google_alias', 'google_archive', 'm365_shared_mailbox', 'none')),
  -- in_flight = handover_message: the successor reviewed the one-time message (before any further send).
  message_reviewed_at timestamptz,
  removed_connections jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(removed_connections) = 'array'),
  assigned_by uuid,
  assigned_at timestamptz,
  closed_by uuid,
  closed_at timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, person_id, workflow_id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id),
  FOREIGN KEY (tenant_id, job_role_id) REFERENCES job_roles (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, successor_person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, successor_role_identity_id) REFERENCES role_identities (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_by) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES people (tenant_id, id),
  CHECK ((successor_type IS NULL AND successor_person_id IS NULL AND successor_role_identity_id IS NULL)
    OR (successor_type = 'person' AND successor_person_id IS NOT NULL AND successor_role_identity_id IS NULL)
    OR (successor_type = 'role_identity' AND successor_role_identity_id IS NOT NULL AND successor_person_id IS NULL)),
  CHECK (state = 'open' OR successor_type IS NOT NULL),
  CHECK (state <> 'closed' OR closed_at IS NOT NULL),
  CHECK (successor_person_id IS DISTINCT FROM person_id)
);
CREATE INDEX handovers_workflow_idx ON handovers (tenant_id, workflow_id);
CREATE INDEX handovers_state_idx ON handovers (tenant_id, state, id);

-- Append-only history of each hand-over (opened, assigned, accepted, resumed, closed), with the acting identity.
CREATE TABLE handover_events (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id bigint GENERATED ALWAYS AS IDENTITY,
  handover_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opened', 'assigned', 'accepted', 'message_reviewed', 'resumed', 'closed')),
  actor_type text NOT NULL CHECK (actor_type IN ('person', 'system')),
  actor_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, handover_id) REFERENCES handovers (tenant_id, id)
);
CREATE INDEX handover_events_handover_idx ON handover_events (tenant_id, handover_id, id);

-- Personal connections removed on freeze (ADR 0107 §2, §6). The connection row is deleted; when history (a batch)
-- still references it, its credential reference is erased instead (ADR 0113 §2). Either way it is recorded here.
CREATE TABLE removed_connections (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  connection_id uuid NOT NULL,
  person_id uuid NOT NULL,
  kind text NOT NULL,
  ownership text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('deleted', 'erased')),
  removed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, connection_id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['offboardings', 'handovers', 'handover_events', 'removed_connections']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END
$$;

-- handover_events is append-only for everyone, owner included.
CREATE FUNCTION continuity_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$$;
CREATE TRIGGER handover_events_append_only BEFORE UPDATE OR DELETE ON handover_events
  FOR EACH ROW EXECUTE FUNCTION continuity_append_only();

GRANT SELECT, INSERT, UPDATE ON offboardings, handovers TO offload_app;
GRANT SELECT, INSERT ON handover_events, removed_connections TO offload_app;
