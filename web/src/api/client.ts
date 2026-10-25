// The one fetch layer every screen uses. `createMockClient` (src/api/mock) and `createHttpClient` (below) implement the
// same interface, so S2-11 swaps the mock for the real API (VITE_API=real) without touching screens.

export type ErrorCode =
  | "unauthorized" | "forbidden" | "not_found" | "conflict" | "validation_failed" | "consent_missing"
  | "feature_disabled" | "group_floor" | "forbidden_binding" | "recipient_not_allowed" | "hash_mismatch"
  | "token_used" | "kill_switch_active" | "budget_exceeded" | "rate_limited" | "replay" | "bad_signature"
  | "server_error";

export const ERROR_CODES: readonly ErrorCode[] = [
  "unauthorized", "forbidden", "not_found", "conflict", "validation_failed", "consent_missing", "feature_disabled",
  "group_floor", "forbidden_binding", "recipient_not_allowed", "hash_mismatch", "token_used", "kill_switch_active",
  "budget_exceeded", "rate_limited", "replay", "bad_signature", "server_error",
];

/** Plain words for every error code. Screens show these, never the raw code or a stack. */
export const ERROR_WORDS: Record<ErrorCode, string> = {
  unauthorized: "You are signed out. Sign in again to continue.",
  forbidden: "Your access role does not allow this.",
  not_found: "This does not exist, or it is outside what you can see.",
  conflict: "Someone changed this at the same time. Reload and try again.",
  validation_failed: "Some of what was sent is not valid. Check the fields and try again.",
  consent_missing: "This person has not acknowledged the current notice yet.",
  feature_disabled: "This feature is off for this company.",
  group_floor: "Fewer than 5 people are in this group, so it is not shown.",
  forbidden_binding: "That connection cannot be used for this step.",
  recipient_not_allowed: "A recipient is outside what the policy allows.",
  hash_mismatch: "The batch changed since you opened it. Reopen it to see the current items.",
  token_used: "This approval was already used.",
  kill_switch_active: "Sending is stopped by a kill switch.",
  budget_exceeded: "The budget for this is used up.",
  rate_limited: "Too many requests. Wait a minute and try again.",
  replay: "This request was already received.",
  bad_signature: "The request signature did not check out.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? ERROR_WORDS[code]);
    this.name = "ApiError";
  }
}

export function errorWords(err: unknown): string {
  if (err instanceof ApiError) return ERROR_WORDS[err.code] ?? ERROR_WORDS.server_error;
  return ERROR_WORDS.server_error;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  /** For text responses (SOP export). */
  getText(path: string): Promise<string>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

/** API.md "Lists": every list endpoint answers `{ items, page: { nextCursor } }`. */
export interface Page<T> {
  items: T[];
  page: { nextCursor: string | null };
}

/** Read every page of a list (limit 200 per page, at most `maxPages`). */
export async function listAll<T>(api: ApiClient, path: string, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const page: Page<T> = await api.get<Page<T>>(`${path}${sep}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...page.items);
    cursor = page.page.nextCursor;
    if (cursor === null) return out;
  }
  return out;
}

const STATUS_CODE: Record<number, ErrorCode> = {
  400: "validation_failed",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "group_floor",
  429: "rate_limited",
};

/** Real API over fetch: cookie session, CSRF header on mutations (from GET /auth/session). */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function createHttpClient(base = "", fetchImpl: FetchLike = (i, init) => fetch(i, init)): ApiClient {
  let csrf: string | null = null;

  async function send(method: string, path: string, body?: unknown, text = false): Promise<unknown> {
    const headers: Record<string, string> = { accept: text ? "text/markdown" : "application/json" };
    if (method !== "GET") {
      if (csrf === null) {
        const s = (await send("GET", "/auth/session")) as { csrfToken: string };
        csrf = s.csrfToken;
      }
      headers["x-csrf-token"] = csrf;
      headers["content-type"] = "application/json; charset=utf-8";
    }
    const res = await fetchImpl(base + path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let code: ErrorCode = STATUS_CODE[res.status] ?? "server_error";
      try {
        const j = (await res.json()) as { error?: { code?: string } };
        if (j.error?.code && (ERROR_CODES as readonly string[]).includes(j.error.code)) code = j.error.code as ErrorCode;
      } catch {
        // body was not JSON; keep the status mapping
      }
      throw new ApiError(code, res.status);
    }
    if (text) return res.text();
    if (res.status === 204) return undefined;
    return res.json();
  }

  return {
    get: <T>(p: string) => send("GET", p) as Promise<T>,
    getText: (p: string) => send("GET", p, undefined, true) as Promise<string>,
    post: <T>(p: string, b?: unknown) => send("POST", p, b ?? {}) as Promise<T>,
    patch: <T>(p: string, b: unknown) => send("PATCH", p, b) as Promise<T>,
    delete: <T>(p: string) => send("DELETE", p) as Promise<T>,
  };
}
