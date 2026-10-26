import { describe, expect, test } from "bun:test";
import { PERSON_COLUMNS } from "../../src/modules/compliance/selfview.ts";

// Product rule (manager, PR #16): the employee sees every row where they are the subject; a column that names another
// person who acted (assigned, closed, requested) is listed with a reason instead of the actor's identity.
const by = (t: string, c: string) => PERSON_COLUMNS.find((r) => r.table === t && r.column === c);

describe("AUDIT", () => {
  test("AUDIT: self-view registry: the leaver's own S2-10 rows (hand-overs, successor, offboarding, removed connections) are shown", () => {
    for (const [t, c] of [
      ["handovers", "person_id"],
      ["handovers", "successor_person_id"],
      ["offboardings", "person_id"],
      ["removed_connections", "person_id"],
    ] as const) {
      expect(by(t, c)).toMatchObject({ shownIn: "accessLog", slice: "S2-10" });
    }
  });

  test("AUDIT: self-view registry: actor columns are listed with a reason, not shown as another person's identity", () => {
    for (const [t, c] of [
      ["handovers", "assigned_by"],
      ["handovers", "closed_by"],
      ["offboardings", "requested_by"],
    ] as const) {
      const r = by(t, c);
      expect(r).toMatchObject({ shownIn: null, slice: "S2-10" });
      expect(r!.reason).toMatch(/identifies the actor, not you/);
    }
  });
});
