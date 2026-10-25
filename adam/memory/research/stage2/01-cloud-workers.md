# 01 · Cloud workers: where an always-on agent with a browser should run

Date: 2026-10-25. Scope: S2-06 (cloud workers), feeds S2-07 (overnight).
Tags: CONFIRMED = read in source (URL or path given) · INFERENCE = my reasoning from confirmed facts · UNKNOWN = not found.
Local source: `~/builds/cua` (sparse clone, commit `59cf287`, 2026-10-24). Prior teardown: `workpaper/adam/memory/research/pivot/12-rea-cua.md`.

---

## Headline

1. **Cua Cloud is gone.** Cua Cloud and Fleets ended on 18 October 2026. The SDK now raises `CloudEnded` for `on="cloud"`. Any plan that says "use cua's cloud sandboxes" is dead on arrival. Cua is now a bring-your-own-computer product.
2. **"One always-on VM per employee" is the wrong unit for v1.** Most overnight jobs (drafts, research, follow-ups) need an API session, not a desktop. Always-on desktops cost $25 to $470 per person per month and add a large attack surface.
3. **Recommendation for v1:** Claude Managed Agents for headless, scheduled and overnight work (per-role agent, vault credentials, per-tool approval, budgets, cron). Add Browserbase (contexts) only for workflows that need a logged-in web UI with no API. Keep full desktops (cua SDK on your own cloud, or E2B/Fly) as a later, per-role opt-in.

---

## 1. cua today

| # | Claim | Tag | Evidence |
|---|---|---|---|
| 1.1 | Cua Cloud and Fleets (pools, claims, warm replicas, Terraform provider) ended 18 Oct 2026. `on="cloud"`, `local=False`, `pool:` refs fail with "Cua Cloud has ended". | CONFIRMED | https://cua.ai/docs/cua-sdk/guides/cua-cloud-ended ; `libs/python/cua-sandbox/cua_sandbox/_ended.py`; `_placement.py` lines 5-7, 177-222 |
| 1.2 | `cuabot`, `cua-computer`, `cua-computer-server`, `cua-agent` are deprecated. Cua says "Do not run cuabot" (known security issues). | CONFIRMED | same cloud-ended page |
| 1.3 | The `cua-agent` loop that our teardown 12 studied (ComputerAgent + LiteLLM) is no longer maintained. Cua now says "bring your own agent" plus Cua Driver MCP. | CONFIRMED | same page, "cua-agent" section |
| 1.4 | Where sandboxes run now: local (default); your own cloud `aws`, `gcp`, `hetzner`, `modal` via `cua cloud connect`; contrib providers `e2b`, `daytona`, `modal` (opt-in build); `direct:<addr>` to any host running cua-spacesd. | CONFIRMED | https://cua.ai/docs/cua-sdk/guides/local-runtimes ; `cua_sandbox/sandbox.py` lines 290-320 (`_apply_on`) |
| 1.5 | Local runtimes: containers via gVisor (else runc) on Docker/Podman; Linux/Windows VMs via QEMU (KVM/HVF/WHPX); macOS VMs via Lume (Apple Virtualization.framework, Apple silicon only). | CONFIRMED | local-runtimes page; `runtime/lume.py` docstring lines 1-7; `runtime/` listing (docker, lume, tart, qemu, hyperv, android_emulator, native) |
| 1.6 | macOS caps a host at 128 VMs at once (hypervisor slots); QEMU VMs admitted by real RSS (default 0.8 of RAM), vCPU overcommit 8x. | CONFIRMED | local-runtimes page "Many VMs on one machine" |
| 1.7 | Cua Spaces pricing: Free (2 live sessions, 20 remote hours/mo), Pro $15/mo yearly or $18 monthly, Teams $25/seat/mo yearly or $30 monthly (5 sessions + 200 remote hours per seat pooled, roles, device approval). SSO and audit export "not included yet". "Cua doesn't rent [computers]": you pay your own cloud. | CONFIRMED | https://cua.ai/pricing |
| 1.8 | Licences: everything outside Cua Spaces and Cua Driver Bench is MIT (SDK, `cua` CLI, daemon, Cua Driver, Lume). FSL-1.1-MIT covers the Spaces apps, cua-spacesd, Cua Keyvault, teleport, Cua Volume, streaming client/codecs/viewers; free to self-host and build on but "no competing hosted service"; each release becomes MIT two years after it ships. Cua Driver Bench became FSL on 11 Oct 2026. Optional `cua-som` is AGPL-3.0. | CONFIRMED | `~/builds/cua/README.md` lines 267-279 |
| 1.9 | Consequence: Offload may embed the MIT SDK, Lume and Cua Driver. Offload must not ship a hosted service built on cua-spacesd or Keyvault (FSL "competing use"), and the current VM images ship cua-spacesd. | INFERENCE | from 1.8 + local-runtimes page ("VM images apply [layers] after boot through cua-spacesd"). Check `legal/LICENSING.md` and `legal/COMMERCIAL.md` (not checked out) before relying on any image. |
| 1.10 | Exact status of cua-spacesd inside the images we would use on AWS/GCP (FSL) and whether a pure-MIT agentless path (VNC/SSH/QMP) is good enough. | UNKNOWN | `transport/agentless.py` exists; not read |

