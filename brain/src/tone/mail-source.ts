// Where sent mail comes from. FixtureMailSource for tests and demos; McpMailSource reads a connected MCP server
// (Gmail MCP or Composio, brain/CONNECTORS.md) through a read-only tool. Mail stays on this Mac.
import { SENT_MAIL } from "../../fixtures/sent-mail.ts";
import type { SentEmail } from "./types.ts";

export interface MailSource {
  /** The user's sent emails, newest first, at most `limit`. */
  listSent(opts: { limit: number }): Promise<SentEmail[]>;
}

export class FixtureMailSource implements MailSource {
  constructor(private readonly emails: readonly SentEmail[] = SENT_MAIL) {}
  async listSent(opts: { limit: number }): Promise<SentEmail[]> {
    return [...this.emails].sort((a, b) => b.sentAt - a.sentAt || (a.id < b.id ? -1 : 1)).slice(0, opts.limit);
  }
}

export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface McpMailSourceOptions {
  caller: ToolCaller;
  /** Read tool, e.g. Composio "GMAIL_FETCH_EMAILS" or a Gmail MCP server's "search_emails". */
  tool: string;
  /** Extra arguments, e.g. { query: "in:sent" }. */
  args?: Record<string, unknown>;
  /** Name of the tool's page-size argument. Default "max_results". */
  limitArg?: string;
}

export class McpMailSource implements MailSource {
  constructor(private readonly o: McpMailSourceOptions) {}
  async listSent(opts: { limit: number }): Promise<SentEmail[]> {
    const result = await this.o.caller.callTool(this.o.tool, { ...(this.o.args ?? {}), [this.o.limitArg ?? "max_results"]: opts.limit });
    return parseMailToolResult(result).slice(0, opts.limit);
  }
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : typeof x === "number" ? String(x) : undefined);

function findArray(x: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(x)) return x;
  if (!isObj(x) || depth > 3) return null;
  for (const k of ["messages", "emails", "items", "results", "data", "response_data", "structuredContent"]) {
    const found = findArray(x[k], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function toTime(x: unknown): number {
  const s = str(x);
  if (s === undefined) return 0;
  if (/^\d{10,13}$/.test(s)) return s.length === 10 ? Number(s) * 1000 : Number(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Normalises a mail read tool's result. Accepts the raw MCP result ({ content: [{ type: "text", text: JSON }] } or
 * structuredContent) and common shapes (Composio data.messages[] with messageId/messageText/messageTimestamp, or
 * id/to/subject/body/date). Throws when no message list is found: a wrong tool must not look like an empty mailbox.
 */
export function parseMailToolResult(result: unknown): SentEmail[] {
  let r: unknown = result;
  if (isObj(r) && Array.isArray(r.content) && r.structuredContent === undefined) {
    const text = r.content.map((c) => (isObj(c) && c.type === "text" ? str(c.text) ?? "" : "")).join("");
    try {
      r = JSON.parse(text);
    } catch {
      throw new Error("mail tool returned text that is not JSON");
    }
  }
  const list = findArray(r);
  if (list === null) throw new Error("mail tool result has no message list");
  const out: SentEmail[] = [];
  for (const m of list) {
    if (!isObj(m)) continue;
    const id = str(m.messageId) ?? str(m.id);
    const body = str(m.messageText) ?? str(m.body) ?? str(m.text) ?? str(m.snippet);
    if (id === undefined || body === undefined) continue;
    const toRaw = m.to ?? m.recipients ?? m.recipient;
    const to = Array.isArray(toRaw) ? toRaw.map((t) => str(t) ?? "").filter((t) => t !== "") : (str(toRaw) ?? "").split(",").map((t) => t.trim()).filter((t) => t !== "");
    out.push({ id, to, subject: str(m.subject) ?? "", body, sentAt: toTime(m.messageTimestamp ?? m.date ?? m.internalDate ?? m.sentAt) });
  }
  return out;
}
