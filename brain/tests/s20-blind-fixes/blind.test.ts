// s20 acceptance: each problem the 7-day blind test found, reproduced on a synthetic fixture (fixture.ts) and checked
// through the real code path. Tags: MERGE, TYPER, SURFACE, SAVING, KEYS, ROUTE (slices/s20-blind-fixes/SPEC.md).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeHome, type Analysis, type Insight } from "../../src/analyze.ts";
import { chainDeps, chainOrder, ChainResolver, result, type MethodProbe } from "../../src/connectors/chain.ts";
import { resolutionMethods, writeSim, type Method } from "../../src/connectors/link.ts";
import { targetForProfile } from "../../src/connectors/targets.ts";
import { estimateSaving } from "../../src/insights/saving.ts";
import { StubModel } from "../../src/models/model.ts";
import { buildPlan, chosenVariant } from "../../src/plan/build.ts";
import { ChainCapabilityResolver } from "../../src/plan/chain-resolver.ts";
import { stepClass, verbClass } from "../../src/plan/steps.ts";
import { DEFAULT_MODELS } from "../../src/models/model.ts";
import { brainKeyMode, brainKeyPath, isPlainHome, openText, sealText } from "../../src/store/vault.ts";
import { understandingJudge, isWriteVerb } from "../../src/understanding/labeler.ts";
import { describeSpans } from "../../src/understanding/describe.ts";
import { StubEmbedder } from "../../src/understanding/embed.ts";
import { understandSpans } from "../../src/understanding/pipeline.ts";
import { knownSurfaceIn, normalizeSurface, surfaceKeyOf } from "../../src/understanding/surfaces.ts";
import { baseVerb } from "../../src/understanding/verbs.ts";
import type { FrameNote } from "../../src/understanding/frames.ts";
import type { Span } from "../../src/types.ts";
import { blindWeek, NOW, SYNTH_APP, writeBlindWeek } from "./fixture.ts";

const homes: string[] = [];
const tmp = (p = "offload-s20-") => {
  const h = mkdtempSync(join(tmpdir(), p));
  homes.push(h);
  return h;
};
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

let cached: Promise<{ home: string; a: Analysis; week: ReturnType<typeof blindWeek> }> | null = null;
/** The blind week, written as the importer writes it and analysed with understanding v2 (stub embedder). */
function blind() {
  cached ??= (async () => {
    const home = tmp("offload-s20-blind-");
    const week = blindWeek();
    writeBlindWeek(home, week);
    const a = await analyzeHome(home, { now: () => NOW, understanding: "v2" });
    return { home, a, week };
  })();
  return cached;
}

const taskOfShot = (a: Analysis, ts: number) => {
  const span = a.spans.find((s) => ts >= s.start && ts < s.end);
  return span === undefined ? undefined : a.taskOfSpan.get(span.id);
};
const insightWith = (a: Analysis, pred: (i: Insight) => boolean) => {
  const i = a.insights.find(pred);
  if (i === undefined) throw new Error("no such insight");
  return i;
};
const onSurface = (name: string) => (i: Insight) => (i.profile.understanding?.surfaces ?? []).some((s) => s.appName === name);

// ---------- 10 spans on one stand-in app, one frame each (the importer's shape, without the store) ----------

const BASE = new Date(2026, 9, 14, 10).getTime();
function screens(captions: ReadonlyArray<Partial<FrameNote>>, gapMs = 30_000): { spans: Span[]; frames: FrameNote[] } {
  const spans: Span[] = [];
  const frames: FrameNote[] = [];
  captions.forEach((c, i) => {
    const start = BASE + i * (60_000 + gapMs);
    spans.push({ id: `sp_${i}`, day: "2026-10-14", key: `${SYNTH_APP}|Screen ${i + 1}|`, app: SYNTH_APP, appName: "Screen", title: `Screen ${i + 1}`, url: "", host: "", start, end: start + 60_000, activeMs: 60_000, keys: 0, clicks: 0, ocr: [], eventIds: [`e${i}`] });
    frames.push({ id: `fn_${i}`, ts: start + 1000, kind: "frame", frameId: `kf_${i}`, model: "stub", activity: "Reviewing content on the screen", confidence: 0.8, ...c });
  });
  return { spans, frames };
}

