-- S2-07 fix round 2 (PR #12 re-review, N2/N3). Range 0700-0799.

-- N2: an approval binds the batch's connection account, sending identity, runner and CRM sheet, not only the items:
-- sha256 of them at approval, re-derived before every call (a re-linked mailbox or a re-pointed batch does not send).
ALTER TABLE approval_tokens ADD COLUMN binding_hash text CHECK (binding_hash ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION s207_approval_tokens_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'offload_app' THEN RETURN NEW; END IF;
  IF (NEW.tenant_id, NEW.id, NEW.token_hash, NEW.batch_hash, NEW.item_keys, NEW.approver_kind, NEW.approved_by, NEW.policy_id,
      NEW.created_at, NEW.expires_at, NEW.binding_hash)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.token_hash, OLD.batch_hash, OLD.item_keys, OLD.approver_kind, OLD.approved_by,
      OLD.policy_id, OLD.created_at, OLD.expires_at, OLD.binding_hash) THEN
    RAISE EXCEPTION 'approval_tokens: a token is immutable';
  END IF;
  IF OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at THEN
    RAISE EXCEPTION 'approval_tokens: used_at is immutable once set';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoked_reason) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_reason) THEN
    RAISE EXCEPTION 'approval_tokens: revoked_at is immutable once set';
  END IF;
  RETURN NEW;
END
$$;

-- N2: what a batch sends through and as whom is fixed at propose; offload_app changes only its state and evaluation.
CREATE FUNCTION s207_batches_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'offload_app' THEN RETURN NEW; END IF;
  IF (NEW.tenant_id, NEW.hash, NEW.workflow_id, NEW.version, NEW.run_id, NEW.runtime, NEW.identity_type, NEW.identity_id,
      NEW.job_role_id, NEW.department_id, NEW.runner_person_id, NEW.connection_id, NEW.crm_sheet, NEW.overnight_policy_id,
      NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.hash, OLD.workflow_id, OLD.version, OLD.run_id, OLD.runtime, OLD.identity_type,
      OLD.identity_id, OLD.job_role_id, OLD.department_id, OLD.runner_person_id, OLD.connection_id, OLD.crm_sheet,
      OLD.overnight_policy_id, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'batches: a batch''s binding (connection, identity, runner, CRM sheet) is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER s207_batches_guard BEFORE UPDATE ON batches FOR EACH ROW EXECUTE FUNCTION s207_batches_guard();

-- N3: who paused a policy. Only that person (or an owner, admin or dept lead) resumes it; a pause by the system (a
-- freeze) has none. A trip is re-armed only by an owner, admin or dept lead.
ALTER TABLE overnight_policies ADD COLUMN paused_by uuid;
