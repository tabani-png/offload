/**
 * Request/response shapes that API.md writes inline (e.g. `{code, expiresAt}`) rather than as files in
 * schemas/stage2. They live here, reference the frozen stage2 definitions, and are validated exactly like them.
 */
// Relative to the inline $id `offload/control/<name>.json`, so they resolve to `offload/stage2/...`.
const C = "../stage2/common.schema.json#/$defs";
const S = "../stage2";
const P = "offload/control";

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});

const nullable = (ref: string) => ({ oneOf: [{ $ref: ref }, { type: "null" }] });

/** List responses: `{items, page}` (API.md "Lists"). */
const list = (id: string, itemRef: string) => ({
  $id: `${P}/${id}.json`,
  ...obj({ items: { type: "array", items: { $ref: itemRef } }, page: { $ref: `${C}/page` } }),
});

export const INLINE_SCHEMAS: Array<{ $id: string } & Record<string, unknown>> = [
  { $id: `${P}/empty.json`, ...obj({}) },
  {
    $id: `${P}/auth-session.json`,
    ...obj({ person: { $ref: `${S}/person.schema.json` }, csrfToken: { type: "string", maxLength: 128 } }),
  },
  {
    $id: `${P}/enrollment-code.json`,
    ...obj({ code: { type: "string", minLength: 16, maxLength: 64 }, expiresAt: { $ref: `${C}/tsMs` } }),
  },
  { $id: `${P}/challenge-request.json`, ...obj({ deviceId: { $ref: `${C}/uuid` } }) },
  list("device-list", `${S}/device-enrollment.schema.json#/$defs/device`),
  {
    $id: `${P}/tenant-patch.json`,
    ...obj(
      {
        name: { $ref: `${C}/name` },
        reportingTimezone: { type: "string", minLength: 1, maxLength: 64 },
        groupFloor: { type: "integer", minimum: 5, maximum: 100 },
        identityAddon: obj({ sso: { type: "boolean" }, directorySync: { type: "boolean" } }, []),
        retention: obj(
          {
            perPersonDays: { type: "integer", minimum: 1, maximum: 90 },
            workingTimeDays: { type: "integer", minimum: 1, maximum: 30 },
            groupMonths: { type: "integer", minimum: 1, maximum: 24 },
          },
          [],
        ),
        monthlyWorkerBudgetCents: { $ref: `${C}/cents` },
      },
      [],
    ),
  },
  list("department-list", `${S}/department.schema.json`),
  {
    $id: `${P}/department-create.json`,
    ...obj(
      {
        name: { $ref: `${C}/name` },
        parentId: nullable(`${C}/uuid`),
        directoryGroups: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 20 },
      },
      ["name"],
    ),
  },
  {
    $id: `${P}/department-patch.json`,
    ...obj(
      {
        name: { $ref: `${C}/name` },
        parentId: nullable(`${C}/uuid`),
        directoryGroups: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 20 },
      },
      [],
    ),
  },
  list("person-list", `${S}/person.schema.json`),
  list("person-summary-list", `${S}/person-summary.schema.json`),
  {
    $id: `${P}/person-patch.json`,
    ...obj(
      {
        accessRole: { enum: ["owner", "admin", "dept_lead", "member", "auditor"] },
        departmentId: nullable(`${C}/uuid`),
        deptLeadOf: { type: "array", items: { $ref: `${C}/uuid` }, maxItems: 50, uniqueItems: true },
        jobRoleIds: { type: "array", items: { $ref: `${C}/uuid` }, maxItems: 20, uniqueItems: true },
        jurisdiction: { $ref: `${C}/jurisdiction` },
        leavingOn: nullable(`${C}/day`),
      },
      [],
    ),
  },
  {
    $id: `${P}/person-invite.json`,
    ...obj({
      email: { type: "string", maxLength: 254, format: "email" },
      displayName: { $ref: `${C}/name` },
      departmentId: nullable(`${C}/uuid`),
      jurisdiction: { $ref: `${C}/jurisdiction` },
    }),
  },
  list("job-role-list", `${S}/job-role.schema.json`),
  { $id: `${P}/job-role-create.json`, ...obj({ name: { $ref: `${C}/name` }, departmentId: { $ref: `${C}/uuid` } }) },
  {
    $id: `${P}/job-role-patch.json`,
    ...obj({ name: { $ref: `${C}/name` }, departmentId: { $ref: `${C}/uuid` } }, []),
  },
  list("role-identity-list", `${S}/role-identity.schema.json`),
  {
    $id: `${P}/role-identity-create.json`,
    ...obj(
      {
        jobRoleId: { $ref: `${C}/uuid` },
        label: { $ref: `${C}/name` },
        address: { oneOf: [{ type: "string", maxLength: 254 }, { type: "null" }] },
        connectionId: { $ref: `${C}/uuid` },
        signature: { type: "string", maxLength: 2000 },
      },
      ["jobRoleId", "label", "connectionId"],
    ),
  },
  {
    $id: `${P}/role-identity-patch.json`,
    ...obj(
      {
        label: { $ref: `${C}/name` },
        address: { oneOf: [{ type: "string", maxLength: 254 }, { type: "null" }] },
        connectionId: { $ref: `${C}/uuid` },
        signature: { type: "string", maxLength: 2000 },
      },
      [],
    ),
  },
  {
    $id: `${P}/support-grant-request.json`,
    ...obj({ hours: { type: "integer", minimum: 1, maximum: 72 }, readOnly: { type: "boolean" } }, ["hours"]),
  },
  {
    $id: `${P}/support-grant.json`,
    ...obj({
      id: { $ref: `${C}/uuid` },
      hours: { type: "integer", minimum: 1, maximum: 72 },
      readOnly: { type: "boolean" },
      createdAt: { $ref: `${C}/tsMs` },
      expiresAt: { $ref: `${C}/tsMs` },
    }),
  },
  list("audit-event-list", `${S}/audit-event.schema.json`),
  {
    $id: `${P}/audit-verify.json`,
    ...obj(
      { ok: { type: "boolean" }, brokenAt: { $ref: `${C}/ulid` }, reason: { enum: ["link", "truncated", "rewritten"] } },
      ["ok"],
    ),
  },
  {
    // WorkOS webhook envelope: only the fields we read are constrained; WorkOS adds fields over time.
    $id: `${P}/workos-event.json`,
    type: "object",
    required: ["id", "event", "data"],
    properties: {
      id: { type: "string", maxLength: 200 },
      event: { type: "string", maxLength: 100 },
      data: { type: "object" },
    },
  },
];