describe("s20 MERGE: generic verbs no longer merge work across apps", () => {
  test("MERGE: 10 'reviewing' captions across 6 apps on one stand-in app yield at least 4 tasks", async () => {
    const apps = ["Terminal", "Gmail", "Google Docs", "ChatGPT", "LinkedIn", "YouTube", "Gmail", "Terminal", "Google Docs", "ChatGPT"];
    const { spans, frames } = screens(apps.map((surface) => ({ verb: "reviewing", object: "content", surface })));
    const u = await understandSpans(spans, { frames, embedder: new StubEmbedder() });
    expect(u.tasks.length).toBeGreaterThanOrEqual(4);
    // And no task mixes two of the products.
    for (const t of u.tasks) expect(new Set(t.profile.understanding!.surfaces.map((s) => s.appName)).size).toBe(1);
  });

  test("MERGE: the blind week (74% 'reviewing') has no task holding more than 25% of screen time", async () => {
    const { a, week } = await blind();
    expect(week.frames.filter((f) => f.verb === "reviewing").length / week.frames.length).toBeGreaterThan(0.7);
    const share = a.tasks.map((t) => t.instances.reduce((n, i) => n + i.activeMs, 0) / a.totalActiveMs);
    expect(Math.max(...share)).toBeLessThanOrEqual(0.25);
    expect(a.tasks.length).toBeGreaterThanOrEqual(10);
  });

  test("MERGE: every task of the blind week stays inside one product", async () => {
    const { a } = await blind();
    for (const t of a.tasks) expect(new Set(t.profile.understanding!.surfaces.map((s) => `${s.appName}|${s.host}`)).size).toBe(1);
  });

  test("MERGE: the embedded text drops generic verbs and leads with surface and object", () => {
    const { spans, frames } = screens([{ verb: "reviewing", object: "content", surface: "Gmail" }]);
    const [d] = describeSpans(spans, new Map([["sp_0", frames]]));
    expect(d!.text.toLowerCase()).not.toContain("review");
    expect(d!.text.startsWith("Gmail content")).toBe(true);
  });

  test("MERGE: a real app whose captions name itself is never treated as a stand-in", async () => {
    const { spans, frames } = screens(["Terminal", "Terminal", "Terminal", "Terminal"].map((surface) => ({ verb: "reviewing", object: "code", surface })));
    const real = spans.map((s) => ({ ...s, app: "com.apple.Terminal", appName: "Terminal" }));
    const ds = describeSpans(real, new Map(real.map((s, i) => [s.id, [frames[i]!]])));
    for (const d of ds) {
      expect(d.surfaceFrom).toBe("observed");
      expect(d.app).toBe("com.apple.Terminal");
    }
  });
});

