-- S2-09 follow-up (operator-approved schema change, 2026-10-26, ADR 0112 §18): the time each offload_need_human
-- question was asked, in the same order as worker_runs.questions (written by the same statement), so the run DTO and
-- the digest show each question with its run, workflow and time. Questions stored before this get the run's start.
ALTER TABLE worker_runs ADD COLUMN question_asked_at jsonb NOT NULL DEFAULT '[]'::jsonb;
UPDATE worker_runs r SET question_asked_at = (
  SELECT coalesce(jsonb_agg(s.t), '[]'::jsonb)
    FROM (SELECT (extract(epoch FROM r.started_at) * 1000)::bigint AS t FROM jsonb_array_elements(r.questions)) s)
 WHERE jsonb_array_length(r.questions) > 0;
ALTER TABLE worker_runs ADD CONSTRAINT worker_runs_question_times
  CHECK (jsonb_array_length(question_asked_at) = jsonb_array_length(questions));
