-- S2-06 workflow registry (ADR 0104): proposals, immutable role versions, per-step connection bindings, declines.
-- Same rules as S2-01: tenant_id leads every key, foreign keys are composite (tenant_id, id), RLS is enabled and
-- forced on every table, and offload_app gets only the grants it needs.

-- One row per proposal (a person's shared definition) that may later become a role workflow owned by a job role.
-- The proposal's definition is kept as received and never changes; role versions live in workflow_versions.
CREATE TABLE workflows (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  state text NOT NULL CHECK (state IN ('proposed', 'role', 'retired', 'declined')),
  job_role_id uuid,
  department_id uuid,
  latest_version integer NOT NULL DEFAULT 1 CHECK (latest_version >= 1),
  proposed_by uuid,
  proposer_department_id uuid,
  local_workflow_id text CHECK (length(local_workflow_id) <= 64),
  proposal_object_id text CHECK (proposal_object_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  proposal_hash text CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  proposal_definition jsonb CHECK (jsonb_typeof(proposal_definition) = 'object'),
  proposed_at_ms bigint,
  promoted_by uuid,
  promoted_at_ms bigint,
  retired_at_ms bigint,
  created_at_ms bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, job_role_id) REFERENCES job_roles (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, proposed_by) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, proposer_department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, promoted_by) REFERENCES people (tenant_id, id),
  -- A role or retired workflow always has its owner job role and department.
  CHECK (state IN ('proposed', 'declined') OR (job_role_id IS NOT NULL AND department_id IS NOT NULL)),
  -- A proposal always has its proposer, local id, hash and definition.
  CHECK (proposed_by IS NULL OR (local_workflow_id IS NOT NULL AND proposal_hash IS NOT NULL
    AND proposal_definition IS NOT NULL AND proposed_at_ms IS NOT NULL))
);
-- Proposal dedupe (SPEC): one row per (person, localWorkflowId, definitionHash).
CREATE UNIQUE INDEX workflows_proposal_uq ON workflows (tenant_id, proposed_by, local_workflow_id, proposal_hash)
  WHERE proposed_by IS NOT NULL;
CREATE INDEX workflows_job_role_idx ON workflows (tenant_id, job_role_id);

-- Role versions. Immutable: offload_app may only insert and read, and a trigger refuses UPDATE and DELETE for everyone.
CREATE TABLE workflow_versions (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  workflow_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  -- ADR 0109 / S2-05: the previous version's baseline carries over only when the step capabilities are unchanged.
  baseline_carry_over boolean NOT NULL,
  created_by uuid NOT NULL,
  created_at_ms bigint NOT NULL,
  PRIMARY KEY (tenant_id, workflow_id, version),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES people (tenant_id, id)
);

-- One row per step of a role version: the company connection it is bound to, or disabled at promotion.
CREATE TABLE version_bindings (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  workflow_id uuid NOT NULL,
  version integer NOT NULL,
  -- Order of the step in the definition the version was made from (disabled steps keep their place).
  position integer NOT NULL CHECK (position BETWEEN 0 AND 39),
  step_id text NOT NULL CHECK (step_id ~ '^[a-z0-9_-]{1,64}$'),
  step_class text NOT NULL CHECK (step_class IN ('read', 'draft', 'commit')),
  capability text NOT NULL CHECK (length(capability) BETWEEN 1 AND 120),
  connection_id uuid,
  ownership text CHECK (ownership IN ('company', 'personal-allowed', 'personal-forbidden')),
  disabled boolean NOT NULL,
  PRIMARY KEY (tenant_id, workflow_id, version, step_id),
  UNIQUE (tenant_id, workflow_id, version, position),
  FOREIGN KEY (tenant_id, workflow_id, version) REFERENCES workflow_versions (tenant_id, workflow_id, version),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id),
  CHECK (NOT disabled OR connection_id IS NULL),
  -- The registry rule (ADR 0104 §5), also at the database: a live commit binding is never personal-forbidden.
  CHECK (disabled OR step_class <> 'commit' OR ownership IS DISTINCT FROM 'personal-forbidden')
);

-- Declines, with the reason shown to the proposer.
CREATE TABLE proposals_declined (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  workflow_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  declined_by uuid NOT NULL,
  declined_at_ms bigint NOT NULL,
  PRIMARY KEY (tenant_id, workflow_id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id),
  FOREIGN KEY (tenant_id, declined_by) REFERENCES people (tenant_id, id)
);

CREATE FUNCTION registry_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable: make a new version instead', TG_TABLE_NAME;
END
$$;
CREATE TRIGGER workflow_versions_immutable BEFORE UPDATE OR DELETE ON workflow_versions
  FOR EACH ROW EXECUTE FUNCTION registry_immutable();
CREATE TRIGGER workflow_versions_no_truncate BEFORE TRUNCATE ON workflow_versions
  FOR EACH STATEMENT EXECUTE FUNCTION registry_immutable();
CREATE TRIGGER version_bindings_immutable BEFORE UPDATE OR DELETE ON version_bindings
  FOR EACH ROW EXECUTE FUNCTION registry_immutable();
CREATE TRIGGER version_bindings_no_truncate BEFORE TRUNCATE ON version_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION registry_immutable();

-- The proposal half of a workflow row is written once.
CREATE FUNCTION registry_proposal_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.proposal_definition IS DISTINCT FROM OLD.proposal_definition OR NEW.proposal_hash IS DISTINCT FROM OLD.proposal_hash
    OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by OR NEW.local_workflow_id IS DISTINCT FROM OLD.local_workflow_id THEN
    RAISE EXCEPTION 'a proposal definition is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER workflows_proposal_frozen BEFORE UPDATE ON workflows
  FOR EACH ROW EXECUTE FUNCTION registry_proposal_frozen();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflows', 'workflow_versions', 'version_bindings', 'proposals_declined']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END
$$;

-- offload_app: no DELETE anywhere; UPDATE only on the lifecycle columns of workflows (never on definitions).
GRANT SELECT, INSERT ON workflows, workflow_versions, version_bindings, proposals_declined TO offload_app;
GRANT UPDATE (name, state, job_role_id, department_id, latest_version, promoted_by, promoted_at_ms, retired_at_ms)
  ON workflows TO offload_app;
