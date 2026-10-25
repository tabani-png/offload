// 40 synthetic sent emails in one voice (short, direct, no fluff, signs "Muhammad"): investor outreach, scheduling,
// follow-ups and a few others. Some carry quoted replies and a signature block so the cleaner has work to do.
// Every name, fund address and figure is invented. Used by FixtureMailSource and the tone tests.
import type { SentEmail } from "../src/tone/types.ts";

const SIG = "--\nMuhammad Ali\nFounder, Offload\n+44 7700 900123 | offload.so";
const BASE = Date.UTC(2026, 8, 1, 9, 0, 0);

type Row = [to: string, subject: string, body: string];

const OUTREACH: Row[] = [
  ["anna@northzone.com", "Offload seed round: Northzone", "Hi Anna,\n\nOffload is a Mac app that watches a week of your work and automates the parts that repeat. You backed Spotify early, so you know what a boring problem at scale looks like.\n\nWe are raising a $2.5M seed. 40 design partners, 3 paying.\n\nWorth 20 minutes next week? Deck attached.\n\nMuhammad"],
  ["james.chen@accel.com", "Offload seed round: Accel", "Hi James,\n\nShort one. Offload watches a week of your work on the Mac and automates the parts that repeat.\n\nRaising a $2.5M seed. 40 design partners, 3 already paying.\n\nWorth a call? I can do any day next week.\n\nMuhammad\n\n" + SIG],
  ["priya@localglobe.vc", "Offload seed round: LocalGlobe", "Hi Priya,\n\nYou wrote about knowledge work still being stuck in copy and paste. We agree and built Offload: a Mac app that learns a week of your work and automates the repeat parts.\n\nWe are raising $2.5M. 40 design partners, 3 paying.\n\nCan I show you in 20 minutes?\n\nMuhammad"],
  ["tom@seedcamp.com", "Offload seed round: Seedcamp", "Hi Tom,\n\nOffload watches a week of your work and takes the repeat tasks off your plate.\n\nRaising a $2.5M seed. 40 design partners, 3 of them paying.\n\nWould you take a 20 minute call next week? Deck attached.\n\nMuhammad"],
  ["sofia.rossi@creandum.com", "Offload seed round: Creandum", "Hi Sofia,\n\nFounders lose hours every week to the same emails and updates. Offload gives them back: it watches a week of work and automates the parts that repeat.\n\nWe are raising $2.5M. 40 design partners, 3 paying.\n\nOpen to a quick call?\n\nMuhammad"],
  ["david@pointnine.com", "Offload seed round: Point Nine", "Hi David,\n\nYou know early SaaS metrics better than anyone, so straight to them: 40 design partners, 3 paying.\n\nOffload is a Mac app that automates the repeat parts of your week. Raising a $2.5M seed.\n\n20 minutes next week?\n\nMuhammad"],
  ["lena.weber@earlybird.com", "Offload seed round: Earlybird", "Hi Lena,\n\nOffload watches a week of your work and automates what repeats. Our design partners get hours back every week.\n\nRaising a $2.5M seed. 40 design partners, 3 paying.\n\nWould a call next Tuesday or Wednesday work?\n\nMuhammad"],
  ["omar@speedinvest.com", "Offload seed round: Speedinvest", "Hi Omar,\n\nOffload: a Mac app that learns your week and automates the repeat parts. Built for founders and small teams.\n\nWe are raising a $2.5M seed. 40 design partners, 3 paying.\n\nOpen to 20 minutes? Deck attached.\n\nMuhammad"],
  ["rachel@frontline.vc", "Offload seed round: Frontline", "Hi Rachel,\n\nQuick intro. Offload watches a week of your work and automates the parts that repeat.\n\nRaising $2.5M. 40 design partners, 3 paying.\n\nCall next week?\n\nMuhammad"],
  ["marc@cherry.vc", "Offload seed round: Cherry Ventures", "Hi Marc,\n\nOffload automates the repeat parts of your week on the Mac. Design partners love it because it removes the copy and paste chase.\n\nWe are raising a $2.5M seed. 40 design partners, 3 paying.\n\n20 minutes next week?\n\nMuhammad\n\n" + SIG],
  ["nina.patel@balderton.com", "Offload seed round: Balderton", "Hi Nina,\n\nOffload watches a week of your work and automates the parts that repeat.\n\nRaising a $2.5M seed. 40 design partners, 3 paying.\n\nOpen to a short call? Deck attached.\n\nMuhammad"],
  ["ben@hoxtonventures.com", "Offload seed round: Hoxton", "Hi Ben,\n\nStraight to it: Offload is a Mac app that automates the repeat parts of your week.\n\nWe are raising $2.5M. 40 design partners, 3 paying.\n\nWould you take a call next week?\n\nMuhammad"],
  ["clara@felixcap.com", "Offload seed round: Felix", "Hi Clara,\n\nOffload gives founders hours back every week. It watches a week of work and automates what repeats.\n\nRaising a $2.5M seed. 40 design partners, 3 paying.\n\n20 minutes?\n\nMuhammad"],
  ["sam.okafor@plural.vc", "Offload seed round: Plural", "Hi Sam,\n\nOffload watches a week of your work and automates the parts that repeat.\n\nWe are raising $2.5M. 40 design partners, 3 of them paying.\n\nOpen to a call next week? Deck attached.\n\nMuhammad"],
  ["julia@mosaicventures.com", "Offload seed round: Mosaic", "Hi Julia,\n\nYou backed Raycast, so Mac productivity is your patch. Offload watches a week of your work and automates the parts that repeat.\n\nRaising a $2.5M seed. 40 design partners, 3 paying.\n\nCan we talk next week?\n\nMuhammad"],
  ["alex@atomico.com", "Offload seed round: Atomico", "Hi Alex,\n\nOffload automates the repeat parts of your week. One week of watching, then it does them.\n\nRaising $2.5M. 40 design partners, 3 paying.\n\nWould 20 minutes next week work?\n\nMuhammad"],
  ["hannah@notion.vc", "Offload seed round: Notion Capital", "Hi Hannah,\n\nOffload is for founders who are tired of doing the same tasks every week. It watches a week of work and automates the repeats.\n\nWe are raising a $2.5M seed. 40 design partners, 3 paying.\n\nOpen to a call?\n\nMuhammad"],
  ["leo@hustlefund.vc", "Offload seed round: Hustle Fund", "Hi Leo,\n\nShort and direct, as you like it. Offload: a Mac app that automates the repeat parts of your week. 40 design partners, 3 paying. Raising $2.5M.\n\n20 minutes next week?\n\nMuhammad"],
];

