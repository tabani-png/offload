// s14 Harness^2 "probe": run both variants against last week's real instances and keep the one closer to what the
// user actually did. Deterministic arithmetic (ADR 0005):
//   per instance, predicted = the understanding steps a variant would run (unconditional steps always; a step behind a
//   decide when another step of the instance carries an item id of the kind that step uses, e.g. "order #"; with no
//   id kind, when the step is in at least half the instances); actual = the steps the user took (span -> step map).
//   A check step that was never observed counts as one extra step per instance.
//   agreement = matched / (matched + extra + missed), pooled over every instance.
// Higher agreement wins; a tie goes to the variant with fewer steps, then to A.
import type { PlanVariantDTO, ProbeScoreDTO } from "../api/s14-types.ts";
import { idKind, type InstanceEvidence, type TaskEvidence } from "./evidence.ts";

const CHECK = "check";

/** The understanding steps (and the pseudo step "check") a variant runs in one instance. */
export function predictedSteps(v: PlanVariantDTO, inst: InstanceEvidence, ev: Pick<TaskEvidence, "stepIdKinds" | "stepById">): Set<string> {
  const out = new Set<string>();
  // Item-id kinds the instance shows on each of its steps.
  const kindsOn = new Map<string, Set<string>>();
  for (const [sid, ss] of inst.bySteps) {
    const ks = new Set<string>();
    for (const id of ss.identifiers) {
      const k = idKind(id);
      if (k !== null) ks.add(k);
    }
    kindsOn.set(sid, ks);
  }
  for (const s of v.steps) {
    if (s.sourceSteps.length === 0) {
      if (s.type === "decide") out.add(CHECK);
      continue;
    }
    for (const src of s.sourceSteps) {
      if (s.when === null) {
        out.add(src);
        continue;
      }
      const kinds = ev.stepIdKinds.get(src) ?? new Set<string>();
      if (kinds.size === 0) {
        if ((ev.stepById.get(src)?.perInstance ?? 0) >= 0.5) out.add(src);
        continue;
      }
      const others = [...kindsOn.entries()].filter(([sid]) => sid !== src).flatMap(([, ks]) => [...ks]);
      if (others.some((k) => kinds.has(k))) out.add(src);
    }
  }
  return out;
}

export function probeVariant(v: PlanVariantDTO, ev: TaskEvidence): ProbeScoreDTO {
  let matched = 0;
  let extra = 0;
  let missed = 0;
  const known = new Set(ev.understanding.steps.map((s) => s.id));
  for (const inst of ev.instances) {
    const p = predictedSteps(v, inst, ev);
    const actual = new Set([...inst.steps].filter((s) => known.has(s)));
    for (const s of p) if (actual.has(s)) matched += 1;
    else extra += 1;
    for (const s of actual) if (!p.has(s)) missed += 1;
  }
  const denom = matched + extra + missed;
  const agreement = denom === 0 ? 0 : matched / denom;
  const pct = Math.round(agreement * 1000) / 10;
  return {
    variant: v.id,
    instances: ev.instances.length,
    matched,
    extra,
    missed,
    agreement: Math.round(agreement * 10_000) / 10_000,
    arithmetic: `${matched} matched / (${matched} matched + ${extra} extra + ${missed} missed) over ${ev.instances.length} instances = ${pct.toFixed(1)}%`,
  };
}

export interface ProbeResult {
  scores: ProbeScoreDTO[];
  chosen: "a" | "b";
  reason: string;
}

export function probe(variants: readonly PlanVariantDTO[], ev: TaskEvidence): ProbeResult {
  const scores = variants.map((v) => probeVariant(v, ev));
  const [a, b] = scores as [ProbeScoreDTO, ProbeScoreDTO];
  const [va, vb] = variants as [PlanVariantDTO, PlanVariantDTO];
  let chosen: "a" | "b";
  let why: string;
  const pa = Math.round(a.agreement * 100);
  const pb = Math.round(b.agreement * 100);
  if (a.agreement !== b.agreement) {
    chosen = a.agreement > b.agreement ? "a" : "b";
    why = `closer to what you did: ${chosen === "a" ? pa : pb}% of your steps vs ${chosen === "a" ? pb : pa}%`;
  } else if (va.steps.length !== vb.steps.length) {
    chosen = va.steps.length < vb.steps.length ? "a" : "b";
    why = `both match ${pa}% of your steps; this one has fewer steps`;
  } else {
    chosen = "a";
    why = `both match ${pa}% of your steps`;
  }
  return { scores, chosen, reason: why };
}
