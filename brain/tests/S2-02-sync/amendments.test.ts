// ADR 0111 (wave A contract amendments) and the wave A review's LOW items for S2-02:
//   §3 consent is forward-only: nothing observed before the acknowledgement time leaves the Mac; no required notice in
//      the config = only notice_ack may be sent (fail closed);
//   §4 a run outcome's object id is derived from runId only; updates to the same run reuse it with a higher seq;
//   LOW: host masking without a fixed TLD list; share confirm needs the preview hash; ref purges write a purge-log line.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createBrain } from "../../src/api/server.ts";
import { StubModel } from "../../src/models/model.ts";
import { localDay } from "../../src/store/vault.ts";
import { startLoopback } from "../../src/sync/enroll.ts";
import { PKCE_VERIFIER_HEADER } from "../../src/sync/http.ts";
import { consentStartsAt, decide, noticeSatisfied, type ConsentState } from "../../src/sync/consent.ts";
import { EvidenceKey, purgeRefs } from "../../src/sync/evidence-key.ts";
import { mask, projectRunOutcome, runIdFor, runOutcomeIdFor } from "../../src/sync/project/index.ts";
import { saveBatch } from "../../src/workflows/store.ts";
import { SYNC_KINDS, type ProjectionContext, type RunInput, type SyncObject } from "../../src/sync/types.ts";
import { tempHome } from "../helpers.ts";
import { defaultConfig, NOTICE_1, NOTICE_WT, WORKFLOW } from "./fake-control.ts";
import { ackAt, browser, connect, fixtureSyncWorld, loopbackFetch, NOW, type FixtureSyncWorld } from "./setup.ts";

const DAY_MS = 86_400_000;
const acked = [{ noticeVersionId: NOTICE_1, acknowledgedAt: NOW - DAY_MS, features: ["workflow_metrics" as const] }];
const state = (over: Partial<ConsentState> = {}): ConsentState => ({ config: defaultConfig(), acks: acked, paused: false, now: NOW, ...over });

const sentOf = (w: FixtureSyncWorld) => w.control.acceptedObjects() as SyncObject[];

