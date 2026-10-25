// s14: the brain's model for `serve` and the CLI: always the router (ADR 0008). Backend: the Claude API when a key is
// configured (metered, per-route models), else the local Claude Code login through the Agent SDK (unmetered; status
// says "add a Claude key"), or the deterministic stub for tests and demos.
import { ApiBackend, type ApiBackendOptions } from "./api-backend.ts";
import { AgentSdkModel, StubModel, type Model } from "./model.ts";
import { ModelBackend, ModelRouter, RoutedModel } from "./router.ts";

export function createRoutedModel(o: { home: string; stub?: boolean; stubModel?: Model; env?: Readonly<Record<string, string | undefined>>; api?: ApiBackendOptions; now?: () => number }): RoutedModel {
  const env = o.env ?? process.env;
  const backend = o.stub === true ? new ModelBackend("stub", o.stubModel ?? new StubModel()) : (ApiBackend.fromEnv({ env, ...(o.api ?? {}) }) ?? new ModelBackend("claude-code", new AgentSdkModel()));
  return new RoutedModel(new ModelRouter({ home: o.home, backend, env, ...(o.now === undefined ? {} : { now: o.now }) }));
}
