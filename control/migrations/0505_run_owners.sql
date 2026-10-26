-- Who owns a run id (ADR 0113 §2, PR #9 round 4). Migration 0503 kept the copy with the earliest first_received_at,
-- a now() default: the start of the ingest transaction, not the time the copy was stored. An envelope that began first
-- but stored its copy after another device had committed one got the earlier time and took the run over.
--
-- Ownership is now a claim: the first copy of a run id stored in the tenant inserts (tenant_id, run_id) here, every
-- later copy's insert does nothing (ON CONFLICT DO NOTHING). The primary key settles races without any clock: a second
-- insert of the same key waits for the first transaction, then does nothing if it committed (or claims the run if it
-- rolled back). So the owner is the device whose claim committed first, and it never changes afterwards; the run row
-- of that device (its latest report, ADR 0111 §4) is the one hs-1 reads.
--
-- person_id is the claiming device's person, so the per-person policy of ADR 0101 §5 applies as on run_outcomes.
-- Like every S2-05 table there is no DELETE grant (retention is S2-08's).
CREATE TABLE run_owners (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  run_id text NOT NULL CHECK (run_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  device_id uuid NOT NULL,
  person_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, run_id),
  FOREIGN KEY (tenant_id, device_id, run_id) REFERENCES run_outcomes (tenant_id, device_id, run_id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);

-- Runs stored before this migration: the 0503 rule, once, for the claims.
INSERT INTO run_owners (tenant_id, run_id, device_id, person_id)
SELECT DISTINCT ON (tenant_id, run_id) tenant_id, run_id, device_id, person_id
FROM run_outcomes
ORDER BY tenant_id, run_id, first_received_at, device_id;

ALTER TABLE run_outcomes DROP COLUMN first_received_at;

ALTER TABLE run_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_owners FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON run_owners
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY person_visibility ON run_owners AS RESTRICTIVE
  USING (person_id = nullif(current_setting('app.principal_person_id', true), '')::uuid
    OR current_setting('app.person_read', true) = 'on' OR current_setting('app.aggregate_read', true) = 'on')
  WITH CHECK (person_id = nullif(current_setting('app.principal_person_id', true), '')::uuid);

GRANT SELECT, INSERT ON run_owners TO offload_app;
