// AC-9 WIRING: CLI flags for analyze/serve, usage errors, the API's additive `understanding` block behind the flag.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createBrain } from "../../src/api/server.ts";
import type { InsightsResponse } from "../../src/api/types.ts";
import { generatePersona, writePersona } from "../../fixtures/gen-domains.ts";
import { tempHome } from "../helpers.ts";
import { personaRun, reportNow, SEED } from "./setup.ts";

const CLI = join(import.meta.dir, "../../src/cli.ts");
const TOKEN = "s".repeat(48);

function cli(args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync([process.execPath, "run", CLI, ...args], { env: { ...process.env, OFFLOAD_TOKEN: "" } });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("WIRING cli", () => {
  test("analyze --understanding v2 --json returns insights with the understanding block", async () => {
    // The CLI reads with the real clock, so this week ends yesterday (like the generator's default).
    const { home, cleanup } = tempHome();
    try {
      const t = new Date(Date.now() - 7 * 86_400_000);
      const start = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
      writePersona(home, generatePersona("bookkeeper", { seed: SEED, startDay: start }), { encrypted: true, seed: SEED });
      const r = cli(["analyze", "--home", home, "--understanding", "v2", "--embedder", "stub", "--top", "2", "--json", "--role", "Bookkeeper"]);
      expect(r.code).toBe(0);
      const body = JSON.parse(r.out) as InsightsResponse;
      expect(body.insights.length).toBe(2);
      for (const i of body.insights) expect(i.understanding).toBeDefined();
      expect(body.insights[0]!.understanding!.surfaces.map((s) => s.host || s.app)).toEqual(expect.arrayContaining(["go.xero.com", "com.apple.Preview"]));
      const text = cli(["analyze", "--home", home, "--understanding", "v2", "--top", "1"]);
      expect(text.out).toMatch(/^#1 .*\[task\.enter-bill\]/m);
      expect(text.out).toContain("loop: read supplier invoice");
    } finally {
      cleanup();
    }
  });

  test("usage errors exit 2: unknown version, --embedder without v2, s12 flags on other commands", async () => {
    const { home } = await personaRun("bookkeeper");
    expect(cli(["analyze", "--home", home, "--understanding", "v3"]).code).toBe(2);
    expect(cli(["analyze", "--home", home, "--embedder", "ollama"]).code).toBe(2);
    expect(cli(["analyze", "--home", home, "--understanding", "v2", "--embed-model", "llama3"]).code).toBe(2);
    expect(cli(["purge", "--home", home, "--understanding", "v2"]).code).toBe(2);
  });
});

describe("WIRING api", () => {
  test("serve options: v2 adds `understanding` to /insights; v1 (default) has none", async () => {
    const { home } = await personaRun("salesops");
    const get = async (analyze?: { understanding: "v2" }) => {
      const brain = createBrain({ home, token: TOKEN, now: reportNow, ...(analyze === undefined ? {} : { analyze }) });
      const res = await brain.handle(new Request("http://127.0.0.1:4545/insights", { headers: { authorization: `Bearer ${TOKEN}` } }));
      expect(res.status).toBe(200);
      return (await res.json()) as InsightsResponse;
    };
    const v2 = await get({ understanding: "v2" });
    const top = v2.insights[0]!;
    expect(top.understanding?.loop.length).toBeGreaterThanOrEqual(2);
    expect(top.understanding?.surfaces.map((s) => s.host)).toEqual(expect.arrayContaining(["docs.google.com", "www.linkedin.com"]));
    expect(top.understanding?.reach.perSurface.some((s) => s.connectorId === "google-sheets")).toBe(true);
    const v1 = await get();
    expect(v1.insights.every((i) => i.understanding === undefined)).toBe(true);
  });
});