## 2. Alternatives for "an agent that runs non-stop with a browser"

Reference size for comparison: 2 vCPU, 4 GiB RAM, running 24x7 for 30 days (720 h). Arithmetic is mine from published unit prices.

| Option | What it is | Unit price (source) | Always-on 720 h, 2 vCPU/4 GiB | Persistence | Isolation | Credentials | Tag |
|---|---|---|---|---|---|---|---|
| **Claude Managed Agents** (cloud env) | Anthropic-hosted agent harness; each session gets its own fresh Linux container; tools: bash, files, web search/fetch, MCP; skills | tokens + **$0.08 per session-hour, only while `running`**; idle, waiting for approval, and terminated time free; web search $10/1k | $57.60 if literally running all month, plus tokens. Realistic overnight job: one Opus 1-h session ~ $0.58 (Anthropic worked example) ≈ $17-21/mo nightly | Sessions are stateful (history, sandbox state, outputs server-side); memory stores; scheduled deployments (cron, timezone, pause/unpause, run records, up to 1,000/org) | Per-session container; `limited` networking with `allowed_hosts`; self-hosted sandbox option | Vault, injected "at the network boundary, so the agent and its code only ever see a placeholder"; per-tool policy: auto / always ask / check-then-run; MCP tools ask by default; session budget cap (`max_list_cost`, goes idle with `budget_reached`) | CONFIRMED: https://claude.com/platform/claude-managed-agents ; https://platform.claude.com/docs/en/managed-agents/overview ; https://platform.claude.com/docs/en/managed-agents/environments ; budget + schedule details via https://sobalabs.ai/blog/claude-managed-agents-what-you-still-own/ and https://www.developersdigest.tech/blog/claude-code-routines-vs-managed-agents-schedules (secondary, verify on platform docs) |
| **Browserbase** | Hosted headless Chromium sessions + live view; Functions runtime | Developer $20: 100 browser-h then $0.12/h; Startup $99: 500 h then $0.10/h; 25/100 concurrency; 7/30-day retention; Enterprise: SSO, DPA, HIPAA BAA | ~$72-86 per always-open browser; but billed by browser-hour so on-demand use is far cheaper | **Contexts** persist the Chromium user-data dir (cookies, localStorage, IndexedDB), encrypted at rest (AES-256-CBC), live until deleted | Isolated browser per session | Log in once by a human through Live View, persist in a Context; 1Password Agentic Autofill fills logins without returning secrets to the app | CONFIRMED: https://www.browserbase.com/pricing ; https://docs.browserbase.com/platform/browser/core-features/contexts ; https://docs.browserbase.com/platform/identity/authentication |
| **E2B** | Firecracker-style sandboxes (also a Desktop template) | per second: 2 vCPU $0.000028/s + 4 GiB $0.000018/s; Pro $150/mo base | **$119** + $150 Pro base (org-wide) | Pause/resume saves filesystem + memory; paused sandboxes kept indefinitely and not billed; continuous run capped at 24 h on Pro (resets on pause/resume) | microVM per sandbox | Not read | CONFIRMED: https://e2b.dev/pricing ; https://docs.e2b.dev/sandbox/persistence ; https://docs.e2b.dev/faq/sandbox-lifetime |
| **Daytona** | Sandboxes, per second | vCPU $0.0504/h, GiB $0.0162/h, storage $0.000108/GiB-h after 5 free | **$119** | Not read | Not read | Not read; SSO/audit/BYOC on Enterprise | CONFIRMED price: https://www.daytona.io/pricing ; rest UNKNOWN |
| **Fly Machines** | Firecracker microVMs, raw infra | shared-cpu-2x/4GB $25.40/mo; performance-2x/4GB $66/mo; stopped machine $0.15/GB rootfs; volume $0.15/GB/mo | **$25-66** (you build the desktop/browser stack yourself) | Volumes; stop/suspend | microVM | Your own secret store (Fly secrets) | CONFIRMED price: https://docs.fly.io/about/pricing ; https://fly.io/pricing (iad) |
| **cua SDK on your own AWS/GCP/Hetzner** | MIT SDK places sandboxes in our cloud account | provider rates | provider rates (e.g. Fly/Hetzner-class) + ops work | per provider; "your own cloud gives each sandbox a time limit and cleans up after it" | gVisor container / QEMU VM | Sidecars/secrets "work the same way" | CONFIRMED placement: local-runtimes + cloud-ended pages; cost UNKNOWN |
| **macOS in the cloud (EC2 Mac)** | Bare-metal Mac mini on a Dedicated Host | 24-hour minimum allocation (Apple licence); one Mac instance per host; Savings Plans up to 44% off | Hourly rate not read. INFERENCE: several hundred dollars per host-month | EBS | Dedicated hardware | your own | CONFIRMED terms: https://aws.amazon.com/ec2/instance-types/mac/ ; https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html ; price UNKNOWN |