describe("ADR 0111 §1: loopback PKCE enrollment", () => {
  test("ENROLL: the login URL, callback, code bounds, error param and verifier header follow ADR 0111 §1", async () => {
    expect(PKCE_VERIFIER_HEADER).toBe("Offload-Code-Verifier");
    const control = "http://127.0.0.1:9";
    const flows: Array<ReturnType<typeof startLoopback>> = [];
    const open = () => {
      const f = startLoopback(control, { timeoutMs: 5_000 });
      flows.push(f);
      const u = new URL(f.authorizeUrl);
      return { f, u, state: u.searchParams.get("state")! };
    };
    try {
      const { f, u, state } = open();
      expect(`${u.origin}${u.pathname}`).toBe(`${control}/auth/login`);
      expect([...u.searchParams.keys()].sort()).toEqual(["client", "code_challenge", "code_challenge_method", "redirect_uri", "state"]);
      expect(u.searchParams.get("client")).toBe("offload-mac");
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      expect(f.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      expect(u.searchParams.get("redirect_uri")).toBe(f.redirectUri);
      // A code is 16..64 characters (device-enrollment.schema.json): a 15-character one ends the flow.
      expect((await loopbackFetch(`${f.redirectUri}?code=${"c".repeat(15)}&state=${state}`)).status).toBe(400);
      await expect(f.code).rejects.toThrow();
      const ok = open();
      expect((await loopbackFetch(`${ok.f.redirectUri}?code=${"c".repeat(64)}&state=${ok.state}`)).status).toBe(200);
      expect(await ok.f.code).toBe("c".repeat(64));
      // The control plane's `?error=<reason>&state=<s>` ends the flow with that reason.
      const bad = open();
      expect((await loopbackFetch(`${bad.f.redirectUri}?error=access_denied&state=${bad.state}`)).status).toBe(400);
      await expect(bad.f.code).rejects.toThrow("access_denied");
    } finally {
      for (const f of flows) f.close();
    }
  });
});

describe("ADR 0111 §3: consent is forward-only", () => {
  let w: FixtureSyncWorld | null = null;
  afterEach(async () => {
    await w?.cleanup();
    w = null;
  });

  test("CONSENT: a config with no required notice lets nothing but notice_ack leave, even with acks on file", () => {
    const s = state({ config: defaultConfig({ requiredNotice: null }) });
    expect(noticeSatisfied(s)).toBe(false);
    expect(consentStartsAt(s)).toBeNull();
    for (const k of SYNC_KINDS) expect(decide(k, s, { confirmed: true })).toBe(k === "notice_ack" ? "send" : k === "working_time_aggregate" ? "drop" : "hold");
  });

  test("CONSENT: consent starts at the acknowledgement time of the required notice, not at its day", () => {
    expect(consentStartsAt(state())).toBe(NOW - DAY_MS);
    expect(consentStartsAt(state({ acks: [] }))).toBeNull();
    // An ack of another notice version does not count.
    expect(consentStartsAt(state({ acks: [{ noticeVersionId: NOTICE_WT, acknowledgedAt: NOW - 9 * DAY_MS, features: ["workflow_metrics"] }] }))).toBeNull();
  });

  test("CONSENT: end to end, a tenant with no required notice receives nothing from this Mac", async () => {
    w = await fixtureSyncWorld();
    w.control.config = defaultConfig({ requiredNotice: null });
    await connect(w);
    const r = await w.client.flush({ force: true });
    expect(r.envelopes).toBe(0);
    expect(w.control.received).toEqual([]);
    expect(r.held).toBe(0);
  });

  test("CONSENT: nothing observed before the ack leaves: run outcomes, reviews, baselines and daily rows start at the ack time", async () => {
    w = await fixtureSyncWorld();
    await connect(w);
    // The fixture's batch was approved at 14:59 local on 2026-10-16 and sent from 15:00. Ack at 13:00 that day.
    const ack = new Date(2026, 9, 16, 13, 0).getTime();
    await ackAt(w, NOTICE_1, ack);
    await w.client.flush({ force: true });
    const sent = sentOf(w);
    const kinds = new Set(sent.map((o) => o.kind));
    expect(kinds).toEqual(new Set(["notice_ack", "run_outcome", "baseline_sample", "daily_aggregate"]));
    // Daily rows: only the ack day and later (2026-10-16..18 are complete at NOW).
    const days = sent.flatMap((o) => (o.kind === "daily_aggregate" ? [o.day] : [])).sort();
    expect(days).toEqual(["2026-10-16", "2026-10-17", "2026-10-18"]);
    // Baselines: exactly the refs of instances that started at or after the ack.
    const ev = EvidenceKey.load(w.home, { create: false })!;
    const taskId = w.fixture.outreach.taskId;
    const task = w.fixture.analysis.tasks.find((t) => t.id === taskId)!;
    const after = new Set(task.instances.filter((i) => i.start >= ack).map((i) => ev.ref(i.id)));
    const before = new Set(task.instances.filter((i) => i.start < ack).map((i) => ev.ref(i.id)));
    expect(after.size).toBeGreaterThan(0);
    expect(before.size).toBeGreaterThan(0);
    const refs = sent.flatMap((o) => (o.kind === "baseline_sample" ? o.instances.map((i) => i.instanceRef) : []));
    expect(new Set(refs)).toEqual(after);
    for (const r of refs) expect(before.has(r)).toBe(false);
    // The ack-day row counts only post-ack instances.
    const row16 = sent.find((o) => o.kind === "daily_aggregate" && o.day === "2026-10-16");
    expect(row16).toBeDefined();
  });

  test("CONSENT: a run that started before the ack never leaves, nor its review", async () => {
    w = await fixtureSyncWorld();
    await connect(w);
    await ackAt(w, NOTICE_1, new Date(2026, 9, 16, 16, 0).getTime());
    await w.client.flush({ force: true });
    const kinds = new Set(sentOf(w).map((o) => o.kind));
    expect(kinds.has("run_outcome")).toBe(false);
    expect(kinds.has("review_event")).toBe(false);
    // The ack day still has a row, built only from what happened after the ack (no run, so no workflow row).
    const rows = sentOf(w).flatMap((o) => (o.kind === "daily_aggregate" ? [o] : []));
    expect(rows.map((o) => o.day).sort()).toEqual(["2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(rows.find((o) => o.day === "2026-10-16")!.workflows).toEqual([]);
  });

  test("CONSENT: working time starts at the ack too, also when the notice period ended earlier", async () => {
    w = await fixtureSyncWorld();
    w.control.config = defaultConfig({
      requiredNotice: { noticeVersionId: NOTICE_WT, title: "Working time", markdown: "m", features: ["workflow_metrics", "working_time"] },
      features: { workflow_metrics: true, per_person_views: false, working_time: true },
      workingTimeStartsAt: new Date(2026, 9, 12).getTime(),
    });
    await connect(w);
    const ack = new Date(2026, 9, 16, 13, 0).getTime();
    await ackAt(w, NOTICE_WT, ack);
    await w.client.flush({ force: true });
    const wt = sentOf(w).flatMap((o) => (o.kind === "working_time_aggregate" ? [o] : []));
    expect(wt.length).toBeGreaterThan(0);
    for (const o of wt) expect(o.day >= localDay(ack)).toBe(true);
    // On the ack day the first active slot is not before the ack (13:00 = quarter 52).
    const d16 = wt.find((o) => o.day === "2026-10-16");
    expect(d16).toBeDefined();
    expect(d16!.firstActiveQuarter).toBeGreaterThanOrEqual(52);
  });
});

describe("ADR 0111 §4: run outcome identity", () => {
  const t = tempHome();
  const ctx: ProjectionContext = { ids: EvidenceKey.fromBytes(t.home, new Uint8Array(32).fill(7)).ids, now: NOW };
  const HASH = "b".repeat(64);
  const run = (over: Partial<RunInput> = {}): RunInput => ({ binding: { workflowId: WORKFLOW, version: 1 }, batchHash: HASH, startedAt: NOW - 600_000, endedAt: NOW - 300_000, state: "partial", items: { total: 20, sent: 12, failedBeforeSend: 0, unknown: 0, pending: 8 }, approver: "person", failed: false, overnight: false, ...over });

  test("PROJECT: a run outcome's id is a function of its runId alone; later states of the run keep it", () => {
    const a = projectRunOutcome(run(), ctx);
    const b = projectRunOutcome(run({ state: "sent", endedAt: NOW, items: { total: 20, sent: 20, failedBeforeSend: 0, unknown: 0, pending: 0 } }), ctx);
    expect(a.runId).toBe(b.runId);
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(runOutcomeIdFor(ctx.ids, a.runId));
    expect(a.id).not.toBe(a.runId);
    // Another run (another start) is another id.
    const c = projectRunOutcome(run({ startedAt: NOW - 700_000 }), ctx);
    expect(c.runId).not.toBe(a.runId);
    expect(c.id).not.toBe(a.id);
    expect(runIdFor(ctx.ids, HASH, NOW - 600_000)).toBe(a.runId);
  });

  test("PROJECT: a run that progresses is re-sent under the same id with a higher seq; an unchanged run is not", async () => {
    const w = await fixtureSyncWorld();
    try {
      // The run first ends partial: 12 of 20 sent.
      const b = w.batch;
      const keys = b.items.map((i) => i.key);
      const late = new Set(keys.slice(12));
      const full = { itemStates: b.itemStates, results: b.results };
      b.state = "partial";
      b.itemStates = Object.fromEntries(Object.entries(b.itemStates!).map(([k, v]) => [k, late.has(k) ? { ...v, state: "failed_before_send" as const } : v]));
      b.results = b.results.filter((r) => !late.has(r.key));
      saveBatch(w.home, b);
      await connect(w);
      await ackAt(w, NOTICE_1, new Date(2026, 9, 12).getTime());
      await w.client.flush({ force: true });
      const first = w.control.received.flatMap((r) => r.envelope.objects.flatMap((o) => (o.kind === "run_outcome" ? [{ o, seq: r.envelope.seq }] : [])));
      expect(first).toHaveLength(1);
      expect(first[0]!.o.kind === "run_outcome" && first[0]!.o.items.sent).toBe(12);
      // Nothing changed: the next flush does not repeat it.
      w.clock.now += 60_000;
      await w.client.flush({ force: true });
      expect(w.control.received.flatMap((r) => r.envelope.objects).filter((o) => o.kind === "run_outcome")).toHaveLength(1);
      // The rest is retried and sent: same run, same object id, a higher seq.
      b.state = "sent";
      b.itemStates = full.itemStates;
      b.results = full.results;
      saveBatch(w.home, b);
      w.clock.now += 60_000;
      await w.client.flush({ force: true });
      const all = w.control.received.flatMap((r) => r.envelope.objects.flatMap((o) => (o.kind === "run_outcome" && r.receipt?.accepted.includes(o.id) ? [{ o, seq: r.envelope.seq }] : [])));
      expect(all).toHaveLength(2);
      const [x, y] = all as [{ o: Extract<SyncObject, { kind: "run_outcome" }>; seq: number }, { o: Extract<SyncObject, { kind: "run_outcome" }>; seq: number }];
      expect(y.o.id).toBe(x.o.id);
      expect(y.o.runId).toBe(x.o.runId);
      expect(y.seq).toBeGreaterThan(x.seq);
      expect(y.o.items.sent).toBe(20);
      expect(y.o.outcome).toBe("success");
    } finally {
      await w.cleanup();
    }
  });
});

describe("wave A review, LOW items", () => {
  test("PROJECT: mask hides any registrable domain, not just a fixed list of top-level domains", () => {
    for (const host of ["acme.studio", "clinic.health", "sklep.pl", "loja.com.br", "my-shop.co.uk", "foo.bar.example", "agency.berlin", "team.consulting"]) {
      expect(mask(`write to the team at ${host} today`)).toBe("write to the team at [host] today");
    }
    // The brain's own workflow file names, numbers and abbreviations stay.
    expect(mask("Read recipients.csv, facts.md, workflow.json and SKILL.md; e.g. 98.4/day, v1.2")).toBe("Read recipients.csv, facts.md, workflow.json and SKILL.md; e.g. 98.4/day, v1.2");
  });

  test("ROUTES: share confirm requires the preview's hash; without it nothing is queued", async () => {
    const w = await fixtureSyncWorld();
    const TOKEN = "s".repeat(40);
    const brain = createBrain({ home: w.home, token: TOKEN, now: () => w.clock.now, workflows: { model: new StubModel(), env: {} }, sync: { controlUrl: w.control.url, fetch: loopbackFetch, openUrl: browser, log: () => {}, analysis: async () => w.fixture.analysis, timezone: "America/Toronto" } });
    try {
      await connect({ ...w, client: brain.sync });
      await brain.sync.refreshConfig();
      await brain.sync.acknowledgeNotice(NOTICE_1);
      const id = w.fixture.outreach.id;
      const r = await brain.handle(new Request(`http://127.0.0.1:4545/workflows/${id}/share?confirm=1`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }));
      expect(r.status).toBe(400);
      await brain.sync.flush({ force: true });
      expect(w.control.received.flatMap((x) => x.envelope.objects).some((o) => o.kind === "workflow_proposal")).toBe(false);
      // The client API needs the hash too.
      // @ts-expect-error the hash is required
      expect(() => brain.sync.share(id)).toThrow();
    } finally {
      await w.cleanup();
    }
  });

  test("REF: purging an expired ref map writes a purge-log line", () => {
    const t = tempHome();
    try {
      const ev = EvidenceKey.fromBytes(t.home, new Uint8Array(32).fill(9));
      ev.remember([{ instanceId: "inst-a", day: "2026-10-12" }, { instanceId: "inst-b", day: "2026-10-18" }], NOW);
      const gone = purgeRefs(t.home, NOW + 3 * DAY_MS);
      expect(gone).toEqual(["2026-10-12"]);
      const p = join(t.home, "purge-log.jsonl");
      expect(existsSync(p)).toBe(true);
      const lines = readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines).toEqual([{ day: "2026-10-12", deletedAt: NOW + 3 * DAY_MS, events: 0, files: 1, by: "sync-refs" }]);
    } finally {
      t.cleanup();
    }
  });
});
