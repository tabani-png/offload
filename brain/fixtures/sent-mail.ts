// 40 synthetic sent emails in one voice (short, direct, no fluff, signs "Muhammad"): investor outreach, scheduling,
// follow-ups and a few others. Some carry quoted replies and a signature block so the cleaner has work to do.
// Every name, fund address and figure is invented. Used by FixtureMailSource and the tone tests.
import type { SentEmail } from "../src/tone/types.ts";

const SIG = "--\nMuhammad Ali\nFounder, Acme\n+44 7700 900123 | acme.io";
const BASE = Date.UTC(2026, 8, 1, 9, 0, 0);

type Row = [to: string, subject: string, body: string];

const OUTREACH: Row[] = [
  ["anna@northzone.com", "Acme seed round: Northzone", "Hi Anna,\n\nAcme closes the month for finance teams in two days instead of ten. You backed Spotify early, so you know what a boring problem at scale looks like.\n\nWe are raising a $3M seed. $40k MRR, 18% month over month, 31 paying customers.\n\nOpen to 20 minutes next week? Deck attached.\n\nMuhammad"],
  ["james.chen@accel.com", "Acme seed round: Accel", "Hi James,\n\nShort one. Acme automates the month-end close for finance teams. Two days instead of ten.\n\nRaising a $3M seed. $40k MRR, growing 18% a month, 31 customers paying.\n\nWorth a call? I can do any day next week.\n\nMuhammad\n\n" + SIG],
  ["priya@localglobe.vc", "Acme seed round: LocalGlobe", "Hi Priya,\n\nYou wrote about finance tooling being stuck in 2010. We agree and built Acme: the month-end close in two days, not ten.\n\nWe are raising $3M. $40k MRR, 18% MoM, 31 customers.\n\nCan I show you in 20 minutes?\n\nMuhammad"],
  ["tom@seedcamp.com", "Acme seed round: Seedcamp", "Hi Tom,\n\nAcme takes the month-end close from ten days to two for finance teams.\n\nRaising a $3M seed. $40k MRR, up 18% each month, 31 paying customers.\n\nWould you take a 20 minute call next week? Deck attached.\n\nMuhammad"],
  ["sofia.rossi@creandum.com", "Acme seed round: Creandum", "Hi Sofia,\n\nFinance teams lose a week every month to the close. Acme gives it back: two days instead of ten.\n\nWe are raising $3M. $40k MRR, 18% MoM, 31 customers.\n\nOpen to a quick call?\n\nMuhammad"],
  ["david@pointnine.com", "Acme seed round: Point Nine", "Hi David,\n\nYou know SaaS metrics better than anyone, so straight to them: $40k MRR, 18% month over month, 31 paying customers.\n\nAcme closes the books in two days instead of ten. Raising a $3M seed.\n\n20 minutes next week?\n\nMuhammad"],
  ["lena.weber@earlybird.com", "Acme seed round: Earlybird", "Hi Lena,\n\nAcme automates the month-end close. Our customers go from ten days to two.\n\nRaising $3M seed. $40k MRR, 18% MoM, 31 customers.\n\nWould a call next Tuesday or Wednesday work?\n\nMuhammad"],
  ["omar@speedinvest.com", "Acme seed round: Speedinvest", "Hi Omar,\n\nAcme: month-end close in two days, not ten. Built for finance teams of 3 to 30.\n\nWe are raising a $3M seed. $40k MRR, growing 18% a month, 31 paying.\n\nOpen to 20 minutes? Deck attached.\n\nMuhammad"],
  ["rachel@frontline.vc", "Acme seed round: Frontline", "Hi Rachel,\n\nQuick intro. Acme closes the books for finance teams in two days instead of ten.\n\nRaising $3M. $40k MRR, 18% MoM, 31 customers.\n\nCall next week?\n\nMuhammad"],
  ["marc@cherry.vc", "Acme seed round: Cherry Ventures", "Hi Marc,\n\nAcme cuts the month-end close from ten days to two. Finance teams love it because it removes the spreadsheet chase.\n\nWe are raising a $3M seed. $40k MRR, 18% month over month, 31 customers.\n\n20 minutes next week?\n\nMuhammad\n\n" + SIG],
  ["nina.patel@balderton.com", "Acme seed round: Balderton", "Hi Nina,\n\nAcme does the month-end close in two days instead of ten.\n\nRaising a $3M seed. $40k MRR, 18% MoM, 31 paying customers.\n\nOpen to a short call? Deck attached.\n\nMuhammad"],
  ["ben@hoxtonventures.com", "Acme seed round: Hoxton", "Hi Ben,\n\nStraight to it: Acme automates the close for finance teams. Two days, not ten.\n\nWe are raising $3M. $40k MRR, 18% a month, 31 customers.\n\nWould you take a call next week?\n\nMuhammad"],
  ["clara@felixcap.com", "Acme seed round: Felix", "Hi Clara,\n\nAcme gives finance teams a week back every month. The close takes two days instead of ten.\n\nRaising a $3M seed. $40k MRR, 18% MoM, 31 customers.\n\n20 minutes?\n\nMuhammad"],
  ["sam.okafor@plural.vc", "Acme seed round: Plural", "Hi Sam,\n\nAcme closes the books in two days instead of ten for finance teams.\n\nWe are raising $3M. $40k MRR, growing 18% month over month, 31 paying customers.\n\nOpen to a call next week? Deck attached.\n\nMuhammad"],
  ["julia@mosaicventures.com", "Acme seed round: Mosaic", "Hi Julia,\n\nYou backed Paddle, so finance infrastructure is your patch. Acme takes the month-end close from ten days to two.\n\nRaising a $3M seed. $40k MRR, 18% MoM, 31 customers.\n\nCan we talk next week?\n\nMuhammad"],
  ["alex@atomico.com", "Acme seed round: Atomico", "Hi Alex,\n\nAcme automates the month-end close. Two days instead of ten.\n\nRaising $3M. $40k MRR, 18% a month, 31 paying customers.\n\nWould 20 minutes next week work?\n\nMuhammad"],
  ["hannah@notion.vc", "Acme seed round: Notion Capital", "Hi Hannah,\n\nAcme is the close for finance teams that are tired of chasing spreadsheets. Ten days becomes two.\n\nWe are raising a $3M seed. $40k MRR, 18% MoM, 31 customers.\n\nOpen to a call?\n\nMuhammad"],
  ["leo@hustlefund.vc", "Acme seed round: Hustle Fund", "Hi Leo,\n\nShort and direct, as you like it. Acme: month-end close in two days, not ten. $40k MRR, 18% MoM, 31 customers. Raising $3M.\n\n20 minutes next week?\n\nMuhammad"],
];

