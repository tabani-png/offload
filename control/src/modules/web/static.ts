// Serves the admin SPA (web/dist) from the control plane (SPEC S2-11 SERVE, ADR 0113). Pure request -> response: no
// database, no session. API paths never reach this handler.
import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

/** Paths the API owns. Everything else that is a GET or HEAD is the SPA. */
export const API_PREFIXES = ["/v1/", "/auth/", "/webhooks/"] as const;

/**
 * The page's CSP. Everything from our own origin only; no inline script or style (tokens ship as a built stylesheet),
 * no framing, no plugins, no form posts elsewhere.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Vite names built assets `<name>-<hash>.<ext>`; those never change, so they are cached for a year. */
export const IMMUTABLE = "public, max-age=31536000, immutable";
export const REVALIDATE = "no-cache";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const HASHED = /^\/assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

export function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((p) => pathname.startsWith(p) || pathname === p.slice(0, -1));
}

function headers(type: string, cache: string): Headers {
  const h = new Headers({
    "Content-Type": type,
    "Cache-Control": cache,
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  return h;
}

/** A file under `root`, or null for anything that escapes it, is not a regular file, or does not exist. */
function fileUnder(root: string, pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  const full = resolve(root, `.${rel}`);
  if (full !== root && !full.startsWith(root + sep)) return null;
  if (!existsSync(full)) return null;
  return statSync(full).isFile() ? full : null;
}

export interface StaticSite {
  root: string;
  /** null when `req` is not the SPA's (an API path, a non-GET, or no build present): the caller passes it on. */
  handle(req: Request): Response | null;
}

/** The SPA in `dir` (a `vite build` output), or null when there is no build to serve. */
export function staticSite(dir: string): StaticSite | null {
  const root = resolve(dir);
  const index = join(root, "index.html");
  if (!existsSync(index)) return null;
  return {
    root,
    handle(req) {
      if (req.method !== "GET" && req.method !== "HEAD") return null;
      const { pathname } = new URL(req.url);
      if (isApiPath(pathname)) return null;
      const body = (file: string) => (req.method === "HEAD" ? null : Bun.file(file));
      if (pathname.startsWith("/assets/")) {
        const f = fileUnder(root, pathname);
        // A missing asset is a plain 404, never index.html: a stale tab must not run HTML as a script.
        if (!f) return new Response("not found", { status: 404, headers: headers("text/plain; charset=utf-8", REVALIDATE) });
        const cache = HASHED.test(pathname) ? IMMUTABLE : REVALIDATE;
        return new Response(body(f), { headers: headers(TYPES[extname(f)] ?? "application/octet-stream", cache) });
      }
      const f = pathname === "/" ? null : fileUnder(root, pathname);
      if (f) return new Response(body(f), { headers: headers(TYPES[extname(f)] ?? "application/octet-stream", REVALIDATE) });
      // Client-side routes (/workflows/…, /people, …) all load the shell; the router picks the screen.
      return new Response(body(index), { headers: headers(TYPES[".html"]!, REVALIDATE) });
    },
  };
}
