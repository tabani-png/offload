import { describe, expect, test } from "bun:test";
import { CONNECTORS, connectorsFor } from "../../src/connectors/catalog.ts";
import { profile } from "../helpers.ts";

describe("connector catalog", () => {
  test("lists the nine v1 connectors, then the tools s14 routes to (s16 commit schemas)", () => {
    expect(CONNECTORS.map((c) => c.name)).toEqual(["Gmail", "Google Calendar", "Slack", "LinkedIn", "Google Sheets", "Notion", "HubSpot", "Attio", "Outlook", "Instantly", "Smartlead", "Salesforce", "Xero", "QuickBooks", "Zendesk", "Intercom", "Airtable", "Greenhouse", "Zoom"]);
  });

  test("every connector says how it connects: gmail-mcp, composio:<toolkit> or none", () => {
    for (const c of CONNECTORS) expect(c.how).toMatch(/^(gmail-mcp|composio:[a-z0-9_]+|none)$/);
    expect(CONNECTORS.find((c) => c.id === "gmail")?.how).toBe("gmail-mcp");
  });

  test("reachability is within 0..1 and LinkedIn is marked limited", () => {
    for (const c of CONNECTORS) expect(c.reach).toBeGreaterThanOrEqual(0);
    for (const c of CONNECTORS) expect(c.reach).toBeLessThanOrEqual(1);
    const li = CONNECTORS.find((c) => c.id === "linkedin");
    expect(li?.reach).toBeLessThan(0.5);
    expect(li?.limits).toBeDefined();
  });

  test("Gmail tasks map to the Gmail connector with full reachability", () => {
    const r = connectorsFor(profile());
    expect(r.primary?.id).toBe("gmail");
    expect(r.reachability).toBe(1);
  });

  test("scheduling tasks also need Google Calendar", () => {
    const r = connectorsFor(profile({ schedulingShare: 0.8 }));
    expect(r.all.map((c) => c.id)).toEqual(["gmail", "google-calendar"]);
  });

  test("Google Sheets matches on host plus the spreadsheets path", () => {
    expect(connectorsFor(profile({ host: "docs.google.com", urlPattern: "/spreadsheets/d/<id>/edit", category: "sheet" })).primary?.id).toBe("google-sheets");
    expect(connectorsFor(profile({ host: "docs.google.com", urlPattern: "/document/d/<id>/edit", category: "browse" })).primary).toBeNull();
  });

  test("desktop apps match on bundle id", () => {
    expect(connectorsFor(profile({ app: "com.tinyspeck.slackmacgap", host: "", urlPattern: "", category: "chat" })).primary?.id).toBe("slack");
    expect(connectorsFor(profile({ app: "us.zoom.xos", host: "", urlPattern: "", category: "call" })).primary?.id).toBe("zoom");
  });

  test("a task with no connector has reachability 0", () => {
    const r = connectorsFor(profile({ app: "com.apple.Terminal", host: "", urlPattern: "", category: "code" }));
    expect(r.primary).toBeNull();
    expect(r.reachability).toBe(0);
  });
});