const SCHEDULING: Row[] = [
  ["anna@northzone.com", "Re: Acme seed round: Northzone", "Hi Anna,\n\nTuesday 2pm or Thursday 10am both work. Send an invite for whichever suits.\n\nMuhammad\n\nOn Mon, 7 Sep 2026 at 16:02, Anna <anna@northzone.com> wrote:\n> Thanks Muhammad, happy to chat. What times work next week?\n> Anna"],
  ["james.chen@accel.com", "Re: Acme seed round: Accel", "Hi James,\n\nThursday at 11am works. I will send a Zoom link.\n\nMuhammad"],
  ["priya@localglobe.vc", "Re: Acme seed round: LocalGlobe", "Hi Priya,\n\nWednesday 3:30pm is good. Invite sent.\n\nMuhammad\n\n" + SIG + "\n\nOn Tue, 8 Sep 2026 at 09:14, Priya <priya@localglobe.vc> wrote:\n> Could we do Wednesday afternoon?"],
  ["tom@seedcamp.com", "Re: Acme seed round: Seedcamp", "Hi Tom,\n\nMonday 9:30am or Tuesday 4pm? Either is fine.\n\nMuhammad"],
  ["sofia.rossi@creandum.com", "Re: Acme seed round: Creandum", "Hi Sofia,\n\nFriday 11am works. Talk then.\n\nMuhammad"],
  ["david@pointnine.com", "Re: Acme seed round: Point Nine", "Hi David,\n\nThanks. Tuesday 2pm is free. I will bring the cohort numbers.\n\nMuhammad"],
  ["lena.weber@earlybird.com", "Re: Acme seed round: Earlybird", "Hi Lena,\n\nWednesday works. 10am or 3:30pm?\n\nMuhammad"],
  ["omar@speedinvest.com", "Re: Acme seed round: Speedinvest", "Hi Omar,\n\nNeed to move our call. Could we do Thursday 4pm instead? Sorry for the shuffle.\n\nMuhammad"],
  ["rachel@frontline.vc", "Re: Acme seed round: Frontline", "Hi Rachel,\n\nMonday 11am works. Invite on its way.\n\nMuhammad"],
  ["marc@cherry.vc", "Re: Acme seed round: Cherry Ventures", "Hi Marc,\n\nTuesday 9:30am or Thursday 2pm. Your pick.\n\nMuhammad\n\nOn Wed, 9 Sep 2026 at 18:40, Marc <marc@cherry.vc> wrote:\n> Let's find 30 min next week.\n> Marc"],
  ["nina.patel@balderton.com", "Re: Acme seed round: Balderton", "Hi Nina,\n\nThursday 3:30pm is good. Calendar invite sent.\n\nMuhammad"],
  ["ben@hoxtonventures.com", "Re: Acme seed round: Hoxton", "Hi Ben,\n\nFriday 10am works. See you then.\n\nMuhammad"],
];

