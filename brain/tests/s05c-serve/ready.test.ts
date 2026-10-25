// s05c: `serve` prints exactly one machine-readable first stdout line, `OFFLOAD_BRAIN_READY {"port":N,"token":"..."}`,
// with nothing before it (startup logs go to stderr). The app reads that line (brain/API.md "Connection").
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAIN_READY_PREFIX, type BrainReadyDTO } from "../../src/api/types.ts";
import { formatReadyLine, parseReadyLine } from "../../src/api/server.ts";
import { tempHome } from "../helpers.ts";

const CLI = new URL("../../src/cli.ts", import.meta.url).pathname;
const procs: Array<{ kill: () => void }> = [];
const homes: Array<() => void> = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
  for (const c of homes.splice(0)) c();
});

interface Started {
  first: string;
  stdout: string;
  stderr: () => Promise<string>;
}

/** Starts `serve` and returns once stdout has two lines (or the process ended). */
async function serve(home: string, env: Record<string, string>, args: string[] = []): Promise<Started> {
  const p = Bun.spawn(["bun", "run", CLI, "serve", "--home", home, ...args], { env: { ...process.env, OFFLOAD_TOKEN: "", ...env }, stdout: "pipe", stderr: "pipe" });
  procs.push(p);
  const reader = p.stdout.getReader();
  let text = "";
  const deadline = Date.now() + 15_000;
  while (text.split("\n").length < 3 && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return {
    first: text.split("\n")[0] ?? "",
    stdout: text,
    stderr: async () => {
      p.kill();
      return await new Response(p.stderr).text();
    },
  };
}

function ready(line: string): BrainReadyDTO {
  expect(line.startsWith(`${BRAIN_READY_PREFIX} `)).toBe(true);
  const parsed = JSON.parse(line.slice(BRAIN_READY_PREFIX.length + 1)) as BrainReadyDTO;
  expect(Object.keys(parsed).sort()).toEqual(["port", "token"]);
  return parsed;
}

describe("s05c serve handshake", () => {
  test("READY: the first stdout line is OFFLOAD_BRAIN_READY with the picked port and a generated token the API accepts", async () => {
    const { home, cleanup } = tempHome();
    homes.push(cleanup);
    const s = await serve(home, {});
    const r = ready(s.first);
    expect(r.port).toBeGreaterThan(0);
    expect(r.token.length).toBeGreaterThanOrEqual(32);
    // The token is printed once, in the ready line only.
    expect(s.stdout.split(r.token).length - 1).toBe(1);
    expect(s.stdout).not.toContain("OFFLOAD_TOKEN=");
    const ok = await fetch(`http://127.0.0.1:${r.port}/status`, { headers: { authorization: `Bearer ${r.token}` } });
    expect(ok.status).toBe(200);
    const no = await fetch(`http://127.0.0.1:${r.port}/status`, { headers: { authorization: "Bearer nope" } });
    expect(no.status).toBe(401);
  }, 30_000);

  test("READY: OFFLOAD_TOKEN is echoed and --port N is honoured", async () => {
    const { home, cleanup } = tempHome();
    homes.push(cleanup);
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = Number(probe.port);
    await probe.stop(true);
    const token = "s".repeat(48);
    const s = await serve(home, { OFFLOAD_TOKEN: token }, ["--port", String(port)]);
    expect(ready(s.first)).toEqual({ port, token });
  }, 30_000);

  test("READY: nothing precedes the ready line even when the startup purge logs (logs go to stderr)", async () => {
    const { home, cleanup } = tempHome();
    homes.push(cleanup);
    // A pre-s05b plaintext tone corpus: the startup purge seals it and logs one line.
    mkdirSync(join(home, "tone"), { recursive: true });
    writeFileSync(join(home, "tone", "corpus.jsonl"), '{"id":"m1"}\n');
    const t = Date.now() / 1000;
    utimesSync(join(home, "tone", "corpus.jsonl"), t, t);
    const s = await serve(home, { OFFLOAD_KEYS: "file" });
    ready(s.first);
    expect(s.stdout).not.toContain("purge");
    expect(await s.stderr()).toContain("purge");
  }, 30_000);

  test("READY: formatReadyLine and parseReadyLine round-trip and reject anything else", () => {
    const line = formatReadyLine(51234, "x".repeat(43));
    expect(line).toBe(`OFFLOAD_BRAIN_READY {"port":51234,"token":"${"x".repeat(43)}"}`);
    expect(parseReadyLine(line)).toEqual({ port: 51234, token: "x".repeat(43) });
    expect(parseReadyLine("brain listening on http://127.0.0.1:1/")).toBeNull();
    expect(parseReadyLine('OFFLOAD_BRAIN_READY {"port":0,"token":"x"}')).toBeNull();
    expect(parseReadyLine('OFFLOAD_BRAIN_READY {"port":"1","token":"' + "x".repeat(40) + '"}')).toBeNull();
  });
});
