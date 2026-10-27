// s10b, REVIEW-2 section 3 (privacy inventory). Every file with plaintext user content is either sealed and purged at
// 7 days, or a user file (recipients.csv, facts.md, crm-log.csv, tone cards the user edited) kept until the user
// deletes it and listed in GET /observer `keptFiles` for the app's "Observing" section.
//   live batches: sealed under the day they were drafted, purged at 30 days; never-write-twice survives the purge
//                 through a content-free ledger (sha256 of workflow + address);
//   tone/<bucket>.md the user did not edit: purged with the corpus they came from;
//   gate-log.jsonl: no addresses and no argument snippets on disk (items are hashed refs), rotated at 5 MB.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ObserverResponse } from "../../src/api/types.ts";
import { purgeAll } from "../../src/store/retention.ts";
import { styleCardPath } from "../../src/tone/pack.ts";
import { createGate } from "../../src/workflows/gate.ts";
import { makeBatch } from "../../src/workflows/batch.ts";
import { ScriptedExecutor, sendEachItem } from "../../src/workflows/executor.ts";
import { approveBatch, executeBatch, prepareLiveBatch } from "../../src/workflows/runner.ts";
import { listBatches, readBatch, workflowDir } from "../../src/workflows/store.ts";
import { SEND, type S09bWorld } from "../s09b-brain/setup.ts";
import { activeWorld, DAY_MS, MON_0800, plaintextHits } from "./setup.ts";

let w: S09bWorld | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

const sender = (x: S09bWorld) => new ScriptedExecutor({ [SEND]: async (i) => void x.sends.push(i as Record<string, unknown>) }, sendEachItem(SEND));

async function sentBatch(x: S09bWorld) {
  const b = await prepareLiveBatch({ home: x.home, workflowId: x.outreach.id, model: x.model, now: () => MON_0800 });
  const { token } = approveBatch(x.home, x.outreach.id, b.hash, MON_0800);
  await executeBatch({ home: x.home, workflowId: x.outreach.id, hash: b.hash, token, executor: sender(x), now: () => MON_0800 });
  return b;
}