const FOLLOW_UP: Row[] = [
  ["clara@felixcap.com", "Re: Acme seed round: Felix", "Hi Clara,\n\nFollowing up on my note last week. Since then we signed two more customers, 33 now.\n\nStill open to 20 minutes?\n\nMuhammad"],
  ["sam.okafor@plural.vc", "Re: Acme seed round: Plural", "Hi Sam,\n\nBumping this in case it got buried. Happy to send the deck if a call is too much.\n\nMuhammad"],
  ["julia@mosaicventures.com", "Re: Acme seed round: Mosaic", "Hi Julia,\n\nCircling back. We closed half the round this week. Would love you in it.\n\nMuhammad"],
  ["alex@atomico.com", "Re: Acme seed round: Atomico", "Hi Alex,\n\nFollowing up. Any thoughts on the deck?\n\nMuhammad\n\n" + SIG],
  ["hannah@notion.vc", "Re: Acme seed round: Notion Capital", "Hi Hannah,\n\nQuick bump. We are closing the round at the end of the month.\n\nMuhammad"],
  ["leo@hustlefund.vc", "Re: Acme seed round: Hustle Fund", "Hi Leo,\n\nFollowing up on this. Still keen to talk.\n\nMuhammad"],
];

const OTHER: Row[] = [
  ["team@acme.io", "Board pack", "Team,\n\nBoard pack is in the drive. Please check your section by Thursday.\n\nThanks,\nMuhammad"],
  ["finance@brightledger.com", "Your close this month", "Hi Grace,\n\nYour close finished in 1.8 days this month. Nice work. Anything we should fix before next month?\n\nMuhammad"],
  ["ops@acme.io", "Invoice approvals", "Hi Kemi,\n\nApproved the three invoices. Please pay the AWS one first.\n\nThanks,\nMuhammad"],
  ["lawyer@hartlaw.co.uk", "SAFE side letter", "Hi Peter,\n\nComments on the side letter attached. Two changes, both small. Can you turn it today?\n\nMuhammad\n\n---------- Forwarded message ---------\nFrom: Nina Patel <nina.patel@balderton.com>\nDate: Thu, 10 Sep 2026\nSubject: Side letter\n> See attached."],
];

function rows(list: Row[], offsetDays: number): SentEmail[] {
  return list.map(([to, subject, body], i) => ({
    id: `sent_${String(offsetDays * 100 + i + 1).padStart(4, "0")}`,
    to: [to],
    subject,
    body,
    sentAt: BASE + (offsetDays + i) * 3_600_000 * 5,
  }));
}

export const SENT_MAIL: readonly SentEmail[] = [...rows(OUTREACH, 0), ...rows(SCHEDULING, 1), ...rows(FOLLOW_UP, 2), ...rows(OTHER, 3)];

/** Facts for the fixture founder, in the facts.md format the workflow drafter writes. */
export const FIXTURE_FACTS = `# Facts for drafting
Only these facts may appear in drafts. Edit freely.

company: Acme
pitch: Acme closes the month for finance teams in two days instead of ten.
raise: Raising a $3M seed.
traction: $40k MRR, 18% month over month, 31 paying customers.
ask: Open to 20 minutes next week? Deck attached.
sign: Muhammad
subject: Acme seed round: {org}
`;
