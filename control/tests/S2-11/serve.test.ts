import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSP, IMMUTABLE, REVALIDATE } from "../../src/modules/web/static.ts";
import { asPrincipal, createHarness, type Harness } from "../helpers/harness.ts";

// A dist/ with the shape `vite build` writes: index.html referencing content-hashed assets.
const INDEX = `<!doctype html><html><head><script type="module" crossorigin src="/assets/index-Bx7Q2kLm.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-C9dE3fGh.css"></head><body><div id="root"></div></body></html>`;
const JS = "console.log('app')";

let dist: string;
let h: Harness;
const prior = process.env.OFFLOAD_WEB_DIST;

const raw = (path: string, init: RequestInit = {}) => h.app.request(`http://control.test${path}`, init);

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), "offload-s211-dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), INDEX);
  writeFileSync(join(dist, "assets", "index-Bx7Q2kLm.js"), JS);
  writeFileSync(join(dist, "assets", "index-C9dE3fGh.css"), "body{margin:0}");
  writeFileSync(join(dist, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(dirname(dist), "offload-s211-secret.txt"), "outside the build");
  process.env.OFFLOAD_WEB_DIST = dist;
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
  rmSync(dist, { recursive: true, force: true });
  rmSync(join(dirname(dist), "offload-s211-secret.txt"), { force: true });
  if (prior === undefined) delete process.env.OFFLOAD_WEB_DIST;
  else process.env.OFFLOAD_WEB_DIST = prior;
});

function dirname(p: string) {
  return join(p, "..");
}

describe("SERVE the admin SPA from the control plane", () => {
  test("SERVE: / is index.html with the CSP (default-src 'self'), revalidated on every load", async () => {
    const r = await raw("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await r.text()).toBe(INDEX);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(CSP);
    expect(csp.split("; ")[0]).toBe("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(r.headers.get("cache-control")).toBe(REVALIDATE);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("SERVE: client routes (deep links) load the same shell", async () => {
    for (const p of ["/workflows", "/workflows/0a000000-0000-4000-8000-000000000001/evidence", "/people", "/me"]) {
      const r = await raw(p);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe(INDEX);
      expect(r.headers.get("content-security-policy")).toBe(CSP);
    }
  });

  test("SERVE: hashed assets are cached immutable for a year with their content type", async () => {
    const js = await raw("/assets/index-Bx7Q2kLm.js");
    expect(js.status).toBe(200);
    expect(await js.text()).toBe(JS);
    expect(js.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const css = await raw("/assets/index-C9dE3fGh.css");
    expect(css.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    // Un-hashed files at the root may change between deploys: revalidated.
    const icon = await raw("/favicon.svg");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("cache-control")).toBe(REVALIDATE);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
  });

  test("SERVE: a missing asset is 404, not the HTML shell", async () => {
    const r = await raw("/assets/index-OLDHASH1.js");
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("<html");
  });

  test("SERVE: paths cannot escape the build directory", async () => {
    for (const p of ["/assets/..%2F..%2Foffload-s211-secret.txt", "/..%2Foffload-s211-secret.txt", "/assets/%2e%2e/%2e%2e/offload-s211-secret.txt"]) {
      const r = await raw(p);
      expect(await r.text()).not.toContain("outside the build");
    }
  });

  test("SERVE: API routes are unaffected: same gate, same JSON errors, same handlers", async () => {
    // Unauthenticated API reads stay 401 JSON, unknown API paths stay 404 JSON (never the shell).
    const tenant = await raw("/v1/tenant");
    expect(tenant.status).toBe(401);
    expect(tenant.headers.get("content-type")).toContain("application/json");
    expect(((await tenant.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    const nope = await raw("/v1/no-such-thing");
    expect(nope.status).toBe(404);
    expect(((await nope.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect((await raw("/auth/session")).status).toBe(401);
    // A signed-in read answers JSON with no SPA headers.
    const owner = await asPrincipal(h, "owner");
    const t = await owner.get("/v1/tenant");
    expect(t.status).toBe(200);
    expect(t.json.name).toBe(h.a.name);
    expect(t.headers.get("content-security-policy")).toBeNull();
    // Mutations to non-API paths are not served by the SPA either (the gate answers).
    const post = await raw("/", { method: "POST" });
    expect(post.status).toBe(404);
    expect(post.headers.get("content-type")).toContain("application/json");
  });

  test("SERVE: HEAD answers headers without a body", async () => {
    const r = await raw("/people", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect(await r.text()).toBe("");
  });

  test("SERVE: with no build present the module stays out of the way", async () => {
    process.env.OFFLOAD_WEB_DIST = join(dist, "does-not-exist");
    const h2 = await createHarness();
    try {
      const r = await h2.app.request("http://control.test/");
      expect(r.status).toBe(404);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("not_found");
    } finally {
      process.env.OFFLOAD_WEB_DIST = dist;
      await h2.close();
    }
  });
});
