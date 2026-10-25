# 04 · Continuity after an employee leaves

Date: 2026-10-25. Scope: S2-08 (continuity), S2-03 (registry), S2-01 (deprovisioning).
Tags: CONFIRMED = read in source (URL given) · INFERENCE = my reasoning · UNKNOWN = not found.

---

## Headline

- **Company-owned channels can keep running; personal ones cannot.** Work mailboxes, domains, cold-email sender accounts, CRM records, Drive files and company LinkedIn Pages belong to the company and have official hand-over tools. A personal LinkedIn profile belongs to the person, LinkedIn bans automation of it, and sharing it is prohibited.
- **Never keep sending as the departed person.** Continue as a named successor or a role identity (e.g. `sales@`), with a hand-over notice. Sending under a departed person's name is misleading to recipients and risks anti-spam rules. INFERENCE (see 4.3).
- Plan principle 3 is right. This file turns it into concrete product rules.

---

## 1. Email

| # | Fact | Tag | Source |
|---|---|---|---|
| 1.1 | Google Workspace: before or during deletion a super admin can **transfer** Drive/Docs files, Google Sites, primary Calendar data and Data Studio assets to another user. Gmail is not in that transfer list. Deleting removes "their email, contacts, Drive and Docs files, Calendar data ...". | CONFIRMED | https://knowledge.workspace.google.com/admin/users/delete-or-remove-a-user-from-your-organization |
| 1.2 | Google Workspace: Gmail is moved with the **data migration service** into another account, or kept by **archiving** the user (Archived User licence; frees the main licence within 24 h; with Vault, data stays searchable/exportable under retention rules). | CONFIRMED (migration options listed; archive behaviour from Google Help thread quoting docs) | https://support.google.com/edu/setup/answer/1041297 ; https://support.google.com/a/thread/346088730 |
| 1.3 | Google Workspace: common pattern is to add the departed address as an **alternate address (alias)** of the successor or a group/collaborative inbox, so replies keep arriving. Mailbox **delegation** needs the account to stay active. | INFERENCE (standard admin practice; specific help article not read) | — |
| 1.4 | Microsoft 365: **convert the user mailbox to a shared mailbox**; license needed only to convert; afterwards remove the license if under **50 GB**; keep the account object as anchor; block sign-in. Alternative: forward to another employee. | CONFIRMED | https://learn.microsoft.com/en-us/microsoft-365/admin/email/convert-user-mailbox-to-shared-mailbox ; https://learn.microsoft.com/en-us/microsoft-365/admin/add-users/remove-former-employee-step-4 |
| 1.5 | Cold-email platforms: sending mailboxes are connected to the company workspace, not the person. Smartlead has a **"Reallocate Mailboxes"** feature for live or paused campaigns. | CONFIRMED (feature exists) | https://helpcenter.smartlead.ai/en/articles/231-what-is-the-reallocate-mailboxes-feature-and-how-to-use-it |
| 1.6 | Instantly: equivalent sender-swap and unibox reassignment details. | UNKNOWN | not found in this pass |
| 1.7 | Sender identity rules: CAN-SPAM forbids materially misleading header and "from" information; CASL requires the message to identify the person sending it and on whose behalf. A sequence that keeps signing as a person who has left, or replies as them, is exposed under both. | INFERENCE (statutes not re-read here; get counsel to confirm) | — |

## 2. LinkedIn

