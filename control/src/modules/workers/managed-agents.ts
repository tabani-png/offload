/**
 * The narrow interface the orchestrator uses to talk to Claude Managed Agents (ADR 0105, beta
 * `managed-agents-2026-04-01`, which the SDK sets on every `client.beta.*` call). Only the fields Offload sends are
 * typed here; `sdkManagedAgents` passes them to `@anthropic-ai/sdk` 1.3.0, so `tsc` checks them against the SDK's
 * own parameter types.
 *
 * This is the only file that constructs an SDK client. It talks to the real API only when `OFFLOAD_CMA_REAL=1` and an
 * API key is set (never in tests or verify); tests pass a `fetch` that answers at the HTTP boundary
 * (`FakeManagedAgents`, which checks every request against the recorded contract in `cma-contract.json`).
 */
import Anthropic from "@anthropic-ai/sdk";

export const CMA_BETA = "managed-agents-2026-04-01";

export type Policy = { type: "always_allow" } | { type: "always_ask" };

export interface LimitedNetworking {
  type: "limited";
  allowed_hosts: string[];
  allow_mcp_servers: boolean;
  allow_package_managers: boolean;
}

export interface EnvironmentParams {
  name: string;
  config: { type: "cloud"; networking: LimitedNetworking };
  metadata?: Record<string, string>;
}

export type AgentToolConfig =
  | { name: "bash"; enabled: boolean; permission_policy: Policy }
  | { name: "web_fetch" | "web_search"; enabled: boolean; permission_policy?: Policy; allowed_domains?: string[] };

export interface AgentToolset {
  type: "agent_toolset_20260401";
  default_config: { enabled: boolean; permission_policy: Policy };
  configs: AgentToolConfig[];
}

export interface McpToolset {
  type: "mcp_toolset";
  mcp_server_name: string;
  default_config: { enabled: boolean; permission_policy: Policy };
  configs: Array<{ name: string; enabled: boolean; permission_policy: Policy }>;
}

export interface CustomTool {
  type: "custom";
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[] };
}

export type Tool = AgentToolset | McpToolset | CustomTool;

export interface AgentParams {
  name: string;
  model: string;
  system: string;
  description?: string;
  mcp_servers: Array<{ type: "url"; name: string; url: string }>;
  tools: Tool[];
  metadata?: Record<string, string>;
}

export interface Money {
  amount: string;
  currency: "USD";
}

export interface Budget {
  type: "limit";
  max_list_cost: Money;
}

export interface UserMessage {
  type: "user.message";
  content: Array<{ type: "text"; text: string }>;
}

export type UserEvent =
  | UserMessage
  | { type: "user.interrupt" }
  | { type: "user.tool_confirmation"; tool_use_id: string; result: "allow" | "deny"; deny_message?: string }
  | { type: "user.custom_tool_result"; custom_tool_use_id: string; content: Array<{ type: "text"; text: string }>; is_error?: boolean };

export interface SessionParams {
  agent: { type: "agent"; id: string; version: number };
  environment_id: string;
  vault_ids: string[];
  budget: Budget;
  title?: string;
  metadata?: Record<string, string>;
}

export interface DeploymentParams {
  name: string;
  agent: { type: "agent"; id: string; version: number };
  environment_id: string;
  vault_ids: string[];
  budget: Budget;
  schedule: { type: "cron"; expression: string; timezone: string };
  initial_events: UserMessage[];
  metadata?: Record<string, string>;
}

export interface CredentialParams {
  display_name: string;
  auth: { type: "static_bearer"; token: string; mcp_server_url: string };
}

/** A session event as the stream and the list endpoint deliver it (only the fields the orchestrator reads). */
export interface SessionEvent {
  id: string;
  type: string;
  processed_at?: string | null;
  name?: string;
  mcp_server_name?: string;
  input?: Record<string, unknown>;
  evaluated_permission?: string;
  stop_reason?: { type: string; event_ids?: string[] } | null;
  [k: string]: unknown;
}

export interface SessionInfo {
  id: string;
  status: string;
  usage: { list_cost?: Money | null };
}

export interface DeploymentRunInfo {
  id: string;
  deployment_id: string;
  created_at: string;
  session_id: string | null;
  error: { type: string; message?: string } | null;
}

