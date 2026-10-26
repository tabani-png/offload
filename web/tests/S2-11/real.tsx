// Test-only: the admin web on the REAL control plane. Starts control/tests/S2-11/fixture-server.ts (the real app on a
// seeded Postgres schema, over HTTP) and renders the whole app against it with the production fetch layer
// (`createHttpClient`, cookie session, CSRF header). Nothing in between is mocked.
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { setDefaultTimeout } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHttpClient, type ApiClient } from "../../src/api/client.ts";
import { App, createAppRouter } from "../../src/app/router.tsx";
import { settle } from "../helpers/render.tsx";

const CONTROL = join(import.meta.dir, "../../../control");
// Real HTTP round trips to a real database: give each test room (bun's default of 5 s also kills the fixture server).
setDefaultTimeout(30_000);

export interface FixtureState {
  api: string;
  ctl: string;
  now: number;
  tenantId: string;
  people: Record<"owner" | "admin" | "lead" | "member" | "member2" | "auditor", string>;
  depts: { sales: string; finance: string; legal: string };
  jobRoles: { sdr: string; ap: string; counsel: string };
  workflows: { sales: string; finance: string; legal: string };
  members: Array<{ personId: string; name: string; departmentId: string; workflowId: string }>;
  noticeId: string;
  pendingBatch: string;
}

export interface Control {
  state: FixtureState;
  /** Clock of the control plane; the web's `now` follows it. */
  now(): number;
  setClock(t: number): Promise<void>;
  /** The production fetch layer signed in as `who` (seeded key or person id), plus raw JSON access for assertions. */
  as(who: string): Promise<{ api: ApiClient; json: <T = any>(path: string) => Promise<T>; csrf: string }>;
  ctl(path: string, body?: unknown): Promise<any>;
  close(): Promise<void>;
}

/** The control test database (control/tests/helpers/db.ts uses the same default). */
const DEFAULT_PG_URL = "postgres://offload_migrator:offload@127.0.0.1:54329/offload_test";

async function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  try {
    const sock = await Bun.connect({ hostname: u.hostname, port: Number(u.port || 5432), socket: { data() {} } });
    sock.end();
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string[], cwd: string, what: string) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${what} failed (${cmd.join(" ")}):\n${r.stderr.toString()}${r.stdout.toString()}`);
}

/**
 * What the fixture needs, provided the way slices/S2-common/verify-lib.sh does (s2_install, s2_pg_up), so the web suite
 * runs anywhere `bun test tests` runs: control's locked dependencies, and the local Postgres from
 * control/docker-compose.yml when the test database is not reachable. Never a remote database; never a skip: if it
 * cannot be provided, every test here fails with the reason.
 */
let provisioned: Promise<void> | null = null;
function provision(): Promise<void> {
  return (provisioned ??= (async () => {
    if (!existsSync(join(CONTROL, "node_modules"))) run(["bun", "install", "--frozen-lockfile"], CONTROL, "control install");
    const url = process.env.OFFLOAD_PG_URL ?? DEFAULT_PG_URL;
    if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("OFFLOAD_PG_URL must be local");
    if (await reachable(url)) return;
    if (process.env.OFFLOAD_PG_URL) throw new Error(`OFFLOAD_PG_URL is set but nothing answers at ${new URL(url).host}`);
    run(["docker", "compose", "-f", join(CONTROL, "docker-compose.yml"), "up", "-d", "--wait"], CONTROL, "starting the control test Postgres");
  })());
}

export async function startControl(): Promise<Control> {
  await provision();
  const proc = Bun.spawn(["bun", "tests/S2-11/fixture-server.ts"], { cwd: CONTROL, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let state: FixtureState | null = null;
  const deadline = Date.now() + 60_000;
  while (!state) {
    if (Date.now() > deadline) throw new Error("control fixture did not start");
    const { value, done } = await reader.read();
    if (done) throw new Error(`control fixture exited with ${await proc.exited} (its stderr is above)`);
    buf += dec.decode(value);
    const line = buf.split("\n").find((l) => l.startsWith("S2-11-READY "));
    if (line) state = JSON.parse(line.slice("S2-11-READY ".length)) as FixtureState;
  }
  reader.releaseLock();
  let now = state.now;

  const ctl = async (path: string, body?: unknown) => {
    const r = await fetch(state!.ctl + path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    if (!r.ok) throw new Error(`ctl ${path}: ${r.status} ${await r.text()}`);
    return r.json();
  };

  return {
    state,
    now: () => now,
    async setClock(t) {
      await ctl("/clock", { t });
      now = t;
    },
    async as(who) {
      const id = (state!.people as Record<string, string>)[who] ?? who;
      const { cookie, csrf } = (await ctl("/session", { who: id })) as { cookie: string; csrf: string };
      const withCookie = (input: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set("cookie", cookie);
        return fetch(input, { ...init, headers });
      };
      const api = createHttpClient(state!.api, withCookie);
      const json = async (path: string) => {
        const r = await withCookie(state!.api + path);
        if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
        return r.json();
      };
      return { api, json, csrf };
    },
    ctl,
    async close() {
      proc.stdin.end();
      await proc.exited;
    },
  };
}

/** Render the whole app at `path`, signed in as `who`, on the real API. */
export async function renderReal(c: Control, path: string, who: string, opts: { onRequest?: (method: string, path: string) => void } = {}) {
  const { api: inner } = await c.as(who);
  const seen = (m: string, p: string) => opts.onRequest?.(m, p);
  const api: ApiClient = {
    get: (p) => (seen("GET", p), inner.get(p)),
    getText: (p) => (seen("GET", p), inner.getText(p)),
    post: (p, b) => (seen("POST", p), inner.post(p, b)),
    patch: (p, b) => (seen("PATCH", p), inner.patch(p, b)),
    delete: (p) => (seen("DELETE", p), inner.delete(p)),
  };
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const utils = render(<App deps={{ api, now: c.now }} router={router} queryClient={queryClient} />);
  await settle();
  return { ...utils, api, router, queryClient };
}
