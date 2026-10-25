// AC-4 INDUCE: step clusters, links by identifiers and transitions, instances by identifiers and the loop model.
import { describe, expect, test } from "bun:test";
import type { SpanDescription } from "../../src/understanding/describe.ts";
import { StubEmbedder } from "../../src/understanding/embed.ts";
import { induceTasks, type Induction } from "../../src/understanding/induce.ts";
import { desc } from "./setup.ts";

const stub = new StubEmbedder();
const run = (ds: readonly SpanDescription[]): Induction => induceTasks(ds, (d) => stub.embedOne(d.text));
const taskOf = (ind: Induction, d: SpanDescription) => ind.tasks.find((t) => t.spans.some((s) => s.spanId === d.spanId))!;

const PDF = { app: "com.apple.Preview", host: "", urlPattern: "", verb: "read", object: "invoice", surface: "Preview PDF viewer", category: "other" as const };
const XERO = { host: "go.xero.com", urlPattern: "/AccountsPayable/Edit.aspx", template: "New Bill | Xero", verb: "enter", object: "bill", surface: "Xero new bill form" };
const SLACK = { app: "com.tinyspeck.slackmacgap", host: "", urlPattern: "", template: "#general (Channel) - Org - Slack", verb: "read", object: "message", surface: "Slack channel", category: "chat" as const };

/** n invoices: PDF then Xero, sharing the invoice number; a Slack visit after every third. */
function invoices(n: number, opts: { ids?: boolean; slack?: boolean; day?: string; startAt?: number } = {}): SpanDescription[] {
  const out: SpanDescription[] = [];
  let t = opts.startAt ?? 0;
  for (let i = 0; i < n; i++) {
    const id = `inv-${10000 + i}`;
    out.push(desc({ ...PDF, at: t, dur: 40, template: `INV-<n> Supplier ${i % 3}.pdf`, title: `INV-${10000 + i}.pdf`, identifiers: opts.ids === false ? [] : [id], ...(opts.day === undefined ? {} : { day: opts.day }) }));
    out.push(desc({ ...XERO, at: t + 40, dur: 90, identifiers: opts.ids === false ? [] : [id], ...(opts.day === undefined ? {} : { day: opts.day }) }));
    t += 130;
    if (opts.slack === true && i % 3 === 2) {
      out.push(desc({ ...SLACK, at: t + 5, dur: 60, ...(opts.day === undefined ? {} : { day: opts.day }) }));
      t += 70;
    }
  }
  return out;
}

describe("INDUCE steps", () => {
  test("descriptions with one surface, verb and object are one step; another app is another step", () => {
    const ind = run(invoices(6));
    expect(ind.steps.length).toBe(2);
    expect(new Set(ind.steps.map((s) => s.members.length))).toEqual(new Set([6]));
  });

  test("wording differences on the same screen merge into one step (global merge)", () => {
    const ds = [
      ...Array.from({ length: 4 }, (_, i) => desc({ ...XERO, at: i * 100, verb: "enter", object: "bill", activity: "Keying a supplier bill into Xero" })),
      ...Array.from({ length: 4 }, (_, i) => desc({ ...XERO, at: 1000 + i * 100, verb: "key in", object: "bill", activity: "Keying a supplier bill into Xero" })),
      ...Array.from({ length: 4 }, (_, i) => desc({ ...XERO, day: "2026-10-13", at: i * 100, verb: "enter", object: "supplier bill", activity: "Copying invoice details into the Xero bill form" })),
    ];
    expect(run(ds).steps.length).toBe(1);
  });

  test("a vague description (low confidence) joins the main step on its screen", () => {
    const ds = invoices(5);
    ds.push(desc({ ...XERO, at: 2000, verb: "view", object: "screen", activity: "Looking at the screen", confidence: 0.3 }));
    const ind = run(ds);
    expect(ind.steps.length).toBe(2);
    expect(ind.tasks.length).toBe(1);
  });
});

