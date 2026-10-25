// S2-07 ITEM and EXEC: the item journal (pending → sending → sent | unknown; pending → failed_before_send), the
// contacted ledger written before the call, unknown never retried, release; executors receive exactly the approved
// arguments and anything else is denied before any call.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ComposioCliExecutor, type CommitCall } from "../../src/modules/broker/executors.ts";
import type { BatchItem, CrmSheet, ToolPolicy } from "../../src/modules/broker/stage1.ts";
import { approveHttp, approveToken, batchState, client, email, FakeComposio, items, propose, proposeOk, world, type World } from "./setup.ts";

let w: World;
let n = 0;
const to = () => `i${++n}@fund.com`;
beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.close();
});

const ledger = async (hash: string) =>
  (await w.h.db.migrator`select outcome, released_at, recipient from contacted_ledger where tenant_id = ${w.t.id} and batch_hash = ${hash}`) as Array<{
    outcome: string;
    released_at: Date | null;
    recipient: string;
  }>;

/** An executor that changes the approved call before running it (a bug or a compromised component). */
class Tampering extends ComposioCliExecutor {
  constructor(runner: FakeComposio, private readonly change: (c: CommitCall) => CommitCall) {
    super(runner);
  }
  override build(p: ToolPolicy, item: BatchItem, ctx: { batchHash: string; crmSheet?: CrmSheet }): CommitCall | null {
    const c = super.build(p, item, ctx);
    return c === null ? null : this.change(c);
  }
}

const withComposio = async <T>(exec: ComposioCliExecutor | undefined, fn: () => Promise<T>): Promise<T> => {
  w.useComposio(exec);
  try {
    return await fn();
  } finally {
    w.restore();
  }
};

