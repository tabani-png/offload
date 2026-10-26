-- S2-08 follow-up (wave B review, PR #10): retention against S2-05's real per-person tables, the nightly job's tenant
-- walk, and narrower write grants on correction_requests.

-- Retention deletes as offload_retention, a NOLOGIN role offload_app may SET ROLE to but does not inherit from. So
-- offload_app keeps no DELETE on S2-05's tables (its RLS test still holds), and only the retention pass, which sets the
-- role for its own transaction, can delete. RLS still applies to the role: tenant_isolation narrows the delete to the
-- pass's tenant, and person_visibility admits the rows because the pass sets app.person_read for that transaction.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'offload_retention') THEN
    CREATE ROLE offload_retention NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
GRANT offload_retention TO offload_app WITH INHERIT FALSE, SET TRUE;
DO $$ BEGIN EXECUTE format('GRANT USAGE ON SCHEMA %I TO offload_retention', current_schema()); END $$;

-- The tables the retention pass prunes (retention.ts RETENTION_TABLES). They belong to S2-05 (migration 0501); a tree
-- without them gets no grant here, and the pass then fails closed on the missing table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['run_outcomes', 'review_events', 'baseline_samples', 'baseline_sample_instances',
    'daily_aggregates', 'daily_aggregate_workflows', 'working_time_aggregates']
  LOOP
    IF to_regclass(format('%I', t)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, DELETE ON %I TO offload_retention', t);
    END IF;
  END LOOP;
END
$$;

-- The nightly retention job lists tenant ids under app.job (as S2-05's recompute does), then works tenant by tenant.
CREATE POLICY compliance_retention_tenants ON tenants FOR SELECT
  USING (nullif(current_setting('app.job', true), '') = 'compliance_retention');
