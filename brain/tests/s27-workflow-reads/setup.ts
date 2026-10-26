// s27: shared setup for workflows that fetch their own data (slices/s27-workflow-reads/SPEC.md). Hermetic: the s23
// neutral week with a dashboard visit (PostHog, the numbers on screen) right before every "Team metrics" sheet update,
// the real brain routes with the stub model and a fake clock, the stub connector chain with fake MCP / Composio probes
// and readers for the dashboard, and an in-memory driver that shows the dashboard or the sheet. No network, no real
// model, no real UI, nothing sent anywhere.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateNeutralWeek } from "../../fixtures/gen-neutral.ts";
import { writeFixture, type FixtureDay } from "../../fixtures/gen.ts";
import { createBrain, type Brain } from "../../src/api/server.ts";
import { ApiProbe } from "../../src/connectors/api.ts";
import { result, stubProbes, type FetchLike, type MethodProbe } from "../../src/connectors/chain.ts";
import { ScriptedPlanner, type ComputerTask } from "../../src/connectors/computer/claude.ts";
import { StubDriver, type MouseButton, type StubElement } from "../../src/connectors/computer/driver.ts";
import type { Method } from "../../src/connectors/link.ts";
import { GENERIC_READ, type ChainTarget } from "../../src/connectors/targets.ts";
import { StubModel } from "../../src/models/model.ts";
import type { OffloadEvent } from "../../src/types.ts";
import type { ReadCall, SourceReader } from "../../src/workflows/read-fetch.ts";

export const TOKEN = "r".repeat(48);
export const SEED = 42;
export const START = "2026-10-12";
const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0, 0).getTime();
export const WED_EVENING = at(14, 21);
export const FRI_EVENING = at(16, 21);
export const METRICS_TITLE = "Team metrics - Google Sheets";
export const DASHBOARD_TITLE = "Weekly metrics - PostHog";
export const DASHBOARD_URL = "https://us.posthog.com/project/1/dashboard/7";
export const SOURCE_TARGET = "web-us-posthog-com";
export const SHEET_COLUMNS = ["Week", "Signups", "Active", "Churn"] as const;
/** Seconds the person spends on the dashboard before each sheet update. */
export const READ_SECONDS = 50;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A ULID-shaped id: time part from `ts`, the rest from a hash of `seed` (deterministic). */
function ulidAt(ts: number, seed: string): string {
  let time = "";
  let t = ts;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const h = createHash("sha256").update(seed).digest();
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[h[i]! % 32];
  return time + rand;
}

/** The values the person typed into the sheet on one visit (its OCR row). */
export function sheetValues(ocr: string): string[] | null {
  const line = ocr.split("\n")[1];
  if (line === undefined) return null;
  const cells = line.split("|").map((c) => c.trim());
  return cells.length === 4 ? cells : null;
}

export function dashboardOcr(v: readonly string[]): string {
  return `Weekly metrics\nWeek ${v[0]}\nSignups ${v[1]}\nActive users ${v[2]}\nChurn ${v[3]}\nLast 7 days · updated hourly`;
}

/** The neutral week with a PostHog dashboard visit (READ_SECONDS, its OCR showing the same numbers) right before every
 * metrics sheet visit: the person reads the numbers, then types them. */
export function withDashboard(days: readonly FixtureDay[]): FixtureDay[] {
  return days.map((d) => {
    const out: OffloadEvent[] = [];
    const evs = d.events;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]!;
      if (e.kind === "focus" && e.title === METRICS_TITLE) {
        const ocr = evs.slice(i + 1).find((x) => x.kind === "ocr");
        const values = ocr?.kind === "ocr" ? sheetValues(ocr.text ?? "") : null;
        if (values !== null) {
          const t0 = e.ts - READ_SECONDS * 1000;
          out.push({ id: ulidAt(t0, `dash-focus-${e.id}`), ts: t0, kind: "focus", app: "com.google.Chrome", appName: "Google Chrome", title: DASHBOARD_TITLE, url: DASHBOARD_URL, host: "us.posthog.com" } as OffloadEvent);
          const text = dashboardOcr(values);
          out.push({ id: ulidAt(t0 + 1500, `dash-ocr-${e.id}`), ts: t0 + 1500, kind: "ocr", text, textHash: createHash("sha256").update(text).digest("hex").slice(0, 16) } as OffloadEvent);
        }
      }
      out.push(e);
    }
    return { day: d.day, events: out.sort((a, b) => a.ts - b.ts) };
  });
}