describe("S2-07 item journal", () => {
  test("ITEM: pending → sending → sent, with the ledger written and committed before the call", async () => {
    const r = to();
    const hash = await proposeOk(w, [email(r)]);
    let seen: unknown = null;
    w.composio.during = async () => {
      // Another connection sees the journal while the call is in flight: it was committed before the call.
      seen = { item: (await items(w, hash))[0]!.state, ledger: (await ledger(hash)).map((l) => l.outcome) };
    };
    try {
      expect((await approveHttp(w, "member", hash)).status).toBe(200);
    } finally {
      w.composio.during = null;
    }
    expect(seen).toEqual({ item: "sending", ledger: ["sending"] });
    expect((await items(w, hash))[0]!.state).toBe("sent");
    expect((await ledger(hash)).map((l) => l.outcome)).toEqual(["sent"]);
    expect(await batchState(w, hash)).toBe("done");
  });

  test("ITEM: a call that throws after sending is unknown and is never retried", async () => {
    const hash = await proposeOk(w, [email(to())]);
    w.composio.mode = "throw";
    try {
      await approveHttp(w, "member", hash);
    } finally {
      w.composio.mode = "ok";
    }
    expect((await items(w, hash))[0]!.state).toBe("unknown");
    const calls = w.composio.calls.length;
    await w.broker.runDue(w.t.id);
    await w.broker.runDue(w.t.id, hash);
    expect(w.composio.calls.length).toBe(calls);
    expect((await ledger(hash))[0]!.outcome).toBe("unknown");
  });

  test("ITEM: a non-success answer after the call started is unknown, not failed_before_send", async () => {
    const hash = await proposeOk(w, [email(to())]);
    w.composio.mode = "fail";
    try {
      await approveHttp(w, "member", hash);
    } finally {
      w.composio.mode = "ok";
    }
    expect((await items(w, hash))[0]!.state).toBe("unknown");
  });

  test("ITEM: crash between sending and result → unknown on recovery; the late answer does not resend or overwrite", async () => {
    const hash = await proposeOk(w, [email(to())]);
    const { token } = await approveToken(w, "member", hash);
    w.composio.mode = "hang";
    const running = w.broker.commitApproved(w.t.id, hash, token);
    for (let i = 0; i < 100 && (await items(w, hash))[0]!.state !== "sending"; i++) await Bun.sleep(5);
    w.composio.mode = "ok";
    expect((await items(w, hash))[0]!.state).toBe("sending");
    // Not stale yet: recovery leaves it alone.
    expect(await w.broker.reconcile(w.t.id)).toBe(0);
    w.h.clock.advance(11 * 60_000);
    expect(await w.broker.reconcile(w.t.id)).toBe(1);
    expect((await items(w, hash))[0]!.state).toBe("unknown");
    const calls = w.composio.calls.length;
    await w.broker.runDue(w.t.id);
    expect(w.composio.calls.length).toBe(calls);
    w.composio.finishHung();
    await running;
    expect((await items(w, hash))[0]!.state).toBe("unknown");
  });

  test("ITEM: unknown blocks a new batch to the recipient until a person releases it; then it may be drafted again", async () => {
    const r = to();
    const hash = await proposeOk(w, [email(r)]);
    w.composio.mode = "throw";
    try {
      await approveHttp(w, "member", hash);
    } finally {
      w.composio.mode = "ok";
    }
    const again = await propose(w, [email(r, "Second try")]);
    expect(again).toMatchObject({ ok: false, code: "conflict" });
    const rel = await (await client(w, "member")).post(`/v1/batches/${hash}/release`, { keys: [r] });
    expect(rel.status).toBe(200);
    expect(rel.json.items[0]).toMatchObject({ key: r, state: "unknown" });
    expect((await items(w, hash))[0]!.released_at).not.toBeNull();
    expect((await ledger(hash))[0]!.released_at).not.toBeNull();
    expect((await propose(w, [email(r, "Second try")])).ok).toBe(true);
  });

  test("ITEM: release is only for unknown items, once, and only by an approver", async () => {
    const r = to();
    const hash = await proposeOk(w, [email(r)]);
    await approveHttp(w, "member", hash);
    const member = await client(w, "member");
    expect((await member.post(`/v1/batches/${hash}/release`, { keys: [r] })).status).toBe(409);
    expect((await member.post(`/v1/batches/${hash}/release`, { keys: ["nobody@x.com"] })).status).toBe(400);
    expect((await (await client(w, "owner")).post(`/v1/batches/${hash}/release`, { keys: [r] })).status).toBe(403);
    expect((await (await client(w, "member2")).post(`/v1/batches/${hash}/release`, { keys: [r] })).status).toBe(404);
  });

  test("ITEM: failed_before_send is provably not sent: no ledger entry, and the recipient can be drafted again", async () => {
    const r = to();
    const hash = await proposeOk(w, [email(r)]);
    await withComposio(undefined, () => approveHttp(w, "member", hash));
    const [it] = await items(w, hash);
    expect(it!.state).toBe("failed_before_send");
    expect(it!.error).toContain("no composio executor");
    expect(await ledger(hash)).toHaveLength(0);
    expect((await propose(w, [email(r, "Re-drafted")])).ok).toBe(true);
  });

  test("ITEM: double send: two commits racing on the same items call the tool once per item", async () => {
    const [a, b] = [to(), to()];
    const hash = await proposeOk(w, [email(a), email(b)]);
    const { token } = await approveToken(w, "member", hash);
    const before = w.composio.calls.length;
    const results = await Promise.allSettled([
      w.broker.commitApproved(w.t.id, hash, token),
      w.broker.commitApproved(w.t.id, hash, token),
      w.broker.runDue(w.t.id, hash),
      w.broker.runDue(w.t.id, hash),
    ]);
    await w.broker.idle();
    expect(results.filter((x) => x.status === "rejected")).toHaveLength(1);
    expect(w.composio.calls.length - before).toBe(2);
    expect(new Set(w.composio.args().slice(-2).map((x) => x.recipient_email))).toEqual(new Set([a, b]));
    expect((await items(w, hash)).map((i) => i.state)).toEqual(["sent", "sent"]);
  });

  test("ITEM: a rejected batch sends nothing and its items are rejected", async () => {
    const hash = await proposeOk(w, [email(to())]);
    const r = await (await client(w, "member")).post(`/v1/batches/${hash}/reject`, { reason: "not now" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ state: "rejected" });
    expect(r.json.items[0].state).toBe("rejected");
    expect((await approveHttp(w, "member", hash)).status).toBe(409);
  });
});

