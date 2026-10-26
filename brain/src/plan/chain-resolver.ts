// s20: plan capability needs resolved through the s13 connector chain (the CapabilityResolver seam s14 left).
// Per need the methods are tried in the chain's order and the first healthy one that offers the capability wins:
//   catalog target (Gmail, Slack, ...): its own chain (connector on this Mac, Composio, direct API, computer use);
//   a product a caption named that the catalog does not know (Granola, Linear, Google Docs): connector on this Mac,
//   then Composio through its toolkit (the s17 universe target, generic read / exact-approval commit), then a direct
//   API configured for it, and only then computer use;
//   any other app: its app target's chain (Composio, API, computer use).
// Before s20 every step of a stand-in app resolved to computer use. The chain decides HOW, never WHETHER: every commit
// still passes the approval gate (ADR 0006).
import type { CapabilityNeedDTO, CapabilityResolutionDTO } from "../api/s14-types.ts";
import type { ChainResolver, MethodState } from "../connectors/chain.ts";
import type { Method } from "../connectors/link.ts";
import { catalogTarget, GENERIC_COMMIT, GENERIC_READ, SCREEN_READ, toolkitGuess, UI_COMMIT, universeTarget, type ChainTarget } from "../connectors/targets.ts";
import { readUniverse } from "../connectors/universe.ts";
import { knownSurfaceForTargetId } from "../understanding/surfaces.ts";
import type { CapabilityResolver } from "./capabilities.ts";

/** Plain words per method (the app's lint refuses internal words). */
const METHOD_WORDS: Record<Method, string> = {
  mcp: "its connector on this Mac",
  composio: "Composio",
  api: "its direct connection",
  computer: "using the app on screen",
};

interface Attempt {
  method: Method;
  state: MethodState;
  /** The capability this method is asked for (a universe toolkit offers generic read / commit). */
  capability: string;
}

/** The app target of a need the catalog does not know (same shape as connectors/targets.ts targetForProfile). */
function appTarget(n: CapabilityNeedDTO): ChainTarget {
  const s = knownSurfaceForTargetId(n.target);
  return {
    id: n.target,
    name: s?.name ?? n.targetName,
    catalog: false,
    bundleIds: s?.app === undefined ? [] : [s.app],
    hosts: s?.host === undefined ? [] : [s.host],
    toolkit: s?.toolkit ?? toolkitGuess(n.targetName),
    reads: [SCREEN_READ],
    sends: [UI_COMMIT],
    logs: [],
  };
}

/** What a universe toolkit is asked for in place of an app target's screen read / UI commit. */
const genericOf = (capability: string, role: CapabilityNeedDTO["role"]) => (role === "read" || capability === SCREEN_READ || capability.endsWith(".read") ? GENERIC_READ : GENERIC_COMMIT);

const offers = (s: MethodState, capability: string) => s.health === "ok" && (s.reads.includes(capability) || s.writes.includes(capability));

export class ChainCapabilityResolver implements CapabilityResolver {
  constructor(
    private readonly chain: ChainResolver,
    private readonly home: string = chain.deps.home,
  ) {}

  /** The methods tried for one need, in order, with the capability each is asked for. */
  async attempts(n: CapabilityNeedDTO): Promise<Attempt[]> {
    const ct = catalogTarget(n.target);
    if (ct !== null) return (await this.chain.resolve(ct)).methods.map((state) => ({ method: state.method, state, capability: n.capability }));
    const app = appTarget(n);
    const own = (await this.chain.resolve(app)).methods.map((state) => ({ method: state.method, state, capability: n.capability }));
    const surface = knownSurfaceForTargetId(n.target);
    const toolkit = surface?.toolkit;
    const idx = toolkit === undefined ? null : readUniverse(this.home);
    const tk = toolkit === undefined || idx === null || !Object.hasOwn(idx.toolkits, toolkit) ? undefined : idx.toolkits[toolkit];
    // Simulated chains (stub model) know a toolkit by its demo sign-in, the way the stub probe does.
    const viaUniverse = tk !== undefined ? universeTarget(tk) : toolkit !== undefined && this.chain.deps.simulated ? universeTarget({ slug: toolkit, name: surface!.name }) : null;
    if (viaUniverse === null) return own;
    const uni = (await this.chain.resolve(viaUniverse)).methods.find((m) => m.method === "composio");
    if (uni === undefined) return own;
    // The toolkit's Composio state replaces the app target's: Composio has no allowlisted tool for an app target.
    return own.map((a) => (a.method === "composio" ? { method: "composio", state: uni, capability: genericOf(n.capability, n.role) } : a));
  }

  async resolve(needs: readonly CapabilityNeedDTO[]): Promise<CapabilityResolutionDTO[]> {
    const seen = new Set<string>();
    const out: CapabilityResolutionDTO[] = [];
    for (const n of needs) {
      const k = `${n.target}\u0000${n.capability}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const tried = await this.attempts(n);
      const pick = tried.find((a) => offers(a.state, a.capability));
      const before = pick === undefined ? tried : tried.slice(0, tried.indexOf(pick));
      const why = before.map((a) => `${METHOD_WORDS[a.method]}: ${a.state.reason ?? "it cannot do this"}`).join(" ");
      out.push(
        pick === undefined
          ? { target: n.target, capability: n.capability, status: "unavailable", method: null, reason: `${n.targetName}: no way works yet. ${why}`.trim() }
          : { target: n.target, capability: n.capability, status: "resolved", method: pick.method, reason: `${n.targetName}: through ${METHOD_WORDS[pick.method]}.${why === "" ? "" : ` Tried first: ${why}`}` },
      );
    }
    return out;
  }
}
