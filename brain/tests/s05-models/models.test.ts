// s05 AC-6: model routing and config. Drafting uses the best model, cheap steps the cheaper one; all offline here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODELS, loadModelConfig, modelFor, StubModel, tagged } from "../../src/models/model.ts";
import { tempHome } from "../helpers.ts";

let home = "";
let cleanup = () => {};
beforeEach(() => ({ home, cleanup } = tempHome()));
afterEach(() => cleanup());

describe("s05 models", () => {
  test("defaults: drafting claude-opus-5-5, cheap steps claude-sonnet-5-5", () => {
    expect(DEFAULT_MODELS).toEqual({ draft: "claude-opus-5-5", cheap: "claude-sonnet-5-5" });
    expect(modelFor("draft", DEFAULT_MODELS)).toBe("claude-opus-5-5");
    expect(modelFor("bucket", DEFAULT_MODELS)).toBe("claude-sonnet-5-5");
    expect(modelFor("style_card", DEFAULT_MODELS)).toBe("claude-sonnet-5-5");
  });

  test("models.json overrides, then env overrides", () => {
    writeFileSync(join(home, "models.json"), JSON.stringify({ cheap: "claude-haiku-5" }));
    expect(loadModelConfig(home, {})).toEqual({ draft: "claude-opus-5-5", cheap: "claude-haiku-5" });
    expect(loadModelConfig(home, { OFFLOAD_MODEL_DRAFT: "claude-sonnet-5-5" }).draft).toBe("claude-sonnet-5-5");
    expect(loadModelConfig(join(home, "missing"), {})).toEqual({ ...DEFAULT_MODELS });
  });

  test("a bad models.json is an error, not a silent default", () => {
    writeFileSync(join(home, "models.json"), JSON.stringify({ draft: "rm -rf /" }));
    expect(() => loadModelConfig(home, {})).toThrow(/model id/);
  });

  test("the stub is deterministic and builds drafts only from the recipient and facts blocks", async () => {
    const prompt = '<facts>\npitch: We do X.\nraise: Raising $1M.\nask: Call?\nsign: Muhammad\n</facts>\n<recipient>\n{"email":"a@b.com","firstName":"Ana","org":"B Fund"}\n</recipient>';
    const a = await new StubModel().complete({ role: "draft", model: "m", system: "", prompt });
    const b = await new StubModel().complete({ role: "draft", model: "m", system: "", prompt });
    expect(a).toBe(b);
    expect(a).toBe("Hi Ana,\n\nWe do X.\nRaising $1M.\nI think it fits B Fund.\n\nCall?\n\nMuhammad");
    expect(tagged("x <a>\nhello\n</a> y", "a")).toBe("hello");
  });

  test("the stub records every call with its role and model", async () => {
    const s = new StubModel();
    await s.complete({ role: "bucket", model: "claude-sonnet-5-5", system: "", prompt: "<bucket_hint>scheduling</bucket_hint>" });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ role: "bucket", model: "claude-sonnet-5-5" });
  });
});
