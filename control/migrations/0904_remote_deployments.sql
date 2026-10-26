-- S2-09 follow-up (Codex on 4153ad3): every deployment Offload made on Managed Agents is tracked until it is drained:
-- archived on the platform, polled at least once after the archive, and every session it started imported as a run
-- and ended. Replacing or removing a schedule no longer forgets the old deployment's last sessions.
CREATE TABLE remote_deployments (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  deployment_id text NOT NULL CHECK (length(deployment_id) <= 100),
  worker_id uuid NOT NULL,
  -- the session budget the deployment was created with: what its sessions reserve (worker_runs.budget_cents).
  budget_cents integer NOT NULL CHECK (budget_cents >= 1),
  created_at timestamptz NOT NULL,
  last_run_seen_at text CHECK (length(last_run_seen_at) <= 64),
  archived_at timestamptz,
  polled_after_archive_at timestamptz,
  drained_at timestamptz,
  PRIMARY KEY (tenant_id, deployment_id),
  FOREIGN KEY (tenant_id, worker_id) REFERENCES workers (tenant_id, id)
);
CREATE INDEX remote_deployments_undrained_idx ON remote_deployments (tenant_id, deployment_id) WHERE drained_at IS NULL;
ALTER TABLE remote_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_deployments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON remote_deployments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON remote_deployments TO offload_app;

-- Which deployment started a scheduled run (drain: no unfinished run of it is left).
ALTER TABLE worker_runs ADD COLUMN deployment_id text CHECK (length(deployment_id) <= 100);

-- Existing deployments: the current one, and replaced ones not yet archived.
INSERT INTO remote_deployments (tenant_id, deployment_id, worker_id, budget_cents, created_at, last_run_seen_at, archived_at)
SELECT d.tenant_id, d.deployment_id, d.worker_id, w.session_budget_cents, d.updated_at, d.last_run_seen_at,
       CASE WHEN d.remote_status = 'archived' THEN d.updated_at END
  FROM deployments d JOIN workers w ON w.tenant_id = d.tenant_id AND w.id = d.worker_id
 WHERE d.deployment_id IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO remote_deployments (tenant_id, deployment_id, worker_id, budget_cents, created_at, last_run_seen_at)
SELECT d.tenant_id, s.id, d.worker_id, w.session_budget_cents, d.updated_at, d.last_run_seen_at
  FROM deployments d JOIN workers w ON w.tenant_id = d.tenant_id AND w.id = d.worker_id,
       jsonb_array_elements_text(d.stale_deployment_ids) AS s(id)
ON CONFLICT DO NOTHING;