const SCHEDULING: Row[] = [
  ["anna@northzone.com", "Re: Offload seed round: Northzone", "Hi Anna,\n\nTuesday 2pm or Thursday 10am both work. Send an invite for whichever suits.\n\nMuhammad\n\nOn Mon, 7 Sep 2026 at 16:02, Anna <anna@northzone.com> wrote:\n> Thanks Muhammad, happy to chat. What times work next week?\n> Anna"],
  ["james.chen@accel.com", "Re: Offload seed round: Accel", "Hi James,\n\nThursday at 11am works. I will send a Zoom link.\n\nMuhammad"],
  ["priya@localglobe.vc", "Re: Offload seed round: LocalGlobe", "Hi Priya,\n\nWednesday 3:30pm is good. Invite sent.\n\nMuhammad\n\n" + SIG + "\n\nOn Tue, 8 Sep 2026 at 09:14, Priya <priya@localglobe.vc> wrote:\n> Could we do Wednesday afternoon?"],
  ["tom@seedcamp.com", "Re: Offload seed round: Seedcamp", "Hi Tom,\n\nMonday 9:30am or Tuesday 4pm? Either is fine.\n\nMuhammad"],
  ["sofia.rossi@creandum.com", "Re: Offload seed round: Creandum", "Hi Sofia,\n\nFriday 11am works. Talk then.\n\nMuhammad"],
  ["david@pointnine.com", "Re: Offload seed round: Point Nine", "Hi David,\n\nThanks. Tuesday 2pm is free. I will bring the usage numbers.\n\nMuhammad"],
  ["lena.weber@earlybird.com", "Re: Offload seed round: Earlybird", "Hi Lena,\n\nWednesday works. 10am or 3:30pm?\n\nMuhammad"],
  ["omar@speedinvest.com", "Re: Offload seed round: Speedinvest", "Hi Omar,\n\nNeed to move our call. Could we do Thursday 4pm instead? Sorry for the shuffle.\n\nMuhammad"],
  ["rachel@frontline.vc", "Re: Offload seed round: Frontline", "Hi Rachel,\n\nMonday 11am works. Invite on its way.\n\nMuhammad"],
  ["marc@cherry.vc", "Re: Offload seed round: Cherry Ventures", "Hi Marc,\n\nTuesday 9:30am or Thursday 2pm. Your pick.\n\nMuhammad\n\nOn Wed, 9 Sep 2026 at 18:40, Marc <marc@cherry.vc> wrote:\n> Let's find 30 min next week.\n> Marc"],
  ["nina.patel@balderton.com", "Re: Offload seed round: Balderton", "Hi Nina,\n\nThursday 3:30pm is good. Calendar invite sent.\n\nMuhammad"],
  ["ben@hoxtonventures.com", "Re: Offload seed round: Hoxton", "Hi Ben,\n\nFriday 10am works. See you then.\n\nMuhammad"],
];