describe("INDUCE tasks", () => {
  test("shared item identifiers link steps in different apps into one task; Slack noise stays apart", () => {
    const ds = invoices(9, { slack: true });
    const ind = run(ds);
    const inv = taskOf(ind, ds[0]!);
    expect(inv.steps.length).toBe(2);
    expect(inv.instances.length).toBe(9);
    const slack = ds.find((d) => d.app === SLACK.app)!;
    expect(taskOf(ind, slack)).not.toBe(inv);
  });

  test("without identifiers, a step that reliably follows another links by transition", () => {
    const ind = run(invoices(8, { ids: false }));
    expect(ind.tasks.length).toBe(1);
    expect(ind.tasks[0]!.steps.length).toBe(2);
  });

  test("a rare follower is not linked (both sides must see the transition)", () => {
    const ds: SpanDescription[] = [];
    // 8 invoices a day for 5 days, then a reconciliation screen right after the last bill: always after Xero (5/5),
    // but rare for Xero (5/40).
    for (let k = 0; k < 5; k++) {
      const day = `2026-10-1${2 + k}`;
      ds.push(...invoices(8, { day }));
      ds.push(desc({ host: "go.xero.com", urlPattern: "/Bank/BankRec.aspx", template: "Reconcile | Xero", verb: "match", object: "bank transaction", surface: "Xero bank reconciliation", at: 8 * 130 + 5, day }));
    }
    const ind = run(ds);
    const rec = ds[ds.length - 1]!;
    expect(taskOf(ind, rec)).not.toBe(taskOf(ind, ds[0]!));
    expect(taskOf(ind, ds[0]!).instances.length).toBe(40);
  });
});

describe("INDUCE instances and loop model", () => {
  test("a new item on a screen already in the instance starts a new instance; the same item again joins", () => {
    const ds = invoices(4);
    // Back to the bill of the last invoice after a short check: same item, same instance.
    ds.push(desc({ ...XERO, at: 4 * 130 + 10, dur: 30, identifiers: ["inv-10003"] }));
    const t = run(ds).tasks[0]!;
    expect(t.instances.length).toBe(4);
    expect(t.instances.map((i) => i.reason)).toEqual(["first", "new_item", "new_item", "new_item"]);
    expect(t.instances[3]!.spans.length).toBe(3);
  });

  test("loop model: the start step recurring with a new item restarts, even when ids overlap (sheet rows)", () => {
    const ds: SpanDescription[] = [];
    const SHEET = { host: "docs.google.com", urlPattern: "/spreadsheets/d/<id>/edit", template: "Leads - Google Sheets", verb: "update", object: "lead row", surface: "Google Sheets lead list", category: "sheet" as const };
    const LI = { host: "www.linkedin.com", urlPattern: "/in/<slug>/", template: "<*> | LinkedIn", verb: "look up", object: "lead profile", surface: "LinkedIn profile page", category: "social" as const };
    for (let i = 0; i < 10; i++) {
      // Each sheet span types the previous row and reads the next: its ids overlap the previous instance.
      ds.push(desc({ ...SHEET, at: i * 100, dur: 30, identifiers: i === 0 ? [`row ${i}`] : [`row ${i - 1}`, `row ${i}`] }));
      ds.push(desc({ ...LI, at: i * 100 + 30, dur: 50, identifiers: ["acme"] }));
    }
    const t = run(ds).tasks[0]!;
    expect(t.steps.length).toBe(2);
    expect(t.instances.length).toBe(10);
    expect(t.startStep).toBe(t.steps.find((s) => s.cluster.surfaces.has("google sheets lead list"))!.cluster.id);
    expect(t.steps.every((s) => s.core && Math.abs(s.perInstance - 1) < 1e-9)).toBe(true);
  });

  test("a new day and a long gap split instances", () => {
    const ds = [...invoices(2, { ids: false }), ...invoices(2, { ids: false, startAt: 3600 }), ...invoices(2, { ids: false, day: "2026-10-13" })];
    const t = run(ds).tasks[0]!;
    expect(t.instances.map((i) => i.reason)).toEqual(["first", "loop_restart", "gap", "loop_restart", "new_day", "loop_restart"]);
  });

  test("optional steps are not core; the loop lists core steps in order", () => {
    const ds = invoices(10);
    // Every fourth invoice also gets a supplier lookup in between (shares the invoice id).
    for (let i = 0; i < 10; i += 4) ds.push(desc({ host: "go.xero.com", urlPattern: "/Contacts/View", template: "Supplier | Xero", verb: "look up", object: "supplier", surface: "Xero contact", at: i * 130 + 39, dur: 1, identifiers: [`inv-${10000 + i}`] }));
    const t = run(ds).tasks.find((x) => x.spans.length > 20)!;
    const lookup = t.steps.find((s) => s.cluster.surfaces.has("xero contact"))!;
    expect(lookup.core).toBe(false);
    expect(t.steps.filter((s) => s.core).map((s) => [...s.cluster.surfaces.keys()][0])).toEqual(["preview pdf viewer", "xero new bill form"]);
  });

  test("deterministic: the same descriptions give the same tasks, steps and instance ids", () => {
    const ds = invoices(9, { slack: true });
    const a = run(ds);
    const b = run(ds);
    const shape = (x: Induction) => x.tasks.map((t) => [t.signature, t.startStep, t.instances.map((i) => i.id)]);
    expect(shape(a)).toEqual(shape(b));
  });
});
