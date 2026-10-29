# Cindy eval: can it be Offload's builder engine?

Date: 2026-10-26. Repo: github.com/makecindy/cindy at `7c5bd270c` (cloned to /tmp/cindy, not committed here).
Everything in that repo was read as untrusted data.

**Verdict: BORROW.** Don't embed Cindy. Copy a few small ideas into our own Agent SDK runner.

## What Cindy is

- An Electron desktop app plus an Expo mobile app, in one big pnpm monorepo (17k files). Apache-2.0, made by XD Inc.
- It is a shell around other agent CLIs. It does not have its own agent loop. Backends ("harnesses"):
  - **Claude Code**: through the official `@anthropic-ai/claude-agent-sdk` (0.3.292). It sets
    `pathToClaudeCodeExecutable` to a pinned `claude` binary (2.1.296), and each turn is one SDK `query()`.
  - **Codex**: runs `codex app-server` and talks JSON-RPC to it.
  - **Pi**: a third CLI agent, over RPC JSONL.
- `apps/cindy-headless` is a CLI with no UI (`cindy-headless run --profile p.json --task ...`). It runs one harness
  and writes events, usage and a result. It is built for the Harbor benchmark tool.
- About the "no API key" note: the **desktop** app can reuse your Claude Code or Codex subscription login
  (`oauth-bearer` mode). **Headless only takes an API key** (`ANTHROPIC_API_KEY` or `CINDY_HEADLESS_API_KEY`) or a
  gateway URL. So a server-side embed would still need a key, or a patch.

## 1. Security read (done before running anything)

| Item | Finding | Risk |
| --- | --- | --- |
| Install scripts | Root `postinstall` downloads the claude, codex, ripgrep and pi binaries from their official sources (npm, downloads.claude.ai, GitHub), with sha256 checks that fail closed. If those are slow it falls back to XD's own CDN. It also chmods node-pty and fetches Electron. | Medium. Avoided with `--ignore-scripts`. |
| Network / telemetry | The desktop app talks to about 20 `*.cindy.app` services by default (auth, chat, heartbeat, skill hub, plugins, auto-update CDN). I found none of these calls in the headless and maker-core code. It sets `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1` for Claude Code. | Medium for desktop, low for headless. |
| Credentials | Keys come from env vars or a config file outside the repo. Profiles refuse to hold keys. | OK |
| Shell / sandbox | Headless defaults to `permissionMode: bypassPermissions` (the agent runs any tool with no prompt). It refuses to start unless `containerSandbox: true` or an "unsafe" flag is set. Cindy has no sandbox of its own; it expects a container around it. | High if run on a user's Mac. Fine in a throwaway container. |
| Dependencies | 3,722 lockfile entries. Even `--filter cindy-headless...` installs **2,309 packages**. | High upkeep and supply-chain surface. |
| Activity | Very active: 3,442 commits and 64 authors in the last 30 days, commits merged today. | Good, but it moves fast and has no stable API. |
| License | Apache-2.0, DCO sign-off, no CLA. | OK to borrow from, with attribution. |

Nothing was dangerous enough to stop at this stage, so I installed (`--ignore-scripts`) and built headless (it worked:
`version` → 0.4.3).

## 2. The 3 outcome tasks

**Cindy itself was not run on the tasks.** The sandbox's safety check blocked running Cindy's headless CLI, which is
untrusted external code that would drive a nested agent with permissions bypassed. I did not try to get around that
block. To still get outcome numbers, I ran the same 3 tasks on the **`claude` CLI** (2.1.310, in this environment).
Cindy's Claude harness is a wrapper around this same CLI, so this baseline shows what Cindy would build on. These
are **not** Cindy results.

How the runs were set up: `claude -p --permission-mode acceptEdits`, an allowlist of tools (Read, Write, Edit, Glob,
and python3/ls/mkdir/mv/cat in Bash), max 40 turns, one folder per task, no network tools. My own check scripts graded
each result afterwards, and the agent never saw those scripts. For task (c) the brief included `accept.py`, and I
checked by sha256 that the agent did not change it.