describe("S2-07 deterministic executors", () => {
  test("EXEC: the fake Composio runner receives exactly the approved arguments (Outlook through the company mailbox)", async () => {
    const r = to();
    const hash = await proposeOk(w, [email(r, "Quarterly update", "Hi,\nnumbers attached in the portal.\nSam")], {
      identity: { type: "role_identity", id: w.conns.roleIdentity },
      connectionId: w.t.connections.company,
    });
    await approveHttp(w, "lead", hash);
    const argv = w.composio.calls.at(-1)!;
    const [ref] = await w.h.db.migrator`select external_ref from connections where id = ${w.t.connections.company}`;
    expect(argv.slice(0, 3)).toEqual(["composio", "execute", "OUTLOOK_SEND_EMAIL"]);
    expect(argv.slice(-2)).toEqual(["--account", ref!.external_ref as string]);
    expect(JSON.parse(argv[argv.indexOf("-d") + 1]!)).toEqual({ to: r, subject: "Quarterly update", body: "Hi,\nnumbers attached in the portal.\nSam", is_html: false });
    expect((await items(w, hash))[0]).toMatchObject({ state: "sent", tool: "OUTLOOK_SEND_EMAIL" });
  });

  test("EXEC: Gmail through Composio pins include_signature false (the s13 live schema)", async () => {
    const r = to();
    const hash = await proposeOk(w, [email(r)]);
    await approveHttp(w, "member", hash);
    expect(w.composio.tools().at(-1)).toBe("GMAIL_SEND_EMAIL");
    expect(w.composio.args().at(-1)).toEqual({ recipient_email: r, subject: "Seed round follow-up", body: `Hi,\nshort note for ${r}.\nSam`, include_signature: false });
  });

  const tamperCases: Array<[string, (c: CommitCall) => CommitCall, string]> = [
    ["an extra cc", (c) => ({ ...c, args: { ...c.args, cc: "boss@evil.example" } }), "cc is not allowed"],
    ["a changed subject", (c) => ({ ...c, args: { ...c.args, subject: "Urgent: wire money" } }), "arguments differ"],
    ["a changed recipient", (c) => ({ ...c, args: { ...c.args, recipient_email: "x@evil.example" } }), "arguments differ"],
    ["an extra bcc", (c) => ({ ...c, args: { ...c.args, bcc: ["x@evil.example"] } }), "bcc is not allowed"],
    ["signature turned on", (c) => ({ ...c, args: { ...c.args, include_signature: true } }), "include_signature must be false"],
    ["another tool", (c) => ({ ...c, tool: "GMAIL_SEND_DRAFT" }), "not the approved tool"],
  ];
  for (const [name, change, reason] of tamperCases) {
    test(`EXEC: ${name} is denied before any call (failed_before_send)`, async () => {
      const runner = new FakeComposio();
      const hash = await proposeOk(w, [email(to())]);
      await withComposio(new Tampering(runner, change), () => approveHttp(w, "member", hash));
      expect(runner.calls).toHaveLength(0);
      const [it] = await items(w, hash);
      expect(it!.state).toBe("failed_before_send");
      expect(it!.error).toContain(reason);
    });
  }

  test("EXEC: company MCP: the MCP client gets the approved send_email arguments on the connection's server", async () => {
    const r = to();
    const before = w.mcp.calls.length;
    const hash = await proposeOk(w, [email(r)], { connectionId: w.conns.mcp });
    await approveHttp(w, "member", hash);
    expect(w.mcp.calls.length - before).toBe(1);
    expect(w.mcp.calls.at(-1)).toEqual({ server: "mcp_sales_gmail", tool: "send_email", args: { to: [r], subject: "Seed round follow-up", body: `Hi,\nshort note for ${r}.\nSam` } });
  });

  test("EXEC: direct API: the transport gets the approved operation and body", async () => {
    const before = w.api.calls.length;
    const item = { key: "ops@northzone.com", capability: "chat.post", fields: [["to", "ops@northzone.com"], ["subject", ""], ["body", "Deploy done."], ["verb", "post_message"], ["channel", "C042"]] as Array<[string, string]> };
    const hash = await proposeOk(w, [item], { connectionId: w.conns.api });
    await approveHttp(w, "member", hash);
    expect(w.api.calls.length - before).toBe(1);
    expect(w.api.calls.at(-1)).toEqual({ connectionRef: "api_sales", operation: "SLACK_SEND_MESSAGE", body: { channel: "C042", markdown_text: "Deploy done.", unfurl_links: false, unfurl_media: false } });
  });

  test("EXEC: a non-email commit (Instantly lead) is built from its labelled fields", async () => {
    const item = { key: "lead@target.com", capability: "outreach.add_lead", fields: [["to", "lead@target.com"], ["subject", ""], ["body", ""], ["verb", "add_to_campaign"], ["campaign_id", "cmp_1"], ["first_name", "Lea"]] as Array<[string, string]> };
    const hash = await proposeOk(w, [item], { connectionId: w.conns.org });
    await approveHttp(w, "member", hash);
    expect(w.composio.tools().at(-1)).toBe("INSTANTLY_ADD_LEADS_BULK");
    expect(w.composio.args().at(-1)).toEqual({ campaign_id: "cmp_1", leads: [{ email: "lead@target.com", first_name: "Lea" }], skip_if_in_campaign: true, verify: false });
  });
});
