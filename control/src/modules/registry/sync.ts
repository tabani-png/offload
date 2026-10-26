import { actorOf, type SyncHandler } from "../../app.ts";
import { HttpError, invalid } from "../../schema/http.ts";
import { definitionHash } from "./hash.ts";
import type { DefinitionObject } from "./types.ts";

const DEFINITION = "offload/stage2/workflow-definition.schema.json";

/**
 * `syncHandlers.workflow_proposal` (ADR 0103 G4, ADR 0104 §1): a person's shared definition becomes a proposal.
 * The object is validated, its definitionHash recomputed (mismatch: 409 hash_mismatch) and deduped by
 * (person, localWorkflowId, definitionHash): a resend, even of a declined proposal, changes nothing.
 */
export const ingestProposal: SyncHandler = async (tx, object, { principal, deps }) => {
  const v = deps.validator.validate(DEFINITION, object);
  if (!v.ok) throw invalid("workflow_proposal does not match its schema", v.errors);
  const obj = object as DefinitionObject;
  if (definitionHash(obj) !== obj.definitionHash) {
    throw new HttpError(409, "hash_mismatch", "definitionHash does not match the definition");
  }
  const [person] = await tx`select department_id from people where id = ${principal.personId}`;
  if (!person) throw invalid("unknown proposer");
  const [row] = await tx`insert into workflows (tenant_id, name, state, proposed_by, proposer_department_id,
      local_workflow_id, proposal_object_id, proposal_hash, proposal_definition, proposed_at_ms, created_at_ms)
    values (current_setting('app.tenant_id')::uuid, ${obj.name}, 'proposed', ${principal.personId},
      ${person.department_id as string | null}, ${obj.localWorkflowId}, ${obj.id}, ${obj.definitionHash},
      ${obj}::jsonb, ${obj.createdAt}, ${deps.clock.now()})
    on conflict (tenant_id, proposed_by, local_workflow_id, proposal_hash) where proposed_by is not null do nothing
    returning id`;
  if (!row) return; // duplicate
  await deps.ports.audit.write(tx, {
    actor: actorOf(principal),
    action: "workflow.proposed",
    subjectPersonId: principal.personId,
    resource: { type: "workflow", id: row.id as string },
    detail: { definitionHash: obj.definitionHash, steps: obj.steps.length },
  });
};
