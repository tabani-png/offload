// The real control plane on a seeded Postgres schema, over HTTP, for the web suite (web/tests/S2-11). Run with
// `bun tests/S2-11/fixture-server.ts`; prints one line `S2-11-READY {json}` and serves until stdin closes.
// The API server is the real app (every module, real RBAC gate, CSRF, RLS). A second, loopback-only port is the test
// control channel: it moves the shared clock, mints sessions and makes the seeded Macs send sync envelopes, all
// through the same producers the tests in this folder use. It is test-only and never part of the app.
import { buildWorld, noticeAck, workingTime } from "./world.ts";

const w = await buildWorld();

const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => w.h.app.fetch(req) });

const json = (v: unknown, status = 200) => Response.json(v, { status });
let ctlPort = 0;

const ctl = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : {};
    switch (`${req.method} ${url.pathname}`) {
      case "GET /state":
        return json(state());
      case "POST /clock":
        w.setClock(Number(body.t));
        return json(state());
      case "POST /session": {
        const c = await w.as(String(body.who)).cred();
        return json(c);
      }
      case "POST /ack": {
        // Every seeded Mac acknowledges a notice now (G1/G2 of ADR 0103), as the Mac app would after showing it.
        const features = (body.features as string[] | undefined) ?? ["workflow_metrics"];
        for (const m of w.members) {
          const r = await w.sendObjects(m.device, [noticeAck(String(body.noticeId), w.h.clock.now(), features)]);
          if (r.status !== 200 || r.json.rejected.length > 0) return json({ error: r.json }, 500);
        }
        return json({ ok: true });
      }
      case "POST /working-time": {
        const days = body.days as string[];
        const out: unknown[] = [];
        let i = 0;
        for (const m of w.members) {
          const objs = days.map((d) => workingTime(d, 380 + 10 * (i % 7), String(body.noticeId)));
          const r = await w.sendObjects(m.device, objs);
          out.push(r.json);
          i++;
        }
        return json({ receipts: out });
      }
      default:
        return json({ error: "no such control route" }, 404);
    }
  },
});
ctlPort = ctl.port ?? 0;

function state(): Record<string, unknown> {
  return {
    api: `http://127.0.0.1:${api.port}`,
    ctl: `http://127.0.0.1:${ctlPort}`,
    now: w.h.clock.now(),
    tenantId: w.t.id,
    people: Object.fromEntries(Object.entries(w.t.people).map(([k, v]) => [k, v.id])),
    depts: w.depts,
    jobRoles: w.jobRoles,
    workflows: w.workflows,
    members: w.members.map((m) => ({ personId: m.personId, name: m.name, departmentId: m.departmentId, workflowId: m.workflowId })),
    noticeId: w.noticeId,
    pendingBatch: w.pendingBatch,
  };
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  api.stop(true);
  ctl.stop(true);
  await w.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.stdin.on("end", () => void shutdown());
process.stdin.on("close", () => void shutdown());
process.stdin.resume();

console.log(`S2-11-READY ${JSON.stringify(state())}`);