export interface ManagedAgentsApi {
  createEnvironment(p: EnvironmentParams): Promise<{ id: string }>;
  updateEnvironment(id: string, p: EnvironmentParams): Promise<{ id: string }>;
  createVault(p: { display_name: string; metadata?: Record<string, string> }): Promise<{ id: string }>;
  createCredential(vaultId: string, p: CredentialParams): Promise<{ id: string }>;
  createAgent(p: AgentParams): Promise<{ id: string; version: number }>;
  createSession(p: SessionParams): Promise<{ id: string }>;
  retrieveSession(id: string): Promise<SessionInfo>;
  deleteSession(id: string): Promise<void>;
  sendEvents(sessionId: string, events: UserEvent[]): Promise<void>;
  /** Resolves once the stream is open (response headers received); iterate for events. */
  streamEvents(sessionId: string, signal?: AbortSignal): Promise<AsyncIterable<SessionEvent>>;
  /** Every event of the session in order, optionally from `createdGte` (RFC 3339) on. */
  listEvents(sessionId: string, createdGte?: string): Promise<SessionEvent[]>;
  createDeployment(p: DeploymentParams): Promise<{ id: string }>;
  pauseDeployment(id: string): Promise<void>;
  unpauseDeployment(id: string): Promise<void>;
  archiveDeployment(id: string): Promise<void>;
  listDeploymentRuns(deploymentId: string, createdGte?: string): Promise<DeploymentRunInfo[]>;
}

export interface ClientOpts {
  apiKey: string;
  baseURL?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

async function all<T>(page: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of page) out.push(x);
  return out;
}

/** The ManagedAgentsApi over `@anthropic-ai/sdk` `client.beta.*`. */
export function sdkManagedAgents(opts: ClientOpts): ManagedAgentsApi {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const b = client.beta;
  // A create is never retried by the SDK: a 5xx or a timeout after the platform made the resource would make a
  // second one (the contract has no idempotency key). The orchestrator decides what an unanswered create means.
  const once = { maxRetries: 0 };
  return {
    createEnvironment: (p) => b.environments.create(p, once),
    updateEnvironment: (id, p) => b.environments.update(id, p),
    createVault: (p) => b.vaults.create(p, once),
    createCredential: (vaultId, p) => b.vaults.credentials.create(vaultId, p, once),
    createAgent: (p) => b.agents.create(p, once),
    createSession: (p) => b.sessions.create(p, once),
    retrieveSession: async (id) => (await b.sessions.retrieve(id)) as unknown as SessionInfo,
    async deleteSession(id) {
      await b.sessions.delete(id);
    },
    async sendEvents(sessionId, events) {
      await b.sessions.events.send(sessionId, { events });
    },
    async streamEvents(sessionId, signal) {
      return (await b.sessions.events.stream(sessionId, {}, signal ? { signal } : {})) as unknown as AsyncIterable<SessionEvent>;
    },
    listEvents: async (sessionId, createdGte) =>
      (await all(b.sessions.events.list(sessionId, { order: "asc", ...(createdGte ? { "created_at[gte]": createdGte } : {}) }))) as unknown as SessionEvent[],
    createDeployment: (p) => b.deployments.create(p, once),
    async pauseDeployment(id) {
      await b.deployments.pause(id);
    },
    async unpauseDeployment(id) {
      await b.deployments.unpause(id);
    },
    async archiveDeployment(id) {
      await b.deployments.archive(id);
    },
    listDeploymentRuns: async (deploymentId, createdGte) =>
      (await all(b.deploymentRuns.list({ deployment_id: deploymentId, ...(createdGte ? { "created_at[gte]": createdGte } : {}) }))) as unknown as DeploymentRunInfo[],
  };
}

/** No client configured: every call fails, so nothing reaches Managed Agents by accident. */
export const disabledManagedAgents: ManagedAgentsApi = new Proxy({} as ManagedAgentsApi, {
  get: () => async () => {
    throw new Error("cloud workers are not configured (no Managed Agents client)");
  },
});

/** The client from the environment: the real API only with OFFLOAD_CMA_REAL=1 and ANTHROPIC_API_KEY set. */
export function managedAgentsFromEnv(env: Record<string, string | undefined> = process.env): ManagedAgentsApi {
  if (env.OFFLOAD_CMA_REAL !== "1" || !env.ANTHROPIC_API_KEY) return disabledManagedAgents;
  return sdkManagedAgents({ apiKey: env.ANTHROPIC_API_KEY });
}
