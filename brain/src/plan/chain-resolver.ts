// s20: plan capability needs resolved through the s13 connector chain (the CapabilityResolver seam s14 left).
// Per need the methods are tried in the chain's order and the first healthy one that offers the capability wins:
//   catalog target (Gmail, Slack, ...): its own chain (connector on this Mac, Composio, direct API, computer use);
//   a product a caption named that the catalog does not know (Granola, Linear, Google Docs): connector on this Mac,
//   then Composio through its toolkit (the s17 universe target, generic read / exact-approval commit), then a direct
//   API configured for it, and only then computer use;
//   any other app: its app target's chain (Composio, API, computer use).
// Before s20 every step of a stand-in app resolved to computer use. The chain decides HOW, never WHETHER: every commit
// still passes the approval gate (ADR 0006).
import type { Analysis } from "../analyze.ts";
import type { CapabilityNeedDTO, CapabilityResolutionDTO } from "../api/s14-types.ts";
import { knownTarget, type ChainResolver, type MethodState } from "../connectors/chain.ts";
import type { Method } from "../connectors/link.ts";
import { catalogTarget, GENERIC_COMMIT, GENERIC_READ, SCREEN_READ, toolkitGuess, UI_COMMIT, universeTarget, type ChainTarget } from "../connectors/targets.ts";
import { readUniverse } from "../connectors/universe.ts";
import { knownSurfaceForTargetId } from "../understanding/surfaces.ts";
import { appTargetId, targetOf, type CapabilityResolver } from "./capabilities.ts";

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

/** Where an app was observed: the bundle ids and hosts the observer saw for a target id. */
export interface ObservedIdentity {
  bundleIds: string[];
  hosts: string[];
}
export type ObservedTargets = Map<string, ObservedIdentity>;

const uniq = (xs: readonly string[]) => [...new Set(xs.filter((x) => x !== ""))];

/**
 * s20 review 2 (Codex on 9f12355): the observed identity of every target the analysis' steps use, keyed by the plan's
 * target ids (capabilities.ts targetOf): a site's host (never the browser's bundle id), else the app's bundle id.
 * Observed data wins over the product table, which only supplements what was not observed.
 */
export function observedTargets(a: Pick<Analysis, "insights">): ObservedTargets {
  const out: ObservedTargets = new Map();
  const add = (s: { app: string; appName: string; host: string; surfaceKey: string }) => {
    if (s.app === "" && s.host === "") return;
    const id = targetOf(s).target;
    const web = appTargetId(s.app, s.appName, s.host).startsWith("web-");
    const cur = out.get(id) ?? { bundleIds: [], hosts: [] };
    if (web) cur.hosts = uniq([...cur.hosts, s.host.replace(/^www\./, "")]);
    else if (s.app !== "") cur.bundleIds = uniq([...cur.bundleIds, s.app]);
    out.set(id, cur);
  };
  for (const i of a.insights) {
    const p = i.profile;
    add({ app: p.app, appName: p.appName, host: p.host, surfaceKey: `${p.app}|${p.host}|${p.urlPattern ?? ""}` });
    for (const s of p.understanding?.steps ?? []) add(s);
  }
  return out;
}

/** `base` with the observed identity first, then a stored app target's (GET /connectors), then the table's own. */
function withIdentity(base: ChainTarget, observed: ObservedIdentity | undefined, stored: ChainTarget | null): ChainTarget {
  return {
    ...base,
    bundleIds: uniq([...(observed?.bundleIds ?? []), ...(stored?.bundleIds ?? []), ...base.bundleIds]),
    hosts: uniq([...(observed?.hosts ?? []), ...(stored?.hosts ?? []), ...base.hosts]),
  };
}

/** The app target of a need the catalog does not know (same shape as connectors/targets.ts targetForProfile). The
 * product table gives name and toolkit; bundle ids and hosts come from observation first (see withIdentity). */
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

