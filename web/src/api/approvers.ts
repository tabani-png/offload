// Who may approve a batch, and so see its item fields (API.md Broker, ADR 0111 §6). One rule for the mock and the screen.

import type { Batch, Person, RolePolicy, Workflow } from "./types.ts";

/**
 * The runner and the approvers the job role's policy names. Owner and admin approve only when the policy names them,
 * which none of today's policy values do. A workflow with no job role (personal) has only its runner.
 */
export function canApprove(batch: Batch, me: Person, workflow: Workflow | undefined, policy: RolePolicy | undefined): boolean {
  const runner = batch.identity.type === "person" && batch.identity.id === me.id;
  const lead = !!workflow?.departmentId && me.deptLeadOf.includes(workflow.departmentId);
  switch (policy?.approvers) {
    case "dept_lead": return lead;
    case "runner_or_dept_lead": return runner || lead;
    default: return runner;
  }
}
