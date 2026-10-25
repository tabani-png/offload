import { describe, expect, test } from "bun:test";
import { clusterTitles, extractEmails, maskText, sequenceSimilarity, tokenize, urlPattern } from "../../src/grouping/normalize.ts";
import { categoryFor, defaultLabeler, detectOwnEmails, groupTasks, type Labeler } from "../../src/grouping/group.ts";
import { sessionize, DEFAULT_SESSION_OPTIONS } from "../../src/sessionize.ts";
import type { Span } from "../../src/types.ts";
import { EventBuilder } from "../helpers.ts";

// s03 tests use raw idle timestamps (idle_start = the moment input stopped); s05 tests cover the observer backdate.
const RAW = { ...DEFAULT_SESSION_OPTIONS, idleBackdateMs: 0 };

describe("normalisation", () => {
  test("emails, numbers, times and long ids are masked", () => {
    expect(maskText("Inbox (12) - muhammad@offload.so - Gmail")).toBe("Inbox (<n>) - <email> - Gmail");
    expect(maskText("Call at 3:30pm on 2026-10-12, ref 8f3a9c2d1e")).toBe("Call at <time> on <date>, ref <id>");
  });

  test("URL path patterns mask ids and numbers and drop query and fragment", () => {
    expect(urlPattern("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=0")).toBe("/spreadsheets/d/<id>/edit");
    expect(urlPattern("https://mail.google.com/mail/u/0/#inbox/FMfcgzQ")).toBe("/mail/u/<n>/");
    expect(urlPattern("https://www.linkedin.com/in/kofi-larsen/")).toBe("/in/<slug>/");
    expect(urlPattern("")).toBe("");
  });

  test("titles that differ only in names cluster into one template with a wildcard", () => {
    const titles = [
      "Re: Offload seed round for Sequoia Capital - <email> - Gmail",
      "Re: Offload seed round for Index Ventures - <email> - Gmail",
      "Re: Offload seed round for Accel - <email> - Gmail",
    ].map(tokenize);
    const clusters = clusterTitles(titles);
    expect(clusters.length).toBe(1);
    expect(clusters[0]?.template).toBe("Re: Offload seed round for <*> - <email> - Gmail");
  });

  test("titles that differ only in a person's name share one template", () => {
    const clusters = clusterTitles(["Kofi Larsen | LinkedIn", "Ravi Adeyemi | LinkedIn", "Ben Doe | LinkedIn"].map(tokenize));
    expect(clusters.length).toBe(1);
    expect(clusters[0]?.template).toBe("<*> | LinkedIn");
  });

  test("structurally different titles stay in different clusters", () => {
    const clusters = clusterTitles(["Inbox (<n>) - <email> - Gmail", "Re: Offload seed round for Accel - <email> - Gmail", "New Message"].map(tokenize));
    expect(clusters.length).toBe(3);
  });

  test("sequence similarity is 1 for identical and 0 for disjoint token lists", () => {
    expect(sequenceSimilarity(["a", "b"], ["a", "b"])).toBe(1);
    expect(sequenceSimilarity(["a"], ["b"])).toBe(0);
  });

  test("extractEmails finds addresses in lowercase, unique", () => {
    expect(extractEmails("To: Jane.Doe@Sequoia.com, bob@a16z.com; jane.doe@sequoia.com")).toEqual(["bob@a16z.com", "jane.doe@sequoia.com"]);
  });

  test("categories come from app and host rules", () => {
    expect(categoryFor("com.google.Chrome", "mail.google.com", "")).toBe("email");
    expect(categoryFor("com.tinyspeck.slackmacgap", "", "")).toBe("chat");
    expect(categoryFor("us.zoom.xos", "", "")).toBe("call");
    expect(categoryFor("com.apple.Terminal", "", "")).toBe("code");
    expect(categoryFor("com.google.Chrome", "docs.google.com", "/spreadsheets/d/<id>/edit")).toBe("sheet");
    expect(categoryFor("com.google.Chrome", "www.linkedin.com", "")).toBe("social");
  });
});