/** s20 review: what a local document read is called (no account, nothing to set up: the file is on this Mac). */
const LOCAL_FILE_READ = "file.read";
const LOCAL_WORDS = "reading the file on this Mac";

/**
 * s20 review (Codex P2 on 497ffdf): a need is matched to what each METHOD advertises, not only by its exact name.
 * - the exact capability always serves;
 * - computer use reads any app on screen (`screen.read` serves every read need: mail.read, file.read, ...) and does
 *   any UI commit (`ui.commit`): every computer target has the same gated commit tool (computer/executor.ts);
 * - a generic need of an app (`screen.read`, `file.read`, `ui.commit`: "read / change what is in this app") is served
 *   by any read / write a connector on this Mac, Composio or the app's own API advertises for that same app, and by a
 *   universe toolkit's generic read / commit; each commit still waits for exact approval at the gate (ADR 0006);
 * - a specific catalog commit (mail.send, accounting.bill, ...) is never served by a different write.
 */
export function serves(method: Method, s: Pick<MethodState, "health" | "reads" | "writes">, n: Pick<CapabilityNeedDTO, "capability" | "role">, asked: string = n.capability): boolean {
  if (s.health !== "ok") return false;
  if (s.reads.includes(asked) || s.writes.includes(asked)) return true;
  const read = n.role === "read";
  if (method === "computer") return read ? s.reads.includes(SCREEN_READ) : n.capability === UI_COMMIT;
  const generic = read ? n.capability === SCREEN_READ || n.capability === LOCAL_FILE_READ : n.capability === UI_COMMIT;
  if (!generic) return false;
  return read ? s.reads.length > 0 : s.writes.length > 0;
}

export class ChainCapabilityResolver implements CapabilityResolver {
  constructor(
    private readonly chain: ChainResolver,
    private readonly home: string = chain.deps.home,
    /** s20 review 2: where the current analysis saw each target (server: observedTargets of the analysis). */
    private readonly opts: { observed?: () => ObservedTargets | Promise<ObservedTargets> } = {},
  ) {}

  /** The target with its observed identity: catalog targets keep their catalog hosts after the observed ones. */
  private identify(base: ChainTarget, observed: ObservedTargets | null): ChainTarget {
    const stored = base.catalog ? null : knownTarget(this.home, base.id, this.chain.deps.now());
    const t = withIdentity(base, observed?.get(base.id), stored !== null && !stored.catalog ? stored : null);
    // A product the table does not know keeps the toolkit stored with its observed target.
    return !base.catalog && knownSurfaceForTargetId(base.id) === null && stored !== null && !stored.catalog ? { ...t, toolkit: stored.toolkit } : t;
  }

  /** The methods tried for one need, in order, with the capability each is asked for. */
  async attempts(n: CapabilityNeedDTO, observed: ObservedTargets | null = null): Promise<Attempt[]> {
    const cat = catalogTarget(n.target);
    const ct = cat === null ? null : this.identify(cat, observed);
    if (ct !== null) return (await this.chain.resolve(ct)).methods.map((state) => ({ method: state.method, state, capability: n.capability }));
    const app = this.identify(appTarget(n), observed);
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
    // Read once per call (no shared state: the server's one resolver can serve calls at the same time).
    const observed = this.opts.observed === undefined ? null : await Promise.resolve().then(this.opts.observed).catch(() => null);
    const seen = new Set<string>();
    const out: CapabilityResolutionDTO[] = [];
    for (const n of needs) {
      const k = `${n.target}\u0000${n.capability}`;
      if (seen.has(k)) continue;
      seen.add(k);
      // A local document is read from disk first: no method has to be set up for it (the s14 `local` tool option).
      if (n.via === "local_file" && n.role === "read" && n.capability === LOCAL_FILE_READ) {
        out.push({ target: n.target, capability: n.capability, status: "resolved", method: "local", reason: `${n.targetName}: by ${LOCAL_WORDS}.` });
        continue;
      }
      const tried = await this.attempts(n, observed);
      const pick = tried.find((a) => serves(a.method, a.state, n, a.capability));
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
