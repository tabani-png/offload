// S2-07 HASH: the broker and the brain produce byte-identical batch hashes for the Stage 1 fixtures (ADR 0105 §3).
// The fixtures are copied verbatim from the brain's own tests (cited per batch); the brain functions are imported
// read-only from brain/src/workflows, the broker path goes fields → Stage 1 item → hash.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { batchHash as brainBatchHash, makeBatch, type BatchItem } from "../../../brain/src/workflows/batch.ts";
import { fromStage1, itemHashOf, itemRef, stage1Hash, toStage1, type Stage2Item } from "../../src/modules/broker/stage1.ts";

// brain/tests/s05-gate/gate.test.ts:16-18
const s05item = (to: string, body = `Hi there,\n\nShort note for ${to}.\n\nMuhammad`): BatchItem => ({ key: to, to, subject: "Offload seed round", body, warnings: [] });
const S05_A = [s05item("anna@northzone.com"), s05item("tom@seedcamp.com")];
const S05_B = [s05item("leo@hustlefund.vc")];
// brain/tests/s13-connector-chain/setup.ts:159-160
const ITEM: BatchItem = { key: "anna@northzone.com", to: "anna@northzone.com", subject: "Seed round: Offload", body: "Hi Anna,\n\nShort note.\n\nMuhammad", warnings: [] };
const ITEM2: BatchItem = { key: "leo@hustlefund.vc", to: "leo@hustlefund.vc", subject: "Seed round: Offload", body: "Hi Leo,\n\nShort note.\n\nMuhammad", warnings: [] };
// brain/tests/s13-connector-chain/gate.test.ts:107-115 (items that carry their commit)
const SAVE_120: BatchItem = { ...ITEM, commit: { verb: "save", fields: [["amount", "120.00"]] } };
const SAVE_121: BatchItem = { ...ITEM, commit: { verb: "save", fields: [["amount", "121.00"]] } };
const INVOICE: BatchItem = { ...ITEM, commit: { verb: "save", fields: [["Invoice number", "INV-7"], ["Amount", "120.00"]] } };
// brain/tests/s16-commit-schemas/cases.ts:23-30 (email and commit items)
const TO = "ana@fund.com";
const s16email = (): BatchItem => ({ key: TO, to: TO, subject: "Seed round follow-up", body: "Hi Ana,\nthe deck is attached in the data room.\nBest, Sam", warnings: [] });
const s16commit = (verb: string, fields: Array<[string, string]>): BatchItem => ({ ...s16email(), commit: { verb, fields } });
const INSTANTLY = s16commit("add_to_campaign", [["campaign_id", "0b6c2f1e-9a3d-4c1b-8e7f-1234567890ab"], ["first_name", "Ana"], ["company_name", "Fund"]]);
const SMARTLEAD = s16commit("send", [["from_email", "sam@startup.io"], ["from_name", "Sam"]]);
const RESUME = s16commit("resume_lead", [["campaign_id", "4411"], ["lead_id", "99812"]]);

const FIXTURES: Array<[name: string, workflowId: string, items: BatchItem[]]> = [
  ["s05 batch A", "wf_a", S05_A],
  ["s05 batch B", "wf_a", S05_B],
  ["s13 ITEM + ITEM2", "wf_test", [ITEM, ITEM2]],
  ["s13 commit save 120", "wf", [SAVE_120]],
  ["s13 commit save 121", "wf", [SAVE_121]],
  ["s13 invoice form", "wf", [INVOICE]],
  ["s16 email", "wf_s16", [s16email()]],
  ["s16 instantly add lead", "wf_s16", [INSTANTLY]],
  ["s16 smartlead send with from_email", "wf_s16", [SMARTLEAD]],
  ["s16 smartlead resume lead", "wf_s16", [RESUME]],
  ["uuid workflow id (Stage 2)", "0b6c2f1e-9a3d-4c1b-8e7f-1234567890ab", [ITEM, SAVE_120, RESUME]],
];

