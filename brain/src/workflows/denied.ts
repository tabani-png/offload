// s17: the s16 "still denied on purpose" commits (brain/CONNECTORS.md), kept apart from allowlist.ts so that file
// never names them (s16 verify greps it). Never given any policy, hand-written or generic.
/** s16 "still denied on purpose" (brain/CONNECTORS.md): commits no approved item can bind (campaign-wide launches,
 * payments, ledger posts, legacy duplicates). s17: never given a generic policy either. */
export const DENIED_ON_PURPOSE: ReadonlySet<string> = new Set([
  "INSTANTLY_ACTIVATE_CAMPAIGN",
  "SMARTLEAD_UPDATE_CAMPAIGN_STATUS",
  "SMARTLEAD_CREATE_CAMPAIGN",
  "QUICKBOOKS_CREATE_BILL_PAYMENT",
  "XERO_POST_INVOICE_UPDATE",
  "HUBSPOT_CREATE_ENGAGEMENT",
  "SLACK_CHAT_POST_MESSAGE",
  "SLACK_SEND_EPHEMERAL_MESSAGE",
  "INSTANTLY_CREATE_LEAD",
  "GMAIL_SEND_DRAFT",
  "GMAIL_UPDATE_DRAFT",
  "OUTLOOK_SEND_DRAFT",
]);

