// s26: shared setup for the individual automation path (slices/s26-automation-e2e/SPEC.md). Hermetic: the s23 neutral
// week in the observer's store format, the real brain routes with the stub model and a fake clock, the stub connector
// chain and an in-memory "sheet row" app driven by a scripted planner (recorded computer-use turns). No network, no
// real model, no real UI, nothing sent anywhere.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateNeutralWeek } from "../../fixtures/gen-neutral.ts";
import { writeFixture, type FixtureDay } from "../../fixtures/gen.ts";
import { createBrain, type Brain } from "../../src/api/server.ts";
import { ScriptedPlanner, type ComputerTask } from "../../src/connectors/computer/claude.ts";
import { StubDriver, type MouseButton } from "../../src/connectors/computer/driver.ts";
import { StubModel } from "../../src/models/model.ts";

export const TOKEN = "s".repeat(48);
export const SEED = 42;
/** The neutral week starts Mon 12 Oct 2026 (local days, like the observer). */
export const START = "2026-10-12";
const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0, 0).getTime();
/** Phase 1: Mon-Wed are stored; the person reviews and approves on Wednesday evening. */
export const WED_EVENING = at(14, 21);
/** Phase 2: Thu and Fri are stored too (Offload did the sheet updates; the person spent that time elsewhere). */
export const FRI_EVENING = at(16, 21);
export const METRICS_TITLE = "Team metrics - Google Sheets";

/** Words of the old outreach demo; none may appear on this path (s23 OUTREACH_WORDS). */
export const OUTREACH_WORDS = /outreach|investor|cold e-?mail|prospect|fundrais|seed round|instantly|apollo|smartlead|lemlist/i;

export function tempHome(prefix = "offload-s26-"): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export const neutralDays = (): FixtureDay[] => generateNeutralWeek({ seed: SEED, startDay: START });

/** Mon-Wed exactly as the observer would have stored them. */
export function writeFirstDays(home: string): FixtureDay[] {
  const days = neutralDays().slice(0, 3);
  writeFixture(home, days, { encrypted: false, seed: SEED });
  return days;
}

/** Thu-Fri with every metrics-sheet visit replaced by reading Hacker News: the person no longer types the numbers. */
export function afterDays(): FixtureDay[] {
  return neutralDays()
    .slice(3, 5)
    .map((d) => {
      let inMetrics = false;
      const events = d.events.map((e) => {
        if (e.kind === "focus") {
          inMetrics = e.title === METRICS_TITLE;
          return inMetrics ? { ...e, app: "com.google.Chrome", appName: "Google Chrome", title: "Hacker News", url: "https://news.ycombinator.com/", host: "news.ycombinator.com" } : e;
        }
        if (inMetrics && e.kind === "ocr") return { ...e, text: "Hacker News\nnew | past | comments | ask | show", textHash: "s26hn" };
        return e;
      });
      return { day: d.day, events };
    });
}

export function writeAfterDays(home: string): FixtureDay[] {
  const days = afterDays();
  writeFixture(home, days, { encrypted: false, seed: SEED });
  return days;
}

// ---------- the fake app: one sheet row form ----------

export const SHEET_COLUMNS = ["Week", "Signups", "Active", "Churn"] as const;

/** A row-entry form like the sheet's: four cells and a Save button. Saving clears the row (the next item starts empty). */
export class SheetRowDriver extends StubDriver {
  constructor() {
    super([
      ...SHEET_COLUMNS.map((c, i) => ({ id: c.toLowerCase(), role: "AXTextField", title: c, editable: true, value: "", x: 100, y: 100 + i * 30, w: 300, h: 20 })),
      { id: "save", role: "AXButton", title: "Save", editable: false, x: 100, y: 240, w: 60, h: 24 },
      { id: "filter", role: "AXButton", title: "Filter views", editable: false, x: 170, y: 240, w: 80, h: 24 },
    ]);
  }

  override async click(x: number, y: number, button: MouseButton, count: 1 | 2 | 3): Promise<void> {
    const before = this.pressed.length;
    await super.click(x, y, button, count);
    if (this.pressed.length > before && this.pressed[this.pressed.length - 1]!.title === "Save") for (const e of this.elements) if (e.editable) e.value = "";
  }
}

type Turn = Array<{ name: string; input: Record<string, unknown> }>;

/**
 * Recorded computer-use turns for one item: look, fill each approved field into its cell, press Save, report done.
 * `override` changes what is typed into one cell (to prove a changed value is never committed).
 */
export function sheetPlanner(d: SheetRowDriver, override: Record<string, string> = {}): ScriptedPlanner {
  return new ScriptedPlanner((task: ComputerTask): Turn[] => {
    const fill: Turn = [];
    for (const [key, value] of task.fields) {
      const id = key!.toLowerCase();
      if (!d.elements.some((e) => e.id === id)) continue;
      fill.push({ name: "left_click", input: { coordinate: d.center(id) } }, { name: "type", input: { text: override[id] ?? value } });
    }
    return [[{ name: "screenshot", input: {} }], fill, [{ name: "left_click", input: { coordinate: d.center("save") } }], [{ name: "done", input: { outcome: "committed", note: "" } }]];
  });
}

export interface World {
  home: string;
  clock: { now: number };
  model: StubModel;
  driver: SheetRowDriver;
  planner: ScriptedPlanner;
  brain: Brain;
  call: <T = any>(path: string, method?: string, body?: unknown) => Promise<{ status: number; body: T }>;
  rebrain: (o?: { override?: Record<string, string> }) => void;
  cleanup: () => void;
}

export function world(o: { now?: number } = {}): World {
  const h = tempHome();
  const clock = { now: o.now ?? WED_EVENING };
  const model = new StubModel();
  const w = { home: h.home, clock, model, cleanup: h.cleanup } as World;
  w.rebrain = (r = {}) => {
    w.driver = new SheetRowDriver();
    w.planner = sheetPlanner(w.driver, r.override ?? {});
    w.brain = createBrain({
      home: h.home,
      token: TOKEN,
      now: () => clock.now,
      workflows: { model, env: {} },
      chain: { computer: { driver: w.driver, planner: w.planner }, always: true },
      log: () => {},
    });
  };
  w.rebrain();
  w.call = async (path, method = "GET", body) => {
    const headers = new Headers({ authorization: `Bearer ${TOKEN}` });
    if (body !== undefined) headers.set("content-type", "application/json");
    const res = await w.brain.handle(new Request(`http://127.0.0.1:4545${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };
  return w;
}

/** The person's list of rows to enter (the workflow's items.csv): header = the sheet's columns. */
export function itemsCsv(rows: ReadonlyArray<readonly string[]>): string {
  return [SHEET_COLUMNS.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
}

/** Mon-Wed stored, the metrics workflow chosen, dry-run and approved (active). Returns its id and folder. */
export async function activeMetricsWorkflow(w: World): Promise<{ id: string; dir: string; insightId: string }> {
  writeFirstDays(w.home);
  const ins = ((await w.call("/insights")).body.insights as any[]).find((i) => /Team metrics/.test(i.name));
  const wf = (await w.call(`/insights/${ins.id}/solutions/choose`, "POST", { kind: "workflow" })).body.workflow;
  const d = await w.call(`/workflows/${wf.id}/dry-run`, "POST", { limit: 3 });
  const a = await w.call(`/workflows/${wf.id}/approve`, "POST", { batchHash: d.body.batchHash });
  if (a.status !== 200) throw new Error(`approve failed: ${JSON.stringify(a.body)}`);
  return { id: wf.id, dir: join(w.home, "workflows", wf.id), insightId: ins.id };
}
