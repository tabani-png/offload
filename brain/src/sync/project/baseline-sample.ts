// baseline_sample: observed manual durations for one workflow version as {instanceRef, activeSeconds, day}. Refs are
// HMACs only this Mac can resolve. Never span titles, apps, hosts, OCR or frame notes: BaselineInput has none.
import { sha256Hex } from "../encoding.ts";
import type { BaselineInput, BaselineSample, ProjectionContext } from "../types.ts";

export const MAX_INSTANCES = 500;

const dayMs = (day: string) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};

/** One object per 500 instances, sorted by day then ref. Empty input gives no object (the schema needs one). */
export function projectBaselineSamples(i: BaselineInput, ctx: ProjectionContext): BaselineSample[] {
  const rows = [...i.instances].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.instanceRef < b.instanceRef ? -1 : a.instanceRef > b.instanceRef ? 1 : 0)).map((r) => ({ instanceRef: r.instanceRef, activeSeconds: Math.max(0, Math.round(r.activeSeconds)), day: r.day }));
  const out: BaselineSample[] = [];
  for (let k = 0; k < rows.length; k += MAX_INSTANCES) {
    const chunk = rows.slice(k, k + MAX_INSTANCES);
    const key = `${i.binding.workflowId}@${i.binding.version}:${sha256Hex(chunk.map((r) => `${r.instanceRef}:${r.activeSeconds}`).join(","))}`;
    out.push({
      // The id's time is the window end (stable), so the same chunk always gets the same id.
      id: ctx.ids("baseline_sample", key, dayMs(chunk[chunk.length - 1]!.day)),
      kind: "baseline_sample",
      createdAt: ctx.now,
      workflowId: i.binding.workflowId,
      version: i.binding.version,
      windowStart: chunk[0]!.day,
      windowEnd: chunk[chunk.length - 1]!.day,
      instances: chunk,
    });
  }
  return out;
}
