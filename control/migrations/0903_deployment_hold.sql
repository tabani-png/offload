-- S2-09 follow-up (Codex on a9bf194): a deployment is held paused while its worker may not run on a schedule, and
-- released when it may again. desired_status stays what a person or a kill switch set; the hold is the system's.
--   budget_exceeded  one more session would exceed the tenant's monthly cap (released next month or on a raised cap)
--   ineligible       registry.isRunnableBy fails: the workflow version is no longer live, or the identity no longer
--                    runs it (a person left the job role, a role identity was removed)
ALTER TABLE deployments
  ADD COLUMN hold_reason text CHECK (hold_reason IN ('budget_exceeded', 'ineligible'));