export const neutralDays = (): FixtureDay[] => generateNeutralWeek({ seed: SEED, startDay: START });
export const dashboardDays = (): FixtureDay[] => withDashboard(neutralDays());

/** Mon-Wed with the dashboard, as the observer would have stored them. */
export function writeFirstDays(home: string, o: { dashboard?: boolean } = {}): FixtureDay[] {
  const days = (o.dashboard === false ? neutralDays() : dashboardDays()).slice(0, 3);
  writeFixture(home, days, { encrypted: false, seed: SEED });
  return days;
}

/** Thu-Fri: Offload reads the dashboard and fills the sheet; the person reads Hacker News in that time instead. */
export function writeAfterDays(home: string): FixtureDay[] {
  const days = dashboardDays()
    .slice(3, 5)
    .map((d) => {
      let replaced = false;
      const events = d.events.map((e) => {
        if (e.kind === "focus") {
          replaced = e.title === METRICS_TITLE || e.title === DASHBOARD_TITLE;
          return replaced ? { ...e, title: "Hacker News", url: "https://news.ycombinator.com/", host: "news.ycombinator.com" } : e;
        }
        if (replaced && e.kind === "ocr") return { ...e, text: "Hacker News\nnew | past | comments", textHash: "s27hn" };
        return e;
      });
      return { day: d.day, events };
    });
  writeFixture(home, days, { encrypted: false, seed: SEED });
  return days;
}

// ---------- the fake apps: a dashboard (read only) and one sheet row form ----------

export interface Dash {
  week: string;
  signups: string;
  active: string;
  churn: string;
}

const sheetElements = (): StubElement[] => [
  ...SHEET_COLUMNS.map((c, i) => ({ id: c.toLowerCase(), role: "AXTextField", title: c, editable: true, value: "", x: 100, y: 100 + i * 30, w: 300, h: 20 })),
  { id: "save", role: "AXButton", title: "Save", editable: false, x: 100, y: 240, w: 60, h: 24 },
];

const dashElements = (d: Dash): StubElement[] => [
  { id: "d-title", role: "AXStaticText", title: "Weekly metrics", editable: false, x: 10, y: 10, w: 200, h: 20 },
  { id: "d-week", role: "AXStaticText", title: `Week ${d.week}`, editable: false, x: 10, y: 40, w: 200, h: 20 },
  { id: "d-signups", role: "AXStaticText", title: `Signups ${d.signups}`, editable: false, x: 10, y: 70, w: 200, h: 20 },
  { id: "d-active", role: "AXStaticText", title: `Active users ${d.active}`, editable: false, x: 10, y: 100, w: 200, h: 20 },
  { id: "d-churn", role: "AXStaticText", title: `Churn ${d.churn}`, editable: false, x: 10, y: 130, w: 200, h: 20 },
  { id: "d-edit", role: "AXButton", title: "Edit dashboard", editable: false, x: 10, y: 160, w: 120, h: 24 },
];

/** Shows the dashboard after opening the source target, the sheet row form otherwise. Saving the sheet clears it. */
export class DashSheetDriver extends StubDriver {
  dash: Dash = { week: "43", signups: "352", active: "2410", churn: "3" };
  readonly sheet = sheetElements();
  readonly opened: string[] = [];

  constructor() {
    super(sheetElements());
    this.elements = this.sheet;
  }

