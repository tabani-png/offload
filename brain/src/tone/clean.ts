// Strip what the user did not write in this email: quoted replies, forwarded messages, signature blocks.
// Keeps the greeting and the sign-off (they are part of the voice) and splits them out for the style card.
import type { CleanEmail, SentEmail } from "./types.ts";

/** Lines at which the user's own text ends. */
const CUT_RES = [
  /^On .+wrote:\s*$/, // Gmail / Apple Mail reply header
  /^-{2,}\s*(?:forwarded|original) message/i,
  /^-- ?$/, // RFC 3676 signature delimiter
  /^—{1,}\s*$/,
  /^Sent from my /i,
  /^From: .+<[^>]+@[^>]+>\s*$/, // Outlook reply header
];

const CLOSE_RE = /^(?:best|thanks|thank you|cheers|regards|kind regards|best regards|warm regards|speak soon|talk soon|many thanks|all the best)[,.!]?$/i;
const NAME_RE = /^[A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?$/;
const GREETING_RE = /^(?:(?:hi|hello|hey|dear|morning|good morning|afternoon)\b.*|[A-Z][\w ]{0,30}),$/i;

function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.trim() === "") a++;
  while (b > a && lines[b - 1]!.trim() === "") b--;
  return lines.slice(a, b);
}

/** Collapse runs of blank lines to one, trim trailing spaces. */
function tidy(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, "");
    if (l === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(l);
  }
  return trimBlank(out);
}

export function cleanEmail(m: SentEmail): CleanEmail {
  let lines = m.body.replace(/\r\n?/g, "\n").split("\n");
  const cut = lines.findIndex((l) => CUT_RES.some((re) => re.test(l.trim())));
  if (cut >= 0) lines = lines.slice(0, cut);
  lines = tidy(lines.filter((l) => !l.trimStart().startsWith(">")));

  // Sign-off: the last paragraph is either "Close,\nName[\n title/phone...]" or "Name[\n title/phone...]".
  let close: string | null = null;
  let signName: string | null = null;
  const lastBlank = lines.lastIndexOf("");
  const para = lines.slice(lastBlank + 1);
  const ci = para.findIndex((l) => CLOSE_RE.test(l.trim()));
  if (ci >= 0 && para[ci + 1] !== undefined && NAME_RE.test(para[ci + 1]!.trim())) {
    close = para[ci]!.trim();
    signName = para[ci + 1]!.trim();
    lines = [...lines.slice(0, lastBlank + 1 + ci), close, signName];
  } else if (para[0] !== undefined && NAME_RE.test(para[0].trim()) && lastBlank >= 0) {
    signName = para[0].trim();
    lines = [...lines.slice(0, lastBlank + 1), signName];
  }

  const first = lines[0]?.trim() ?? "";
  const greeting = lines.length > 1 && GREETING_RE.test(first) ? first : null;
  const bodyEnd = signName === null ? lines.length : lines.length - (close === null ? 1 : 2);
  const core = tidy(lines.slice(greeting === null ? 0 : 1, bodyEnd)).join("\n");
  return { id: m.id, to: [...m.to], subject: m.subject, sentAt: m.sentAt, text: lines.join("\n"), core, greeting, close, signName };
}