/** What a Stage 2 caller sends for a Stage 1 item. */
const asStage2 = (i: BatchItem, capability = "mail.send"): Stage2Item => ({ key: i.to.toLowerCase(), capability, fields: fromStage1(i) });

const viaBroker = (workflowId: string, items: BatchItem[]) =>
  stage1Hash(
    workflowId,
    items.map((i) => {
      const r = toStage1(asStage2(i));
      if ("reason" in r) throw new Error(r.reason);
      return r.item;
    }),
  );

describe("S2-07 HASH parity with the brain", () => {
  for (const [name, wf, items] of FIXTURES) {
    test(`HASH: ${name}: broker hash is byte-identical to brain batchHash and makeBatch`, () => {
      const broker = viaBroker(wf, items);
      expect(broker).toBe(brainBatchHash(wf, "live", items));
      expect(broker).toBe(makeBatch(wf, "live", items, 0).hash);
      expect(broker).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  test("HASH: an item without a commit hashes exactly as the pre-s13 formula (pinned)", () => {
    const old = createHash("sha256").update(JSON.stringify({ v: 1, workflowId: "wf", kind: "live", items: [[ITEM.to, ITEM.subject, ITEM.body]] })).digest("hex");
    expect(viaBroker("wf", [ITEM])).toBe(old);
  });

  test("HASH: fields round-trip: toStage1(fromStage1(item)) is the item", () => {
    for (const [, , items] of FIXTURES) {
      for (const i of items) {
        const r = toStage1(asStage2(i));
        expect("item" in r && r.item).toEqual({ ...i, key: i.to.toLowerCase(), warnings: [] });
      }
    }
  });

  test("HASH: any changed value, label or order changes the hash", () => {
    const base = viaBroker("wf", [INVOICE]);
    expect(viaBroker("wf", [{ ...INVOICE, subject: `${INVOICE.subject}!` }])).not.toBe(base);
    expect(viaBroker("wf", [{ ...INVOICE, commit: { verb: "save", fields: [["Amount", "120.00"], ["Invoice number", "INV-7"]] } }])).not.toBe(base);
    expect(viaBroker("wf", [{ ...INVOICE, commit: { verb: "submit", fields: INVOICE.commit!.fields } }])).not.toBe(base);
    expect(viaBroker("wf", [ITEM, ITEM2])).not.toBe(viaBroker("wf", [ITEM2, ITEM]));
    expect(viaBroker("wf2", [INVOICE])).not.toBe(base);
  });

  test("HASH: the recipient's case does not change the hash (Stage 1 lowercases it)", () => {
    const upper: BatchItem = { ...ITEM, to: "Anna@NorthZone.com" };
    expect(viaBroker("wf", [upper])).toBe(viaBroker("wf", [ITEM]));
    expect(brainBatchHash("wf", "live", [upper])).toBe(viaBroker("wf", [upper]));
  });

  test("HASH: item hash is the brain hash of the one-item batch; itemRef matches the gate's content-free ref", () => {
    expect(itemHashOf("wf", ITEM)).toBe(brainBatchHash("wf", "live", [ITEM]));
    expect(itemRef("wf_a", "Anna@northzone.com")).toBe(createHash("sha256").update("wf_a\u0000anna@northzone.com").digest("hex").slice(0, 16));
  });

  test("HASH: malformed fields are refused, never guessed", () => {
    const bad = (fields: Array<[string, string]>, key = "a@b.com") => toStage1({ key, capability: "mail.send", fields });
    expect("reason" in bad([["to", "a@b.com"], ["subject", "s"]])).toBe(true);
    expect("reason" in bad([["to", "a@b.com"], ["to", "c@d.com"], ["subject", "s"], ["body", "b"]])).toBe(true);
    expect("reason" in bad([["to", "a@b.com"], ["subject", "s"], ["body", "b"]], "other@b.com")).toBe(true);
    expect("reason" in bad([["to", ""], ["subject", "s"], ["body", "b"]], "")).toBe(true);
    expect("reason" in bad([["to", "a@b.com"], ["subject", "s"], ["body", "b"], ["verb", " "]])).toBe(true);
  });
});
