// ADR 0103 §5 across reads (ADR 0113 §1). hs-1's suppress() works on one tree, so a department or job role read directly
// would be a fresh root that is never complementary-suppressed, and the company total minus the visible departments
// would give back a hidden one. A group read is therefore floored where it sits in the company tree: company →
// departments → the job roles of the scope's department, exactly as the company and department reports show it.
//
// Every level is floored over its complete child set (never a response-size page of it), plus the remainder: the rows
// of the parent that fall in no child (people with no department; people of a department with no job role there).
// The remainder is never shown, but the parent total minus the shown children equals it, so it is floored like a
// child. On top of hs-1's rule (one hidden child → hide the smallest other one too), the hidden children of a node
// must together hold 0 or at least `floor` people: an empty child is "under the floor" for suppress(), and two small
// children hide nothing from a subtraction when their sum is still under the floor.
import type { Tx } from "../../db/pool.ts";
import {
  isSuppressed, suppress, SUPPRESSED, type Cell, type CellTree, type CellValue, type Scope,
} from "../../../../packages/hours-saved/src/index.ts";

/**
 * The cells of one metric over its rows. `cell(scope, parent)` is the scope's rows that are also in `parent` (null at
 * the root), as report() computes a child cell from the parent's rows. `rest(parent, kids)` is the parent's rows in
 * none of `kids`.
 */
export interface Cells {
  cell(scope: Scope, parent: Scope | null): Cell;
  rest(parent: Scope, kids: readonly Scope[]): Cell;
}

export interface Child {
  scope: Scope;
  label: string;
}

/** The tenant's departments and job roles, each list in report order (name, then id). Loaded whole, never paged. */
export interface Hierarchy {
  departments: Child[];
  rolesOf: Map<string, Child[]>;
  roleDept: Map<string, string | null>;
}

export const COMPANY: Scope = { type: "company", id: null };
/** Label of the remainder pseudo-child; never returned. */
const REST = "\u0000rest";

export async function loadHierarchy(tx: Tx): Promise<Hierarchy> {
  const depts = (await tx`select id, name from departments order by name, id`) as Array<{ id: string; name: string }>;
  const roles = (await tx`select id, name, department_id from job_roles order by name, id`) as Array<{
    id: string; name: string; department_id: string | null;
  }>;
  const rolesOf = new Map<string, Child[]>();
  const roleDept = new Map<string, string | null>();
  for (const r of roles) {
    roleDept.set(r.id, r.department_id);
    if (r.department_id === null) continue;
    const list = rolesOf.get(r.department_id) ?? [];
    list.push({ scope: { type: "job_role", id: r.id }, label: r.name });
    rolesOf.set(r.department_id, list);
  }
  return { departments: depts.map((d) => ({ scope: { type: "department", id: d.id }, label: d.name })), rolesOf, roleDept };
}

/** Children of a group scope: a company's departments, a department's job roles; none below. */
export function childrenIn(h: Hierarchy, scope: Scope): Child[] {
  if (scope.type === "company") return h.departments;
  if (scope.type === "department") return h.rolesOf.get(scope.id!) ?? [];
  return [];
}

type Raw = { scope: Scope; label: string; value: Cell };

/** hs-1's order for picking the complementary cell: people, seconds, label, id. */
function smaller(a: Raw, b: Raw): boolean {
  if (a.value.people !== b.value.people) return a.value.people < b.value.people;
  if (a.value.seconds !== b.value.seconds) return a.value.seconds < b.value.seconds;
  if (a.label !== b.label) return a.label < b.label;
  return (a.scope.id ?? "") < (b.scope.id ?? "");
}

export interface FlooredNode {
  value: CellValue;
  children: Array<{ scope: Scope; label: string; value: CellValue }>;
}

/** Options of floorNode. */
export interface FloorOpts {
  /**
   * Leave children with no people out of hs-1's suppress(), which counts an empty child as under the floor and hides
   * a neighbour for it. An empty child reveals nothing, so only trees S2-05 adds on top of hs-1 (per-workflow trees)
   * use this; report children stay at least as hidden as hs-1's own suppress() has them.
   */
  ignoreEmpty?: boolean;
}

/**
 * One node floored over all its children and its remainder. `parent` is the node's own parent (null for the company).
 * Returns the node's value and its real children's values in `kids` order (the remainder is never returned).
 */
export function floorNode(
  node: Scope,
  parent: Scope | null,
  kids: readonly Child[],
  cells: Cells,
  floor: number,
  opts: FloorOpts = {},
): FlooredNode {
  const raw: Raw[] = kids.map((k) => ({ scope: k.scope, label: k.label, value: cells.cell(k.scope, node) }));
  const rest = cells.rest(node, kids.map((k) => k.scope));
  if (rest.people > 0) raw.push({ scope: { type: node.type === "company" ? "department" : "job_role", id: null }, label: REST, value: rest });
  const inTree = raw.map((c) => !opts.ignoreEmpty || c.value.people > 0);
  const tree: CellTree = {
    scope: node,
    label: "total",
    value: cells.cell(node, parent),
    children: raw.filter((_, i) => inTree[i]).map((c) => ({ ...c, children: [] })),
  };
  const shown = suppress(tree, floor);
  if (isSuppressed(shown.value)) return { value: SUPPRESSED, children: kids.map((k) => ({ scope: k.scope, label: k.label, value: SUPPRESSED })) };
  const shownKids = [...shown.children];
  // Empty children left out of the tree are suppressed cells with nothing in them.
  const hidden = raw.map((_, i) => (inTree[i] ? isSuppressed(shownKids.shift()!.value) : true));
  const hiddenPeople = raw.reduce((n, c, i) => n + (hidden[i] ? c.value.people : 0), 0);
  if (hiddenPeople > 0 && hiddenPeople < floor) {
    let pick = -1;
    raw.forEach((c, i) => {
      if (!hidden[i] && (pick < 0 || smaller(c, raw[pick]!))) pick = i;
    });
    // Every visible child holds at least `floor` people, so one more is enough.
    if (pick >= 0) hidden[pick] = true;
  }
  return {
    value: shown.value,
    children: kids.map((k, i) => ({ scope: k.scope, label: k.label, value: hidden[i] ? SUPPRESSED : raw[i]!.value })),
  };
}

/**
 * True when a department or job role is hidden in the company tree (floorNode at each level down to it), or when it is
 * a job role held by anyone outside its department: no department tree floors those holders, and job role minus
 * department.job role would single them out or, taken from their own department's remainder, single out the rest of
 * it. Company and person scopes are never hidden here.
 */
export function hiddenInTree(h: Hierarchy, scope: Scope, cells: Cells, floor: number, opts: FloorOpts = {}): boolean {
  if (scope.type !== "department" && scope.type !== "job_role") return false;
  const deptId = scope.type === "department" ? scope.id! : (h.roleDept.get(scope.id!) ?? null);
  // A job role with no department has no place to be floored in: hidden.
  if (deptId === null) return true;
  const top = floorNode(COMPANY, null, h.departments, cells, floor, opts);
  const dept = top.children.find((c) => c.scope.id === deptId);
  if (!dept || isSuppressed(dept.value)) return true;
  if (scope.type === "department") return false;
  const deptScope: Scope = { type: "department", id: deptId };
  const level = floorNode(deptScope, COMPANY, childrenIn(h, deptScope), cells, floor, opts);
  const node = level.children.find((c) => c.scope.id === scope.id);
  if (!node || isSuppressed(node.value)) return true;
  return cells.cell(scope, null).people !== (node.value as Cell).people;
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
