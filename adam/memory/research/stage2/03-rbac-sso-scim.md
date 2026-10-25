# 03 · RBAC, SSO and SCIM for the admin dashboard

Date: 2026-10-25. Scope: S2-01 (org model), S2-04 (dashboard).
Tags: CONFIRMED = read in source (URL given) · INFERENCE = my reasoning · UNKNOWN = not found.

---

## Headline

- **Recommend WorkOS (AuthKit + SSO + Directory Sync + Admin Portal)** for v1. Free user management up to 1M MAU with RBAC, $125 per SSO connection and $125 per directory connection per month (tiered down), and it is the only vendor found that syncs **Google Workspace directories** natively, which matters because our first customers (small firms such as Consultance AI) are likely on Google Workspace.
- **Runner-up: Clerk** (cheaper per connection, $75; 1 SSO + 1 SCIM included per app; B2B add-on $100/mo for custom role sets). Pick Clerk only if Google Workspace group sync is not needed or Clerk confirms it.
- Department-lead scoping ("sees only Finance") is **our** authorization logic in the control plane, fed by directory groups. No vendor's org RBAC does that out of the box. INFERENCE.

---

## 1. Patterns

| # | Pattern | Tag | Source / reason |
|---|---|---|---|
| 1.1 | Two login paths: (a) "Sign in with Google / Microsoft" (OIDC, free, self-serve, fine for small teams); (b) enterprise SAML/OIDC SSO configured by the customer's IT via a hosted admin portal. | INFERENCE | standard B2B practice; WorkOS Admin Portal "Included in all WorkOS accounts" CONFIRMED https://workos.com/pricing |
| 1.2 | Provisioning: Microsoft Entra and Okta push users/groups via **SCIM 2.0**. Google Workspace does not offer SCIM to custom apps; sync goes through Google's directory API, which WorkOS supports as "Google Directory Sync". | CONFIRMED (WorkOS supports Google Workspace directories and claims to be the only auth provider that does) / INFERENCE (Google has no SCIM for custom apps) | https://workos.com/docs/integrations/google-directory-sync ; https://workos.com/blog/scim-providers-comparison (vendor's own comparison) |
| 1.3 | **IdP role assignment**: map IdP groups to app roles so the customer's IT controls who is admin. WorkOS supports this for SCIM and Google Workspace directories. | CONFIRMED | https://workos.com/docs/directory-sync/identity-provider-role-assignment |
| 1.4 | Deprovisioning: a SCIM "user deactivated" event must immediately revoke sessions and API tokens, freeze that person's Mac sync, and **start the continuity flow** (file 04), not delete workflows. | INFERENCE (ties S2-01 to S2-08) |
| 1.5 | Department membership comes from directory groups (e.g. `dept-finance`) or an HRIS field; map group → department in our org model, with manual override for small tenants without groups. | INFERENCE |

## 2. Role model (proposed)

| Role | Can | Cannot | Notes |
|---|---|---|---|
| **Owner** | Billing, delete tenant, assign admins, set data-region, enable sensitive features (per-person views, working time) after DPIA attestation | — | At least 1, recommend 2; break-glass |
| **Admin** | Manage users/roles/departments, policies (tools, approval rules, budgets), connections (Composio/MCP org connections), cloud workers, offboarding/successor assignment | Billing; enable sensitive features (owner only) | Usually IT/ops |
| **Department lead** | See workflows, runs and aggregates **for their department(s)**; promote workflows to role workflows; approve commits for role workflows in their dept | See other departments; see per-person data unless the tenant enabled it and policy allows | Scope = set of department IDs |
| **Member** | Own Mac app; own workflows; own metrics and evidence; propose a workflow to the registry; approve own runs | See others | Default |
| **Auditor** (optional) | Read-only audit log and compliance pack | Change anything | Useful for SOC 2 and works council (file 02) |
| **Service identity** (role worker) | Run role workflows in cloud workers with company-held credentials | Interactive login | Not a human seat; see file 04 |

