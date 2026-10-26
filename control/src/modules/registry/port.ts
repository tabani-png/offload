/**
 * The registry's port for later slices (SPEC S2-06): `getVersion`, `bindingsFor`, `isRunnableBy`, plus the core's
 * `workflowsOf`. `src/ports.ts` (frozen) declares only `workflowsOf`; consumers narrow `deps.ports.registry` to
 * `RegistryApi` until the coordinator widens `RegistryPort`.
 */
import type { Tx } from "../../db/pool.ts";
import type { RegistryPort } from "../../ports.ts";
import type { DefinitionObject, WorkflowState } from "./types.ts";

export interface RegistryVersion {
  workflowId: string;
  version: number;
  state: WorkflowState;
  jobRoleId: string;
  departmentId: string;
  definition: DefinitionObject;
  definitionHash: string;
  /** ADR 0109: the previous version's baseline carries over (step capabilities unchanged). For S2-05. */
  baselineCarryOver: boolean;
  createdAt: number;
}

export interface StepBinding {
  stepId: string;
  stepClass: "read" | "draft" | "commit";
  capability: string;
  connectionId: string | null;
  ownership: "company" | "personal-allowed" | "personal-forbidden" | null;
  disabled: boolean;
}

export type Runner = { personId: string } | { identityId: string };

export interface RegistryApi extends RegistryPort {
  /** A role workflow version (role or retired), or null. Proposals are not versions. */
  getVersion(tx: Tx, workflowId: string, version: number): Promise<RegistryVersion | null>;
  /** Every step's binding in definition order, disabled steps included. */
  bindingsFor(tx: Tx, workflowId: string, version: number): Promise<StepBinding[]>;
  /** A live (role, not retired) version run by an active holder of its job role or by one of its role identities. */
  isRunnableBy(tx: Tx, workflowId: string, version: number, runner: Runner): Promise<boolean>;
}

export function createRegistryPort(): RegistryApi {
  return {
    async workflowsOf(tx, personId) {
      const rows = await tx`select w.id from workflows w
        where (w.state = 'role' and w.job_role_id in (select h.job_role_id from job_role_holders h where h.person_id = ${personId}))
           or (w.state = 'proposed' and w.proposed_by = ${personId})
        order by w.id`;
      return rows.map((r: { id: string }) => r.id);
    },

    async getVersion(tx, workflowId, version) {
      const [r] = await tx`select w.state, w.job_role_id, w.department_id, v.definition, v.definition_hash,
          v.baseline_carry_over, v.created_at_ms
        from workflows w join workflow_versions v on v.tenant_id = w.tenant_id and v.workflow_id = w.id
        where w.id = ${workflowId} and v.version = ${version} and w.state in ('role', 'retired')`;
      if (!r) return null;
      return {
        workflowId,
        version,
        state: r.state as WorkflowState,
        jobRoleId: r.job_role_id as string,
        departmentId: r.department_id as string,
        definition: r.definition as DefinitionObject,
        definitionHash: r.definition_hash as string,
        baselineCarryOver: r.baseline_carry_over as boolean,
        createdAt: Number(r.created_at_ms),
      };
    },

    async bindingsFor(tx, workflowId, version) {
      const rows: Array<Record<string, unknown>> = await tx`select step_id, step_class, capability, connection_id, ownership, disabled
        from version_bindings where workflow_id = ${workflowId} and version = ${version} order by position`;
      return rows.map((r) => ({
        stepId: r.step_id as string,
        stepClass: r.step_class as StepBinding["stepClass"],
        capability: r.capability as string,
        connectionId: r.connection_id as string | null,
        ownership: r.ownership as StepBinding["ownership"],
        disabled: r.disabled as boolean,
      }));
    },

    async isRunnableBy(tx, workflowId, version, runner) {
      const [w] = await tx`select w.job_role_id from workflows w
        join workflow_versions v on v.tenant_id = w.tenant_id and v.workflow_id = w.id
        where w.id = ${workflowId} and v.version = ${version} and w.state = 'role'`;
      if (!w) return false;
      if ("personId" in runner) {
        const [h] = await tx`select 1 from job_role_holders h join people p on p.tenant_id = h.tenant_id and p.id = h.person_id
          where h.job_role_id = ${w.job_role_id} and h.person_id = ${runner.personId} and p.state in ('active', 'leaving')`;
        return h !== undefined;
      }
      const [i] = await tx`select 1 from role_identities where id = ${runner.identityId} and job_role_id = ${w.job_role_id}`;
      return i !== undefined;
    },
  };
}
