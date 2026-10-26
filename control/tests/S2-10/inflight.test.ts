import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTenant } from "../../src/db/tenant.ts";
import { audits, email, handoverFor, handoversOf, offboard, principal, run, runnable, to, world, type World } from "./world.ts";

let w: World;
let member: string;
let h1: string;
let h2: string;
let inFlightHash: string;

beforeAll(async () => {
  w = await world();
  member = w.t.people.member.id;
  const r = await w.broker.proposeBatch(w.t.id, run(w, w.wf.sdr1, { type: "person", id: member }, member, w.t.connections.company), [email(to())]);
  if (!r.ok) throw new Error(r.message);
  inFlightHash = r.batchHash;
  const lead = await principal(w, "lead");
  await withTenant(w.h.db.app, { tenantId: w.t.id, principalPersonId: lead.personId, accessRole: lead.accessRole }, (t) =>
    w.broker.approve(t, lead, inFlightHash, { batchHash: inFlightHash, itemKeys: null, edits: [] }),
  );
  await offboard(w, member);
  h1 = await handoverFor(w, member, w.wf.sdr1);
  h2 = await handoverFor(w, member, w.wf.sdr2);
});
afterAll(() => w.close());

const rep2Run = (wf: string) => run(w, wf, { type: "person", id: w.extra.rep2 }, w.extra.rep2, w.rep2Gmail);

describe("INFLIGHT", () => {
  test("INFLIGHT: hand-overs open with inFlight pause; assign without inFlight keeps pause and records inboxStep", async () => {
    expect((await handoversOf(w, member)).every((h) => h.in_flight === "pause")).toBe(true);
    const r = await (await w.as("admin")).post(`/v1/handovers/${h2}/assign`, {
      successor: { type: "role_identity", roleIdentityId: w.identities.sdr },
      inboxStep: "m365_shared_mailbox",
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ inFlight: "pause", inboxStep: "m365_shared_mailbox" });
  });

  test("INFLIGHT: pause: the leaver's in-flight batch stays stopped (its tokens were revoked at freeze, nothing re-approves it)", async () => {
    const tokens = await w.h.db.migrator`select revoked_at from approval_tokens where batch_hash = ${inFlightHash}`;
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.revoked_at).not.toBeNull();
    const sent = await w.h.db.migrator`select count(*)::int as n from batch_items where batch_hash = ${inFlightHash} and state in ('sending', 'sent')`;
    expect(sent[0]!.n).toBe(0);
  });

  test("INFLIGHT: handover_message needs a person successor (a role identity cannot review)", async () => {
    const r = await (await w.as("admin")).post(`/v1/handovers/${h1}/assign`, {
      successor: { type: "role_identity", roleIdentityId: w.identities.sdr },
      inFlight: "handover_message",
    });
    expect(r.status).toBe(400);
  });

  test("INFLIGHT: handover_message: accepting without reviewing the message is refused", async () => {
    const admin = await w.as("admin");
    const r = await admin.post(`/v1/handovers/${h1}/assign`, { successor: { type: "person", personId: w.extra.rep2 }, inFlight: "handover_message", inboxStep: "google_alias" });
    expect(r.status).toBe(200);
    expect(r.json.inFlight).toBe("handover_message");
    const acc = await (await w.as("rep2")).post(`/v1/handovers/${h1}/accept`, {});
    expect(acc.status).toBe(409);
    expect(await runnable(w, w.wf.sdr1, { personId: w.extra.rep2 })).toBe(false);
  });

  test("INFLIGHT: handover_message: no send before the successor's review", async () => {
    const r = await w.broker.proposeBatch(w.t.id, rep2Run(w.wf.sdr1), [email(to())]);
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    expect((await audits(w, "run.held")).at(-1)!.detail).toMatchObject({ reason: "awaiting_successor" });
  });

  test("INFLIGHT: handover_message: after the successor accepts with the review, sending resumes", async () => {
    const acc = await (await w.as("rep2")).post(`/v1/handovers/${h1}/accept`, { reviewedHandoverMessage: true });
    expect(acc.status).toBe(200);
    const [h] = (await handoversOf(w, member)).filter((x) => x.id === h1);
    expect(h!.message_reviewed_at).not.toBeNull();
    expect(await runnable(w, w.wf.sdr1, { personId: w.extra.rep2 })).toBe(true);
    expect(await w.broker.proposeBatch(w.t.id, rep2Run(w.wf.sdr1), [email(to())])).toMatchObject({ ok: true });
  });

  test("INFLIGHT: stop is recorded on the hand-over", async () => {
    const r = await (await w.as("admin")).post(`/v1/handovers/${h2}/assign`, {
      successor: { type: "role_identity", roleIdentityId: w.identities.sdr },
      inFlight: "stop",
      inboxStep: "none",
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ inFlight: "stop", inboxStep: "none" });
  });
});
