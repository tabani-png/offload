// s13: the api and computer ways of connecting, registered into the s10e Connect registry (the seams are filled; the
// route is unchanged). Both answer at once from the chain's probe: there is no browser sign-in for them.
//   api: connected when connectors.json `apis` has the app and its health request answers; else failed with why.
//   computer: connected when computer use is on and allowed (Accessibility, Screen Recording) and the app is here.
// Connecting never sends anything: every action still needs an approved item and the gate.
import { CHAIN_WORDS, type ChainResolver } from "./chain.ts";
import { loadConnectorsConfig } from "./config.ts";
import { LINK_METHODS, METHOD_DETAIL, type LinkMethod, type LinkMethodContext, type LinkProgress, type LinkRegistry, type Method } from "./link.ts";
import type { ChainTarget } from "./targets.ts";

const sentence = (s: string) => (s.endsWith(".") ? s : `${s}.`);

function progressOf(method: Method, ctx: LinkMethodContext, ok: boolean, reason: string | null): LinkProgress {
  const name = ctx.connector.name;
  return {
    method,
    state: ok ? "connected" : "failed",
    url: null,
    message: ok ? `${name} is connected.` : `That way of connecting did not work: ${sentence(reason ?? CHAIN_WORDS.noUsable).replace(/^./, (x) => x.toLowerCase())}`,
    detail: ok ? METHOD_DETAIL[method] : sentence(reason ?? CHAIN_WORDS.noUsable),
    startedAt: ctx.now,
    connectedAt: ok ? ctx.now : null,
    signedIn: ok,
    lastPollAt: 0,
  };
}

/** A way of connecting answered by one chain method's probe (fresh: it re-probes). */
export function chainLinkMethod(method: "api" | "computer", resolver: ChainResolver, targetOf: (id: string) => ChainTarget | null): LinkMethod {
  return {
    method,
    available: true,
    async start(ctx) {
      const t = targetOf(ctx.connector.id);
      if (t === null) return progressOf(method, ctx, false, CHAIN_WORDS.noUsable);
      const d = await resolver.resolve(t, { refresh: true });
      const s = d.methods.find((m) => m.method === method);
      return progressOf(method, ctx, s?.health === "ok", s?.reason ?? null);
    },
    async poll() {},
    usable(id) {
      if (method === "api") return loadConnectorsConfig(resolver.deps.home).config?.apis?.[id] !== undefined;
      const s = resolver.peek(id)?.methods.find((m) => m.method === "computer");
      return s !== undefined ? s.health === "ok" : resolver.deps.simulated || resolver.deps.env.OFFLOAD_COMPUTER_REAL === "1";
    },
  };
}

/** The Connect registry with api and computer filled in. */
export function chainLinkRegistry(resolver: ChainResolver, targetOf: (id: string) => ChainTarget | null): LinkRegistry {
  const r: LinkRegistry = new Map(LINK_METHODS);
  r.set("api", chainLinkMethod("api", resolver, targetOf));
  r.set("computer", chainLinkMethod("computer", resolver, targetOf));
  return r;
}

export const METHOD_WORDS_FOR_LINT: readonly string[] = ["That way of connecting did not work: no direct connection is set up for Gmail.", "Gmail is connected."];