  override async open(t: ChainTarget): Promise<void> {
    await super.open(t);
    this.opened.push(t.id);
    this.elements = t.id === SOURCE_TARGET ? dashElements(this.dash) : this.sheet;
  }

  override async click(x: number, y: number, button: MouseButton, count: 1 | 2 | 3): Promise<void> {
    const before = this.pressed.length;
    await super.click(x, y, button, count);
    if (this.pressed.length > before && this.pressed[this.pressed.length - 1]!.title === "Save") for (const e of this.elements) if (e.editable) e.value = "";
  }

  /** Clicks and typed text since the start (a read must have none). */
  touches(): number {
    return this.events.filter((e) => e.kind === "click" || e.kind === "type" || e.kind === "key").length;
  }
}

type Turn = Array<{ name: string; input: Record<string, unknown> }>;

/** Recorded computer-use turns for one sheet item: fill each approved field, press Save, done. */
export function sheetPlanner(d: DashSheetDriver): ScriptedPlanner {
  return new ScriptedPlanner((task: ComputerTask): Turn[] => {
    const fill: Turn = [];
    for (const [key, value] of task.fields) {
      const id = key!.toLowerCase();
      if (!d.sheet.some((e) => e.id === id)) continue;
      fill.push({ name: "left_click", input: { coordinate: d.center(id) } }, { name: "type", input: { text: value } });
    }
    return [[{ name: "screenshot", input: {} }], fill, [{ name: "left_click", input: { coordinate: d.center("save") } }], [{ name: "done", input: { outcome: "committed", note: "" } }]];
  });
}

// ---------- fake connectors for the dashboard ----------

export const MCP_READ_TOOL = "mcp__posthog__query_metrics";
export const COMPOSIO_READ_TOOL = "mcp__composio_cli__POSTHOG_GET_INSIGHT";

/** What a connector answers for the dashboard: JSON, as an MCP tool or `composio execute` would. */
export const dashJson = (d: Dash) => JSON.stringify({ insight: "Weekly metrics", week: d.week, signups: d.signups, active_users: d.active, churn: d.churn });

/** A reader that does one call through the read gate; `tool` / `input` can be anything (a write, to prove refusal).
 * Without an explicit `input` it sends the arguments Offload learned (job.args), like a real reader. */
export class FakeReader implements SourceReader {
  calls = 0;
  ran = 0;
  fail: string | null = null;
  lastInput: Record<string, unknown> | null = null;
  constructor(
    private readonly answer: () => string,
    public tool: string,
    public input: Record<string, unknown> | null = null,
  ) {}

  async read(o: { call: ReadCall; args: Record<string, unknown> }): Promise<string> {
    this.calls += 1;
    if (this.fail !== null) throw new Error(this.fail);
    this.lastInput = this.input ?? o.args;
    return o.call(this.tool, this.lastInput, async () => {
      this.ran += 1;
      return this.answer();
    });
  }
}

export type ProbeMode = "ok" | "none";

/** Stub probes, with the dashboard reachable through a fake MCP server and/or a fake Composio account. */
export function probesFor(o: { mcp: ProbeMode; composio: ProbeMode }): Map<Method, MethodProbe> {
  const base = stubProbes();
  const mcp = base.get("mcp")!;
  const composio = base.get("composio")!;
  base.set("mcp", {
    method: "mcp",
    async probe(t, d) {
      if (t.id !== SOURCE_TARGET) return mcp.probe(t, d);
      return o.mcp === "ok" ? result("ok", "ok", null, { reads: ["metrics.read"], tools: { "metrics.read": MCP_READ_TOOL } }, 0, { server: "posthog" }) : result("skipped", "no_server", "No connector on this Mac is set up for PostHog.");
    },
  });
  base.set("composio", {
    method: "composio",
    async probe(t, d) {
      if (t.id !== SOURCE_TARGET) return composio.probe(t, d);
      return o.composio === "ok" ? result("ok", "ok", null, { reads: [GENERIC_READ], tools: { [GENERIC_READ]: COMPOSIO_READ_TOOL } }, 0, { toolkit: "posthog", account: "acct_1" }) : result("skipped", "no_toolkit", "Composio has no app for PostHog.");
    },
  });
  return base;
}

