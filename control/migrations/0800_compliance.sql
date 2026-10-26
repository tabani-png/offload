-- S2-08 monitoring compliance (ADR 0108): notices + acks, sensitive feature enablements, correction requests,
-- retention runs. History is kept: offload_app has no DELETE on any of these tables, and triggers stop rewrites.

-- Notice versions. Content is fixed at creation; publishing and replacing only stamp their times once.
CREATE TABLE notices (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  version integer NOT NULL CHECK (version >= 1),
  template text NOT NULL CHECK (length(template) BETWEEN 1 AND 80),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  markdown text NOT NULL CHECK (length(markdown) <= 65536),
  features jsonb NOT NULL CHECK (jsonb_typeof(features) = 'array'),
  jurisdictions jsonb NOT NULL CHECK (jsonb_typeof(jurisdictions) = 'array'),
  created_by uuid NOT NULL,
  created_at_ms bigint NOT NULL,
  published_at_ms bigint,
  replaced_at_ms bigint,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, version),
  FOREIGN KEY (tenant_id, created_by) REFERENCES people (tenant_id, id),
  CHECK (replaced_at_ms IS NULL OR published_at_ms IS NOT NULL)
);

CREATE FUNCTION notices_history_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'notice history is kept: % not allowed', TG_OP;
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.version <> OLD.version OR NEW.template <> OLD.template
     OR NEW.title <> OLD.title OR NEW.markdown <> OLD.markdown OR NEW.features <> OLD.features
     OR NEW.jurisdictions <> OLD.jurisdictions OR NEW.created_by <> OLD.created_by
     OR NEW.created_at_ms <> OLD.created_at_ms THEN
    RAISE EXCEPTION 'notice content is immutable';
  END IF;
  IF OLD.published_at_ms IS NOT NULL AND NEW.published_at_ms IS DISTINCT FROM OLD.published_at_ms THEN
    RAISE EXCEPTION 'notice publish time is immutable';
  END IF;
  IF OLD.replaced_at_ms IS NOT NULL AND NEW.replaced_at_ms IS DISTINCT FROM OLD.replaced_at_ms THEN
    RAISE EXCEPTION 'notice replace time is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER notices_no_rewrite BEFORE UPDATE OR DELETE ON notices
  FOR EACH ROW EXECUTE FUNCTION notices_history_kept();
CREATE TRIGGER notices_no_truncate BEFORE TRUNCATE ON notices
  FOR EACH STATEMENT EXECUTE FUNCTION notices_history_kept();

-- Acknowledgements: one per person and notice version, append-only.
CREATE TABLE notice_acks (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  person_id uuid NOT NULL,
  notice_id uuid NOT NULL,
  acknowledged_at_ms bigint NOT NULL,
  created_at_ms bigint NOT NULL,
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  features jsonb NOT NULL CHECK (jsonb_typeof(features) = 'array'),
  channel text NOT NULL CHECK (channel IN ('mac_app', 'web')),
  device_id uuid,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, person_id, notice_id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, notice_id) REFERENCES notices (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id)
);
CREATE INDEX notice_acks_person_idx ON notice_acks (tenant_id, person_id, acknowledged_at_ms);

-- Sensitive feature enablements, one row per owner act. Only the disable stamp may be set, once.
CREATE TABLE feature_enablements (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  feature text NOT NULL CHECK (feature IN ('per_person_views', 'working_time')),
  jurisdictions jsonb NOT NULL CHECK (jsonb_typeof(jurisdictions) = 'array' AND jsonb_array_length(jurisdictions) >= 1),
  legal_basis text NOT NULL
    CHECK (legal_basis IN ('legitimate_interest', 'contract', 'consent', 'works_agreement', 'other')),
  dpia_attestation jsonb NOT NULL CHECK (jsonb_typeof(dpia_attestation) = 'object'),
  notice_version_id uuid NOT NULL,
  notice_period_days integer NOT NULL CHECK (notice_period_days BETWEEN 0 AND 90),
  works_agreement_ref jsonb CHECK (works_agreement_ref IS NULL OR jsonb_typeof(works_agreement_ref) = 'object'),
  quebec_activation_ack boolean NOT NULL,
  purpose_lock text NOT NULL CHECK (purpose_lock = 'process_improvement'),
  enabled_by uuid NOT NULL,
  enabled_at_ms bigint NOT NULL,
  effective_at_ms bigint NOT NULL,
  disabled_at_ms bigint,
  disabled_by uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, notice_version_id) REFERENCES notices (tenant_id, id),
  FOREIGN KEY (tenant_id, enabled_by) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, disabled_by) REFERENCES people (tenant_id, id),
  CHECK (effective_at_ms = enabled_at_ms + notice_period_days::bigint * 86400000),
  CHECK ((disabled_at_ms IS NULL) = (disabled_by IS NULL))
);
CREATE INDEX feature_enablements_feature_idx ON feature_enablements (tenant_id, feature, disabled_at_ms);

CREATE FUNCTION feature_enablements_history_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'feature enablement history is kept: % not allowed', TG_OP;
  END IF;
  IF OLD.disabled_at_ms IS NOT NULL THEN
    RAISE EXCEPTION 'a disabled enablement is final';
  END IF;
  IF (to_jsonb(NEW) - 'disabled_at_ms' - 'disabled_by') <> (to_jsonb(OLD) - 'disabled_at_ms' - 'disabled_by') THEN
    RAISE EXCEPTION 'only the disable stamp of an enablement may change';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER feature_enablements_no_rewrite BEFORE UPDATE OR DELETE ON feature_enablements
  FOR EACH ROW EXECUTE FUNCTION feature_enablements_history_kept();
CREATE TRIGGER feature_enablements_no_truncate BEFORE TRUNCATE ON feature_enablements
  FOR EACH STATEMENT EXECUTE FUNCTION feature_enablements_history_kept();

-- Self-view correction requests (ADR 0108 §4).
CREATE TABLE correction_requests (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL,
  field text NOT NULL CHECK (length(field) BETWEEN 1 AND 80),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'declined')),
  created_at_ms bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);

-- One row per retention pass: cut-off days and how many rows each table lost.
CREATE TABLE retention_runs (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  ran_at_ms bigint NOT NULL,
  per_person_before date NOT NULL,
  working_time_before date NOT NULL,
  deleted jsonb NOT NULL CHECK (jsonb_typeof(deleted) = 'object'),
  skipped jsonb NOT NULL CHECK (jsonb_typeof(skipped) = 'array'),
  PRIMARY KEY (tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notices', 'notice_acks', 'feature_enablements', 'correction_requests', 'retention_runs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END
$$;

-- No DELETE anywhere: notices and enablements keep their history, acks are the legal record, runs are a log.
GRANT SELECT, INSERT, UPDATE ON notices, feature_enablements, correction_requests TO offload_app;
GRANT SELECT, INSERT ON notice_acks, retention_runs TO offload_app;
