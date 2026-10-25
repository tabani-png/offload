import type { ModuleDef } from "../../app.ts";
import { pageParams } from "../../schema/http.ts";
import { useClock, now } from "./clock.ts";
import { allowsAt } from "./consent.ts";
import { enabledFor, featureRoutes } from "./features.ts";
import { noticeRoutes, syncNoticeAck } from "./notices.ts";
import { retentionJob } from "./retention.ts";
import { selfRoutes } from "./selfview.ts";
import { P, replyLocal } from "./schemas.ts";
import { listTemplates } from "./templates.ts";

/**
 * Monitoring compliance (SPEC S2-08, ADR 0108): sensitive feature enablement per jurisdiction, notices and acks,
 * employee self-view and access log, retention, and the compliance pack templates. Provides ConsentPort and FeaturePort.
 */
const compliance: ModuleDef = {
  name: "compliance",
  routes(app, deps) {
    useClock(deps.clock);
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
  provides: {
    consent: { allows: (tx, personId, kind) => allowsAt(tx, personId, kind, now()) },
    features: { enabledFor: (tx, jurisdiction) => enabledFor(tx, jurisdiction, now()) },
  },
};

export default compliance;
