# 0102 Identity with WorkOS and access roles with department scope

Date: 2026-10-25. Status: proposed. Evidence: research/stage2/03-rbac-sso-scim.md.

## Context
Operator decision: WorkOS AuthKit; SSO and directory sync as a per-tenant add-on. We need owner, admin, department
lead, member, auditor and service identities, and department scoping that no vendor provides.

## Decision
1. **Login**: WorkOS AuthKit (Google, Microsoft, email magic link) for every tenant; enterprise SSO and Directory Sync
   (SCIM for Entra/Okta, Google Directory Sync) switched on per tenant. One WorkOS organization per tenant
   (`tenants.workos_org_id`).
2. **Web session**: after the AuthKit callback we issue our own session cookie (`__Host-offload_session`, httpOnly,
   Secure, SameSite=Lax), 12 h absolute; idle timeout 30 min for owner/admin, 8 h otherwise. Mutations need a
   CSRF header matching a per-session token. Sessions are rows (revocable).
3. **Device auth**: devices enroll with a one-time code (10 min, single use) issued after a browser login on that Mac,
   and register a P-256 public key (JWK). Access tokens (JWT ES256 signed by the control plane, 15 min, audience
   `device`) are minted by `POST /v1/devices/token` with a signature over a server nonce. No long-lived bearer secret
   exists on the Mac.
4. **Access roles** (one per person per tenant, plus department scope):

   | access role | scope | summary |
   |---|---|---|
   | owner | tenant | everything admin can do, plus billing, delete tenant, enable sensitive features (with DPIA attestation), break-glass |
   | admin | tenant | people, departments, job roles, connections, policies, workers, offboarding, kill switch; cannot enable sensitive features or read per-person data unless enabled |
   | dept_lead | set of department ids | read workflows, runs and aggregates of their departments; promote workflows; approve role batches of their departments |
   | member | self | own devices, own data, own approvals, propose workflows |
   | auditor | tenant, read-only | audit log, compliance records, aggregate dashboards; no per-person data |
   | service | one job role identity | used by the worker orchestrator and broker; cannot log in; can only call broker-internal operations |

   Per-endpoint permissions: `plan/stage-2/API.md` RBAC matrix, implemented once in `control/src/rbac/permissions.ts`.
5. **Authorization rule** (`authorize(principal, action, resource)`): allow iff the access role permits the action
   AND (scope is tenant OR `resource.departmentId ∈ principal.departmentScope` OR `resource.personId = principal.personId`)
   AND every feature the action needs is enabled for the tenant AND (for per-person data) for the subject's
   jurisdiction (ADR 0108). Deny is the default; the matrix is data, tested row by row.
6. **IdP mapping**: WorkOS role/group assignment maps to access roles (`owner` is never assigned from the IdP; it is
   set in-app by an existing owner). Directory groups map to departments by a tenant-edited table
   (`department_group_mappings`); small tenants set departments by hand.
7. **Deprovisioning**: a Directory Sync `dsync.user.deleted` / `dsync.user.updated (state=inactive)` webhook (signature
   verified) revokes sessions and device tokens within one request and starts offboarding (ADR 0107). Workflows are
   never deleted by deprovisioning.
8. **Our staff**: no staff access role. Support access is a tenant-owner grant (`support_grants`, max 72 h, read-only by
   default) and every access is a tenant audit event.
9. At least one owner per tenant at all times (removing the last owner is a 409); two recommended.

## Consequences
- Department scoping and feature gates are our code and our tests; WorkOS only answers "who is this".
- WorkOS pricing passes through as an "Enterprise identity" add-on; small tenants pay nothing for login.
- Fine-grained authorization products (WorkOS FGA) are not used in v1.
