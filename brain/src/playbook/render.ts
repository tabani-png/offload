// PLAYBOOK.md: a fixed template over playbook.json (same JSON -> same bytes). Outcome lines are counts with their
// sample sizes, or "too few to say"; never a rate.
import type { Playbook, Share } from "./types.ts";

const words = (v: string) => v.replace(/_/g, " ");
const shareLine = (xs: readonly Share[], k = 4) => (xs.length === 0 ? "none" : xs.slice(0, k).map((s) => `${words(s.value)} (${s.count})`).join(", "));

export function renderPlaybookMd(pb: Playbook): string {
  const out: string[] = [
    "---",
    `schema: ${pb.schema}`,
    `version: ${pb.version}`,
    `workflow: ${pb.workflowId}`,
    `channel: ${pb.channel}`,
    `built_at: ${new Date(pb.builtAt).toISOString()}`,
    `messages: ${pb.sources.messages}`,
    `threads: ${pb.sources.threads}`,
    "---",
    "# Messaging playbook",
    "",
    "What these messages say, to whom, in what shape and with what result. Nothing personal is kept: write it in your own voice.",
    "",
    "## The message",
    pb.message,
    "",
    "## Do",
    ...pb.rules.filter((r) => r.kind === "do").map((r) => `- ${r.text}`),
    "",
    "## Don't",
    ...pb.rules.filter((r) => r.kind === "dont").map((r) => `- ${r.text}`),
    "",
    "## Templates",
  ];
  for (const t of pb.templates) {
    out.push(`### ${t.id === "first_touch" ? "First message" : t.id === "follow_up" ? "Follow-up" : "Reply"} (from ${t.from} message${t.from === 1 ? "" : "s"})`, "```", t.text, "```");
    for (const s of t.slots) out.push(`- {${s.slot}}: ${s.says}`);
    out.push("");
  }
  out.push("## Example skeletons");
  pb.skeletons.forEach((s, i) => out.push(`### ${i + 1}`, "```", s, "```"));
  out.push("", "## Cadence");
  const c = pb.cadence;
  if (c.followUps === 0) out.push("- No follow-ups in these messages.");
  else {
    out.push(`- ${c.followUps} follow-up${c.followUps === 1 ? "" : "s"} in ${c.threadsWithFollowUp} of ${c.threads} threads, at most ${c.maxFollowUps} per thread.`);
    out.push(c.medianDaysToFollowUp === null ? `- Days to the first follow-up: too few to say (${c.timingUnclear} follow-up${c.timingUnclear === 1 ? "" : "s"} with no readable gap).` : `- Days to the first follow-up: median ${c.medianDaysToFollowUp}.`);
    out.push(`- How follow-ups change: ${shareLine(c.followUpMoves)}${c.enough ? "" : " (too few to say which works)"}.`);
  }
  out.push("", "## Avoid", ...pb.avoid.map((a) => `- ${a}`), "", "## What got replies");
  const o = pb.outcomes;
  out.push(`- Opening messages: ${o.messages}; replied ${o.replied}, no reply ${o.noReply}, unknown ${o.unknown}. A pattern needs ${o.minSample} known outcomes before it is compared.`);
  for (const p of o.byPattern) {
    const known = p.replied + p.noReply;
    out.push(p.enough ? `- ${p.dimension} ${words(p.value)}: replied ${p.replied}, no reply ${p.noReply} (${known} known of ${p.sent} sent).` : `- ${p.dimension} ${words(p.value)}: too few to say (${known} known of ${p.sent} sent).`);
  }
  const s = pb.stats;
  out.push(
    "",
    "## Counted patterns",
    `- Intent: ${shareLine(s.intent)}.`,
    `- Audience: ${shareLine(s.audience)}.`,
    `- Opener: ${shareLine(s.opener)}.`,
    `- Ask: ${shareLine(s.cta)}; time-boxed ${s.ctaTimeBoxed}.`,
    `- Proof: ${shareLine(s.proof)}.`,
    `- Personal hooks (the kind of fact): ${shareLine(s.hooks)}.`,
    `- Objection handling: ${shareLine(s.objections)}.`,
    `- Length: median ${s.medianWords} words, p90 ${s.p90Words}; links in ${s.messagesWithLinks}, attachments in ${s.messagesWithAttachments}.`,
    "",
    "## Notes",
    pb.notes.trim() === "" ? "(none yet)" : pb.notes.trim(),
    "",
    `_Labels: ${pb.models.label}. Wording: ${pb.models.synthUsed ? pb.models.synth : "computed in code"}. Every count above is computed in code._`,
    "",
  );
  return out.join("\n");
}
