// s18 x s19 (merge of PR #7): a contact s18 registers (any workflow's recipients.csv) and the user's own name
// (privacy.json) are in the s19 identity, so the playbook's leak check and masking catch them. Failed before its fix.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { identityForWorkflow } from "../../src/playbook/build.ts";
import { findTextLeaks } from "../../src/playbook/leak.ts";
import { maskText } from "../../src/playbook/mask.ts";
import { PlaybookLeakError } from "../../src/playbook/leak.ts";
import { setPlaybookNotes, writePlaybook } from "../../src/playbook/store.ts";
import { NameMap } from "../../src/privacy/names.ts";
import { readNamePolicy } from "../../src/privacy/policy.ts";
import { build, founderPersona, NOW, world, type World } from "./setup.ts";

const NONE = new Set<string>();

describe("s19 x s18: the contact registry joins the playbook identity", () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
    // A contact in ANOTHER workflow's list, with names no lexicon or greeting would find; one named like a common word.
    mkdirSync(join(w.home, "workflows", "wf_other1"), { recursive: true });
    writeFileSync(join(w.home, "workflows", "wf_other1", "recipients.csv"), "email,first_name,last_name,org,notes\nzquellin@kestrel.io,Zorblax,Quéllin,Kestrel,\nwill.short@ardent.vc,Will,Short,Ardent,\n");
    writeFileSync(join(w.home, "privacy.json"), JSON.stringify({ ownName: "Muhammad Ali" }));
  });
  afterAll(() => w.cleanup());

  test("KNOWN: every name s18 masks for a contact is a leak for s19, and is masked by s19", () => {
    const id = identityForWorkflow(w.home, w.outreach, NOW);
    const names = new NameMap(readNamePolicy(w.home));
    for (const t of ["Ask Zorblax for an intro.", "Mention Quéllin first.", "Write like zorblax does.", "Ask Will for an intro.", "Sign as Muhammad."]) {
      // s18 masks it on the way to a model ...
      expect([t, names.mask(t) !== t]).toEqual([t, true]);
      // ... and s19 refuses it in a playbook and masks it in a message.
      expect([t, findTextLeaks(t, id, NONE, "notes").length > 0]).toEqual([t, true]);
      expect([t, maskText(t, id) !== t]).toEqual([t, true]);
    }
    // s18 masks people only; the contact's organisation (address domain) is a known contact for s19 as well.
    expect(findTextLeaks("Copy the Kestrel tone, like kestrel does.", id, NONE, "notes").length).toBeGreaterThan(0);
    // Ordinary wording stays clean.
    expect(findTextLeaks("We will keep it short.", id, NONE, "notes")).toEqual([]);
  });

  test("LEAK: a notes edit naming a registered contact is refused", async () => {
    const pb = { ...(await build(await founderPersona())).playbook, workflowId: w.outreach.id };
    writePlaybook(w.home, pb);
    expect(() => setPlaybookNotes(w.home, w.outreach.id, "Ask Zorblax for an intro.", identityForWorkflow(w.home, w.outreach, NOW), NOW)).toThrow(PlaybookLeakError);
  });
});
