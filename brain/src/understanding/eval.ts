// s12 grouping agreement against ground truth: time-weighted purity (each predicted task's share that belongs to its
// majority truth task), inverse purity (each truth task's share inside its majority predicted task) and their F.
// The usual cluster-agreement figures; used by tests and brain/fixtures/domains-report.ts. Pure.

export interface Assignment {
  weight: number;
  truth: string;
  pred: string;
}

export interface Agreement {
  purity: number;
  inversePurity: number;
  f: number;
  /** pred -> its majority truth label. */
  majority: Map<string, string>;
}

function maxShare(items: readonly Assignment[], by: (a: Assignment) => string, of: (a: Assignment) => string): { sum: number; top: Map<string, string> } {
  const groups = new Map<string, Map<string, number>>();
  for (const a of items) {
    const g = groups.get(by(a)) ?? new Map<string, number>();
    g.set(of(a), (g.get(of(a)) ?? 0) + a.weight);
    groups.set(by(a), g);
  }
  let sum = 0;
  const top = new Map<string, string>();
  for (const [k, g] of groups) {
    let best = "";
    let bw = -1;
    for (const [x, w] of g) if (w > bw || (w === bw && x < best)) [best, bw] = [x, w];
    sum += bw;
    top.set(k, best);
  }
  return { sum, top };
}

export function groupingAgreement(items: readonly Assignment[]): Agreement {
  const total = items.reduce((n, a) => n + a.weight, 0);
  if (total === 0) return { purity: 0, inversePurity: 0, f: 0, majority: new Map() };
  const p = maxShare(items, (a) => a.pred, (a) => a.truth);
  const ip = maxShare(items, (a) => a.truth, (a) => a.pred);
  const purity = p.sum / total;
  const inversePurity = ip.sum / total;
  return { purity, inversePurity, f: purity + inversePurity === 0 ? 0 : (2 * purity * inversePurity) / (purity + inversePurity), majority: p.top };
}
