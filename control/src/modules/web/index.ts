import { join } from "node:path";
import type { ModuleDef } from "../../app.ts";
import { staticSite } from "./static.ts";

/** `vite build` output of the admin web; `OFFLOAD_WEB_DIST` points elsewhere (deploys, tests). */
export const DEFAULT_WEB_DIST = join(import.meta.dir, "../../../../web/dist");

/**
 * S2-11: the control plane serves the admin SPA (ADR 0113). The RBAC gate in app.ts answers 404 for every path that is
 * not in the permission matrix, before any module route runs, and app.ts is closed to later slices. So this module
 * puts the static site in front of the app's fetch: GET/HEAD for a non-API path is answered from web/dist (index.html
 * for client routes); every other request, and every request when no build is present, goes to the gate unchanged.
 */
const web: ModuleDef = {
  name: "web",
  routes(app) {
    const site = staticSite(process.env.OFFLOAD_WEB_DIST || DEFAULT_WEB_DIST);
    if (!site) return;
    const inner = app.fetch;
    // Hono's `request()` (tests) calls `this.fetch`, so both entry points see the site.
    app.fetch = (req, ...rest) => site.handle(req) ?? inner(req, ...rest);
  },
};

export default web;
