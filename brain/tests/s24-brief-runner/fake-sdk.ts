// A recorded Agent SDK stand-in for the CLI / server tests (loaded through OFFLOAD_BUILDER_FAKE_SDK, NODE_ENV=test
// only): writes one file in the workspace, then replays a success result.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function query(args: { prompt: string; options: { cwd?: string } }): AsyncIterable<unknown> {
  return (async function* () {
    yield { type: "system", subtype: "init", claude_code_version: "2.1.310", model: "claude-sonnet-5-5" };
    writeFileSync(join(args.options.cwd!, "tool.py"), "print('built')\n");
    yield { type: "result", subtype: "success", num_turns: 3, total_cost_usd: 0.08, usage: { input_tokens: 800, output_tokens: 200, cache_read_input_tokens: 0 }, modelUsage: { "claude-sonnet-5-5": {} } };
  })();
}
