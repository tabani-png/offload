// Codex review of 03e5e17: an event claimed by a consumer that crashed before acting is retried once its claim's lease
// expires, by the every-minute recovery, without waiting for a stream reconnect, also while a consumer is attached.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EVENT_CLAIM_LEASE_MS } from "../../src/modules/workers/orchestrator.ts";
import { ulid } from "../../src/schema/encoding.ts";
import { createWorker, requiresAction, running, world, type World } from "./setup.ts";

let w: World;

beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.workers.interruptAll(w.t.id, { tenant: true });
  await w.workers.idle();
  await w.close();
});

describe("SESSION", () => {
  test("SESSION: a tool request claimed by a consumer that crashed is answered after the lease expires, with no stream reconnect", async () => {
    const x = await createWorker(w, { identityId: w.t.people.member.id });
    const s = await w.fake.api().createSession({
      agent: { type: "agent", id: x.externalRefs.agentId, version: 1 },
      environment_id: x.externalRefs.environmentId,
      vault_ids: [],
      budget: { type: "limit", max_list_cost: { amount: "300", currency: "USD" } },
      title: "crashed claim",
      metadata: {},
    } as never);
    const id = ulid(w.h.clock.now());
    const at = new Date(w.h.clock.now());
    await w.h.db.migrator`insert into worker_runs (tenant_id, id, worker_id, trigger, runner_person_id, started_at, state, budget_cents, session_ref, first_sent_at)
      values (${w.t.id}, ${id}, ${x.id}, 'manual', ${w.t.people.member.id}, ${at}, 'running', 300, ${s.id}, ${at})`;
    await w.h.db.migrator`insert into session_cursors (tenant_id, session_id, run_id) values (${w.t.id}, ${s.id}, ${id})`;
    w.fake.inject(s.id, [running, { id: "evt_crash_1", type: "agent.mcp_tool_use", mcp_server_name: "gmail", name: "search_emails", input: { query: "x" }, evaluated_permission: "ask" }, requiresAction(["evt_crash_1"])]);
    // Another process claimed the tool request, then died before answering it.
    await w.h.db.migrator`insert into session_events (tenant_id, session_id, event_id, type, handled_at, claimed_at)
      values (${w.t.id}, ${s.id}, 'evt_crash_1', 'agent.mcp_tool_use', null, ${at})`;
    // This process attaches a consumer: the claim is fresh, so it leaves the request alone and waits on its stream.
    await w.workers.resume(w.t.id, id);
    await w.workers.idle();
    const answers = () => w.fake.sent(s.id).filter((e) => e.type === "user.tool_confirmation" && e.tool_use_id === "evt_crash_1");
    expect(answers()).toHaveLength(0);
    const streams = w.fake.streamCount(s.id);
    // The lease expires; the every-minute recovery retries the request.
    w.h.clock.advance(EVENT_CLAIM_LEASE_MS + 60_000);
    await w.workers.recover(w.t.id);
    await w.workers.idle();
    expect(answers()).toHaveLength(1);
    expect(w.fake.streamCount(s.id)).toBe(streams);
    const [e] = await w.h.db.migrator`select handled_at from session_events where session_id = ${s.id} and event_id = 'evt_crash_1'`;
    expect(e!.handled_at).not.toBeNull();
    // Another recovery does not answer it again.
    await w.workers.recover(w.t.id);
    await w.workers.idle();
    expect(answers()).toHaveLength(1);
  }, 60_000);
});
