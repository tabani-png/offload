// s14 user context from onboarding (ADR 0007 point 5): one optional {role, industry}, the only thing Offload asks.
// Stored in $OFFLOAD_HOME/user-context.json (0600). It is the user's own words, not observed content. It is context
// only: it goes to model prompts inside the marked <user_context> block (understanding/context.ts) and never reaches
// grouping or any arithmetic (ADR 0005).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextResponse, UserContextDTO } from "../api/s14-types.ts";
import type { UserContext } from "../types.ts";
import { sanitizeUserContext, USER_CONTEXT_MAX } from "../understanding/context.ts";

export const CONTEXT_FILE = "user-context.json";
export const contextPath = (home: string) => join(home, CONTEXT_FILE);

/** A few suggestions for the onboarding chips. Free text is always allowed. */
export const CONTEXT_SUGGESTIONS = {
  roles: ["Founder", "Recruiter", "Bookkeeper", "Support agent", "Sales ops", "Operations manager"],
  industries: ["Software", "Recruiting", "Accounting", "E-commerce", "Healthcare", "Professional services"],
} as const;

export class ContextError extends Error {}

interface Stored {
  version: 1;
  updatedAt: number;
  context: UserContext;
}

/** The stored context, or undefined when there is none or the file is unreadable (it is optional). */
export function readUserContext(home: string): { context: UserContext | undefined; updatedAt: number | null } {
  const p = contextPath(home);
  if (!existsSync(p)) return { context: undefined, updatedAt: null };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Stored>;
    return { context: sanitizeUserContext(raw.context), updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : null };
  } catch {
    // A broken file is treated as no context; the next PUT replaces it.
    return { context: undefined, updatedAt: null };
  }
}

/** A cheap stamp for caches: changes whenever the file is written. */
export function contextStamp(home: string): string {
  const p = contextPath(home);
  if (!existsSync(p)) return "none";
  const st = statSync(p);
  return `${st.size}:${st.mtimeMs}`;
}

/**
 * Validates a PUT body: only `role` and `industry`, each a string (trimmed, one line, at most 80 characters) or null /
 * "" to clear. A field left out keeps its stored value.
 */
export function parseContextBody(body: Record<string, unknown>, current: UserContext | undefined): UserContext | undefined {
  for (const k of Object.keys(body)) if (k !== "role" && k !== "industry") throw new ContextError(`${k} is not a context field (send role and industry)`);
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const k of ["role", "industry"] as const) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null || v === "") {
      delete next[k];
      continue;
    }
    if (typeof v !== "string") throw new ContextError(`${k} must be a string or null`);
    if (/[\r\n]/.test(v)) throw new ContextError(`${k} must be one line`);
    if (v.trim().length > USER_CONTEXT_MAX) throw new ContextError(`${k} is longer than ${USER_CONTEXT_MAX} characters`);
    next[k] = v;
  }
  return sanitizeUserContext(next);
}

export function writeUserContext(home: string, context: UserContext | undefined, now: number): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const p = contextPath(home);
  const body: Stored = { version: 1, updatedAt: now, context: context ?? {} };
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

export function contextResponse(home: string): ContextResponse {
  const { context, updatedAt } = readUserContext(home);
  const dto: UserContextDTO = { ...(context?.role === undefined ? {} : { role: context.role }), ...(context?.industry === undefined ? {} : { industry: context.industry }) };
  return { version: 1, context: dto, updatedAt, suggestions: { roles: [...CONTEXT_SUGGESTIONS.roles], industries: [...CONTEXT_SUGGESTIONS.industries] } };
}
