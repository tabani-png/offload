// s14 + s16: the commit of one item in the labelled form the gate expects (brain/CONNECTORS.md "Commit schemas (s16)",
// BatchItem.commit = { verb, fields: [label, value][] }). Values come from what was read (copied by code) and the
// item's identifiers; labels that only the user's account can give (an organisation, an account code, a campaign) are
// listed as `missing`: until they are set once, the gate denies that item, and the review says so in plain words.
// Gate semantics are not touched here: this only fills the fields an approved item carries.
import type { OutputDTO } from "../api/s14-types.ts";
import type { InstanceEvidence } from "./evidence.ts";

export interface CommitSpec {
  tool: string;
  verb: string;
  fields: Array<[string, string]>;
  /** Labels the item still needs before the gate can bind it (set once in the tool's setup, or looked up). */
  missing: string[];
}

/** Plain words for a missing label, for the needs-you line. */
const WORDS: Record<string, string> = {
  tenant_id: "the Xero organisation",
  contact_id: "the supplier in Xero",
  "line.1.account_code": "the expense account",
  vendor_id: "the vendor in QuickBooks",
  "line.1.account_id": "the expense account",
  admin_id: "the Intercom teammate who replies",
  conversation_id: "the conversation",
  ticket_id: "the ticket number",
  application_id: "the application",
  from_stage_id: "the current stage",
  to_stage_id: "the next stage",
  campaign_id: "the campaign",
  channel: "the channel",
  base_id: "the Airtable base",
  table: "the table",
  from_email: "the sending account",
};

export function missingWords(missing: readonly string[]): string {
  return [...new Set(missing.map((m) => WORDS[m] ?? m.replace(/[._]/g, " ")))].join(", ");
}

const idsOf = (inst: InstanceEvidence) => [...inst.bySteps.values()].flatMap((s) => s.identifiers);
const first = (re: RegExp, xs: readonly string[]) => {
  for (const x of xs) {
    const m = re.exec(x);
    if (m?.[1] !== undefined) return m[1];
  }
  return undefined;
};
const field = (out: OutputDTO, re: RegExp) => out.fields.find((f) => re.test(f.label) && f.value !== null)?.value ?? undefined;

/** The labelled commit for the chosen tool, or the plain one (computer use, sheets) with the output's own fields. */
export function commitFor(tool: string | null, verb: string, ours: OutputDTO, inst: InstanceEvidence): CommitSpec {
  const ids = idsOf(inst);
  const text = ours.text ?? "";
  const fields: Array<[string, string]> = [];
  const missing: string[] = [];
  const put = (label: string, v: string | undefined) => (v === undefined || v === "" ? missing.push(label) : fields.push([label, v]));
  switch (tool) {
    case "zendesk":
      put("ticket_id", first(/(?:ticket #|\/tickets\/)(\d+)/i, ids));
      if (text !== "") fields.push(["body", text]);
      return { tool, verb: "reply_ticket", fields, missing };
    case "intercom":
      put("conversation_id", first(/\/conversations?\/(\d+)/i, ids));
      put("admin_id", undefined);
      if (text !== "") fields.push(["body", text]);
      return { tool, verb: "reply_conversation", fields, missing };
    case "xero": {
      put("tenant_id", undefined);
      put("contact_id", undefined);
      const ref = field(ours, /ref|invoice|number/i);
      if (ref !== undefined) fields.push(["reference", ref]);
      const from = field(ours, /from|supplier|vendor|name/i);
      fields.push(["line.1.description", from === undefined ? "Bill" : `Bill from ${from}`]);
      fields.push(["line.1.quantity", "1"]);
      put("line.1.unit_amount", field(ours, /total|amount/i)?.replace(/,/g, ""));
      put("line.1.account_code", undefined);
      return { tool, verb: "create_bill", fields, missing };
    }
    case "quickbooks": {
      put("vendor_id", undefined);
      const ref = field(ours, /ref|invoice|number/i);
      if (ref !== undefined) fields.push(["doc_number", ref]);
      put("line.1.amount", field(ours, /total|amount/i)?.replace(/,/g, ""));
      put("line.1.account_id", undefined);
      return { tool, verb: "create_bill", fields, missing };
    }
    case "greenhouse":
      put("application_id", first(/\/applications\/(\d+)/i, ids));
      put("from_stage_id", undefined);
      put("to_stage_id", undefined);
      return { tool, verb: "move_stage", fields, missing };
    case "instantly":
      put("campaign_id", undefined);
      return { tool, verb: "add_to_campaign", fields, missing };
    case "smartlead":
      put("from_email", undefined);
      return { tool, verb: "email", fields, missing };
    case "gmail":
    case "outlook":
      // An email item carries to, subject and body itself; no labelled fields.
      return { tool, verb: "email", fields, missing };
    case "slack":
      put("channel", undefined);
      if (text !== "") fields.push(["body", text]);
      return { tool, verb: "post_message", fields, missing };
    case "airtable":
      put("base_id", undefined);
      put("table", undefined);
      for (const f of ours.fields) if (f.value !== null) fields.push([`field.${f.label}`, f.value]);
      return { tool, verb: "create_record", fields, missing };
    default:
      // Computer use, sheets and tools without a commit schema: the output's own fields (and text).
      for (const f of ours.fields) if (f.value !== null) fields.push([f.label, f.value]);
      if (text !== "") fields.push(["text", text]);
      return { tool: tool ?? "screen", verb, fields, missing };
  }
}
