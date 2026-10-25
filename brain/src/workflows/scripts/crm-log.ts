// Deterministic step: the local CRM log (crm-log.csv). One row per message actually sent. It is also how the
// recipients step knows who was already contacted. Self-contained (no imports).
//   bun scripts/crm-log.ts crm-log.csv     -> prints the contacted addresses
import { existsSync, readFileSync } from "node:fs";

export const CRM_HEADER = "date,email,subject,batch,status";

const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export interface CrmEntry {
  at: number;
  email: string;
  subject: string;
  batch: string;
  status: "sent" | "failed";
}

export function crmLines(entries: readonly CrmEntry[]): string {
  return entries.map((e) => [new Date(e.at).toISOString(), e.email, e.subject, e.batch.slice(0, 12), e.status].map(esc).join(",")).join("\n") + (entries.length > 0 ? "\n" : "");
}

/** Addresses with a "sent" row. */
export function contactedFrom(logCsv: string): Set<string> {
  const out = new Set<string>();
  for (const line of logCsv.split(/\r?\n/).slice(1)) {
    const cols = line.split(",");
    if (cols[1] && cols[cols.length - 1]?.trim() === "sent") out.add(cols[1].trim().toLowerCase());
  }
  return out;
}

if (import.meta.main) {
  const [log] = process.argv.slice(2);
  if (log === undefined) {
    console.error("usage: bun scripts/crm-log.ts crm-log.csv");
    process.exit(2);
  }
  console.log([...contactedFrom(existsSync(log) ? readFileSync(log, "utf8") : "")].join("\n"));
}
