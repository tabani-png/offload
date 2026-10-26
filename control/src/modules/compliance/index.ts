import type { Deps, ModuleDef } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import type { ConsentPort, FeaturePort } from "../../ports.ts";
import { pageParams } from "../../schema/http.ts";
import { allowsAt, requiredNoticeAt, workingTimeStartsAt } from "./consent.ts";
import { enabledFor, featureRoutes } from "./features.ts";
import { noticeRoutes, syncNoticeAck } from "./notices.ts";
import { retentionJob } from "./retention.ts";
import { selfRoutes } from "./selfview.ts";
import { P, replyLocal } from "./schemas.ts";
import { listTemplates } from "./templates.ts";

/**
 * `ModuleDef.provides` is read before any app (and so any clock) exists, and one module object serves every app in the
 * process. So `provides` only claims the two ports; mounting swaps each claim in that app's own `deps.ports` for a port
 * bound to that app's clock. Nothing module-global holds a clock, so two apps never decide by each other's time.
 * A claim that was never swapped (ports resolved without mounting) refuses to answer rather than guess a time.
 */
const unmounted = (): never => {
  throw new Error("compliance ports answer only once the module is mounted in an app (createApp)");
};
/**
 * ConsentPort plus the extras the sync slice's device config reads when present (ports.ts names only `allows`): the
 * notice the person must acknowledge and when working time may start for them, both "now" by the app's clock.
 */
interface CompliancePort extends ConsentPort {
  requiredNotice(tx: Tx, personId: string): ReturnType<typeof requiredNoticeAt>;
  workingTimeStartsAt(tx: Tx, personId: string): Promise<number | null>;
}
const claimed = {
  consent: {
    allows: async () => unmounted(),
    requiredNotice: async () => unmounted(),
    workingTimeStartsAt: async () => unmounted(),
  } satisfies CompliancePort,
  features: { enabledFor: async () => unmounted() } satisfies FeaturePort,
};

/** Binds the ports this module provides to this app's clock, unless the app overrode them (test spies). */
function bindPorts(deps: Deps): void {
  const clock = deps.clock;
  if (deps.ports.consent === claimed.consent) {
    const consent: CompliancePort = {
      allows: (tx, personId, kind) => allowsAt(tx, personId, kind, clock.now()),
      requiredNotice: (tx, personId) => requiredNoticeAt(tx, personId, clock.now()),
      workingTimeStartsAt: (tx, personId) => workingTimeStartsAt(tx, personId, clock.now()),
    };
    deps.ports.consent = consent;
  }
  if (deps.ports.features === claimed.features) {
    deps.ports.features = { enabledFor: (tx, jurisdiction) => enabledFor(tx, jurisdiction, clock.now()) };
  }
}

/**
 * Monitoring compliance (SPEC S2-08, ADR 0108): sensitive feature enablement per jurisdiction, notices and acks,
 * employee self-view and access log, retention, and the compliance pack templates. Provides ConsentPort and FeaturePort.
 */
const compliance: ModuleDef = {
  name: "compliance",
  routes(app, deps) {
    bindPorts(deps);
    featureRoutes(app, deps);
    noticeRoutes(app, deps);
    selfRoutes(app, deps);
    app.get("/v1/compliance/templates", async (c) => {
      pageParams(c);
      // Eleven static files: always one page.
      const items = listTemplates().map((t) => ({ id: t.id, title: t.title, jurisdictions: t.jurisdictions }));
      const out = { items, page: { nextCursor: null } };
      return replyLocal(c, deps, 200, out, `${P}/template-list.json`);
    });
  },
  syncHandlers: { notice_ack: syncNoticeAck },
  jobs: [retentionJob],
  provides: claimed,
};

export default compliance;
