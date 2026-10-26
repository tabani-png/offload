import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MODULES_DIR } from "../../src/app.ts";
import type { Tx } from "../../src/db/pool.ts";
import { asDevice, asPrincipal, createHarness, enrollDevice, type Harness } from "../helpers/harness.ts";
import { deviceConsent } from "../../src/modules/compliance/consent.ts";
import { DAY_MS, enableBody, publishNotice, signIn, sys, type Who } from "./fixtures.ts";

/**
 * The ConsentPort extras the sync slice's device config reads (`requiredNotice`, `workingTimeStartsAt`): without them the
 * merged build tells every Mac there is no notice to acknowledge and no working-time start.
 */
interface Extras {
  requiredNotice?(tx: Tx, personId: string): Promise<{ noticeVersionId: string; title: string; markdown: string; features: string[] } | null>;
  workingTimeStartsAt?(tx: Tx, personId: string): Promise<number | null>;
}

/** Whether S2-05's sync module (GET /v1/sync/config) is in this tree. */
const SYNC = existsSync(join(MODULES_DIR, "sync", "index.ts"));
const HOUR = 3_600_000;
let h: Harness;
let who: Who;
let notice: { id: string; title: string; markdown: string; features: string[] };
let wtStarts: number;

// T0 notice (workflow_metrics + working_time) published; T0+1h member acks; T0+2h working_time on for CA-ON, 1-day period.
beforeAll(async () => {
  h = await createHarness();
  who = await signIn(h);
  notice = await publishNotice(who.owner, { features: ["workflow_metrics", "working_time"] });
  h.clock.advance(HOUR);
  if ((await who.member.post(`/v1/me/notices/${notice.id}/ack`)).status !== 201) throw new Error("ack");
  h.clock.advance(HOUR);
  const r = await who.owner.post("/v1/compliance/features/working_time/enable", enableBody("working_time", notice.id, { noticePeriodDays: 1 }));
  if (r.status !== 201) throw new Error(`enable ${r.status}`);
  wtStarts = r.json.effectiveAt;
  h.clock.advance(DAY_MS + HOUR);
});
afterAll(() => h.close());

describe("CONSENT", () => {
  test("CONSENT: the ConsentPort provides requiredNotice and workingTimeStartsAt, matching deviceConsent", async () => {
    const port = h.deps.ports.consent as Extras;
    expect(typeof port.requiredNotice).toBe("function");
    expect(typeof port.workingTimeStartsAt).toBe("function");
    const member = who.member.personId;
    await sys(h, async (tx) => {
      const dc = await deviceConsent(tx, member, h.clock.now());
      expect(await port.requiredNotice!(tx, member)).toEqual(dc.requiredNotice);
      expect(await port.workingTimeStartsAt!(tx, member)).toBe(dc.workingTimeStartsAt);
      expect(dc.workingTimeStartsAt).toBe(wtStarts);
      // No published notice for an unknown person; no working time without consent.
      expect(await port.requiredNotice!(tx, crypto.randomUUID())).toBeNull();
      expect(await port.workingTimeStartsAt!(tx, who.owner.personId)).toBeNull();
    });
  });

  test.skipIf(!SYNC)("CONSENT: the device config (S2-05) shows the real required notice and working-time start", async () => {
    const dev = await enrollDevice(h, await asPrincipal(h, "member"));
    const r = await asDevice(h, dev.token)("GET", "/v1/sync/config");
    expect(r.status).toBe(200);
    expect(r.json.requiredNotice).toEqual({ noticeVersionId: notice.id, title: notice.title, markdown: notice.markdown, features: notice.features });
    expect(r.json.workingTimeStartsAt).toBe(wtStarts);
    expect(r.json.allowedKinds).toContain("working_time_aggregate");
    expect(h.deps.validator.validate("offload/stage2/device-config.schema.json", r.json)).toEqual({ ok: true });
  });
});