describe("s20 TYPER: gerunds are write verbs", () => {
  test("TYPER: writing, typing, entering, updating, sending, filling, creating, replying, editing map to write verbs", () => {
    const want: Record<string, string> = { writing: "write", typing: "type", entering: "enter", updating: "update", sending: "send", filling: "fill in", "filling in": "fill in", creating: "create", replying: "reply", editing: "edit", "typing a message": "type" };
    for (const [g, base] of Object.entries(want)) {
      expect(baseVerb(g)).toBe(base);
      expect(isWriteVerb(g)).toBe(true);
      expect(["text", "record"]).toContain(verbClass(g));
    }
    // Looking verbs stay reads.
    for (const g of ["reviewing", "viewing", "reading", "looking at", "watching"]) {
      expect(isWriteVerb(g)).toBe(false);
      expect(verbClass(g)).toBe("read");
    }
    expect(stepClass({ verb: "typing", object: "message" })).toBe("text");
  });

  test("TYPER: 'writing note in Granola' yields a draft step and a gated commit, and is not judged read-only", async () => {
    const { a } = await blind();
    const i = insightWith(a, onSurface("Granola"));
    expect(i.judge.reasons.join(" ")).not.toContain("reading only");
    const { plan } = await buildPlan({ analysis: a, insight: i, model: new StubModel(), models: { ...DEFAULT_MODELS } });
    const v = chosenVariant(plan);
    const types = v.steps.map((s) => s.type);
    expect(types).toContain("draft");
    const commits = v.steps.filter((s) => s.type === "commit");
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every((s) => s.gated)).toBe(true);
    expect(types.indexOf("draft")).toBeLessThan(types.indexOf("commit"));
  });

  test("TYPER: 'typing a message in Gmail' yields a draft step and a gated send", async () => {
    const { a } = await blind();
    const i = insightWith(a, (x) => onSurface("Gmail")(x) && (x.profile.understanding?.steps ?? []).some((s) => s.verb === "type"));
    const { plan } = await buildPlan({ analysis: a, insight: i, model: new StubModel(), models: { ...DEFAULT_MODELS } });
    const v = chosenVariant(plan);
    expect(plan.outputType).toBe("email");
    expect(v.steps.map((s) => s.type)).toEqual(expect.arrayContaining(["draft", "commit"]));
    const commit = v.steps.find((s) => s.type === "commit")!;
    expect(commit.gated).toBe(true);
    expect(commit.capability?.capability).toBe("mail.send");
  });

  test("TYPER: a frames-only write task gets write risk from the judge", () => {
    const steps = [{ id: "s1", name: "write note on Granola", verb: "writing", object: "note", surface: "Granola", surfaceKey: "~granola|||Screen <n>", app: "", appName: "Granola", host: "", category: "other" as const, spans: 5, activeMs: 300_000, perInstance: 1, repeatsPerInstance: 1, meanPosition: 0, core: true }];
    const r = understandingJudge.judge({ profile: { understanding: { version: 2, goal: "", steps, loop: ["s1"], startStep: "s1", startSurface: "", identifiers: { items: 0, examples: [], containers: [] }, counterparts: [], surfaces: [], instanceBoundaries: [], evidenceSpanIds: [], frameIds: [], reach: { value: 0, perSurface: [] }, sources: { frames: 5, rules: 0 } } } as never, sameness: 0.5 });
    expect(r.reasons.join(" ")).not.toContain("reading only");
    expect(r.risk).toBeGreaterThan(0);
  });
});

describe("s20 SURFACE: one product, one name", () => {
  test("SURFACE: case, domains and known aliases normalise before grouping", () => {
    expect(surfaceKeyOf("Instagram")).toBe(surfaceKeyOf("instagram.com"));
    expect(surfaceKeyOf("https://www.instagram.com")).toBe("instagram");
    expect(surfaceKeyOf("Terminal")).toBe(surfaceKeyOf("terminal"));
    expect(surfaceKeyOf("Chrome")).toBe(surfaceKeyOf("Google Chrome"));
    expect(normalizeSurface("instagram.com feed")).toBe("Instagram feed");
    expect(normalizeSurface("mail.google.com")).toBe("Gmail");
    expect(normalizeSurface("acme.io")).toBe("acme");
    expect(knownSurfaceIn("Claude Code session")?.id).toBe("claude-code");
    expect(knownSurfaceIn("Google Docs document")?.id).toBe("google-docs");
    // Unknown surfaces keep their words (fixture wording such as "Xero new bill form" is unchanged).
    expect(normalizeSurface("Xero new bill form")).toBe("Xero new bill form");
  });

  test("SURFACE: Instagram and instagram.com captions group into one task", async () => {
    const { a, week } = await blind();
    for (const pair of [["Instagram", "instagram.com"], ["Terminal", "terminal"], ["Chrome", "Google Chrome"], ["ChatGPT", "chatgpt.com"]] as const) {
      // The importer stamps idle at a run's last row, so that row's screen has no span; every other screen counts.
      const placed = week.shots.filter((s) => (pair as readonly string[]).includes(s.surface)).map((s) => ({ surface: s.surface, task: taskOfShot(a, s.ts) })).filter((x) => x.task !== undefined);
      expect(new Set(placed.map((x) => x.surface)).size).toBe(2);
      expect(new Set(placed.map((x) => x.task)).size).toBe(1);
    }
  });

  test("SURFACE: ten Instagram / instagram.com screens are one step on one surface", async () => {
    const { spans, frames } = screens(Array.from({ length: 10 }, (_, i) => ({ verb: "reviewing", object: "post", surface: i % 2 === 0 ? "Instagram" : "instagram.com" })));
    const u = await understandSpans(spans, { frames, embedder: new StubEmbedder() });
    expect(u.tasks.length).toBe(1);
    expect(u.tasks[0]!.profile.understanding!.steps.length).toBe(1);
    expect(new Set(u.descriptions.map((d) => d.surfaceKey)).size).toBe(1);
  });
});

