import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..");
const REPO = join(WEB, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("production bundle", () => {
  const out = mkdtempSync(join(tmpdir(), "offload-web-build-"));
  let built = false;
  let log = "";

  test("BUILD: vite build succeeds", () => {
    const r = Bun.spawnSync(["bunx", "vite", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"], {
      cwd: WEB, stdout: "pipe", stderr: "pipe",
      // bun test sets NODE_ENV=test; the shipped bundle is the production build.
      env: { ...process.env, NODE_ENV: "production" },
    });
    log = r.stdout.toString() + r.stderr.toString();
    built = r.exitCode === 0;
    if (!built) throw new Error(log);
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain("/assets/");
  }, 60_000);

  test("BUILD: bundle has no source maps and no absolute local paths", () => {
    expect(built).toBe(true);
    const files = walk(out);
    expect(files.filter((f) => f.endsWith(".map"))).toEqual([]);
    const problems: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (text.includes("sourceMappingURL")) problems.push(`${f}: sourceMappingURL`);
      if (text.includes(REPO)) problems.push(`${f}: contains ${REPO}`);
      const abs = /\/(home|Users)\/[^/"'\s]+\//.exec(text);
      if (abs) problems.push(`${f}: absolute path ${abs[0]}`);
    }
    expect(problems).toEqual([]);
  });

  test("BUILD: test-only packages stay out of the bundle", () => {
    expect(built).toBe(true);
    const js = walk(out).filter((f) => f.endsWith(".js")).map((f) => readFileSync(f, "utf8")).join("\n");
    const leaked = ["happy-dom", "ajv/dist", "@testing-library", "jsxDEV"].filter((x) => js.includes(x));
    expect(leaked).toEqual([]);
    // The mock API and its invented fixtures are for dev and tests only; the shipped bundle talks to the control plane.
    const mock = ["northwind.example", "Harbor Logistics", "mock-csrf", "Thanks for asking about a demo"].filter((x) => js.includes(x));
    expect(mock).toEqual([]);
    rmSync(out, { recursive: true, force: true });
  });

  test("BUILD: dependencies are pinned to exact versions and include no CSS framework or component kit", () => {
    const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8")) as Record<string, Record<string, string>>;
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, v] of Object.entries(all)) {
      if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`${name}@${v} is not an exact version`);
    }
    expect(Object.keys(pkg.dependencies!).sort()).toEqual(["@tanstack/react-query", "@tanstack/react-router", "react", "react-dom"]);
    expect(Object.keys(all).join(" ")).not.toMatch(/tailwind|@mui|antd|chakra|bootstrap|chart|recharts|d3/);
    expect(all.typescript).toBe("5.9.3");
  });
});
