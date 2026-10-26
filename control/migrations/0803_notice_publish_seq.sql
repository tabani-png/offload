-- S2-08 follow-up (PR #10 review round 5): the order notices were published in, per tenant. Publish times can tie (two
-- publishes in one millisecond) and versions follow creation, not publication, so neither can say which notice is the
-- latest; "the current notice" is the live one published last. Stamped once, under the publish lock.
ALTER TABLE notices ADD COLUMN publish_seq bigint;

UPDATE notices n SET publish_seq = s.rn
FROM (
  SELECT tenant_id, id, row_number() OVER (PARTITION BY tenant_id ORDER BY published_at_ms, version) AS rn
  FROM notices WHERE published_at_ms IS NOT NULL
) s
WHERE n.tenant_id = s.tenant_id AND n.id = s.id;

ALTER TABLE notices ADD CONSTRAINT notices_publish_seq_with_publish CHECK ((published_at_ms IS NULL) = (publish_seq IS NULL));
ALTER TABLE notices ADD CONSTRAINT notices_publish_seq_unique UNIQUE (tenant_id, publish_seq);

CREATE OR REPLACE FUNCTION notices_history_kept() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD.publish_seq IS NOT NULL AND NEW.publish_seq IS DISTINCT FROM OLD.publish_seq THEN
    RAISE EXCEPTION 'notice publish order is immutable';
  END IF;
  IF OLD.replaced_at_ms IS NOT NULL AND NEW.replaced_at_ms IS DISTINCT FROM OLD.replaced_at_ms THEN
    RAISE EXCEPTION 'notice replace time is immutable';
  END IF;
  RETURN NEW;
END
$$;
