// s18 measured rates (printed by slices/s18-name-masking/verify.sh). Deterministic: the masker over the corpora.
//   false positives = non-name lines the masker changes + kept words of the name cases it masks, over all of them
//   false negatives = listed name occurrences still readable after masking, over all of them
import { maskNamesForStorage } from "../../src/privacy/names.ts";
import { NAME_CASES, NON_NAMES, type NameCase } from "./corpus.ts";

const word = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u");

export interface Rates {
  fp: { count: number; total: number; pct: number; examples: string[] };
  fn: { count: number; total: number; pct: number; examples: string[]; byPersona: Record<NameCase["persona"], { missed: number; total: number }> };
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
  const pct = (a: number, b: number) => Math.round((b === 0 ? 0 : (a / b) * 100) * 100) / 100;
  return { fp: { count: fp, total: fpTotal, pct: pct(fp, fpTotal), examples: fpEx }, fn: { count: fn, total: fnTotal, pct: pct(fn, fnTotal), examples: fnEx, byPersona } };
}

if (import.meta.main) {
  const r = measure();
  console.log(`false positives: ${r.fp.count} of ${r.fp.total} non-name lines and kept words = ${r.fp.pct}%`);
  for (const e of r.fp.examples) console.log(`  fp ${e}`);
  console.log(`false negatives: ${r.fn.count} of ${r.fn.total} name occurrences = ${r.fn.pct}%`);
  for (const [p, v] of Object.entries(r.fn.byPersona)) console.log(`  ${p}: ${v.total - v.missed}/${v.total} masked`);
  for (const e of r.fn.examples) console.log(`  fn ${e}`);
}
