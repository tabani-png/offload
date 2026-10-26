// s19 playbook personas: sent messages of two more messaging workflows (support ticket replies, recruiter DMs) with
// thread state, and a successor's sent mail in a different voice. Every name, company, address and figure is
// invented. The founder outreach persona is fixtures/sent-mail.ts (SENT_MAIL, FIXTURE_FACTS).
import type { PlaybookMessage } from "../src/playbook/types.ts";
import type { SentEmail } from "../src/tone/types.ts";

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 8, 7, 9, 0, 0);

// ---------- support persona: ticket replies, signed Jordan, Brightcart support ----------

const SUPPORT_SIG = "--\nJordan Lee\nSupport, Brightcart\n+1 415 555 0134 | help.brightcart.com";

type Ticket = [to: string, subject: string, body: string, replied: boolean | null];

const TICKETS: Ticket[] = [
  ["maria.gonzalez@gmail.com", "Re: Order #48213 arrived damaged", "Hi Maria,\n\nSorry your mug arrived broken, that is not the first impression we want. I have sent a replacement today and you do not need to send the old one back.\n\nIt should reach you by Thursday. Can you confirm the delivery address is still 12 Elm Street?\n\nJordan\n\n" + SUPPORT_SIG, true],
  ["kwame.boateng@outlook.com", "Re: Refund for order #48177", "Hi Kwame,\n\nThanks for your patience on this. I have refunded the full $64.00 to your card, it shows within 5 working days.\n\nLet me know if it has not landed by next Friday.\n\nJordan", true],
  ["li.wei@yahoo.com", "Re: Wrong size sent", "Hi Li,\n\nSorry about the mix-up with your order. I have sent the medium today with a free return label for the large.\n\nIt should arrive in 2 working days. Can you confirm that works?\n\nJordan\n\n" + SUPPORT_SIG, true],
  ["oscar.lindqvist@gmail.com", "Re: Where is my parcel", "Hi Oscar,\n\nThanks for flagging this. Your parcel was stuck at the Leeds depot, so I have escalated it with the courier and it should be out for delivery tomorrow.\n\nLet me know if it does not turn up and I will send a new one.\n\nJordan", false],
  ["amira.haddad@icloud.com", "Re: Charged twice", "Hi Amira,\n\nSorry, that second charge was our mistake. I have refunded it and it shows within 3 working days.\n\nCan you confirm you see the refund by Monday?\n\nJordan", true],
  ["tom.becker@gmail.com", "Re: Discount code not working", "Hi Tom,\n\nThanks for your patience. I have fixed the code on our side, SPRING15 now works at checkout.\n\nLet me know if it still gives you trouble.\n\nJordan", true],
  ["ines.duarte@gmail.com", "Re: Order #48302 missing an item", "Hi Ines,\n\nSorry the candle was missing from your box. I have sent it on its own today, it should reach you by Wednesday.\n\nCan you confirm the parcel arrives?\n\nJordan\n\n" + SUPPORT_SIG, null],
  ["pavel.novak@seznam.cz", "Re: Cancel my subscription", "Hi Pavel,\n\nThanks for letting us know. I have cancelled your subscription and you will not be charged again.\n\nLet me know if you change your mind.\n\nJordan", false],
  ["grace.kim@gmail.com", "Re: Damaged lid", "Hi Grace,\n\nSorry your jar lid arrived cracked. I have sent a new lid today, it should reach you by Friday.\n\nCan you confirm the address on the order is right?\n\nJordan", true],
  ["noah.smith@hotmail.com", "Re: Late delivery", "Hi Noah,\n\nSorry this is taking so long, I know it is frustrating. I have escalated it with the courier and it should be with you within 2 working days.\n\nLet me know if it is not there by then.\n\nJordan", null],
];

export const SUPPORT_MESSAGES: readonly PlaybookMessage[] = TICKETS.map(([to, subject, body, replied], i) => ({
  id: `tkt_${String(i + 1).padStart(3, "0")}`,
  channel: "ticket",
  to: [to],
  subject,
  body,
  sentAt: BASE + i * DAY,
  replied,
}));

export const SUPPORT_FACTS = "company: Brightcart\nsign: Jordan\n";

// ---------- recruiter persona: LinkedIn-style DMs, signed Taylor, Fernway (first touches + follow-ups) ----------

type Dm = [to: string, body: string, replied: boolean | null, followUp?: [body: string, days: number, replied: boolean | null]];

