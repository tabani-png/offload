-- S2-09 follow-up (Codex on 8e4f343, security): a run's recipient input set is never missing. No trusted recipients
-- is the empty set, so the broker refuses every proposed recipient outside it and outside an overnight allowlist;
-- a missing set used to turn that check off.
UPDATE worker_runs SET input_recipients = '[]'::jsonb WHERE input_recipients IS NULL;
ALTER TABLE worker_runs ALTER COLUMN input_recipients SET DEFAULT '[]'::jsonb;
ALTER TABLE worker_runs ALTER COLUMN input_recipients SET NOT NULL;
