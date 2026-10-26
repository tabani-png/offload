-- S2-07 wave-B review fixes (slices/S2-review/REVIEW-wave-B.md, PR #12; ADR 0112). Range 0700-0799.

-- Night counters: a row written by a signal report before the night's first evaluation is not yet evaluated, so the
-- first batch still decides whether the night is a dry run (fix 3). `counted`: this night added one to
-- dry_run_nights_done; a trip takes it back (fix 6: only nights that did not trip count).
ALTER TABLE overnight_counters ADD COLUMN evaluated boolean NOT NULL DEFAULT true;
ALTER TABLE overnight_counters ADD COLUMN counted boolean NOT NULL DEFAULT false;
ALTER TABLE overnight_counters ADD COLUMN tripped boolean NOT NULL DEFAULT false;

-- Integrity in the database, not only in the app (ranked 30): what offload_app may never change. The table owner
-- (migrations, incident tooling) is not bound, so a test can still simulate tampering below the app.
CREATE FUNCTION s207_batch_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'offload_app' THEN RETURN NEW; END IF;
  IF (NEW.tenant_id, NEW.batch_hash, NEW.key, NEW.position, NEW.capability, NEW.fields, NEW.item_hash, NEW.recipient)
     IS DISTINCT FROM (OLD.tenant_id, OLD.batch_hash, OLD.key, OLD.position, OLD.capability, OLD.fields, OLD.item_hash, OLD.recipient) THEN
    RAISE EXCEPTION 'batch_items: an approved item is immutable (fields, hash, recipient)';
  END IF;
  IF OLD.state IN ('sent', 'failed_before_send', 'unknown', 'rejected') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'batch_items: state % is final and immutable', OLD.state;
  END IF;
  IF OLD.released_at IS NOT NULL AND (NEW.released_at, NEW.released_by) IS DISTINCT FROM (OLD.released_at, OLD.released_by) THEN
    RAISE EXCEPTION 'batch_items: a release is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER s207_batch_items_guard BEFORE UPDATE ON batch_items FOR EACH ROW EXECUTE FUNCTION s207_batch_items_guard();

CREATE FUNCTION s207_approval_tokens_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'offload_app' THEN RETURN NEW; END IF;
  IF (NEW.tenant_id, NEW.id, NEW.token_hash, NEW.batch_hash, NEW.item_keys, NEW.approver_kind, NEW.approved_by, NEW.policy_id,
      NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.token_hash, OLD.batch_hash, OLD.item_keys, OLD.approver_kind, OLD.approved_by,
      OLD.policy_id, OLD.created_at, OLD.expires_at) THEN
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
CREATE TRIGGER s207_approval_tokens_guard BEFORE UPDATE ON approval_tokens FOR EACH ROW EXECUTE FUNCTION s207_approval_tokens_guard();
