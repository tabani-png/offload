/**
 * FakeManagedAgents: Managed Agents faked at the HTTP boundary, for tests (ADR 0105 "a fake for tests"). The real SDK
 * client (`sdkManagedAgents`) is pointed at `fake.fetch`, so every request the orchestrator makes goes through the
 * SDK's own serialisation. The fake
 *   - checks each request against the recorded contract (`cma-contract.json`): known route, `anthropic-beta` header,
 *     required body fields, no unknown fields; anything else is a 400 and is listed in `violations`;
 *   - records every request (`requests`), with secrets (`token`) redacted from the record;
 *   - replays scripted event streams: each session takes the next queued script, whose steps emit events and wait
 *     for the orchestrator's answers (`user.custom_tool_result`, `user.tool_confirmation`, ...);
 *   - streams events as SSE, can drop a stream after N events or replay the last ones on reconnect.
 * Nothing here opens a socket.
 */
import contract from "./cma-contract.json" with { type: "json" };
import { sdkManagedAgents, type ManagedAgentsApi, type SessionEvent } from "./managed-agents.ts";

export interface RecordedRequest {
  op: string;
  method: string;
  path: string;
  id: string | null;
  body: Record<string, any> | null;
  query: Record<string, string>;
  beta: string | null;
  at: number;
}

/** What a script waits for: the type of a user event and, optionally, a predicate on it. */
export interface Await {
  await: "user.message" | "user.custom_tool_result" | "user.tool_confirmation" | "user.interrupt";
  where?: (e: Record<string, any>) => boolean;
}

/** Events to emit (`id` and `processed_at` are filled in when absent); `cost` sets the session's list cost in cents. */
export interface Emit {
  emit: Array<Partial<SessionEvent> & { type: string }>;
  cost?: number;
}

export type Step = Await | Emit;

interface Session {
  id: string;
  body: Record<string, any>;
  status: "idle" | "running" | "terminated";
  events: SessionEvent[];
  script: Step[];
  pos: number;
  costCents: number;
  streams: Set<ReadableStreamDefaultController<Uint8Array>>;
  received: Array<Record<string, any>>;
  deleted: boolean;
}

interface Endpoint {
  op: string;
  method: string;
  path: string;
  required: string[];
  fields: string[];
  query?: string[];
}

const enc = new TextEncoder();
const ENDPOINTS = contract.endpoints as Endpoint[];
const USER_EVENTS = contract.userEvents as unknown as Record<string, { fields: string[] }>;

function route(method: string, path: string): { ep: Endpoint; id: string | null } | null {
  for (const ep of ENDPOINTS) {
    if (ep.method !== method) continue;
    const re = new RegExp(`^${ep.path.replace("{id}", "([^/]+)")}$`);
    const m = re.exec(path);
    if (m) return { ep, id: m[1] ?? null };
  }
  return null;
}

function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "token" ? "[redacted]" : redact(x)]));
  }
  return v;
}

export class FakeManagedAgents {
  requests: RecordedRequest[] = [];
  violations: string[] = [];
  sessions = new Map<string, Session>();
  deployments = new Map<string, { id: string; body: Record<string, any>; status: "active" | "paused" | "archived" }>();
  deploymentRuns: Array<{ id: string; deployment_id: string; created_at: string; session_id: string | null; error: { type: string; message: string } | null }> = [];
  /** Scripts for the next sessions, in order. A session with no script just idles at end_turn after a message. */
  scripts: Step[][] = [];
  /** Drop every stream after this many delivered events (once per session unless `dropEvery`). */
  dropAfter: number | null = null;
  dropEvery = false;
  /** Replay this many already-sent events at the start of each reconnected stream. */
  replayOnReconnect = 0;
  /** Fail the next N requests of this op with a 500. */
  failNext = new Map<string, number>();
  private seq = 0;
  private clock: () => number;
  private dropped = new Set<string>();
  private streamsOpened = new Map<string, number>();

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  /** The orchestrator's client: the real SDK over this fake's fetch. */
  api(): ManagedAgentsApi {
    return sdkManagedAgents({ apiKey: "sk-ant-fake-test-key", baseURL: "http://cma.fake", fetch: this.fetch });
  }

  queue(...scripts: Step[][]): void {
    this.scripts.push(...scripts);
  }

  ops(op?: string): RecordedRequest[] {
    return op ? this.requests.filter((r) => r.op === op) : this.requests;
  }