const DMS: Dm[] = [
  ["linkedin:hana-sato", "Hi Hana,\n\nSaw you led the payments migration at Stripe, that is exactly the work we need. Fernway is hiring a staff engineer to own our payments platform.\n\nSeries B, 40 engineers, fully remote, £120k base plus equity.\n\nOpen to a 15 minute chat this week?\n\nTaylor", true],
  ["linkedin:diego-alvarez", "Hi Diego,\n\nYou built the search stack at Algolia, which is rare. Fernway is hiring a senior backend engineer for our ledger team.\n\nSeries B, fully remote, £110k base plus equity.\n\nWould a 15 minute call this week work?\n\nTaylor", false, ["Hi Diego,\n\nNo pressure at all. If a call is too much, happy to send the job spec first.\n\nTaylor", 4, true]],
  ["linkedin:priyanka-rao", "Hi Priyanka,\n\nSaw you scaled the data platform at Monzo from 3 to 30 people. Fernway is hiring a head of data to build that team again.\n\nSeries B, 40 engineers, hybrid in London.\n\nOpen to a 20 minute chat?\n\nTaylor", false, ["Hi Priyanka,\n\nJust checking this landed. Happy to send the job spec if that is easier than a call.\n\nTaylor", 5, false]],
  ["linkedin:ben-carter", "Hi Ben,\n\nYou ran the mobile team at Deliveroo through two big launches. Fernway is hiring a mobile lead for our customer app.\n\nSeries B, fully remote, £115k base plus equity.\n\nOpen to a 15 minute chat?\n\nTaylor", true],
  ["linkedin:sofia-meyer", "Hi Sofia,\n\nSaw you shipped the fraud models at Wise. Fernway is hiring a machine learning engineer for risk.\n\nSeries B, 40 engineers, fully remote.\n\nWould a 15 minute call next week work?\n\nTaylor", false, ["Hi Sofia,\n\nNo pressure. If now is not the time, a quick no is fine too, and I can send the job spec for later.\n\nTaylor", 4, null]],
  ["linkedin:arjun-mehta", "Hi Arjun,\n\nYou built the platform team at GoCardless. Fernway is hiring a platform lead.\n\nSeries B, fully remote, £125k base plus equity.\n\nOpen to a 15 minute chat this week?\n\nTaylor", true],
  ["linkedin:emma-wilson", "Hi Emma,\n\nSaw you led design systems at Figma. Fernway is hiring a design engineer to own ours.\n\nSeries B, hybrid in London.\n\nOpen to a 20 minute chat?\n\nTaylor", false, ["Hi Emma,\n\nCircling back on this. If a call is too much, happy to send the job spec first.\n\nTaylor", 6, true]],
];

export const RECRUITER_MESSAGES: readonly PlaybookMessage[] = DMS.flatMap(([to, body, replied, fu], i) => {
  const first: PlaybookMessage = { id: `dm_${String(i + 1).padStart(3, "0")}`, channel: "dm", to: [to], subject: "", body, sentAt: BASE + i * DAY, replied };
  if (fu === undefined) return [first];
  return [first, { id: `dm_${String(i + 1).padStart(3, "0")}_f`, channel: "dm", to: [to], subject: "", body: fu[0], sentAt: first.sentAt + fu[1] * DAY, replied: fu[2] }];
});

export const RECRUITER_FACTS = "company: Fernway\nsign: Taylor\n";

// ---------- successor: a different person taking over the founder's outreach, in their own voice ----------

const SUCC: Array<[to: string, subject: string, body: string]> = [
  ["kim@partnerco.com", "Partnership next steps", "Hello Kim,\n\nThank you for the call on Tuesday. I have written up the three points we agreed and shared them with the team.\n\nCould we find time for a call this week to close the last one?\n\nKind regards,\nDana"],
  ["ravi@supplier.io", "Quarterly review", "Hello Ravi,\n\nThank you for sending the figures over. Overall the quarter looks healthy and the team is pleased with delivery.\n\nCould we find time for a call this week to go through the open items?\n\nKind regards,\nDana"],
  ["office@landlord.co", "Office keys", "Hello,\n\nThank you for arranging the new keys. I will collect them on Friday morning from reception.\n\nKind regards,\nDana"],
  ["ana@agency.studio", "Brand refresh", "Hello Ana,\n\nThank you for the first designs. The team preferred the second direction, with a calmer colour palette.\n\nCould we find time for a call this week to agree the next set of designs?\n\nKind regards,\nDana"],
  ["will@advisor.net", "Advisor catch-up", "Hello Will,\n\nThank you for the introductions last month, two of them turned into good conversations.\n\nCould we find time for a call this week to share what came of them?\n\nKind regards,\nDana"],
  ["hr@offload.so", "Hiring plan", "Hello all,\n\nThank you for the input on the hiring plan. I have merged the comments into one document in the shared drive.\n\nKind regards,\nDana"],
];

export const SUCCESSOR_MAIL: readonly SentEmail[] = SUCC.map(([to, subject, body], i) => ({ id: `succ_${String(i + 1).padStart(3, "0")}`, to: [to], subject, body, sentAt: BASE + i * DAY }));

/** The successor's facts: the same company and offer, their own name, no ask (their examples carry the ask). */
export const SUCCESSOR_FACTS = `# Facts for drafting
company: Offload
pitch: Offload is a Mac app that watches a week of your work and automates the parts that repeat.
raise: Raising a $2.5M seed.
traction: 40 design partners, 3 paying.
sign: Dana
subject: Offload seed round: {org}
`;

/** Phrases and names only the original founder uses: a successor's drafts must not carry them. */
export const FOUNDER_ONLY = ["Muhammad", "Short one", "Straight to it", "Quick intro", "Deck attached", "Worth 20 minutes", "Worth a call"];