| Task | Outcome check | Turns | Time | Cost (CLI's own report) | Notes |
| --- | --- | --- | --- | --- | --- |
| (a) recorded steps → `weekly.py` | **PASS** | 5 | 13 s | $0.08 | Handled case and space cleanup, title case, 2-decimal totals. |
| (b) sort receipts into folders + `index.json` | **PASS** | 8 | 27 s | $0.11 | 3 date formats, file with spaces in its name, junk file to `unsorted/`. 2 tool calls were blocked by the allowlist (`cd`, heredoc) and it worked around them. |
| (c) solution brief + `accept.py` → `dedupe.py` with `--dry-run` / `--apply` | **PASS** | 7 | 30 s | $0.13 | It ran `accept.py` itself and stopped on ACCEPT PASS. Dry run changed no files. 1 tool call blocked, worked around. |

How it decides it is done: the model just stops (end of turn). Task (c) only "builds until the checks pass" because
the prompt told it to run `accept.py`. Nothing outside the model forced that. Cindy headless works the same way: a run
ends when the harness sends its last-turn event. Scoring is left to Harbor, outside Cindy. Cindy desktop's multi-agent
mode ("Orca": a lead agent hands out work and judges it) has the lead **model** decide if work is done, not a check
script.

Failure modes I saw or that the code shows: tool calls blocked by the allowlist (the agent recovered); a model that
says "done" without checking, unless the prompt forces a check; and with bypass mode, nothing stops it editing the
check file. That is why we hash it.

## 3. Mapping to Offload

| Offload need | Cindy | Fit |
| --- | --- | --- |
| Exact, single-use approval gate (batchHash, ADR 0006) | Desktop has per-tool approval prompts (`canUseTool`, closed by default). Headless has no approval channel and wants bypass mode. Nothing like a hash-bound, one-use approval. | Poor. We keep our own gate. |
| Dry run first, commit after approval | No dry-run idea at all. The agent changes the workspace directly. | None. Ours is the better design. |
| Outcome-based (checks decide done) | No acceptance-check loop. Done = the model stops. | None built in. We'd wrap it ourselves either way. |
| MCP | Yes. Headless takes remote MCP servers by URL (https, or http on localhost only). Desktop has many built-in MCPs. | OK, but the Agent SDK already gives us this. |
| CLI backends | Claude Code, Codex and Pi behind one event model. This is its real strength. | Nice to have. Only matters if we want Codex or Pi too. |
| Embedding | We'd have to vendor `maker-core` (one huge file per harness: `claude-code/index.ts` is 4k+ lines of mostly Chinese comments), bring in its 2k+ packages, and track a repo with ~100 commits a day. | Expensive. |
| Same base as us | Offload's brain already uses the Claude Agent SDK (ADR 0004). Cindy's Claude path is the same SDK. | Cindy adds a layer, not a new ability. |
| License | Apache-2.0 | OK to borrow code with NOTICE. |

Note: the task said to read `adam/memory/research/pivot/`. That folder does not exist on `main` or on the other
branches I checked (`handoff-2026-10-25`, `integration-wave-b`). I used `brain/API.md`, `plan/plan.md` and
`plan/adr/` instead. Most ADR files there are short pointers into `plan/plan.md`.

## 4. Verdict: BORROW

Three strongest reasons:

1. **It adds no outcome loop.** The part Offload needs is the loop: run the brief, run the acceptance checks, feed
   failures back, stop only on pass, cap turns and cost. Cindy doesn't have it. Headless ends when the model stops, and
   Orca lets a model judge. We'd write this loop either way, and it is about 100 lines around the Agent SDK we already use.
2. **It works against our safety model.** Headless wants `bypassPermissions` inside a container. It has no dry run and
   no hash-bound, one-use approval. Offload's promise is that nothing changes until you approve this exact batch.
   Embedding Cindy means fencing it in from the outside, not reusing it.
3. **Too heavy to embed.** 2,309 packages for headless alone, a fast-moving codebase with no stable API, and desktop
   defaults that talk to `*.cindy.app`. The upkeep cost is much bigger than what we'd get.

Ideas worth borrowing (small, Apache-2.0):

- **Profile + digest pinning**: pin the harness binary version, the system prompt sha256 and the profile digest in each
  run's result, so a build can be repeated and audited. This fits our gate log.
- **"Bypass only inside a container"** rule (`assertSafeExecutionProfile`) as a hard check in our builder runner.
- **One event model for several harnesses** (Claude Agent SDK, `codex app-server` JSON-RPC), if we ever want Codex as
  a second builder.
- **Usage artifact per run** (tokens and cost), for "hours saved vs cost" in the brief result.
- Env defaults for Claude Code subprocesses (`DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`).

Cost of each path:

- **USE (embed headless):** about 1–2 weeks to vendor `maker-core` and headless, patch in OAuth or keyless auth, and
  wrap them in our gate and dry run. After that, ongoing work to follow upstream, plus a 2k-package supply-chain review.
  We'd still have to write the outcome loop.
- **BORROW (recommended):** 2–3 days. Add a "brief runner" to the brain: Agent SDK `query()` in a temp workspace, then
  run the acceptance checks, retry with the failure output (cap N tries and $X), check by hash that the check files are
  unchanged, and save a run record (profile digest, usage, check output). The baseline above shows the model already
  passes small briefs in 1 try, at ~$0.08–0.13 and under 30 s each.
- **SKIP:** zero cost now, but we'd miss the profile-pinning and harness-abstraction ideas.

## Re-run

The tasks and checks were written to `/tmp/cindy-work/tasks` (temporary, not committed). To repeat: build the same 3
folders, run `claude -p "<prompt>" --output-format json --permission-mode acceptEdits --allowedTools ...` in each,
then run the check scripts. To actually test Cindy, run `cindy-headless run` in a throwaway container with
a profile whose `agentBinaryPath` points at `claude`, and set an API key. That run was blocked here.
