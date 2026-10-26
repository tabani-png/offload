// Differencing across figures (S2-05 follow-ups). A reader can add and subtract any figures they can see: company,
// department and job-role totals, the children cells, top workflows at every level. Each figure is a sum over cells
// (department, job role, workflow). A family of figures is safe when no linear combination of them is a nonzero sum
// over cells held by 1 to floor-1 people.
//
// Method: cells with the same membership (which figures contain them) form one block; every combination is constant
// on a block. A vector v over blocks is a combination of the figures iff A·v = 0, A a basis of the null space of the
// figure × block matrix. So a nonzero combination supported on a block set S exists iff A's columns on S are linearly
// dependent. Blocks with floor or more people can never be in a small support; the sets of small blocks whose people
// together stay under the floor are enumerated (at most floor-1 blocks each) and each is tested.

const EPS = 1e-9;
/** Past this many candidate supports the family is treated as unsafe (never as safe). */
const MAX_CHECKS = 200_000;

/** Reduced row echelon form in place; returns pivot columns. */
function rref(m: number[][], cols: number): number[] {
  const pivots: number[] = [];
  let row = 0;
  for (let c = 0; c < cols && row < m.length; c++) {
    let best = row;
    for (let r = row + 1; r < m.length; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[best]![c]!)) best = r;
    if (Math.abs(m[best]![c]!) < EPS) continue;
    [m[row], m[best]] = [m[best]!, m[row]!];
    const p = m[row]![c]!;
    for (let k = c; k < cols; k++) m[row]![k]! /= p;
    for (let r = 0; r < m.length; r++) {
      if (r === row) continue;
      const f = m[r]![c]!;
      if (Math.abs(f) < EPS) continue;
      for (let k = c; k < cols; k++) m[r]![k]! -= f * m[row]![k]!;
    }
    pivots.push(c);
    row++;
  }
  return pivots;
}

function rank(vectors: number[][], len: number): number {
  return rref(vectors.map((v) => [...v]), len).length;
}

/**
 * Is this family of figures safe at `floor`? `figures` are sets of cell keys; `people` gives each cell's people.
 */
export function familySafe(figures: ReadonlyArray<ReadonlySet<string>>, people: ReadonlyMap<string, ReadonlySet<string>>, floor: number): boolean {
  const cells = new Set<string>();
  for (const f of figures) for (const c of f) cells.add(c);
  const blocks = new Map<string, { members: number[]; people: Set<string> }>();
  for (const c of cells) {
    const members = figures.flatMap((f, i) => (f.has(c) ? [i] : []));
    const key = members.join(",");
    const b = blocks.get(key) ?? { members, people: new Set<string>() };
    for (const p of people.get(c) ?? []) b.people.add(p);
    blocks.set(key, b);
  }
  const list = [...blocks.values()];
  const m = list.length;
  // Null space of the figure × block matrix: one basis vector per free column of its RREF.
  const g = figures.map((_, i) => list.map((b) => (b.members.includes(i) ? 1 : 0)));
  const pivots = rref(g, m);
  const pivotSet = new Set(pivots);
  const basis: number[][] = [];
  for (let free = 0; free < m; free++) {
    if (pivotSet.has(free)) continue;
    const v = new Array<number>(m).fill(0);
    v[free] = 1;
    pivots.forEach((pc, r) => (v[pc] = -g[r]![free]!));
    basis.push(v);
  }
  // Column j of A (A's rows = the basis): the j-th entry of every basis vector.
  const column = (j: number) => basis.map((v) => v[j]!);
  const small = list.map((b, j) => ({ j, people: b.people })).filter((x) => x.people.size > 0 && x.people.size < floor);
  let checks = 0;
  const dependent = (js: number[]) => basis.length === 0 || rank(js.map(column), basis.length) < js.length;
  const search = (from: number, chosen: number[], union: Set<string>): boolean => {
    for (let i = from; i < small.length; i++) {
      const u = new Set([...union, ...small[i]!.people]);
      if (u.size >= floor) continue;
      if (++checks > MAX_CHECKS) return false;
      const next = [...chosen, small[i]!.j];
      if (dependent(next)) return false;
      if (!search(i + 1, next, u)) return false;
    }
    return true;
  };
  return search(0, [], new Set());
}
