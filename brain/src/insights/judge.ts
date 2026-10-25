// Judgement and risk for a task. The research pipeline (S5) has Claude score these on the top tasks; until that is
// wired, a deterministic heuristic Judge stands in. Judges see the task profile only, never raw events.
import { isMailListView, WRITING_KEYS_PER_MINUTE } from "../grouping/group.ts";
import type { TaskProfile, UserContext } from "../types.ts";

export interface JudgeInput {
  profile: TaskProfile;
  /** Sameness score 0..1 from stats. */
  sameness: number;
  /** s12: optional onboarding context (role, industry). Context only; the heuristic judge ignores it. */
  user?: UserContext;
}

export interface JudgeResult {
  /** 0..1: how much human judgement each instance needs. */
  judgement: number;
  /** 0..1: how bad a wrong automated action would be. */
  risk: number;
  reasons: string[];
}

export interface Judge {
  judge(input: JudgeInput): JudgeResult | Promise<JudgeResult>;
}

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Writing judgement: templated writing is cheap to automate, free-form one-off writing is not. */
function writingJudgement(sameness: number): { judgement: number; reason: string } {
  const judgement = round2(clamp(1 - sameness, 0.1, 0.9));
  return sameness < 0.5
    ? { judgement, reason: `free-form one-off writing (sameness ${sameness.toFixed(2)})` }
    : { judgement, reason: `templated writing (sameness ${sameness.toFixed(2)})` };
}

export const heuristicJudge = {
  judge({ profile: p, sameness }: JudgeInput): JudgeResult {
    const writes = p.keysPerMinute >= WRITING_KEYS_PER_MINUTE && !(p.category === "email" && isMailListView(p.template));
    const external = p.identifiers.counterparties.length > 0;
    switch (p.category) {
      case "email":
      case "chat": {
        if (!writes) return { judgement: 0.6, risk: 0, reasons: ["reading and triage: deciding what matters is judgement", "nothing is sent"] };
        const w = writingJudgement(sameness);
        if (external) return { judgement: w.judgement, risk: 0.5, reasons: [w.reason, `external send to ${p.identifiers.domains.length} domains`] };
        return { judgement: w.judgement, risk: 0.2, reasons: [w.reason, "internal messages"] };
      }
      case "call":
        return { judgement: 0.9, risk: 0.2, reasons: ["live conversation"] };
      case "code":
        return { judgement: 0.8, risk: 0.2, reasons: ["engineering work"] };
      case "sheet":
        return { judgement: 0.15, risk: 0.1, reasons: ["structured data entry", "writes to shared records"] };
      case "calendar":
        return { judgement: 0.3, risk: 0.2, reasons: ["calendar changes are visible to others"] };
      case "social":
      case "browse":
        return { judgement: 0.6, risk: 0, reasons: ["reading and browsing"] };
      case "other":
        return { judgement: 0.5, risk: 0.1, reasons: ["unknown kind of work"] };
    }
  },
} satisfies Judge;
