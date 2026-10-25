// Shared s10b setup: the s09b world (fixture week, stub tone pack, outreach workflow, createBrain with a movable
// clock and a send-counting executor), activated through a real dry run and approval, with three recipients.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ApproveResponse, DryRunResponse } from "../../src/api/types.ts";
import { listBatches } from "../../src/workflows/store.ts";
import { writeRecipients } from "../s05-workflows/setup.ts";
import { connectGmail, local, s09bWorld, type S09bWorld } from "../s09b-brain/setup.ts";

export { local };
export const MON_0800 = local(2026, 10, 19, 8, 0);
export const MON_0900 = local(2026, 10, 19, 9, 0);
export const TUE_0900 = local(2026, 10, 20, 9, 0);
export const DAY_MS = 86_400_000;
export const BASE_ROWS = ["ana@fund.vc,Ana,Lee,Fund VC,", "bo@seed.vc,Bo,Kim,Seed VC,", "cy@pre.vc,Cy,Ito,Pre VC,"];

export async function activeWorld(o: { autoRun?: boolean; gmail?: boolean; rows?: string[] } = {}): Promise<S09bWorld> {
  const x = await s09bWorld({ now: MON_0800 });
  if (o.gmail !== false) connectGmail(x.home);
  const dry = await x.call<DryRunResponse>(`/workflows/${x.outreach.id}/dry-run`, { method: "POST", body: { limit: 1 } });
  const ok = await x.call<ApproveResponse>(`/workflows/${x.outreach.id}/approve`, { method: "POST", body: { batchHash: dry.body.batchHash } });
  if (ok.body.result !== "activated") throw new Error("activation failed");
  writeRecipients(x.home, x.outreach.id, o.rows ?? BASE_ROWS);
  if (o.autoRun === true) {
    const r = await x.call(`/workflows/${x.outreach.id}/auto-run`, { method: "POST", body: { enabled: true } });
    if (r.status !== 200) throw new Error(`auto-run: ${r.status}`);
  }
  return x;
}

export const live = (x: S09bWorld) => listBatches(x.home, x.outreach.id, x.clock.now).filter((b) => b.kind === "live");

export async function tick(x: S09bWorld, at: number) {
  x.clock.now = at;
  const r = await x.brain.schedulerTick();
  await x.brain.idle();
  return r;
}

export function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}
export const plaintextHits = (dir: string, needle: string) => filesUnder(dir).filter((f) => readFileSync(f, "utf8").includes(needle));
