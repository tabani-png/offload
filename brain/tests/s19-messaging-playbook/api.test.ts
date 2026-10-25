// API: GET/POST /workflows/:id/playbook (build, read, notes), errors, and the S2-06 promotion seam.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBrain } from "../../src/api/server.ts";
import { StubModel } from "../../src/models/model.ts";
import { PlaybookLeakError } from "../../src/playbook/leak.ts";
import { playbookForPromotion, promotablePlaybook } from "../../src/playbook/promote.ts";
import { playbookPath, readPlaybook } from "../../src/playbook/store.ts";
import type { Playbook } from "../../src/playbook/types.ts";
import { sha256Hex } from "../../src/sync/encoding.ts";
import { canonicalize } from "../../src/sync/jcs.ts";
import { NOW, world, type World } from "./setup.ts";

const TOKEN = "p".repeat(40);
let w: World;
let brain: ReturnType<typeof createBrain>;
const call = async (path: string, method = "GET", body?: unknown) => {
  const r = await brain.handle(new Request(`http://127.0.0.1${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, host: "127.0.0.1", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }));
  return { status: r.status, body: (await r.json()) as Record<string, unknown> & { playbook?: Playbook | null; markdown?: string | null; error?: string; message?: string } };
};

beforeAll(async () => {
  w = await world();
  brain = createBrain({ home: w.home, token: TOKEN, now: () => NOW, workflows: { model: new StubModel() } });
});
afterAll(() => w.cleanup());

describe("s19 playbook API", () => {
  test("API: GET before a build returns no playbook", async () => {
    const r = await call(`/workflows/${w.outreach.id}/playbook`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: 1, workflowId: w.outreach.id, playbook: null, markdown: null });
  });

  test("API: POST {action: build} builds playbook.json and PLAYBOOK.md from the tone pack", async () => {
    const r = await call(`/workflows/${w.outreach.id}/playbook`, "POST", { action: "build" });
    expect(r.status).toBe(200);
    expect(r.body.playbook).toMatchObject({ schema: "offload.playbook/1", version: 1, workflowId: w.outreach.id, sources: { messages: 24, threads: 18 }, outcomes: { replied: 12, noReply: 6 } });
    expect(r.body.markdown).toStartWith("---\nschema: offload.playbook/1\nversion: 1\n");
    expect(existsSync(join(w.home, "workflows", w.outreach.id, "PLAYBOOK.md"))).toBe(true);
    for (const n of ["Muhammad", "Offload", "Northzone", "2.5M"]) expect(readFileSync(playbookPath(w.home, w.outreach.id), "utf8")).not.toContain(n);
  });

  test("API: a second build is version 2; GET reads the latest", async () => {
    expect((await call(`/workflows/${w.outreach.id}/playbook`, "POST", { action: "build" })).body.playbook!.version).toBe(2);
    const g = await call(`/workflows/${w.outreach.id}/playbook`);
    expect(g.body.playbook!.version).toBe(2);
    expect(g.body.playbook!.history.map((h) => h.change)).toEqual(["built", "built"]);
  });

  test("API: POST {action: notes} stores the user's notes as a new version, shown in PLAYBOOK.md", async () => {
    const r = await call(`/workflows/${w.outreach.id}/playbook`, "POST", { action: "notes", notes: "Lead with the problem when you know their portfolio." });
    expect(r.status).toBe(200);
    expect(r.body.playbook).toMatchObject({ version: 3, notes: "Lead with the problem when you know their portfolio." });
    expect(r.body.markdown).toContain("## Notes\nLead with the problem when you know their portfolio.\n");
  });

  test("API: notes that name someone, hold an address or a private figure are refused and nothing changes", async () => {
    for (const notes of ["Ask Anna at Northzone first.", "Reply to anna@northzone.com", "Mention the $2.5M round", "Sign as Muhammad"]) {
      const r = await call(`/workflows/${w.outreach.id}/playbook`, "POST", { action: "notes", notes });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("bad_request");
      expect(r.body.message).toMatch(/kept a personal detail/);
      expect(r.body.message).not.toMatch(/Anna|anna@|2\.5M|Muhammad/);
    }
    expect(readPlaybook(w.home, w.outreach.id)!.version).toBe(3);
  });

  test("API: bad bodies are 400: other keys, a bad action, non-string or too long notes, notes on build", async () => {
    const p = `/workflows/${w.outreach.id}/playbook`;
    expect((await call(p, "POST", { action: "build", force: true })).status).toBe(400);
    expect((await call(p, "POST", { action: "rewrite" })).status).toBe(400);
    expect((await call(p, "POST", { action: "notes", notes: 7 })).status).toBe(400);
    expect((await call(p, "POST", { action: "notes", notes: "x".repeat(4001) })).status).toBe(400);
    expect((await call(p, "POST", { action: "build", notes: "x" })).status).toBe(400);
    expect((await call(p, "POST", "not json")).status).toBe(400);
  });

  test("API: unknown workflow is 404, PUT is 405", async () => {
    expect((await call("/workflows/wf_nothere/playbook")).status).toBe(404);
    expect((await call(`/workflows/${w.outreach.id}/playbook`, "PUT", { action: "build" })).status).toBe(405);
  });

  test("API: the promotion seam returns the re-checked playbook without history and a stable hash", () => {
    const got = playbookForPromotion(w.home, w.outreach.id, NOW)!;
    const pb = readPlaybook(w.home, w.outreach.id)!;
    expect(got.playbook).toEqual(promotablePlaybook(pb));
    expect(Object.keys(got.playbook)).not.toEqual(expect.arrayContaining(["history"]));
    expect("builtAt" in got.playbook).toBe(false);
    expect(got.playbookHash).toBe(sha256Hex(canonicalize(promotablePlaybook(JSON.parse(JSON.stringify(pb)) as Playbook))));
    expect(got.playbookHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("API: the promotion seam fails closed on a playbook file edited to hold a name", () => {
    const pb = readPlaybook(w.home, w.outreach.id)!;
    const path = playbookPath(w.home, w.outreach.id);
    const saved = readFileSync(path, "utf8");
    writeFileSync(path, JSON.stringify({ ...pb, avoid: [...pb.avoid, "Writing to Anna at Northzone."] }));
    expect(() => playbookForPromotion(w.home, w.outreach.id, NOW)).toThrow(PlaybookLeakError);
    writeFileSync(path, saved);
    expect(playbookForPromotion(w.home, "wf_nothere", NOW)).toBeNull();
  });

  test("API: without a tone pack a build is 409 and says what to run", async () => {
    rmSync(join(w.home, "tone", "corpus.jsonl.enc"));
    const r = await call(`/workflows/${w.outreach.id}/playbook`, "POST", { action: "build" });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/tone build/);
  });

  test("API: brain/API.md documents the playbook routes", () => {
    const doc = readFileSync(new URL("../../API.md", import.meta.url), "utf8");
    expect(doc).toContain("GET /workflows/:id/playbook");
    expect(doc).toContain('POST /workflows/:id/playbook {action: "build"}');
    expect(doc).toContain('{action: "notes", notes}');
    expect(doc).toContain("playbookForPromotion");
  });
});
