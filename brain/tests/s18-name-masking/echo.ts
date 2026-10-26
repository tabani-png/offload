// Shared by the INJECT and LEFTOVER tests: the stub model behind the real router, with a draft reply that echoes the
// recipient's notes cell (as a model may) and optional extra text.
import { StubModel } from "../../src/models/model.ts";
import type { Backend, BackendReply, BackendRequest } from "../../src/models/router.ts";

export const UNFILLED = "a name Offload could not fill in: check the names before you approve";
export const ECHO = "NOTE-ECHO: ";

/** The stub model behind the real router. A draft reply echoes the recipient's notes cell, as a model may. */
export class EchoNotesBackend implements Backend {
  readonly kind = "stub" as const;
  readonly metered = false;
  readonly calls: BackendRequest[] = [];
  private readonly stub = new StubModel();
  constructor(private readonly extra: (r: BackendRequest) => string = () => "") {}
  async complete(r: BackendRequest): Promise<BackendReply> {
    this.calls.push(r);
    let text = await this.stub.complete({ role: r.role, model: r.model, system: r.system, prompt: r.prompt, maxTokens: r.maxTokens });
    if (r.role === "draft") {
      const notes = /"notes":"((?:[^"\\]|\\.)*)"/.exec(r.prompt)?.[1];
      if (notes !== undefined && notes !== "") text = `${ECHO}${JSON.parse(`"${notes}"`) as string}\n${text}`;
      text += this.extra(r);
    }
    return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, model: r.model };
  }
}

export const echoLine = (body: string) => body.split("\n").find((l) => l.startsWith(ECHO)) ?? "";
