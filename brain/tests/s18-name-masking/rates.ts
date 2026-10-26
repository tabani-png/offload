// s18 measured rates (printed by slices/s18-name-masking/verify.sh). Deterministic: the masker over the corpora.
//   false positives = non-name lines the masker changes + kept words of the name cases it masks, over all of them
//   false negatives = listed name occurrences still readable after masking, over all of them
//   held-out false negatives = the same over heldout.ts (names outside the lexicons, no cue), reported apart: the
//   masker was tuned on corpus.ts, so its rate says little about real mail; this one says how much the rules miss.
import { maskNamesForStorage } from "../../src/privacy/names.ts";
import { NAME_CASES, NON_NAMES, type NameCase } from "./corpus.ts";
import { HELD_OUT } from "./heldout.ts";

const word = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u");

export interface Rates {
  fp: { count: number; total: number; pct: number; examples: string[] };
  fn: { count: number; total: number; pct: number; examples: string[]; byPersona: Record<NameCase["persona"], { missed: number; total: number }> };
  heldOut: { count: number; total: number; pct: number; examples: string[] };
}

const pct = (a: number, b: number) => Math.round((b === 0 ? 0 : (a / b) * 100) * 100) / 100;

/** False negatives over the held-out set only. */
export function measureHeldOut(): Rates["heldOut"] {
  let count = 0;
  let total = 0;
  const examples: string[] = [];
  for (const c of HELD_OUT) {
    const m = maskNamesForStorage(c.text);
    for (const n of c.names) {
      total += 1;
      if (word(n).test(m)) {
        count += 1;
        examples.push(`${n} in ${JSON.stringify(m)}`);
      }
    }
  }
  return { count, total, pct: pct(count, total), examples };
}

export function measure(): Rates {
  const fpEx: string[] = [];
  let fp = 0;
  let fpTotal = 0;
  for (const line of NON_NAMES) {
    fpTotal += 1;
    const m = maskNamesForStorage(line);
    if (m !== line) {
      fp += 1;
      fpEx.push(`${JSON.stringify(line)} -> ${JSON.stringify(m)}`);
    }
  }
  let fn = 0;
  let fnTotal = 0;
  const fnEx: string[] = [];
  const byPersona = {} as Rates["fn"]["byPersona"];
  for (const c of NAME_CASES) {
    const m = maskNamesForStorage(c.text);
    const p = (byPersona[c.persona] ??= { missed: 0, total: 0 });
    for (const n of c.names) {
      fnTotal += 1;
      p.total += 1;
      if (word(n).test(m)) {
        fn += 1;
        p.missed += 1;
        fnEx.push(`${n} in ${JSON.stringify(m)}`);
      }
    }
    for (const k of c.keep ?? []) {
      fpTotal += 1;
      if (!m.includes(k)) {
        fp += 1;
        fpEx.push(`kept word ${JSON.stringify(k)} masked in ${JSON.stringify(m)}`);
      }
    }
  }
  return { fp: { count: fp, total: fpTotal, pct: pct(fp, fpTotal), examples: fpEx }, fn: { count: fn, total: fnTotal, pct: pct(fn, fnTotal), examples: fnEx, byPersona }, heldOut: measureHeldOut() };
}

if (import.meta.main) {
  const r = measure();
  console.log(`false positives: ${r.fp.count} of ${r.fp.total} non-name lines and kept words = ${r.fp.pct}%`);
  for (const e of r.fp.examples) console.log(`  fp ${e}`);
  console.log(`false negatives: ${r.fn.count} of ${r.fn.total} name occurrences = ${r.fn.pct}%`);
  for (const [p, v] of Object.entries(r.fn.byPersona)) console.log(`  ${p}: ${v.total - v.missed}/${v.total} masked`);
  for (const e of r.fn.examples) console.log(`  fn ${e}`);
  console.log(`held-out false negatives (names outside the lexicons, no cue; not a gate): ${r.heldOut.count} of ${r.heldOut.total} = ${r.heldOut.pct}%`);
  for (const e of r.heldOut.examples) console.log(`  held-out fn ${e}`);
}
