import type { ModuleDef } from "../../app.ts";
import { adoptionRoutes } from "./adoption.ts";
import { hoursRoutes } from "./hours.ts";
import { nightlyJob } from "./recompute.ts";
import { syncHandlers } from "./store.ts";

/**
 * Metrics (ADR 0109 serving): storage for the five metric sync kinds, hours saved (hs-1 via packages/hours-saved),
 * evidence, adoption and working time with the group floor, and the nightly recompute check.
 */
const metrics: ModuleDef = {
  name: "metrics",
  routes(app, deps) {
    hoursRoutes(app, deps);
    adoptionRoutes(app, deps);
  },
  syncHandlers,
  jobs: [nightlyJob],
};

export default metrics;
