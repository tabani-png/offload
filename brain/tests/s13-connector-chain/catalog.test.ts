// s13 CATALOG: capability -> candidate tools (MCP / API first, computer use last). Every candidate records its official
// MCP status with a check date, its Composio toolkit (checked read-only), the API docs and which calls are reads vs
// commits; commits stay denied by the gate until the allowlist has their schema. GET /catalog/capabilities[/:id].
import { afterEach, describe, expect, test } from "bun:test";
import type { CapabilitiesResponse, CapabilityDTO, ErrorResponse } from "../../src/api/types.ts";
import { CAPABILITIES, CATALOG_CHECKED_AT, gateAllows, gateRoleOf, TOOLS } from "../../src/connectors/capabilities.ts";
import { COMPOSIO_META_RE } from "../../src/connectors/composio.ts";
import { connectorById } from "../../src/connectors/catalog.ts";
import { s09bWorld, type S09bWorld } from "../s09b-brain/setup.ts";

const REQUIRED = ["instantly", "smartlead", "gmail", "outlook", "apollo", "hubspot", "attio", "salesforce", "xero", "quickbooks", "greenhouse", "lever", "zendesk", "intercom", "googlesheets", "airtable", "notion", "slack", "calendly"];
const CAPS = ["send-outreach-sequence", "enrich-contact", "log-to-crm", "create-bill", "update-ats-stage", "reply-ticket", "write-sheet-row"];

let x: S09bWorld | null = null;
afterEach(() => {
  x?.cleanup();
  x = null;
});

describe("s13 catalog: capabilities -> candidate tools", () => {
  test("CATALOG: the required capabilities and tools are all there, each tool a candidate somewhere", () => {
    for (const id of CAPS) expect(CAPABILITIES.map((c) => c.id)).toContain(id);
    for (const t of REQUIRED) {
      expect(TOOLS[t]).toBeDefined();
      expect(CAPABILITIES.some((c) => c.candidates.some((k) => k.tool === t))).toBe(true);
    }
  });

  test("CATALOG: every tool has an MCP status with a check date, a confirmed Composio toolkit and an https API docs URL", () => {
    for (const t of Object.values(TOOLS)) {
      expect(["CONFIRMED", "UNKNOWN"]).toContain(t.mcp.status);
      expect(t.mcp.checkedAt).toBe(CATALOG_CHECKED_AT);
      if (t.mcp.status === "CONFIRMED") expect(t.mcp.url).toMatch(/^https:\/\//);
      else expect(t.mcp.url).toBeNull();
      expect(t.mcp.evidence.length).toBeGreaterThan(0);
      expect(t.composio).toMatchObject({ status: "CONFIRMED", checkedAt: CATALOG_CHECKED_AT });
      expect(t.composio.tools).toBeGreaterThan(0);
      expect(t.apiDocs).toMatch(/^https:\/\//);
      if (t.catalogId !== null) expect(connectorById(t.catalogId)).toBeDefined();
    }
  });

  test("CATALOG: every call is a read or a commit with a verb; no meta tool; a slug's role is the same everywhere", () => {
    const seen = new Map<string, "read" | "commit">();
    for (const cap of CAPABILITIES)
      for (const cand of cap.candidates) {
        expect(cand.why.length).toBeGreaterThan(10);
        expect(cand.cost.length).toBeGreaterThan(5);
        for (const call of cand.calls) {
          expect(COMPOSIO_META_RE.test(call.slug)).toBe(false);
          expect(call.slug.startsWith(TOOLS[cand.tool]!.composio.toolkit.toUpperCase())).toBe(true);
          if (call.kind === "commit") expect(["send", "launch", "create", "update", "delete"]).toContain(call.verb ?? "none");
          const was = seen.get(call.slug);
          if (was !== undefined) expect(call.kind).toBe(was);
          seen.set(call.slug, call.kind);
        }
      }
    expect(gateRoleOf("INSTANTLY_ACTIVATE_CAMPAIGN")).toBe("commit");
    expect(gateRoleOf("APOLLO_PEOPLE_ENRICHMENT")).toBe("read");
    expect(gateRoleOf("COMPOSIO_MULTI_EXECUTE_TOOL")).toBe("unknown");
  });

  test("CATALOG: the catalog recommends, the allowlist allows: only allowlisted commits say allowedByGate", () => {
    expect(gateAllows("GMAIL_SEND_EMAIL")).toBe(true);
    expect(gateAllows("GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND")).toBe(true);
    expect(gateAllows("INSTANTLY_ACTIVATE_CAMPAIGN")).toBe(false);
    expect(gateAllows("GMAIL_FETCH_EMAILS")).toBe(false);
  });

  test("CATALOG: outreach recommends a sequencing tool before sending one by one from Gmail", () => {
    const order = CAPABILITIES.find((c) => c.id === "send-outreach-sequence")!.candidates.map((c) => c.tool);
    expect(order.indexOf("instantly")).toBeLessThan(order.indexOf("gmail"));
    expect(order.indexOf("smartlead")).toBeLessThan(order.indexOf("gmail"));
  });

  test("CATALOG: GET /catalog/capabilities and /catalog/capabilities/:id; unknown id 404; read-only", async () => {
    x = await s09bWorld();
    const all = await x.call<CapabilitiesResponse>("/catalog/capabilities");
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ version: 1, checkedAt: CATALOG_CHECKED_AT });
    expect(all.body.capabilities.map((c) => c.id)).toEqual(CAPABILITIES.map((c) => c.id));
    const one = await x.call<CapabilityDTO>("/catalog/capabilities/send-outreach-sequence");
    expect(one.status).toBe(200);
    const instantly = one.body.candidates[0]!;
    expect(instantly).toMatchObject({ toolId: "instantly", composio: { toolkit: "instantly", status: "CONFIRMED" } });
    expect(instantly.commits.map((c) => [c.slug, c.verb, c.gateTool, c.allowedByGate])).toContainEqual(["INSTANTLY_ACTIVATE_CAMPAIGN", "launch", "mcp__composio_cli__INSTANTLY_ACTIVATE_CAMPAIGN", false]);
    expect((await x.call<ErrorResponse>("/catalog/capabilities/nope")).status).toBe(404);
    expect((await x.call("/catalog/capabilities", { method: "POST" })).status).toBe(405);
  });
});