Authorization rule: `allow(action, resource) = role permits action AND resource.department ∈ user.scope AND feature flag enabled for tenant AND jurisdiction allows it`. Every read of per-person data is written to the audit log. INFERENCE (design).

## 3. Vendor comparison

| Vendor | User mgmt / free tier | SSO price | SCIM / directory price | Roles | Google Workspace dir sync | Other | Tag / source |
|---|---|---|---|---|---|---|---|
| **WorkOS** | AuthKit free up to 1M users; then $2,500 per extra 1M | $125/connection/mo (1-15), $100 (16-30), $80 (31-50), $65 (51-100) | Same tiers as SSO | RBAC included | **Yes** | Admin Portal included; Audit Logs $125 per SIEM connection/mo + $99 per 1M events stored/mo; volume discounts | CONFIRMED https://workos.com/pricing ; Google: https://workos.com/docs/integrations/google-directory-sync |
| **Clerk** | Hobby free to 50,000 MRU/app; Pro $25/mo ($20 annual); then $0.02 per user | 1 connection included per app (Pro/Business); $75/mo each (2-15), $60 (16-100) | 1 included per app; extra $75/$60; **billing for directory sync starts 1 Jan 2027** | Basic RBAC with custom permissions free; custom roles and role sets in "B2B Authentication enhanced" add-on $100/mo ($85 annual) | UNKNOWN | — | CONFIRMED https://clerk.com/pricing |
| **Stytch** (B2B) | 10,000 MAU free | 5 SSO/SCIM connections included, then $125/connection | same | RBAC included | UNKNOWN | per-MAU overage price not on page | CONFIRMED https://stytch.com/pricing |
| **Auth0** | Essentials $35/mo, Professional $240/mo at 500 MAU; 10 Organizations | not stated on page | **SCIM inbound not included** in Essentials/Professional | RBAC per organization | UNKNOWN | — | CONFIRMED https://auth0.com/pricing |
| **Supabase Auth** | Free 50,000 MAU; Pro $25/mo with 100,000 MAU then $0.00325 | SAML 2.0 on Pro/Team: 50 SSO MAU included then $0.015/MAU | SCIM not on pricing page | RLS-based, roles are DIY | No (INFERENCE) | Team plan $599/mo | CONFIRMED price https://supabase.com/pricing ; SCIM UNKNOWN |

Cost example (INFERENCE, arithmetic): 10 enterprise tenants each with SSO + directory sync on WorkOS = 20 connections → 15×$125 + 5×$100 = $2,375/mo. On Clerk ≈ 2 included + 18×$75 = $1,350/mo (+$100 add-on). Pass these through as an "Enterprise identity" add-on; small tenants use free Google/Microsoft sign-in.

## 4. Recommendation

1. **WorkOS AuthKit** for all logins (Google, Microsoft, email) from day one; SSO and Directory Sync switched on per tenant as a paid add-on. Reasons: Google Workspace directory sync, IdP group → role mapping, hosted Admin Portal so customer IT self-configures, audit-log product we can use for the admin audit trail.
2. Keep authorization (department scoping, feature flags, jurisdiction gates) in our control plane; treat WorkOS roles as coarse (owner/admin/member) and derive department-lead scope from synced groups.
3. On directory deactivation events: revoke, freeze, hand off (file 04). Never auto-delete workflows.
4. If the control plane later runs inside a customer's cloud (open decision in the plan), WorkOS still works as a hosted IdP broker; a self-hosted alternative would be needed only for air-gapped customers. INFERENCE.

## TO CONFIRM
- TC1. Clerk support for Google Workspace directory sync.
- TC2. WorkOS fine-grained authorization (FGA) product and price, if we want resource-scoped roles from the vendor.
- TC3. Auth0 enterprise connection counts per plan (row blank on the page).
- TC4. Microsoft Entra non-gallery SCIM app setup steps for the onboarding guide.