describe("s20 SAVING: the saving can never exceed the task's own observed time", () => {
  test("SAVING: the blind test's 52 h/wk claim from a 46.6 h/wk task is capped and flagged", () => {
    // 79% of 59 h active = 46.6 h/wk observed; the instance count claimed 600 items x 5.5 min.
    const s = estimateSaving({ instances: 600, daysActive: 7, windowDays: 7, medianMinutes: 5.5, eventIds: [], activeMinutes: 46.6 * 60, signals: { share: 0.79, surfaces: 7, genericShare: 0.76 } });
    expect(s.capped).toBe(true);
    expect(s.observedWeeklyHours).toBe(46.6);
    expect(s.weeklyHoursNow).toBeLessThanOrEqual(46.6);
    expect(s.weeklyHoursSaved).toBeLessThanOrEqual(46.6);
    expect(s.range.high.hoursSaved).toBeLessThanOrEqual(46.6);
    expect(s.arithmetic).toContain("capped at the 46.6 h/wk observed");
    expect(s.confidence).toBe("low");
    expect(s.confidenceReasons.join(" ")).toContain("79% of all screen time across 7 apps");
  });

  test("SAVING: the cap holds for 2000 random inputs", () => {
    let x = 7;
    const r = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let k = 0; k < 2000; k++) {
      const days = 1 + Math.floor(r() * 7);
      const active = r() * 3000;
      const s = estimateSaving({ instances: 1 + Math.floor(r() * 900), daysActive: days, windowDays: 7, medianMinutes: r() * 30, eventIds: [], activeMinutes: active });
      const observed = Math.round((active / 60) * 10 + 1e-9) / 10;
      expect(s.weeklyHoursSaved).toBeLessThanOrEqual(observed + 1e-9);
      expect(s.range.low.hoursSaved).toBeLessThanOrEqual(observed + 1e-9);
      expect(s.range.high.hoursSaved).toBeLessThanOrEqual(observed + 1e-9);
    }
  });

  test("SAVING: within rounding the estimate is unchanged (the outreach demo's arithmetic stays)", () => {
    const s = estimateSaving({ instances: 492, daysActive: 5, windowDays: 7, medianMinutes: 3, eventIds: [], activeMinutes: 24.5 * 60 });
    expect(s.capped).toBe(false);
    expect(s.arithmetic).toBe("98.4/day × 5 days × 3.0 min = 24.6 h/wk → review 492 × 20 s = 2.7 h/wk → saves 21.9 h/wk (89%)");
  });

  test("SAVING: every blind-week insight saves no more than its task was observed taking", async () => {
    const { a } = await blind();
    expect(a.insights.length).toBeGreaterThan(0);
    for (const i of a.insights) {
      const observed = (i.stats.activeMinutes.value / 60) * (7 / a.windowDays.length);
      expect(i.saving.weeklyHoursSaved).toBeLessThanOrEqual(Math.round(observed * 10 + 1e-9) / 10 + 1e-9);
      expect(i.saving.observedWeeklyHours).not.toBeNull();
    }
  });

  test("SAVING: an over-merged task (most of the week, many apps) is flagged low confidence in the API", async () => {
    const { toInsights } = await import("../../src/api/dto.ts");
    const { a } = await blind();
    const dto = toInsights(a).insights;
    // Looking-only tasks claim no saving and are not offered (review round); write tasks with enough instances carry no flag.
    expect(dto.filter((d) => d.understanding?.steps.every((s) => s.verb === "reviewing"))).toEqual([]);
    const granola = dto.find((d) => d.understanding?.surfaces.some((s) => s.appName === "Granola"));
    expect(granola?.saving.confidence).toBeUndefined();
    const merged = estimateSaving({ instances: 300, daysActive: 7, windowDays: 7, medianMinutes: 2, eventIds: [], activeMinutes: 600, signals: { share: 0.79, surfaces: 7 } });
    expect(merged.confidence).toBe("low");
  });
});