function outreachDay(): Span[] {
  const b = new EventBuilder();
  let t = 0;
  const funds = ["sequoia.com", "accel.com", "indexventures.com", "a16z.com", "gv.com", "lsvp.com"];
  b.focus(t, "Inbox (3) - muhammad@offload.so - Gmail");
  t += 20;
  for (const [i, d] of funds.entries()) {
    b.focus(t, "New Message");
    b.at(t + 2, "ocr", { text: `To: partner${i}@${d}\nSubject: Offload seed round\nHi there, we are raising a seed round`, textHash: `h${i}` });
    b.at(t + 60, "input", { keys: 200, clicks: 3 });
    t += 180;
    b.focus(t, "Inbox (3) - muhammad@offload.so - Gmail");
    t += 20;
  }
  b.at(t, "idle_start");
  return sessionize(b.events, "2026-10-12", RAW);
}

describe("task grouping", () => {
  test("own addresses are detected from mail window titles", () => {
    expect(detectOwnEmails(outreachDay())).toEqual(["muhammad@offload.so"]);
  });

  test("compose spans and inbox spans become two tasks with stable ids", async () => {
    const tasks = await groupTasks(outreachDay());
    expect(tasks.length).toBe(2);
    const again = await groupTasks(outreachDay());
    expect(again.map((t) => t.id)).toEqual(tasks.map((t) => t.id));
  });

  test("each compose with a different recipient is its own instance, with counterparties and domains", async () => {
    const tasks = await groupTasks(outreachDay());
    const compose = tasks.find((t) => t.profile.template === "New Message");
    expect(compose?.instances.length).toBe(6);
    expect(compose?.profile.identifiers.domains).toContain("sequoia.com");
    expect(compose?.profile.identifiers.counterparties).not.toContain("muhammad@offload.so");
  });

  test("a short interruption inside the same item does not split the instance", async () => {
    const b = new EventBuilder();
    b.focus(0, "Zoom Meeting", "us.zoom.xos", "");
    b.focus(600, "general (Channel) - Offload - Slack", "com.tinyspeck.slackmacgap", "");
    b.focus(630, "Zoom Meeting", "us.zoom.xos", "");
    b.at(1200, "idle_start");
    const tasks = await groupTasks(sessionize(b.events, "2026-10-12", RAW));
    const zoom = tasks.find((t) => t.profile.category === "call");
    expect(zoom?.instances.length).toBe(1);
    expect(zoom?.instances[0]?.spanIds.length).toBe(2);
    expect(zoom?.instances[0]?.activeMs).toBe(1170_000);
  });

  test("the default labeler names outreach and triage deterministically", async () => {
    const tasks = await groupTasks(outreachDay());
    const kinds = tasks.map((t) => t.label.kind).sort();
    expect(kinds).toEqual(["email.outreach", "email.triage"]);
    expect(defaultLabeler.label(tasks[0]!.profile)).toEqual(tasks[0]!.label);
  });

  test("a custom Labeler replaces the default names but not the grouping", async () => {
    const custom: Labeler = { label: async (p) => ({ kind: `custom.${p.category}`, name: "X", description: "y" }) };
    const tasks = await groupTasks(outreachDay(), { labeler: custom });
    expect(tasks.every((t) => t.label.kind === "custom.email")).toBe(true);
    expect(tasks.length).toBe(2);
  });

  test("every span of the day belongs to exactly one task", async () => {
    const spans = outreachDay();
    const tasks = await groupTasks(spans);
    const assigned = tasks.flatMap((t) => t.spanIds).sort();
    expect(assigned).toEqual(spans.map((s) => s.id).sort());
  });

  test("OCR keywords are collected into the task profile", async () => {
    const tasks = await groupTasks(outreachDay());
    const compose = tasks.find((t) => t.label.kind === "email.outreach");
    expect(compose?.profile.ocrKeywords).toContain("seed");
  });
});
