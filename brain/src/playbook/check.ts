// Does a draft follow the playbook? Each checkable rule is tested in code on the draft's own read (read.ts rules, no
// model): yes = every rule holds, partly = at least half, no = fewer. The dry run shows the rule that failed.
import { cleanEmail } from "../tone/clean.ts";
import { maskContacts } from "./mask.ts";
import { ruleRead } from "./read.ts";
import type { MessageRead, Playbook, RuleCheck } from "./types.ts";

export interface PlaybookVerdict {
  version: number;
  verdict: "yes" | "partly" | "no";
  rules: Array<{ id: string; text: string; pass: boolean }>;
}

function holds(c: RuleCheck, r: MessageRead): boolean {
  switch (c.kind) {
    case "cta":
      return r.cta === c.value;
    case "opener":
      return c.values.includes(r.opener);
    case "proof":
      return r.proof.includes(c.value);
    case "move":
      return r.moves.includes(c.value);
    case "max_words":
      return r.shape.words <= c.value;
    case "max_links":
      return r.shape.links <= c.value;
    case "max_questions":
      return r.shape.questions <= c.value;
  }
}

/** The read of a draft: its body without greeting and sign-off, contacts and figures masked. */
export function readDraft(draft: string, role: MessageRead["role"] = "first_touch"): MessageRead {
  const c = cleanEmail({ id: "draft", to: [], subject: "", body: draft, sentAt: 0 });
  return ruleRead(maskContacts(c.core), draft, { id: "draft", threadKey: "draft", role, outcome: "unknown", subject: "" });
}

export function checkPlaybook(draft: string, pb: Playbook): PlaybookVerdict {
  const r = readDraft(draft);
  const rules = pb.rules.filter((x) => x.check !== undefined).map((x) => ({ id: x.id, text: x.text, pass: holds(x.check!, r) }));
  const pass = rules.filter((x) => x.pass).length;
  const verdict = pass === rules.length ? "yes" : pass * 2 >= rules.length ? "partly" : "no";
  return { version: pb.version, verdict, rules };
}
