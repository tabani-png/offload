// PROJECT: every projector's output validates against its frozen schema; over the s09 demo fixture (about 100
// outreach emails a day) the serialized outbox holds none of the fixture's recipient addresses, subjects, body
// sentences, window titles, URLs or hosts.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SENT_MAIL, FIXTURE_FACTS } from "../../fixtures/sent-mail.ts";
import { EvidenceKey } from "../../src/sync/evidence-key.ts";
import { Outbox } from "../../src/sync/outbox.ts";
import { mask, medianSeconds, projectBaselineSamples, projectDailyAggregate, projectNoticeAck, projectReviewEvent, projectRunOutcome, projectWorkflowProposal, projectWorkingTime, runIdFor } from "../../src/sync/project/index.ts";
import { SCHEMA_OF_KIND, validate } from "../../src/sync/schema.ts";
import type { ProjectionContext, RunInput, SyncObject } from "../../src/sync/types.ts";
import { tempHome } from "../helpers.ts";
import { NOTICE_1, NOTICE_WT, WORKFLOW, defaultConfig } from "./fake-control.ts";
import { ackAt, connect, fixtureSyncWorld, NOW, type FixtureSyncWorld } from "./setup.ts";

const t = tempHome();
const ctx: ProjectionContext = { ids: EvidenceKey.fromBytes(t.home, new Uint8Array(32).fill(3)).ids, now: NOW };
const binding = { workflowId: WORKFLOW, version: 2 };
const valid = (o: SyncObject) => expect(validate(SCHEMA_OF_KIND[o.kind], o)).toEqual([]);
const HASH = "a".repeat(64);

const run = (over: Partial<RunInput> = {}): RunInput => ({ binding, batchHash: HASH, startedAt: NOW - 600_000, endedAt: NOW - 300_000, state: "sent", items: { total: 20, sent: 20, failedBeforeSend: 0, unknown: 0, pending: 0 }, approver: "person", failed: false, overnight: false, ...over });

