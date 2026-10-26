// ADR 0103 §5 across reads. hs-1's suppress() works on one tree, so a department or job role read directly would be a
// fresh root that is never complementary-suppressed, and the company total minus the visible departments would give
// back a hidden one. A direct group read is therefore floored where it sits in the company tree: company → departments
// → the job roles of the scope's department, exactly as the company and department reports show it.
import type { Tx } from "../../db/pool.ts";
import { isSuppressed, suppress, type Cell, type CellTree, type Scope } from "../../../../packages/hours-saved/src/index.ts";
import { childrenOf } from "./scope.ts";

/**
 * A scope's cell, computed under `parent` (null at the root): the rows of the scope that are also in the parent, as
 * report() computes a child cell from the parent's rows.
 */
export type CellFor = (scope: Scope, parent: Scope | null) => Cell;

const COMPANY: Scope = { type: "company", id: null };

/**
 * True when a department or job role is suppressed in the company tree, or when the scope read on its own reaches
 * people outside its tree cell and there are fewer than `floor` of them (a job role held outside its department:
 * job role minus department.job role would single them out). Company and person scopes are never hidden here.
 */
export async function hiddenInTree(tx: Tx, scope: Scope, cellFor: CellFor, floor: number): Promise<boolean> {
  if (scope.type !== "department" && scope.type !== "job_role") return false;
  const deptId =
    scope.type === "department"
      ? scope.id
      : ((await tx`select department_id from job_roles where id = ${scope.id}`)[0]?.department_id as string | undefined) ?? null;
  const depts = await childrenOf(tx, COMPANY);
  const roles = scope.type === "job_role" && deptId !== null ? await childrenOf(tx, { type: "department", id: deptId }) : [];
  const tree: CellTree = {
    scope: COMPANY,
    label: "total",
    value: cellFor(COMPANY, null),
    children: depts.map((d) => ({
      scope: d.scope,
      label: d.label,
      value: cellFor(d.scope, COMPANY),
      children: d.scope.id !== deptId ? [] : roles.map((r) => ({ scope: r.scope, label: r.label, value: cellFor(r.scope, d.scope), children: [] })),
    })),
  };
  const shown = suppress(tree, floor);
  const dept = shown.children.find((c) => c.scope.id === deptId);
  const node = scope.type === "department" ? dept : dept?.children.find((c) => c.scope.id === scope.id);
  // A job role whose department is gone from the tree has no place to be floored in: hidden.
  if (!node || isSuppressed(node.value)) return true;
  const outside = cellFor(scope, null).people - (node.value as Cell).people;
  return outside > 0 && outside < floor;
}

/** A Cell carrying only a people count, for metrics that floor on people with data (adoption, working time). */
export function peopleCell(people: number): Cell {
  return {
    seconds: 0,
    hours: 0,
    byGrade: { A: 0, B: 0, C: 0 },
    bySource: { observed: 0, user_estimate: 0 },
    byRuntime: { mac: 0, cloud: 0 },
    overnightSeconds: 0,
    runs: { success: 0, failed: 0, cancelled: 0, rejected: 0, capped: 0 },
    people,
  };
}
