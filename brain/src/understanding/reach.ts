// s12 domain-neutral reach: for every surface a task touches, can an agent get at it? A catalog connector
// (connectors/catalog.ts, read-only use), a local document the agent can read, or the computer-use last resort
// (ADR 0007 chain: MCP -> Composio -> API -> computer use). Task reach = active-time-weighted mean. Pure.
import { connectorsFor, type Connector, type ConnectorMatch } from "../connectors/catalog.ts";
import type { ReachEstimate, SurfaceReach, TaskProfile } from "../types.ts";
import { isDocumentApp } from "./describe.ts";

export const LOCAL_FILE_REACH = 0.8;
export const COMPUTER_USE_REACH = 0.35;

export interface SurfaceUse {
  app: string;
  host: string;
  urlPattern: string;
  activeMs: number;
}

function catalogFor(s: SurfaceUse): Connector | null {
  // connectorsFor only reads app, host, urlPattern and schedulingShare.
  const probe = { app: s.app, host: s.host, urlPattern: s.urlPattern, schedulingShare: 0 } as TaskProfile;
  return connectorsFor(probe).primary;
}

export function surfaceReach(s: SurfaceUse): SurfaceReach {
  const c = catalogFor(s);
  if (c !== null) return { app: s.app, host: s.host, urlPattern: s.urlPattern, via: "catalog", connectorId: c.id, reach: c.reach, activeMs: s.activeMs };
  if (isDocumentApp(s.app)) return { app: s.app, host: s.host, urlPattern: s.urlPattern, via: "local_file", connectorId: null, reach: LOCAL_FILE_REACH, activeMs: s.activeMs };
  return { app: s.app, host: s.host, urlPattern: s.urlPattern, via: "computer_use", connectorId: null, reach: COMPUTER_USE_REACH, activeMs: s.activeMs };
}

export function estimateReach(surfaces: readonly SurfaceUse[]): ReachEstimate {
  const merged = new Map<string, SurfaceUse>();
  for (const s of surfaces) {
    const k = `${s.app}|${s.host}|${s.urlPattern}`;
    const cur = merged.get(k);
    if (cur === undefined) merged.set(k, { ...s });
    else cur.activeMs += s.activeMs;
  }
  const perSurface = [...merged.values()].map(surfaceReach).sort((a, b) => b.activeMs - a.activeMs || (a.app + a.host < b.app + b.host ? -1 : 1));
  const total = perSurface.reduce((n, s) => n + s.activeMs, 0);
  const value = total === 0 ? 0 : perSurface.reduce((n, s) => n + s.reach * s.activeMs, 0) / total;
  return { value: Math.round(value * 1000) / 1000, perSurface };
}

/** ConnectorMatch for a v2 insight: catalog connectors the task's surfaces use (most time first); reachability = reach. */
export function connectorsForReach(reach: ReachEstimate): ConnectorMatch {
  const seen = new Set<string>();
  const all: Connector[] = [];
  for (const s of reach.perSurface) {
    if (s.connectorId === null || seen.has(s.connectorId)) continue;
    seen.add(s.connectorId);
    const probe = { app: s.app, host: s.host, urlPattern: s.urlPattern, schedulingShare: 0 } as TaskProfile;
    const c = connectorsFor(probe).primary;
    if (c !== null) all.push(c);
  }
  return { primary: all[0] ?? null, also: all.slice(1), all, reachability: reach.value };
}