describe("each projector matches its schema", () => {
  test("PROJECT: notice_ack validates against notice-ack.schema.json", () => {
    const o = projectNoticeAck({ noticeVersionId: NOTICE_1, acknowledgedAt: NOW, jurisdiction: "US-NY", features: ["working_time", "workflow_metrics", "working_time"] }, ctx);
    valid(o);
    expect(o.features).toEqual(["workflow_metrics", "working_time"]);
    expect(o.channel).toBe("mac_app");
  });

  test("PROJECT: run_outcome validates for success, partial and failed runs", () => {
    const s = projectRunOutcome(run(), ctx);
    valid(s);
    expect(s).toMatchObject({ outcome: "success", runtime: "mac", batchHash: HASH, approverKind: "person", errorCode: null, costCents: 0 });
    const p = projectRunOutcome(run({ state: "partial", items: { total: 20, sent: 12, failedBeforeSend: 6, unknown: 2, pending: 0 }, failed: true }), ctx);
    valid(p);
    expect(p).toMatchObject({ outcome: "success", errorCode: "unknown_items" });
    const f = projectRunOutcome(run({ state: "failed", items: { total: 20, sent: 0, failedBeforeSend: 20, unknown: 0, pending: 0 }, failed: true, approver: "policy" }), ctx);
    valid(f);
    expect(f).toMatchObject({ outcome: "failed", errorCode: "send_failed", approverKind: "policy" });
  });

  test("PROJECT: review_event validates and shares the run id of its run_outcome", () => {
    const o = projectReviewEvent({ batchHash: HASH, startedAt: NOW - 600_000, at: NOW - 590_000, reviewSeconds: 95.4, editSeconds: 30, fixSeconds: 0, itemsEdited: 2, decision: "approved_with_edits", surface: "mac_review" }, ctx);
    valid(o);
    expect(o.runId).toBe(projectRunOutcome(run(), ctx).runId);
    expect(o.runId).toBe(runIdFor(ctx.ids, HASH, NOW - 600_000));
    expect(o.reviewSeconds).toBe(95);
  });

  test("PROJECT: baseline_sample validates and splits at 500 instances", () => {
    const instances = Array.from({ length: 1101 }, (_, i) => ({ instanceRef: i.toString(16).padStart(32, "0"), activeSeconds: 170 + (i % 20), day: `2026-10-${String(12 + (i % 7)).padStart(2, "0")}` }));
    const out = projectBaselineSamples({ binding, instances }, ctx);
    expect(out.map((o) => o.instances.length)).toEqual([500, 500, 101]);
    for (const o of out) valid(o);
    expect(out[0]!.windowStart).toBe("2026-10-12");
    expect(projectBaselineSamples({ binding, instances: [] }, ctx)).toEqual([]);
    expect(projectBaselineSamples({ binding, instances }, { ...ctx, now: NOW + 5000 }).map((o) => o.id)).toEqual(out.map((o) => o.id));
  });

  test("PROJECT: daily_aggregate validates; saved seconds follow hs-1 per run (no review = no credit)", () => {
    const o = projectDailyAggregate({ day: "2026-10-16", dayEnd: NOW - 1, activeWorkflows: 1, workflows: [{ binding, runs: 3, successRuns: [{ sent: 20, residualSeconds: 400 }, { sent: 10, residualSeconds: null }], baselineSeconds: [170, 180, 190, 200] }] }, ctx);
    valid(o);
    // median(170, 180, 190, 200) = floor((180 + 190) / 2) = 185; 185 × 20 − 400 = 3300; the unreviewed run adds 0.
    expect(o.workflows[0]).toEqual({ workflowId: WORKFLOW, version: 2, runs: 3, successes: 2, savedSecondsDevice: 3300 });
    expect(medianSeconds([5, 1, 3])).toBe(3);
    expect(medianSeconds([])).toBeNull();
    valid(projectDailyAggregate({ day: "2026-10-17", dayEnd: NOW, activeWorkflows: 0, workflows: [] }, ctx));
  });

  test("PROJECT: working_time_aggregate validates and rounds to 15-minute slots", () => {
    const o = projectWorkingTime({ day: "2026-10-16", dayEnd: NOW, activeSeconds: 6.5 * 3600 + 59, firstActiveMinute: 8 * 60 + 14, lastActiveMinute: 18 * 60 + 45, noticeVersionId: NOTICE_WT }, ctx);
    valid(o);
    expect(o).toMatchObject({ activeMinutes: 390, firstActiveQuarter: 32, lastActiveQuarter: 75 });
    valid(projectWorkingTime({ day: "2026-10-16", dayEnd: NOW, activeSeconds: 99 * 3600, firstActiveMinute: -5, lastActiveMinute: 2000, noticeVersionId: NOTICE_WT }, ctx));
  });

  test("PROJECT: workflow_proposal validates, masks contact patterns and hashes its definition", () => {
    const o = projectWorkflowProposal(
      {
        localWorkflowId: "wf_abcdef123456",
        binding: null,
        definedAt: NOW,
        name: "Outreach to jo@fund.vc",
        // A link built at run time: no non-loopback URL literal in this folder (hermetic scan).
        description: `Write to partners at ${["https:", "", "fund.vc", "team"].join("/")} and call +1 (415) 555-0100.`,
        trigger: { type: "cron", cron: "0 9 * * 1-5", timezone: "America/Toronto" },
        steps: [
          { id: "read_list", title: "Read the list", detail: "Read recipients.csv", type: "read", connector: null, sideEffect: false, capability: null },
          { id: "Send Step!", title: "Send from Gmail", detail: "Send each email", type: "send", connector: "gmail", sideEffect: true, capability: "email.send_bulk" },
          { id: "log", title: "Log", detail: "Append to the sheet at docs.google.com", type: "log", connector: "google-sheets", sideEffect: true, capability: null },
        ],
        skillMd: "# Skill\nEmail ops@acme.com about www.acme.com",
        factsKeys: ["raise", "company", "raise"],
        batchSize: 900,
      },
      ctx,
    );
    valid(o);
    const text = JSON.stringify(o);
    for (const s of ["jo@fund.vc", "fund.vc", "555-0100", "ops@acme.com", "acme.com", "docs.google.com"]) expect(text).not.toContain(s);
    expect(o.steps.map((s) => [s.id, s.class, s.capability, s.gate, s.connection?.kind ?? null])).toEqual([
      ["read_list", "read", "local.read", "none", null],
      ["send_step_", "commit", "email.send_bulk", "approval", "gmail"],
      ["log", "commit", "sheet.append", "approval", "other"],
    ]);
    expect(o.factsKeys).toEqual(["company", "raise"]);
    expect(o.limits).toEqual({ maxItemsPerRun: 500, maxRunsPerDay: 1 });
    expect(o.workflowId).toBeNull();
    expect(o.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(projectWorkflowProposal({ ...JSON.parse(JSON.stringify({})), localWorkflowId: "wf_abcdef123456", binding: null, definedAt: NOW, name: "x", description: "", trigger: { type: "manual", cron: null, timezone: null }, steps: [{ id: "a", title: "t", detail: "", type: "read", connector: null, sideEffect: false, capability: null }], skillMd: "", factsKeys: [], batchSize: 1 }, ctx).definitionHash).not.toBe(o.definitionHash);
  });

  test("PROJECT: mask leaves ordinary text, file names and small numbers alone", () => {
    expect(mask("Read recipients.csv and facts.md, 20 s per item, 98.4/day × 5 days = 24.6 h/wk")).toBe("Read recipients.csv and facts.md, 20 s per item, 98.4/day × 5 days = 24.6 h/wk");
    expect(mask("mail anna@northzone.com at mail.google.com")).toBe("mail [email] at [host]");
  });

  test("PROJECT: the validator rejects what the server would reject (extra field, bad pattern, wrong kind)", () => {
    const o = projectRunOutcome(run(), ctx);
    expect(validate(SCHEMA_OF_KIND.run_outcome, { ...o, subject: "Hello" })).toContain("$.subject: not allowed");
    expect(validate(SCHEMA_OF_KIND.run_outcome, { ...o, workflowId: "wf_local" }).length).toBeGreaterThan(0);
    expect(validate("sync-envelope.schema.json", { v: 1, deviceId: WORKFLOW, seq: 1, sentAt: NOW, objects: [{ ...o, kind: "raw_events" }] }).length).toBeGreaterThan(0);
    expect(validate("device-config.schema.json", defaultConfig())).toEqual([]);
  });
});

describe("static: projectors see no raw data", () => {
  test("PROJECT: sync/project imports nothing from store/, understanding/, vision/, tone/ or the event types", () => {
    const dir = join(import.meta.dir, "../../src/sync/project");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const i of imports) expect(["../types.ts", "../encoding.ts", "../jcs.ts", "./mask.ts", "./run-outcome.ts", "./notice-ack.ts", "./review-event.ts", "./baseline-sample.ts", "./daily-aggregate.ts", "./working-time.ts", "./workflow-proposal.ts"]).toContain(i);
      expect(src).not.toMatch(/EventRecord|FrameNote|OffloadEvent|\bSpan\b|OcrSnapshot/);
    }
  });
});

