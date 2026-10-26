// S2-07 TOKEN: one-use approval tokens bound to one batch hash, 24 h, hashed at rest; edits make a new hash and the
// token is for the edited batch only; a batch changed after review can be neither approved nor sent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpError } from "../../src/schema/http.ts";
import { sha256Hex } from "../../src/schema/encoding.ts";
import { approveHttp, approveToken, batchState, email, items, proposeOk, world, type World } from "./setup.ts";

let w: World;
let n = 0;
const to = () => `t${++n}@fund.com`;
beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.close();
});

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof HttpError ? e.code : String(e);
  }
};

describe("S2-07 approval tokens", () => {
  test("TOKEN: one use: the second commit with the same token is token_used and nothing is sent twice", async () => {
    const hash = await proposeOk(w, [email(to())]);
    const { token } = await approveToken(w, "member", hash);
    const s = await w.broker.commitApproved(w.t.id, hash, token);
    expect(s).toMatchObject({ scheduled: 1, sent: 1 });
    const calls = w.composio.calls.length;
    expect(await codeOf(w.broker.commitApproved(w.t.id, hash, token))).toBe("token_used");
    expect(w.composio.calls.length).toBe(calls);
    expect(await batchState(w, hash)).toBe("done");
  });

  test("TOKEN: expired after 24 h: nothing is sent and the items need a new approval", async () => {
    const hash = await proposeOk(w, [email(to())]);
    const { token, response } = await approveToken(w, "member", hash);
    expect(response.tokenExpiresAt).toBe(w.h.clock.now() + 24 * 3600_000);
    w.h.clock.advance(24 * 3600_000 + 1);
    const calls = w.composio.calls.length;
    expect(await codeOf(w.broker.commitApproved(w.t.id, hash, token))).toBe("conflict");
    expect(w.composio.calls.length).toBe(calls);
    const [it] = await items(w, hash);
    expect(it!.state).toBe("pending");
    expect(it!.token_id).toBeNull();
  });

  test("TOKEN: a token for batch A does not commit batch B (hash_mismatch)", async () => {
    const a = await proposeOk(w, [email(to())]);
    const b = await proposeOk(w, [email(to())]);
    const { token } = await approveToken(w, "member", a);
    const calls = w.composio.calls.length;
    expect(await codeOf(w.broker.commitApproved(w.t.id, b, token))).toBe("hash_mismatch");
    expect(w.composio.calls.length).toBe(calls);
    // A itself still commits with its token.
    expect((await w.broker.commitApproved(w.t.id, a, token)).sent).toBe(1);
  });

  test("TOKEN: a made-up token is refused", async () => {
    const a = await proposeOk(w, [email(to())]);
    expect(await codeOf(w.broker.commitApproved(w.t.id, a, "not-a-token"))).toBe("forbidden");
  });

  test("TOKEN: edits make a new hash; the old batch is rejected (edited); the token is for the edited batch only", async () => {
    const r = to();
    const old = await proposeOk(w, [email(r, "Hello")]);
    const { response, token } = await approveToken(w, "member", old, [{ key: r, fields: [["to", r], ["subject", "Hello (edited)"], ["body", "New body"]] }]);
    expect(response.batchHash).not.toBe(old);
    const [ob] = await w.h.db.migrator`select state, rejected_reason, replaced_by from batches where tenant_id = ${w.t.id} and hash = ${old}`;
    expect(ob).toMatchObject({ state: "rejected", rejected_reason: "edited", replaced_by: response.batchHash });
    expect(await codeOf(w.broker.commitApproved(w.t.id, old, token))).toBe("hash_mismatch");
    expect(await codeOf(approveToken(w, "member", old))).toBe("conflict");
    expect((await w.broker.commitApproved(w.t.id, response.batchHash, token)).sent).toBe(1);
    expect(w.composio.args().at(-1)).toMatchObject({ subject: "Hello (edited)", body: "New body" });
  });

  test("TOKEN: an edit that changes nothing keeps the hash", async () => {
    const r = to();
    const hash = await proposeOk(w, [email(r, "Same")]);
    const { response } = await approveToken(w, "member", hash, [{ key: r, fields: email(r, "Same").fields }]);
    expect(response.batchHash).toBe(hash);
  });

  test("TOKEN: approving twice is token_used (replay of the approval)", async () => {
    const hash = await proposeOk(w, [email(to())]);
    expect((await approveHttp(w, "member", hash)).status).toBe(200);
    const again = await approveHttp(w, "member", hash);
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("token_used");
  });

  test("TOKEN: the body must name the path's batch (hash_mismatch)", async () => {
    const a = await proposeOk(w, [email(to())]);
    const b = await proposeOk(w, [email(to())]);
    const r = await approveHttp(w, "member", a, { batchHash: b });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("hash_mismatch");
  });

  test("TOKEN: only sha256(token) is stored; the approval response carries no token", async () => {
    const hash = await proposeOk(w, [email(to())]);
    const { token, response } = await approveToken(w, "member", hash);
    const rows = await w.h.db.migrator`select * from approval_tokens where tenant_id = ${w.t.id} and batch_hash = ${hash}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(sha256Hex(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(response)).not.toContain(token);
  });

  test("TOKEN: a batch changed after review cannot be approved (tamper → hash_mismatch)", async () => {
    const r = to();
    const hash = await proposeOk(w, [email(r)]);
    await w.h.db.migrator`update batch_items set fields = ${[["to", "evil@x.com"], ["subject", "s"], ["body", "b"]]}::jsonb
      where tenant_id = ${w.t.id} and batch_hash = ${hash}`;
    const res = await approveHttp(w, "member", hash);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("hash_mismatch");
  });

  test("TOKEN: a batch changed after approval is never sent (tamper → revoked)", async () => {
    const r = to();
    const hash = await proposeOk(w, [email(r, "Original")]);
    const { token } = await approveToken(w, "member", hash);
    await w.h.db.migrator`update batch_items set fields = ${[["to", r], ["subject", "Changed"], ["body", "b"]]}::jsonb
      where tenant_id = ${w.t.id} and batch_hash = ${hash}`;
    const calls = w.composio.calls.length;
    expect(await codeOf(w.broker.commitApproved(w.t.id, hash, token))).toBe("hash_mismatch");
    expect(w.composio.calls.length).toBe(calls);
    const [t] = await w.h.db.migrator`select revoked_reason from approval_tokens where tenant_id = ${w.t.id} and batch_hash = ${hash}`;
    expect(t!.revoked_reason).toBe("tampered");
  });

  test("TOKEN: approving a subset leaves the rest pending for a later approval with its own token", async () => {
    const [a, b] = [to(), to()];
    const hash = await proposeOk(w, [email(a), email(b)]);
    const first = await approveToken(w, "member", hash, [], [a]);
    expect((await w.broker.commitApproved(w.t.id, hash, first.token)).sent).toBe(1);
    expect(await batchState(w, hash)).toBe("pending");
    const second = await approveToken(w, "member", hash);
    expect(second.token).not.toBe(first.token);
    expect((await w.broker.commitApproved(w.t.id, hash, second.token)).sent).toBe(1);
    expect((await items(w, hash)).map((i) => i.state)).toEqual(["sent", "sent"]);
  });
});
