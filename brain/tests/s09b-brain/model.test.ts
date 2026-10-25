// s09b: `serve --model stub|real` (default real). Every response says which model wrote drafts (`model` in each JSON
// object body and the `x-offload-model` header), so the app can show "sample drafts" for the stub.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import type { DashboardResponse, DryRunResponse, InsightsResponse, StatusResponse, WorkflowDetailDTO } from "../../src/api/types.ts";
import { tempHome } from "../helpers.ts";
import { s09bWorld, type S09bWorld } from "./setup.ts";

const CLI = new URL("../../src/cli.ts", import.meta.url).pathname;
const procs: Array<{ kill: () => void }> = [];
const cleanups: Array<() => void> = [];
let w: S09bWorld | null = null;
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
  for (const c of cleanups.splice(0)) c();
  w?.cleanup();
  w = null;
});

async function serve(home: string, args: string[]): Promise<{ port: number; token: string }> {
  const p = Bun.spawn(["bun", "run", CLI, "serve", "--home", home, "--port", "0", ...args], { env: { ...process.env, OFFLOAD_TOKEN: "", OFFLOAD_KEYS: "file" }, stdout: "pipe", stderr: "pipe" });
  procs.push(p);
  const reader = p.stdout.getReader();
  let text = "";
  const deadline = Date.now() + 15_000;
  while (!text.includes("\n") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const m = /^OFFLOAD_BRAIN_READY (\{.*\})$/m.exec(text);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]!) as { port: number; token: string };
}

function fixtureHome(): string {
  const { home, cleanup } = tempHome();
  cleanups.push(cleanup);
  const t = new Date(Date.now() - 7 * 86_400_000);
  const start = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  writeFixture(home, generateFixture({ seed: 42, startDay: start }), { encrypted: false, seed: 42 });
  return home;
}

const get = async <T>(s: { port: number; token: string }, path: string, init: { method?: string; body?: unknown } = {}) => {
  const r = await fetch(`http://127.0.0.1:${s.port}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${s.token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: r.status, body: (await r.json()) as T, header: r.headers.get("x-offload-model") };
};

describe("s09b serve --model", () => {
  test("MODEL: serve --model stub labels every response stub and dry-runs with the deterministic stub drafts", async () => {
    const home = fixtureHome();
    const s = await serve(home, ["--model", "stub"]);
    const st = await get<StatusResponse & { model: string }>(s, "/status");
    expect(st.status).toBe(200);
    expect(st.body.model).toBe("stub");
    expect(st.header).toBe("stub");
    const ins = await get<InsightsResponse & { model: string }>(s, "/insights");
    expect(ins.body.model).toBe("stub");
    const d = await get<WorkflowDetailDTO>(s, "/workflows/draft", { method: "POST", body: { insightId: ins.body.insights[0]!.id } });
    expect(d.status).toBe(201);
    const dry = await get<DryRunResponse>(s, `/workflows/${d.body.id}/dry-run`, { method: "POST", body: { limit: 2 } });
    expect(dry.status).toBe(200);
    expect(dry.body.model).toBe("stub");
    expect(dry.header).toBe("stub");
    expect(dry.body.instances.length).toBeGreaterThan(0);
    // The stub's draft is built from the recipient and facts only: it starts with the greeting.
    for (const i of dry.body.instances) expect(i.draft?.startsWith(`Hi ${i.recipient.firstName || "there"},`)).toBe(true);
    const errs = await get<{ error: string }>(s, "/nope");
    expect(errs.status).toBe(404);
    expect(errs.header).toBe("stub");
  });

  test("MODEL: serve without --model is the real model, labelled real (no model call is made to say so)", async () => {
    const home = fixtureHome();
    const s = await serve(home, []);
    const st = await get<StatusResponse & { model: string }>(s, "/status");
    expect(st.body.model).toBe("real");
    expect(st.header).toBe("real");
  });

  test("MODEL: --model real is accepted and --model claude stays an alias; anything else is a usage error", async () => {
    const home = fixtureHome();
    const s = await serve(home, ["--model", "real"]);
    expect((await get<{ model: string }>(s, "/dashboard")).body.model).toBe("real");
    const bad = Bun.spawnSync(["bun", "run", CLI, "serve", "--home", home, "--model", "gpt"], { env: { ...process.env, OFFLOAD_KEYS: "file" } });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toString()).toContain("--model must be stub or real");
    // Usage lists the flag for serve.
    expect(bad.stderr.toString()).toMatch(/serve --home DIR \[--port P\] \[--model stub\|real\]/);
  });

  test("MODEL: in-process brain with a stub label: dry-run, workflow detail and dashboard all carry model stub", async () => {
    w = await s09bWorld({ modelLabel: "stub" });
    const id = w.outreach.id;
    const dry = await w.call<DryRunResponse>(`/workflows/${id}/dry-run`, { method: "POST", body: { limit: 1 } });
    expect(dry.body.model).toBe("stub");
    expect((await w.call<WorkflowDetailDTO & { model: string }>(`/workflows/${id}`)).body.model).toBe("stub");
    const dash = await w.call<DashboardResponse & { model: string }>("/dashboard");
    expect(dash.body.model).toBe("stub");
    expect(dash.headers.get("x-offload-model")).toBe("stub");
  });

  test("MODEL: a dry run keeps the label of the model that wrote it; the sealed file stores it", async () => {
    w = await s09bWorld({ modelLabel: "stub" });
    const id = w.outreach.id;
    await w.call<DryRunResponse>(`/workflows/${id}/dry-run`, { method: "POST", body: { limit: 1 } });
    // Same home, a brain labelled real: the stored stub dry run still says stub.
    const { createBrain } = await import("../../src/api/server.ts");
    const real = createBrain({ home: w.home, token: "t".repeat(40), now: () => w!.clock.now, workflows: { model: w.model, modelLabel: "real", env: {} } });
    const r = await real.handle(new Request(`http://127.0.0.1:4545/workflows/${id}/dry-runs/latest`, { headers: { authorization: `Bearer ${"t".repeat(40)}` } }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as DryRunResponse).model).toBe("stub");
    expect(r.headers.get("x-offload-model")).toBe("real");
    expect(readdirSync(join(w.home, "workflows", id, "dry-runs")).length).toBe(1);
  });
});
