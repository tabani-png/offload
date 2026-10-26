// Seam for S2-06 (workflow registry, ADR 0104): when a personal workflow is promoted to a role workflow its playbook
// goes with it, so a successor or a cloud worker keeps the same message in their own voice. The registry schema is
// frozen; the field is proposed in plan/stage-2/adr/0112-playbook-on-promotion.md. Re-checked before it leaves.
import { sha256Hex } from "../sync/encoding.ts";
import { canonicalize } from "../sync/jcs.ts";
import { readWorkflow } from "../workflows/store.ts";
import { identityForWorkflow } from "./build.ts";
import { assertDepersonalised } from "./leak.ts";
import { readPlaybook } from "./store.ts";
import type { Playbook } from "./types.ts";

/** What travels with a promoted workflow: no history, build time or warnings (they say nothing about the message). */
export type PromotablePlaybook = Omit<Playbook, "history" | "builtAt" | "warnings">;

export function promotablePlaybook(pb: Playbook): PromotablePlaybook {
  const { history: _h, builtAt: _b, warnings: _w, ...rest } = pb;
  void _h;
  void _b;
  void _w;
  return rest;
}

/** The workflow's playbook for promotion, re-checked against its identity set (throws PlaybookLeakError), with
 * playbookHash = sha256(JCS(promotable playbook)). null when the workflow has no playbook. */
export function playbookForPromotion(home: string, workflowId: string, now: number = Date.now()): { playbook: PromotablePlaybook; playbookHash: string } | null {
  const wf = readWorkflow(home, workflowId);
  const pb = wf === null ? null : readPlaybook(home, workflowId);
  if (wf === null || pb === null) return null;
  assertDepersonalised(pb, identityForWorkflow(home, wf, now));
  const playbook = promotablePlaybook(pb);
  return { playbook, playbookHash: sha256Hex(canonicalize(playbook)) };
}