describe("s20 KEYS: plain-mode homes seal with file keys", () => {
  function fakeObserver(dir: string): { bin: string; log: string } {
    const bin = join(dir, "observer.sh");
    const log = join(dir, "calls.log");
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\necho "no keychain here" >&2\nexit 1\n`);
    chmodSync(bin, 0o755);
    return { bin, log };
  }
  const day = "2026-10-18";
  const now = new Date(2026, 9, 19, 12).getTime();

  test("KEYS: a plain-mode home with OFFLOAD_KEYS unset seals and opens without the observer Keychain", async () => {
    const { home } = await blind();
    const tools = tmp("offload-s20-obs-");
    const obs = fakeObserver(tools);
    const env = { OFFLOAD_OBSERVER_BIN: obs.bin };
    expect(isPlainHome(home)).toBe(true);
    expect(brainKeyMode(env, home)).toBe("file");
    const path = join(home, "s20-sealed.enc");
    sealText(home, path, "masked dry-run text", day, env);
    expect(existsSync(brainKeyPath(home, day))).toBe(true);
    expect(readFileSync(brainKeyPath(home, day)).length).toBe(32);
    expect(openText(home, path, now, env)).toBe("masked dry-run text");
    expect(existsSync(obs.log)).toBe(false);
  });

  test("KEYS: an observer home (keys/ folder, encrypted days) still asks the Keychain", () => {
    const home = tmp();
    mkdirSync(join(home, "keys"), { recursive: true });
    mkdirSync(join(home, "days"), { recursive: true });
    writeFileSync(join(home, "days", `${day}.jsonl.enc`), "");
    const obs = fakeObserver(tmp("offload-s20-obs-"));
    const env = { OFFLOAD_OBSERVER_BIN: obs.bin };
    expect(isPlainHome(home)).toBe(false);
    expect(brainKeyMode(env, home)).toBe("keychain");
    expect(() => sealText(home, join(home, "x.enc"), "t", day, env)).toThrow();
    expect(readFileSync(obs.log, "utf8")).toContain("wrap-key");
  });

  test("KEYS: OFFLOAD_KEYS=keychain forces the Keychain even on a plain home; =file forces files", async () => {
    const { home } = await blind();
    expect(brainKeyMode({ OFFLOAD_KEYS: "keychain" }, home)).toBe("keychain");
    expect(brainKeyMode({ OFFLOAD_KEYS: "file" }, tmp())).toBe("file");
    expect(brainKeyMode({}, tmp())).toBe("keychain");
  });
});

describe("s20 ROUTE: a captioned product is routed to that product before computer use", () => {
  async function plans() {
    const { a } = await blind();
    const out = new Map<string, Awaited<ReturnType<typeof buildPlan>>["plan"]>();
    for (const name of ["Granola", "Linear", "Google Docs"]) out.set(name, (await buildPlan({ analysis: a, insight: insightWith(a, onSurface(name)), model: new StubModel(), models: { ...DEFAULT_MODELS } })).plan);
    const gm = insightWith(a, (x) => onSurface("Gmail")(x) && (x.profile.understanding?.steps ?? []).some((s) => s.verb === "type"));
    out.set("Gmail", (await buildPlan({ analysis: a, insight: gm, model: new StubModel(), models: { ...DEFAULT_MODELS } })).plan);
    return out;
  }

  test("ROUTE: steps target the product the caption named, not the stand-in app", async () => {
    const p = await plans();
    const targets = (name: string) => new Set(chosenVariant(p.get(name)!).steps.flatMap((s) => (s.capability === null ? [] : [`${s.capability.target}:${s.capability.targetName}`])));
    expect([...targets("Granola")]).toEqual(["app-granola:Granola"]);
    expect([...targets("Linear")]).toEqual(["web-linear-app:Linear"]);
    expect([...targets("Google Docs")]).toEqual(["web-docs-google-com:Google Docs"]);
    expect([...targets("Gmail")]).toEqual(["gmail:Gmail"]);
    for (const plan of p.values()) for (const v of plan.variants) for (const s of v.steps) expect(s.capability?.target ?? "").not.toContain("screen");
  });

  test("ROUTE: the chain order for a captioned product is connector, Composio, API, then computer use", async () => {
    const { a } = await blind();
    const home = tmp();
    const granola = targetForProfile(insightWith(a, onSurface("Granola")).profile);
    expect(granola.id).toBe("app-granola");
    expect(chainOrder(granola, home)).toEqual(["mcp", "composio", "api", "computer"]);
    expect(resolutionMethods("web-linear-app", null)).toEqual(["mcp", "composio", "api", "computer"]);
    // An app no caption names keeps s13's order.
    expect(resolutionMethods("app-quickbooks-online", null)).toEqual(["composio", "api", "computer"]);
  });

  test("ROUTE: each need tries MCP, Composio and the API before computer use, and stops at the first that works", async () => {
    const home = tmp();
    const calls: string[] = [];
    // Method probes are the edge (CLI, HTTP, the screen); the resolver's order and choice are what is tested.
    const ok = new Set(["app-granola:composio", "tk-granola:composio", "web-linear-app:api"]);
    const probe = (method: Method): MethodProbe => ({
      method,
      async probe(t) {
        calls.push(`${t.id}:${method}`);
        const caps = { reads: [...t.reads], writes: [...t.sends] };
        return method === "computer" || ok.has(`${t.id}:${method}`) ? result("ok", "ok", null, caps, 0) : result("skipped", "no_server", `nothing for ${t.name}`);
      },
    });
    const chain = new ChainResolver(chainDeps({ home, env: {}, simulated: false }), new Map((["mcp", "composio", "api", "computer"] as const).map((m) => [m, probe(m)])));
    const r = new ChainCapabilityResolver(chain);
    const p = await plans();
    const needs = [...p.values()].flatMap((plan) => chosenVariant(plan).steps.flatMap((s) => (s.capability === null ? [] : [s.capability])));
    const res = await r.resolve(needs);
    const by = (target: string) => res.filter((x) => x.target === target);
    // Granola: no universe index here, so Composio is asked through the app target (which this fake offers).
    expect(by("app-granola").every((x) => x.status === "resolved" && x.method === "composio")).toBe(true);
    expect(by("web-linear-app").every((x) => x.status === "resolved" && x.method === "api")).toBe(true);
    expect(by("web-docs-google-com").every((x) => x.method === "computer")).toBe(true);
    // Computer use was chosen for Google Docs only after the three others were probed, in order.
    const docs = calls.filter((c) => c.startsWith("web-docs-google-com:")).map((c) => c.split(":")[1]);
    expect(docs).toEqual(["mcp", "composio", "api", "computer"]);
    expect(by("web-docs-google-com")[0]!.reason).toContain("Composio: nothing for Google Docs");
  });

  test("ROUTE: with the stub model a demo Composio sign-in for the product's toolkit is used, not computer use", async () => {
    const { a, home: src } = await blind();
    const home = tmp();
    // The analysis is already made; the chain only needs a home for its cache and the demo sign-ins.
    void src;
    writeSim(home, "tk-granola", NOW);
    const chain = new ChainResolver(chainDeps({ home, env: {}, simulated: true }));
    const { plan } = await buildPlan({ analysis: a, insight: insightWith(a, onSurface("Granola")), model: new StubModel(), models: { ...DEFAULT_MODELS }, resolver: new ChainCapabilityResolver(chain) });
    const granola = plan.capabilities.filter((c) => c.target === "app-granola");
    expect(granola.length).toBeGreaterThan(0);
    expect(granola.every((c) => c.status === "resolved" && c.method === "composio")).toBe(true);
    const { plan: docs } = await buildPlan({ analysis: a, insight: insightWith(a, onSurface("Google Docs")), model: new StubModel(), models: { ...DEFAULT_MODELS }, resolver: new ChainCapabilityResolver(chain) });
    expect(docs.capabilities.every((c) => c.method === "computer")).toBe(true);
    expect(docs.capabilities[0]!.reason).toContain("Tried first");
  });
});
