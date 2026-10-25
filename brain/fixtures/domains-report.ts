// s12 report: grouping agreement of v1 (rules) and v2 (understanding) against each persona's ground truth, plus the
// top insight, its share and instances next to the truth. Exits 1 when a v2 known answer fails.
// Usage: bun run brain/fixtures/domains-report.ts [--seed 7] [--embedder stub|ollama] [--json]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeHome, type Analysis } from "../src/analyze.ts";
import type { Span } from "../src/types.ts";
import { OllamaEmbedder, StubEmbedder, type Embedder } from "../src/understanding/embed.ts";
import { groupingAgreement, type Agreement } from "../src/understanding/eval.ts";
import { generatePersona, PERSONAS, writePersona, type PersonaId, type Truth } from "./gen-domains.ts";

export const REPORT_START = "2026-10-12";
/** Noon on the day after the 7-day window: the reader keeps every generated day. */
export const reportNow = () => new Date(2026, 9, 19, 12).getTime();

/** Truth label of a span = label of the focus event that opened it. */
export function truthOfSpan(s: Span, truth: Truth): string {
  for (const id of s.eventIds) {
    const l = truth.focusLabels[id];
    if (l !== undefined) return l;
  }
  return "unknown";
}

export function agreementOf(a: Analysis, truth: Truth): Agreement {
  return groupingAgreement(a.spans.map((s) => ({ weight: s.activeMs, truth: truthOfSpan(s, truth), pred: a.taskOfSpan.get(s.id) ?? "none" })));
}

export interface PersonaResult {
  persona: PersonaId;
  v1: Agreement;
  v2: Agreement;
  truth: Truth;
  top: { name: string; kind: string; share: number; instances: number; truthLabel: string } | null;
  second: { name: string; truthLabel: string } | null;
  ok: boolean;
  problems: string[];
}

export async function runPersona(p: PersonaId, seed: number, embedder: Embedder): Promise<PersonaResult> {
  const home = mkdtempSync(join(tmpdir(), `offload-s12-${p}-`));
  try {
    const week = generatePersona(p, { seed, startDay: REPORT_START });
    writePersona(home, week, { encrypted: false, seed });
    const truth = week.truth;
    const v1 = await analyzeHome(home, { now: reportNow });
    const v2 = await analyzeHome(home, { now: reportNow, understanding: "v2", embedder, userContext: { role: truth.role, industry: truth.industry } });
    const ag2 = agreementOf(v2, truth);
    const labelOf = (taskId: string | undefined) => (taskId === undefined ? "none" : (ag2.majority.get(taskId) ?? "none"));
    const top = v2.insights[0];
    const second = v2.insights[1];
    const problems: string[] = [];
    const want = truth.second === undefined ? [truth.topTask.label] : [truth.topTask.label, truth.second.label];
    const got = v2.insights.slice(0, want.length).map((i) => labelOf(i.taskId));
    if ([...want].sort().join() !== [...got].sort().join()) problems.push(`top ${want.length}: want ${want.join(",")}, got ${got.join(",")}`);
    for (const i of v2.insights.slice(0, want.length)) {
      const t = truth.tasks[labelOf(i.taskId)];
      if (t === undefined) continue;
      if (Math.abs(i.stats.share.value - t.share) > 0.03) problems.push(`${t.label} share ${(i.stats.share.value * 100).toFixed(1)} vs ${(t.share * 100).toFixed(1)}`);
      if (Math.abs(i.stats.instances.value - t.instances) > 0.1 * t.instances) problems.push(`${t.label} instances ${i.stats.instances.value} vs ${t.instances}`);
      if (i.label.kind.startsWith("email.")) problems.push(`${t.label} labelled ${i.label.kind}`);
    }
    if (ag2.f < 0.9) problems.push(`v2 agreement F ${ag2.f.toFixed(3)} < 0.9`);
    return {
      persona: p,
      v1: agreementOf(v1, truth),
      v2: ag2,
      truth,
      top: top === undefined ? null : { name: top.label.name, kind: top.label.kind, share: top.stats.share.value, instances: top.stats.instances.value, truthLabel: labelOf(top.taskId) },
      second: second === undefined ? null : { name: second.label.name, truthLabel: labelOf(second.taskId) },
      ok: problems.length === 0,
      problems,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let seed = 7;
  let embedder: Embedder = new StubEmbedder();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed") seed = Number(argv[++i]);
    else if (argv[i] === "--embedder") embedder = argv[++i] === "ollama" ? new OllamaEmbedder() : new StubEmbedder();
    else if (argv[i] === "--json") json = true;
  }
  const results: PersonaResult[] = [];
  for (const p of PERSONAS) results.push(await runPersona(p, seed, embedder));
  if (json) console.log(JSON.stringify(results.map((r) => ({ persona: r.persona, v1: { purity: r.v1.purity, inversePurity: r.v1.inversePurity, f: r.v1.f }, v2: { purity: r.v2.purity, inversePurity: r.v2.inversePurity, f: r.v2.f }, top: r.top, ok: r.ok, problems: r.problems })), null, 2));
  else {
    const f3 = (x: number) => x.toFixed(3);
    console.log(`embedder ${embedder.id}, seed ${seed}`);
    console.log("persona     | v1 P / IP / F         | v2 P / IP / F         | v2 #1 (truth)                                   | share v2 / truth | inst v2 / truth");
    for (const r of results) {
      const t = r.truth.topTask;
      const top = r.top;
      const name = top === null ? "(none)" : `${top.name} [${top.kind}] (${top.truthLabel})`;
      console.log(
        `${r.persona.padEnd(11)} | ${f3(r.v1.purity)} ${f3(r.v1.inversePurity)} ${f3(r.v1.f)} | ${f3(r.v2.purity)} ${f3(r.v2.inversePurity)} ${f3(r.v2.f)} | ${name.slice(0, 47).padEnd(47)} | ${top === null ? "-" : (top.share * 100).toFixed(1)} / ${(t.share * 100).toFixed(1)} | ${top?.instances ?? "-"} / ${t.instances}${r.ok ? "" : `  FAIL: ${r.problems.join("; ")}`}`,
      );
    }
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