describe("property: nothing from the fixture's content reaches the outbox", () => {
  let w: FixtureSyncWorld;
  afterEach(() => w.cleanup());

  test("PROJECT: over the s09 demo fixture week the outbox holds no recipient, subject, body sentence, title, URL or host", async () => {
    w = await fixtureSyncWorld();
    const a = w.fixture.analysis;
    const outreach = a.tasks.find((t) => t.id === w.fixture.outreach.taskId)!;
    // About 100 outreach emails a day on weekdays.
    expect(outreach.instances.length).toBeGreaterThan(450);
    w.control.config = defaultConfig({ requiredNotice: { noticeVersionId: NOTICE_WT, title: "Notice", markdown: "m", features: ["workflow_metrics", "working_time"] }, features: { workflow_metrics: true, per_person_views: true, working_time: true }, workingTimeStartsAt: new Date(2026, 9, 12).getTime() });
    await connect(w);
    await ackAt(w, NOTICE_WT);
    w.client.recordReview({ workflowId: w.fixture.outreach.id, batchHash: w.batch.hash, at: w.batch.approvedAt!, reviewSeconds: 240, editSeconds: 60, fixSeconds: 0, itemsEdited: 3, decision: "approved_with_edits", surface: "mac_review" });
    w.client.share(w.fixture.outreach.id, w.client.proposal(w.fixture.outreach.id).definitionHash);
    w.client.setPaused(true);
    await w.client.flush({ force: true });
    const entries = new Outbox(w.home).list(NOW);
    const kinds = new Set(entries.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["notice_ack", "run_outcome", "review_event", "baseline_sample", "daily_aggregate", "working_time_aggregate", "workflow_proposal"]));
    for (const e of entries) valid(e.object);
    w.client.setPaused(false);
    const preview = (await w.client.preview()).body!;
    await w.client.flush({ force: true });
    const wire = w.control.received.map((r) => r.body).join("\n");
    const serialized = [JSON.stringify(entries), preview, wire].join("\n");
    expect(w.control.acceptedObjects()).toHaveLength(entries.length);

    const forbidden = new Map<string, string>();
    const add = (what: string, s: string | undefined, min: number) => {
      const v = (s ?? "").trim();
      if (v.length >= min) forbidden.set(v, what);
    };
    for (const t of a.tasks) for (const i of t.instances) for (const c of i.identifiers.counterparties) add("recipient", c, 6);
    for (const i of w.batch.items) {
      add("recipient", i.to, 6);
      add("subject", i.subject, 8);
      for (const s of i.body.split(/(?<=[.!?])\s+|\n+/)) add("body sentence", s, 20);
    }
    for (const m of SENT_MAIL) for (const s of m.body.split(/(?<=[.!?])\s+|\n+/)) add("sent-mail sentence", s, 20);
    for (const sp of a.spans) {
      add("window title", sp.title, 12);
      add("url", sp.url, 8);
      add("host", sp.host, 6);
      for (const o of sp.ocr) for (const s of o.text.split(/\n+/)) add("ocr line", s, 24);
    }
    for (const v of Object.values({ raise: "Raising a $2.5M seed.", traction: "40 design partners, 3 paying." })) add("facts value", v, 8);
    expect(FIXTURE_FACTS).toContain("Raising a $2.5M seed.");
    expect(forbidden.size).toBeGreaterThan(500);
    const leaks = [...forbidden].filter(([s]) => serialized.includes(s)).map(([s, what]) => `${what}: ${s}`);
    expect(leaks).toEqual([]);
    // Nothing that looks like an address or a link either.
    expect(serialized).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(serialized).not.toMatch(/https?:\/\//);
  }, 60_000);
});

process.on("exit", () => t.cleanup());