| # | Fact | Tag | Source |
|---|---|---|---|
| 2.1 | "As between you and others (including your employer), **your account belongs to you**. However, if the Services were purchased by another party for you to use ..." (the purchaser may control the paid service, e.g. a Sales Navigator seat). | CONFIRMED (quoted in search excerpt of the agreement) | https://www.linkedin.com/legal/user-agreement |
| 2.2 | "You will **not share your account** with anyone else." | CONFIRMED (same excerpt) | same |
| 2.3 | §8.2 bans using "**bots or other unauthorized automated methods** to access the Services, add or download contacts, send or redirect messages, create, comment on, like, share, or re-share posts, or otherwise drive inauthentic engagement", and third-party software, crawlers, plug-ins or extensions that scrape or automate activity; members "risk having their accounts restricted or shut down". | CONFIRMED (help page + secondary quote of §8.2) | https://www.linkedin.com/help/linkedin/answer/a1341387 ; secondary quote https://contentin.io/blog/linkedin-mcp-terms-of-service/ |
| 2.4 | Sales Navigator has an official **data transfer** between corporate dashboards (leads, accounts, searches, notes; InMail moves to the new dashboard; 24-48 h; overwrites target data). Whether an admin can move a departed user's data to a **different person** was not confirmed. | CONFIRMED (feature) / UNKNOWN (cross-person) | https://www.linkedin.com/help/sales-navigator/answer/a105006 ; https://www.linkedin.com/help/sales-navigator/answer/a8006942 |
| 2.5 | Legitimate company channel: **Company Page** with multiple admins, posting and replying through LinkedIn's approved Community Management / Pages APIs. | INFERENCE (API terms not read this pass) | — |
| 2.6 | Note: Offload's operator stack already includes a LinkedIn automation vendor (LeadShark MCP) that acts through the user's own account with budgets and approvals. Even with such tools, automating a **departed** person's account is off-limits by 2.1-2.3 and because the person no longer authorises it. | INFERENCE | — |

## 3. What Offload must do (S2-08 product rules)

1. **Ownership tags on every workflow step**: each connection is `company` (org OAuth / service account / shared mailbox / Company Page / CRM), `personal-allowed` (e.g. employee's own LinkedIn under their own control) or `personal-forbidden`. Only `company` steps can continue after offboarding.
2. **Offboarding trigger**: SCIM/directory deactivation or admin action → within minutes: revoke the person's tokens, stop all runs that use their personal connections, freeze their Mac sync, open a **hand-over task** for the admin/department lead. Nothing runs again until a successor or role is assigned. (Never "silently continue".)
3. **Successor assignment**: admin picks a named successor or a role identity per workflow. Commits resume under the successor's or role's identity and signature, with the successor's approval rules.
4. **Inbox continuity**: Offload does not move mailboxes itself. It shows the admin the right native step (Google: migrate/alias/archive; Microsoft: convert to shared mailbox) and then re-points its email connection to the shared mailbox or successor. Replies to open threads get routed to the successor's approval queue.
5. **Hand-over notice for live sequences**: before any further outreach from an in-flight sequence, insert a one-time hand-over message from the successor ("X has moved on; I am picking this up") or pause the sequence. Default: pause, successor chooses.
6. **LinkedIn**: on departure, all steps on that person's LinkedIn stop permanently and the connection is deleted from Offload. Offer migration to (a) the successor's own LinkedIn, run only with the successor's consent and with human approval on every send, or (b) the Company Page via approved APIs. Never store or reuse a departed person's LinkedIn session or cookies. No shared or "team" logins into personal profiles.
7. **Knowledge becomes SOPs, not access**: the departed person's promoted workflows stay in the registry as versioned SOPs (steps, rules, templates), stripped of personal tokens and personal data such as private messages.
8. **Audit**: record who assigned the successor, when sending resumed, and under which identity.
9. **Employee transparency**: the monitoring/automation notice (file 02) states that role workflows are company property and continue after departure, and that personal accounts are disconnected on exit.

## TO CONFIRM
- TC1. Google Workspace help: alternate address after deletion, and delegation limits.
- TC2. Sales Navigator admin cross-person transfer.
- TC3. LinkedIn Community Management API terms on automation and approval.
- TC4. Instantly sender swap and reply ownership.
- TC5. CAN-SPAM 15 USC 7704(a)(1) and CASL s.6(2) wording with counsel.