const FOLLOW_UP: Row[] = [
  ["clara@felixcap.com", "Re: Offload seed round: Felix", "Hi Clara,\n\nFollowing up on my note last week. Since then two more design partners started paying, 5 now.\n\nStill open to 20 minutes?\n\nMuhammad"],
  ["sam.okafor@plural.vc", "Re: Offload seed round: Plural", "Hi Sam,\n\nBumping this in case it got buried. Happy to send the deck if a call is too much.\n\nMuhammad"],
  ["julia@mosaicventures.com", "Re: Offload seed round: Mosaic", "Hi Julia,\n\nCircling back. We closed half the round this week. Would love you in it.\n\nMuhammad"],
  ["alex@atomico.com", "Re: Offload seed round: Atomico", "Hi Alex,\n\nFollowing up. Any thoughts on the deck?\n\nMuhammad\n\n" + SIG],
  ["hannah@notion.vc", "Re: Offload seed round: Notion Capital", "Hi Hannah,\n\nQuick bump. We are closing the round at the end of the month.\n\nMuhammad"],
  ["leo@hustlefund.vc", "Re: Offload seed round: Hustle Fund", "Hi Leo,\n\nFollowing up on this. Still keen to talk.\n\nMuhammad"],
];

const OTHER: Row[] = [
  ["team@offload.so", "Board pack", "Team,\n\nBoard pack is in the drive. Please check your section by Thursday.\n\nThanks,\nMuhammad"],
  ["grace@brightledger.com", "Your week in Offload", "Hi Grace,\n\nOffload took 3.1 hours of repeat work off your week. Nice work. Anything we should fix before next week?\n\nMuhammad"],
  ["ops@offload.so", "Invoice approvals", "Hi Kemi,\n\nApproved the three invoices. Please pay the AWS one first.\n\nThanks,\nMuhammad"],
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

company: Offload
pitch: Offload is a Mac app that watches a week of your work and automates the parts that repeat.
raise: Raising a $2.5M seed.
traction: 40 design partners, 3 paying.
ask: Worth 20 minutes next week?
sign: Muhammad
subject: Offload seed round: {org}
`;