Notes
- 2.1 Managed Agents' built-in tools do not include a GUI browser or computer-use tool; "browse the web" means web search/fetch. CONFIRMED (overview "Supported tools"). A headless Chromium + Playwright could be installed via `packages` (apt/npm). INFERENCE, untested.
- 2.2 Managed Agents is not eligible for Zero Data Retention or HIPAA BAA; sessions, sandbox state and outputs are stored server-side; deletable via API. CONFIRMED (overview, "Beta access"). This matters for the DPA in S2-10.
- 2.3 Managed Agents is beta (`managed-agents-2026-04-01` header). CONFIRMED (overview).
- 2.4 Self-hosted sandbox mode moves tool execution to our infra, but "Claude still runs on Anthropic's side", and tool inputs/outputs flow to Anthropic. CONFIRMED (https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes).
- 2.5 macOS VMs: Apple's macOS licence limits virtualisation to Apple hardware (the EC2 Mac 24 h minimum exists "to comply with the Apple macOS Software License Agreement"). CONFIRMED (AWS Mac page). Per-employee macOS cloud VMs are therefore the most expensive option by an order of magnitude. INFERENCE.

## 3. Security isolation and credentials: what good looks like

| # | Pattern | Tag |
|---|---|---|
| 3.1 | Secrets never enter the sandbox in clear: inject at an egress proxy (Managed Agents vault), or keep in an encrypted browser Context (Browserbase), or a password-manager fill that returns nothing to the app (1Password Agentic Autofill). | CONFIRMED (sources in table) |
| 3.2 | Egress allowlist per environment (Managed Agents `limited` networking + `allowed_hosts`; Browserbase allowed domains). | CONFIRMED |
| 3.3 | Company-held identities: OAuth connections owned by the org (Composio org connections, company MCP), not the employee's personal tokens. Aligns with plan principle 2. | INFERENCE |
| 3.4 | Human logs in once through a live view, then the agent reuses the session; MFA prompts route back to a human. | CONFIRMED (Browserbase auth doc, "Use the session live view", "2FA challenges") |
| 3.5 | One worker identity per role, not per person; sessions on demand, not always-on. Fewer standing secrets, smaller blast radius, cost tracks work done. | INFERENCE |

## 4. Recommendation for v1 (S2-06)

1. **Primary: Claude Managed Agents** as the cloud worker. One agent definition per role workflow; one environment per tenant with `limited` networking; scheduled deployments for overnight jobs; session budgets as the per-night cap; vault credentials; per-tool "always ask" for any commit tool so the ADR 0006 gate holds. Cost tracks real work ($0.08 per running hour plus tokens), idle is free.
2. **Browser tasks without an API: Browserbase** sessions with one Context per role per site, human first login via Live View, `persist: true`. Pay per browser-hour.
3. **Do not use cua Cloud** (ended). Keep cua's MIT SDK and Lume as the option for "watch the agent on a full desktop" and for customers that want workers in their own cloud (`on="aws"/"gcp"`). Do not ship cua-spacesd/Keyvault inside a hosted Offload service without reading `legal/COMMERCIAL.md`.
4. **Defer always-on per-employee desktops** to after v1. If a customer insists, E2B (pause/resume, paused is free) or Fly Machines are the cheapest Linux options; macOS cloud VMs only on dedicated Mac hosts.
5. **Open risk:** Managed Agents data retention (no ZDR) must be disclosed in our DPA and the customer's DPIA (see file 02).

## TO CONFIRM
- TC1. Browserbase maximum session duration and keep-alive limits (not read).
- TC2. E2B secrets handling and Desktop template pricing.
- TC3. Managed Agents vault docs page and permission-policy page (read only the marketing FAQ and secondary blogs for these).
- TC4. EC2 Mac hourly rate in the target region.
- TC5. `legal/LICENSING.md`, `legal/COMMERCIAL.md` in the cua repo (widen sparse checkout).
