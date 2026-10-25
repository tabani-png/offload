// Deterministic step: read the recipient list (CSV export of the user's sheet) and pick the next N people not yet
// contacted. Self-contained (no imports) so the copy in a workflow folder runs on its own:
//   bun scripts/recipients.ts recipients.csv crm-log.csv 20
import { existsSync, readFileSync } from "node:fs";

export interface RecipientRow {
  email: string;
  firstName: string;
  lastName: string;
  org: string;
  notes: string;
}

export const RECIPIENTS_HEADER = "email,first_name,last_name,org,notes";

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[A-Za-z]{2,}$/;

export function readRecipients(csv: string): RecipientRow[] {
  const [header, ...rows] = parseCsv(csv);
  if (header === undefined) return [];
  const col = (names: string[]) => header.findIndex((h) => names.includes(h.trim().toLowerCase().replace(/[\s-]+/g, "_")));
  const ci = { email: col(["email", "e_mail", "address"]), first: col(["first_name", "first", "firstname"]), last: col(["last_name", "last", "lastname"]), org: col(["org", "fund", "company", "firm"]), notes: col(["notes", "note", "hook"]) };
  if (ci.email < 0) throw new Error("recipient list needs an email column");
  const seen = new Set<string>();
  const out: RecipientRow[] = [];
  for (const r of rows) {
    const email = (r[ci.email] ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    const get = (i: number) => (i < 0 ? "" : (r[i] ?? "").trim());
    out.push({ email, firstName: get(ci.first), lastName: get(ci.last), org: get(ci.org), notes: get(ci.notes) });
  }
  return out;
}

/** The first n rows, in list order, whose email is not in `contacted`. */
export function pickNext(rows: readonly RecipientRow[], contacted: ReadonlySet<string>, n: number): RecipientRow[] {
  return rows.filter((r) => !contacted.has(r.email)).slice(0, Math.max(0, n));
}

if (import.meta.main) {
  const [list, log, n] = process.argv.slice(2);
  if (list === undefined) {
    console.error("usage: bun scripts/recipients.ts recipients.csv [crm-log.csv] [N]");
    process.exit(2);
  }
  const contacted = new Set<string>();
  if (log !== undefined && existsSync(log)) for (const r of parseCsv(readFileSync(log, "utf8")).slice(1)) if (r[1]) contacted.add(r[1].trim().toLowerCase());
  console.log(JSON.stringify(pickNext(readRecipients(readFileSync(list, "utf8")), contacted, Number(n ?? 20)), null, 2));
}
