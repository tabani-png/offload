// S5 Score, per adam/memory/research/10-harness-and-task-mining.md section 3. Pure.

export interface ScoreFactors {
  /** Share of active time, 0..1. */
  volume: number;
  sameness: number;
  reachability: number;
  judgement: number;
  risk: number;
}

export const SCORE_FORMULA = "volume × sameness × reachability × (1 − judgement) × (1 − risk/2)";

export function rankingScore(f: ScoreFactors): number {
  for (const [name, v] of Object.entries(f)) {
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError(`${name} must be within 0..1, got ${v}`);
  }
  return f.volume * f.sameness * f.reachability * (1 - f.judgement) * (1 - f.risk / 2);
}