export interface World {
  home: string;
  clock: { now: number };
  model: StubModel;
  driver: DashSheetDriver;
  planner: ScriptedPlanner;
  brain: Brain;
  mcpReader: FakeReader;
  composioReader: FakeReader;
  call: <T = any>(path: string, method?: string, body?: unknown) => Promise<{ status: number; body: T }>;
  cleanup: () => void;
}

export interface WorldOptions {
  now?: number;
  mcp?: ProbeMode;
  composio?: ProbeMode;
  /** Readers to replace (the default computer reader is the real screen reader on the in-memory driver). */
  readers?: Partial<Record<Method, SourceReader>>;
  /** Use the real direct-API probe (connectors.json `apis`) with this fake fetch; no network. */
  apiFetch?: FetchLike;
}

export function world(o: WorldOptions = {}): World {
  const home = mkdtempSync(join(tmpdir(), "offload-s27-"));
  const clock = { now: o.now ?? WED_EVENING };
  const model = new StubModel();
  const driver = new DashSheetDriver();
  const planner = sheetPlanner(driver);
  const mcpReader = new FakeReader(() => dashJson(driver.dash), MCP_READ_TOOL);
  const composioReader = new FakeReader(() => dashJson(driver.dash), COMPOSIO_READ_TOOL);
  const brain = createBrain({
    home,
    token: TOKEN,
    now: () => clock.now,
    workflows: { model, env: {} },
    chain: {
      computer: { driver, planner },
      always: true,
      probes: (() => {
        const p = probesFor({ mcp: o.mcp ?? "ok", composio: o.composio ?? "ok" });
        if (o.apiFetch !== undefined) p.set("api", new ApiProbe());
        return p;
      })(),
      ...(o.apiFetch === undefined ? {} : { deps: { fetch: o.apiFetch } }),
      readers: { mcp: mcpReader, composio: composioReader, ...(o.readers ?? {}) },
    },
    log: () => {},
  });
  const w: World = {
    home,
    clock,
    model,
    driver,
    planner,
    brain,
    mcpReader,
    composioReader,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
    call: async (path, method = "GET", body) => {
      const headers = new Headers({ authorization: `Bearer ${TOKEN}` });
      if (body !== undefined) headers.set("content-type", "application/json");
      const res = await brain.handle(new Request(`http://127.0.0.1:4545${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      const text = await res.text();
      let parsed: any = null;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed };
    },
  };
  return w;
}

export async function metricsInsight(w: World): Promise<any> {
  return ((await w.call("/insights")).body.insights as any[]).find((i) => /Team metrics/.test(i.name));
}

/** Mon-Wed stored (with or without the dashboard), the metrics workflow chosen, dry-run and approved (active). */
export async function activeMetricsWorkflow(w: World, o: { dashboard?: boolean } = {}): Promise<{ id: string; dir: string; dry: any }> {
  writeFirstDays(w.home, o);
  const ins = await metricsInsight(w);
  const wf = (await w.call(`/insights/${ins.id}/solutions/choose`, "POST", { kind: "workflow" })).body.workflow;
  const d = await w.call(`/workflows/${wf.id}/dry-run`, "POST", { limit: 3 });
  const a = await w.call(`/workflows/${wf.id}/approve`, "POST", { batchHash: d.body.batchHash });
  if (a.status !== 200) throw new Error(`approve failed: ${JSON.stringify(a.body)}`);
  return { id: wf.id, dir: join(w.home, "workflows", wf.id), dry: d.body };
}

export function itemsCsv(rows: ReadonlyArray<readonly string[]>): string {
  return [SHEET_COLUMNS.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
}