  /** Every user event sent to a session, in order. */
  sent(sessionId?: string): Array<Record<string, any>> {
    return this.ops("sessions.events.send")
      .filter((r) => sessionId === undefined || r.id === sessionId)
      .flatMap((r) => (r.body?.events ?? []) as Array<Record<string, any>>);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${String(this.seq).padStart(6, "0")}`;
  }

  private iso(): string {
    // Strictly increasing timestamps, so created_at filters are exact.
    return new Date(this.clock() + this.seq).toISOString();
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const text = method === "GET" || method === "DELETE" ? "" : await req.text();
    let body: Record<string, any> | null = null;
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, any>;
      } catch {
        return this.bad(`${method} ${url.pathname}: body is not JSON`);
      }
    }
    const r = route(method, url.pathname);
    const beta = req.headers.get("anthropic-beta");
    const query = Object.fromEntries(url.searchParams.entries());
    if (!r) return this.bad(`${method} ${url.pathname}: not in the recorded contract`);
    const { ep, id } = r;
    this.seq += 1;
    this.requests.push({ op: ep.op, method, path: url.pathname, id, body: body ? (redact(body) as Record<string, any>) : null, query, beta, at: this.seq });
    if (!beta || !beta.split(",").includes(contract.beta)) return this.bad(`${ep.op}: missing anthropic-beta ${contract.beta}`);
    if (!req.headers.get("x-api-key") && !/^Bearer \S+$/.test(req.headers.get("authorization") ?? "")) return this.bad(`${ep.op}: no API credential`);
    for (const k of Object.keys(query)) if (!(ep.query ?? []).includes(k)) return this.bad(`${ep.op}: unknown query ${k}`);
    if (ep.fields.length > 0 || ep.required.length > 0) {
      const b = body ?? {};
      for (const k of ep.required) if (!(k in b)) return this.bad(`${ep.op}: missing ${k}`);
      for (const k of Object.keys(b)) if (!ep.fields.includes(k)) return this.bad(`${ep.op}: unknown field ${k}`);
    }
    const left = this.failNext.get(ep.op) ?? 0;
    if (left > 0) {
      this.failNext.set(ep.op, left - 1);
      return Response.json({ type: "error", error: { type: "api_error", message: "fake outage" } }, { status: 500 });
    }
    return this.handle(ep.op, id, body ?? {}, query, req.signal);
  };

  private bad(msg: string): Response {
    this.violations.push(msg);
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: msg } }, { status: 400 });
  }

  private notFound(): Response {
    return Response.json({ type: "error", error: { type: "not_found_error", message: "not found" } }, { status: 404 });
  }

  private handle(op: string, id: string | null, body: Record<string, any>, query: Record<string, string>, signal: AbortSignal): Response {
    switch (op) {
      case "environments.create":
        return Response.json({ id: this.nextId("env"), type: "environment", name: body.name, config: body.config });
      case "environments.update":
        return Response.json({ id, type: "environment", name: body.name, config: body.config });
      case "vaults.create":
        return Response.json({ id: this.nextId("vlt"), type: "vault", display_name: body.display_name });
      case "vaults.credentials.create":
        return Response.json({ id: this.nextId("cred"), type: "credential", vault_id: id });
      case "agents.create":
        return Response.json({ id: this.nextId("agent"), type: "agent", version: 1, name: body.name });
      case "sessions.create": {
        if (Array.isArray(body.initial_events) && body.initial_events.length > 0) this.violations.push("sessions.create: initial_events sent before the stream was open");
        const s = this.newSession(body);
        return Response.json({ id: s.id, type: "session", status: s.status, usage: {} });
      }
      case "sessions.retrieve": {
        const s = id ? this.sessions.get(id) : undefined;
        if (!s || s.deleted) return this.notFound();
        return Response.json({ id: s.id, type: "session", status: s.status, usage: { list_cost: { amount: String(s.costCents), currency: "USD" } } });
      }
      case "sessions.delete": {
        const s = id ? this.sessions.get(id) : undefined;
        if (!s || s.deleted) return this.notFound();
        s.deleted = true;
        return Response.json({ id: s.id, type: "session_deleted" });
      }
      case "sessions.events.send": {
        const s = id ? this.sessions.get(id) : undefined;
        if (!s || s.deleted) return this.notFound();
        for (const e of (body.events ?? []) as Array<Record<string, any>>) {
          const spec = USER_EVENTS[e.type as string];
          if (!spec) return this.bad(`sessions.events.send: unknown user event ${String(e.type)}`);
          for (const k of Object.keys(e)) if (!spec.fields.includes(k)) return this.bad(`sessions.events.send: ${e.type} has unknown field ${k}`);
        }
        for (const e of body.events as Array<Record<string, any>>) this.receive(s, e);
        return Response.json({ data: body.events });
      }
      case "sessions.events.stream": {
        const s = id ? this.sessions.get(id) : undefined;
        if (!s || s.deleted) return this.notFound();
        return this.openStream(s, signal);
      }
      case "sessions.events.list": {
        const s = id ? this.sessions.get(id) : undefined;
        if (!s || s.deleted) return this.notFound();
        const gte = query["created_at[gte]"];
        const data = s.events.filter((e) => gte === undefined || (e.processed_at ?? "") >= gte);
        return Response.json({ data, next_page: null });
      }
      case "deployments.create": {
        const d = { id: this.nextId("depl"), body, status: "active" as const };
        this.deployments.set(d.id, d);
        return Response.json({ id: d.id, type: "deployment", status: d.status });
      }
      case "deployments.pause":
      case "deployments.unpause":
      case "deployments.archive": {
        const d = id ? this.deployments.get(id) : undefined;
        if (!d) return this.notFound();
        if (d.status !== "archived") d.status = op === "deployments.pause" ? "paused" : op === "deployments.unpause" ? "active" : "archived";
        return Response.json({ id: d.id, type: "deployment", status: d.status });
      }
      case "deploymentRuns.list": {
        const gt = query["created_at[gt]"];
        const data = this.deploymentRuns.filter((r) => r.deployment_id === query.deployment_id && (gt === undefined || r.created_at > gt));
        return Response.json({ data, next_page: null });
      }
      default:
        return this.bad(`${op}: no fake handler`);
    }
  }

  private newSession(body: Record<string, any>): Session {
    const s: Session = {
      id: this.nextId("sesn"),
      body,
      status: "idle",
      events: [],
      script: this.scripts.shift() ?? [{ await: "user.message" }, { emit: [{ type: "session.status_idle", stop_reason: { type: "end_turn" } }] }],
      pos: 0,
      costCents: 0,
      streams: new Set(),
      received: [],
      deleted: false,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  /** The platform firing a deployment (cron tick). A paused or archived deployment does not fire. */
  fire(deploymentId: string, opts: { error?: string } = {}): string | null {
    const d = this.deployments.get(deploymentId);
    if (!d || d.status !== "active") return null;
    const runId = this.nextId("drun");
    if (opts.error) {
      this.deploymentRuns.push({ id: runId, deployment_id: d.id, created_at: this.iso(), session_id: null, error: { type: opts.error, message: "session could not be created" } });
      return null;
    }
    const s = this.newSession({ agent: d.body.agent, environment_id: d.body.environment_id, vault_ids: d.body.vault_ids, budget: d.body.budget });
    this.deploymentRuns.push({ id: runId, deployment_id: d.id, created_at: this.iso(), session_id: s.id, error: null });
    for (const e of (d.body.initial_events ?? []) as Array<Record<string, any>>) this.receive(s, e);
    return s.id;
  }

  private emit(s: Session, e: Partial<SessionEvent> & { type: string }): void {
    const ev = { ...e, id: e.id ?? this.nextId("sevt"), processed_at: e.processed_at ?? this.iso() } as SessionEvent;
    s.events.push(ev);
    if (ev.type === "session.status_running") s.status = "running";
    if (ev.type === "session.status_idle") s.status = "idle";
    if (ev.type === "session.status_terminated") s.status = "terminated";
    for (const c of [...s.streams]) this.push(s, c, ev);
  }

  private push(s: Session, c: ReadableStreamDefaultController<Uint8Array>, ev: SessionEvent): void {
    const meta = c as unknown as { delivered?: number };
    try {
      c.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
    } catch {
      s.streams.delete(c);
      return;
    }
    meta.delivered = (meta.delivered ?? 0) + 1;
    const once = !this.dropEvery && this.dropped.has(s.id);
    if (this.dropAfter !== null && !once && meta.delivered >= this.dropAfter) {
      this.dropped.add(s.id);
      s.streams.delete(c);
      c.close();
    }
  }

  private openStream(s: Session, signal: AbortSignal): Response {
    const opened = (this.streamsOpened.get(s.id) ?? 0) + 1;
    this.streamsOpened.set(s.id, opened);
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctrl = c;
        s.streams.add(c);
        if (opened > 1 && this.replayOnReconnect > 0) {
          for (const ev of s.events.slice(-this.replayOnReconnect)) c.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
        }
      },
      cancel: () => {
        if (ctrl) s.streams.delete(ctrl);
      },
    });
    signal.addEventListener("abort", () => {
      if (!ctrl) return;
      s.streams.delete(ctrl);
      try {
        ctrl.close();
      } catch {
        // already closed
      }
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }

  /** Tests: the session emits these events now (the agent acting while no consumer listens, e.g. across a restart). */
  inject(sessionId: string, events: Array<Partial<SessionEvent> & { type: string }>): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`no session ${sessionId}`);
    for (const e of events) this.emit(s, e);
  }

  /** User events the session actually received (a failed request is recorded in `requests` but never arrives). */
  receivedBy(sessionId: string): Array<Record<string, any>> {
    return this.sessions.get(sessionId)?.received ?? [];
  }

  streamCount(sessionId: string): number {
    return this.streamsOpened.get(sessionId) ?? 0;
  }

  /** A user event arrives: echo it into the log, then run the script up to its next wait. */
  private receive(s: Session, e: Record<string, any>): void {
    s.received.push(e);
    this.emit(s, { ...(e as { type: string }) });
    if (e.type === "user.interrupt") {
      s.script = [];
      s.pos = 0;
      this.emit(s, { type: "session.status_idle", stop_reason: { type: "end_turn" } });
      return;
    }
    const step = s.script[s.pos];
    if (step && "await" in step && step.await === e.type && (step.where === undefined || step.where(e))) {
      s.pos += 1;
      this.run(s);
    }
  }

  private run(s: Session): void {
    while (s.pos < s.script.length) {
      const step = s.script[s.pos]!;
      if ("await" in step) return;
      if (step.cost !== undefined) s.costCents = step.cost;
      for (const e of step.emit) this.emit(s, e);
      s.pos += 1;
    }
  }
}
