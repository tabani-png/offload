---
id: s16-commit-schemas
title: Verified gate policies for the commit tools workflows need first
depends_on: [s05b-gate-hardening, s13-connector-chain]
parallel_safe: true (s14 edits brain/src/workflows/** except gate.ts and allowlist.ts, and brain/src/models/**; s16 touches neither)
human_gated: false
verify: bash slices/s16-commit-schemas/verify.sh
---

# s16 Commit schemas

Sources: ADR 0006 (every external action passes the approval gate until auto-run is on), s05b (the allowlist gate:
full-argument hash, one use per item, unknown = deny), s13 (capability catalog: commits stay denied until the
allowlist has their schema, `allowedByGate`). Schemas were read **read-only** with `composio execute <SLUG>
--get-schema` (composio CLI 0.4.2, 2026-10-25) and recorded verbatim in
`brain/tests/s16-commit-schemas/fixtures/composio-schemas.json`. Nothing was executed, `--dry-run` was not used, no
account was touched.

## paths_in_scope
`brain/src/workflows/allowlist.ts`, `brain/src/workflows/gate.ts`, `brain/src/connectors/composio.ts`
(policy selection per item), `brain/src/connectors/capabilities.ts` (catalog entries for drafts),
`brain/tests/s16-commit-schemas/**`, `brain/tests/s05b-gate/allowlist.test.ts` (two pinned assertions, below),
`brain/CONNECTORS.md`, `slices/s16-commit-schemas/**`.

## paths_out_of_scope
Every other file under `brain/src/workflows/**` (s14), `brain/src/models/**` (s14), `engine/**`, `app/**`.
`connectors/targets.ts` (the chain's capability vocabulary) is not changed: catalog targets keep their capabilities
(Slack still `ui.commit`), see Gaps.

## Decisions
1. **Drafts in the user's own mailbox are allowed writes, not commits (ADR 0006).** A draft never leaves the mailbox
   and is not an external action; the user still presses Send. New role `draft`: needs a live, intact batch and a
   declared `draft` step through that connector, the FULL arguments must hash-equal one batch item (recipient,
   subject, body exactly; cc, bcc, extra recipients, attachments, thread id only empty), once per item per run, never
   in a dry run, never for an item that is not `pending`. It does NOT need the approval token and does not mark the item
   `sending` or contacted (the runner's `onAllow` already ignores roles other than `send`). Send-a-draft tools
   (`GMAIL_SEND_DRAFT`, `OUTLOOK_SEND_DRAFT`) and update-draft tools stay denied: a draft is only ever created.
2. **Batch-wide launches stay denied.** `INSTANTLY_ACTIVATE_CAMPAIGN` and `SMARTLEAD_UPDATE_CAMPAIGN_STATUS` start
   sending to every lead in the campaign, not only the approved items, so no item hash can bind them. The workflow adds
   approved leads to a campaign (the per-item commit); starting the campaign stays a human step in the tool.
3. **One item, one tool.** A connector may now have several commit tools (Intercom: conversation reply and ticket
   reply), told apart by the item's commit verb: a policy with `commitVerb` only matches items whose
   `commit.verb` equals it; a policy without one matches only email items (no commit, or verb `send`). Per connector,
   flavour and role, verbs are distinct, so an approved item can be expressed for at most one tool.
4. **Every non-email value comes from the approved item.** Ids, from-addresses, campaign ids, amounts and lines are
   read from `item.commit.fields` (labels below), which are inside the batch hash and shown at review. A missing label
   = the item cannot be expressed = denied.
5. **CRM logs** (HubSpot note, Attio note, Salesforce task) are role `log`: after the item's send, once, with a fixed
   text built from the item (`Offload sent "<subject>" to <to> (batch <12 hex>).`, no body), attached to the record id
   the item names (`hubspot.contact_id`, `attio.record_id`, `salesforce.who_id`).
6. **Bills.** Xero: `Type` must be `ACCPAY` and `Status` must be `DRAFT` (authorising posts to the ledger: a human
   step in Xero); `InvoiceNumber` is refused (Composio warns a matching number updates an existing invoice), the
   supplier's number goes in `Reference`; `tenant_id` is required (no "first connected tenant"). QuickBooks has no
   draft bill: `QUICKBOOKS_CREATE_BILL` posts to A/P and is a commit; bill payments stay denied.
7. **Formula injection.** The sheet log only accepts `valueInputOption: RAW` (`USER_ENTERED` would evaluate an
   approved subject that starts with `=` as a formula) and the Composio expected arguments now include it (Composio
   requires it).
8. **Name rule.** `reply` and `draft` in a tool name still mean deny, except the exact static names reviewed here
   (`REVIEWED_NAMES`); a dynamic policy (api, computer) can never use the exception. `forward`, execute, bash, shell,
   workbench, proxy and multi-execute stay denied always.

## Policies (all Composio, schema CONFIRMED 2026-10-25)
| connector | tool | role | verb | item fields used |
|---|---|---|---|---|
| gmail | GMAIL_CREATE_EMAIL_DRAFT | draft | (email) | to, subject, body |
| outlook | OUTLOOK_SEND_EMAIL | send | (email) | to, subject, body |
| outlook | OUTLOOK_CREATE_DRAFT | draft | (email) | to, subject, body |
| instantly | INSTANTLY_ADD_LEADS_BULK | send | add_to_campaign | to, campaign_id, first_name?, last_name?, company_name?, personalization? |
| smartlead | SMARTLEAD_SEND_SINGLE_EMAIL | send | (email) | to, subject, body, from_email, from_name? |
| smartlead | SMARTLEAD_RESUME_CAMPAIGN_LEAD | send | resume_lead | campaign_id, lead_id |
| hubspot | HUBSPOT_CREATE_NOTE | log | | hubspot.contact_id |
| attio | ATTIO_CREATE_NOTE | log | | attio.record_id |
| salesforce | SALESFORCE_CREATE_TASK | log | | salesforce.who_id |
| xero | XERO_CREATE_INVOICE | send | create_bill | tenant_id, contact_id, date?, due_date?, reference?, currency?, line.N.{description,quantity,unit_amount,account_code,tax_type?} |
| quickbooks | QUICKBOOKS_CREATE_BILL | send | create_bill | vendor_id, txn_date?, due_date?, doc_number?, line.N.{amount,description,account_id} |
| zendesk | ZENDESK_REPLY_ZENDESK_TICKET | send | reply_ticket | ticket_id, body (public only) |
| intercom | INTERCOM_REPLY_TO_CONVERSATION | send | reply_conversation | conversation_id, admin_id, body |
| intercom | INTERCOM_REPLY_TICKET | send | reply_ticket | ticket_id, admin_id, body |
| airtable | AIRTABLE_CREATE_RECORD | send | create_record | base_id, table, field.<name> |
| slack | SLACK_SEND_MESSAGE | send | post_message | channel, body |
| greenhouse | GREENHOUSE_MOVE_APPLICATION | send | move_stage | application_id, from_stage_id, to_stage_id |

## Scope changes (tests outside this slice)
`brain/tests/s05b-gate/allowlist.test.ts` pinned the old name rule: (a) `GMAIL_CREATE_EMAIL_DRAFT` as an example of
"not on the allowlist" (now replaced by `GMAIL_UPDATE_DRAFT`, still denied by name); (b) "no policy name contains
forward, reply, draft, execute, bash" (now: none contains forward, execute or bash, and every reply/draft name is in
`REVIEWED_NAMES`); (c) "at most one send per connector flavour" (now: commit verbs are distinct per connector,
flavour and role; Gmail still has exactly one send per flavour). Test names are unchanged (s05b verify finds them by
id). No other assertion is removed.

## Acceptance (tag = test name prefix in `brain/tests/s16-commit-schemas/`)
- POLICY: for every policy above: the exact arguments are allowed once; every changed leaf denied; replay denied;
  dry run denied; wrong server denied; without approval denied (except drafts); undeclared step denied; nested tool
  call and meta tools denied; an item of another verb does not match.
- SCHEMA: every policy's argument names exist in the recorded live schema, every required schema argument is in the
  expected arguments, and the expected arguments validate (types, enums) against the recorded schema.
- DRAFT: the draft decision (no token needed, declared step, exact hash, once, not in dry run, not for a sent item,
  never marks sending, send-draft and update-draft denied).
- DENIED: activate campaign, campaign status, send draft, bill payment, chat.postMessage, reply-all, forward, contact
  impersonation (Intercom `email`, `user_id`), Xero AUTHORISED / ACCREC / InvoiceNumber, sheet USER_ENTERED.
- EXEC: the Composio CLI executor picks the policy the item's verb selects, runs `composio execute` only after an
  allow, and never for a denied item (fake runner).
- CATALOG: `allowedByGate` is true for every slug above and false for the denied ones.

## Done-signal
`slices/s16-commit-schemas/verify.sh`: typecheck; the s16 suite (>= 60 tests) passes with every tag present and
passing; the whole brain suite passes; no s16 test spawns the real `composio`; the fixture holds every allowlisted
Composio commit; CONNECTORS.md has the schema table with CONFIRMED/UNKNOWN and dates.

## Gaps (not done here)
- The chain does not route to these tools yet: `connectors/targets.ts` gives catalog targets capabilities only for the
  tools in `TOOL_CAPABILITY`, and Instantly, Smartlead, Outlook, Salesforce, Xero, QuickBooks, Zendesk, Intercom,
  Airtable and Greenhouse are not catalog connectors (`catalog.ts`). A workflow builder (s14) has to add the
  capability names and catalog ids; the gate already decides them.
- Instantly reply: Composio's Instantly toolkit has no reply tool (checked 2026-10-25). Lever stage change: no
  Composio tool; the api method (`connectors.json apis`, `PUT /opportunities/{id}/stage`) is the way, with its own
  field schema in the config.
- Vendor MCP server tool schemas: see CONNECTORS.md (UNKNOWN unless a vendor page or repo lists them).
- Instantly and Smartlead campaign copy lives in the tool: the gate binds the campaign id, not the sequence text.
- Drafts are single-use per run, not across runs (no journal entry for a draft).