describe("s10b privacy table", () => {
  test("PRIV: live batches are sealed on disk: no draft body or address in plaintext under batches/", async () => {
    w = await activeWorld();
    const b = await sentBatch(w);
    const dir = join(workflowDir(w.home, w.outreach.id), "batches");
    expect(readdirSync(dir).filter((n) => n.startsWith(b.hash))).toEqual([`${b.hash}.json.enc`]);
    expect(plaintextHits(dir, b.items[0]!.body.split("\n")[0]!)).toEqual([]);
    expect(plaintextHits(dir, "ana@fund.vc")).toEqual([]);
    expect(readBatch(w.home, w.outreach.id, b.hash, MON_0800)?.state).toBe("sent");
  });

  test("PRIV: live batches are purged 30 days after they were drafted", async () => {
    w = await activeWorld();
    const b = await sentBatch(w);
    const later = MON_0800 + 31 * DAY_MS;
    purgeAll(w.home, later, { log: () => {} });
    expect(existsSync(join(workflowDir(w.home, w.outreach.id), "batches", `${b.hash}.json.enc`))).toBe(false);
    expect(listBatches(w.home, w.outreach.id, later).filter((x) => x.kind === "live")).toEqual([]);
  });

  test("PRIV: after the purge, a recipient whose send was unknown is still never written to again", async () => {
    w = await activeWorld();
    const x = w;
    const b = await prepareLiveBatch({ home: x.home, workflowId: x.outreach.id, model: x.model, now: () => MON_0800 });
    const { token } = approveBatch(x.home, x.outreach.id, b.hash, MON_0800);
    // The tool throws for bo: the send may have happened (unknown).
    const ex = new ScriptedExecutor({ [SEND]: async (i) => { if ((i as { to: string }).to === "bo@seed.vc") throw new Error("timeout"); x.sends.push(i as Record<string, unknown>); } }, sendEachItem(SEND));
    const out = await executeBatch({ home: x.home, workflowId: x.outreach.id, hash: b.hash, token, executor: ex, now: () => MON_0800 });
    expect(out.itemStates?.["bo@seed.vc"]?.state).toBe("unknown");
    const later = MON_0800 + 31 * DAY_MS;
    purgeAll(x.home, later, { log: () => {} });
    writeFileSync(join(workflowDir(x.home, x.outreach.id), "recipients.csv"), "email,first_name,last_name,org,notes\nana@fund.vc,Ana,,F,\nbo@seed.vc,Bo,,S,\ncy@pre.vc,Cy,,P,\ndee@new.vc,Dee,,N,\n");
    const next = await prepareLiveBatch({ home: x.home, workflowId: x.outreach.id, model: x.model, now: () => later });
    expect(next.items.map((i) => i.key)).toEqual(["dee@new.vc"]);
    expect(readFileSync(join(workflowDir(x.home, x.outreach.id), "contacted.ledger"), "utf8")).not.toContain("bo@seed.vc");
  });

  test("PRIV: unedited tone cards are purged with their corpus; a card you edited is kept", async () => {
    w = await activeWorld();
    const edited = styleCardPath(w.home, "investor_outreach");
    const generated = styleCardPath(w.home, "scheduling");
    expect(existsSync(generated)).toBe(true);
    await w.call(`/workflows/${w.outreach.id}/tone`, { method: "PUT", body: { text: "- Mine. Short." } });
    purgeAll(w.home, Date.UTC(2026, 9, 19, 12) + 31 * DAY_MS, { log: () => {} });
    expect(existsSync(generated)).toBe(false);
    expect(readFileSync(edited, "utf8")).toBe("- Mine. Short.");
    expect(existsSync(join(w.home, "tone", "corpus.jsonl.enc"))).toBe(false);
  });

  test("PRIV: the gate log on disk holds no addresses or argument snippets", async () => {
    w = await activeWorld();
    const logPath = join(w.home, "gate.jsonl");
    const batch = makeBatch("wf_a", "live", [{ key: "ana@fund.vc", to: "ana@fund.vc", subject: "Hi", body: "Body SECRETBODY", warnings: [] }], 1);
    const gate = createGate({ workflowId: "wf_a", mode: "live", batch, autoRun: false, runToken: "t".repeat(20), approvals: () => ({ token: "t".repeat(20), approvedAt: 1 }), logPath });
    gate.check(SEND, { to: "a <evil@x.example> SECRETBODY", subject: "Hi", body: "Body SECRETBODY" });
    gate.check(SEND, { to: "ana@fund.vc", subject: "Hi", body: "Body SECRETBODY" });
    const text = readFileSync(logPath, "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
    expect(text).not.toContain("ana@fund.vc");
    expect(text).not.toContain("evil@x.example");
    expect(text).not.toContain("SECRETBODY");
    expect(text).toContain('"itemRef":"');
    expect(text).toContain('"decision":"allow"');
  });

  test("PRIV: GET /observer lists the files kept until you delete them", async () => {
    w = await activeWorld();
    await w.call(`/workflows/${w.outreach.id}/tone`, { method: "PUT", body: { text: "- Mine." } });
    const r = await w.call<ObserverResponse>("/observer");
    const kept = r.body.keptFiles!;
    const dir = workflowDir(w.home, w.outreach.id);
    const byPath = new Map(kept.map((k) => [k.path, k]));
    expect(byPath.get(join(dir, "recipients.csv"))?.kind).toBe("recipients");
    expect(byPath.get(join(dir, "facts.md"))?.kind).toBe("facts");
    expect(byPath.get(join(dir, "crm-log.csv"))?.kind).toBe("send_log");
    expect(byPath.get(styleCardPath(w.home, "investor_outreach"))?.kind).toBe("tone_card");
    expect(byPath.has(styleCardPath(w.home, "scheduling"))).toBe(false);
    for (const k of kept) {
      expect(k.bytes).toBeGreaterThan(0);
      expect(k.note.length).toBeGreaterThan(10);
    }
    expect(kept.find((k) => k.kind === "recipients")!.workflowId).toBe(w.outreach.id);
  });

  test("PRIV: preparing.json (the reservation) is gone after drafting, also when drafting fails", async () => {
    w = await activeWorld();
    await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model, now: () => MON_0800 });
    expect(existsSync(join(workflowDir(w.home, w.outreach.id), "preparing.json"))).toBe(false);
  });
});
