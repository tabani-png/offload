# Offload: setup guide

Offload is a Mac app that watches your screen and shows where your time goes.
It masks what it sees, encrypts it, and deletes it after 30 days.
It finds work you repeat in any field and proposes the best kind of fix.
It does nothing outside your Mac without your exact, one-time approval.

Status: pre-launch. See [LAUNCH.md](../LAUNCH.md) for what is still open.

## Requirements

| What | Version | Where this comes from |
|---|---|---|
| macOS | 14.0 (Sonoma) or later | `LSMinimumSystemVersion` in `app/Info.plist`; `-apple-macos14.0` target in `app/build.sh` |
| Apple Command Line Tools | check: the repo pins no version | `app/build.sh` and `engine/build.sh` use `swiftc` and the Swift Testing framework from `xcode-select -p`. Full Xcode is not used (ADR 0002). |
| Bun | 1.3.12 exactly | `@types/bun` 1.3.12 in `brain/`, `control/` and `web/` `package.json`; lockfiles are Bun lockfile version 1 |
| Postgres | 17 (control plane only) | `postgres:17-alpine` in `control/docker-compose.yml` |
| Docker | any recent Docker Desktop | only for the control plane tests (`control/docker-compose.yml`) |
| Disk | check: no minimum is set in the repo | builds go to `app/.build` and `engine/.build`; each Bun package gets its own `node_modules` |
| Ollama | optional | local fallback model and captioner (`127.0.0.1:11434`) |

## Setup

### 1. Clone

```bash
git clone https://github.com/tabani-png/offload.git
cd offload
```

The repo is public for hackathon review. See the license before using any of it.

### 2. Install the Command Line Tools

```bash
xcode-select --install
```

Skip this if `xcode-select -p` already prints a path.

### 3. Install Bun 1.3.12

```bash
curl -fsSL https://bun.sh/install | bash -s bun-v1.3.12
bun --version   # must print 1.3.12
```

The app looks for Bun in `~/.bun/bin/bun`, `/opt/homebrew/bin/bun`, `/usr/local/bin/bun`, then your `PATH`.
Set `OFFLOAD_BUN` to use another path.

### 4. Install the brain's packages

```bash
cd brain && bun install --frozen-lockfile && cd ..
```

### 5. Put the Anthropic key in the Keychain

```bash
security add-generic-password -U -s offload.anthropic -a api-key -w
```

The last `-w` has no value on purpose.
`security` then asks for the key, so the key never lands in your shell history.

How the brain finds it (`brain/src/vision/claude.ts`, `resolveAnthropicKey`):

- It reads `OFFLOAD_ANTHROPIC_KEYCHAIN`, which holds the item name `service/account`, here `offload.anthropic/api-key`.
- That variable holds only the name of the Keychain item. It never holds the key.
- The brain then runs `security find-generic-password -s offload.anthropic -a api-key -w` and keeps the key in memory.

Rules:

- Never put the key in a file.
- Never put the key in `ANTHROPIC_API_KEY` in a shell profile or `.env` file. The brain accepts that variable, but it puts the key on disk.
- Never paste the key into a chat or an issue.

To check the item exists without printing the key:

```bash
security find-generic-password -s offload.anthropic -a api-key >/dev/null && echo "key is in the Keychain"
```

### 6. Try the demo first (no real data, no key needed)

```bash
scripts/demo.sh
```

This builds the engine and the app.
It writes a synthetic 7-day week to `scratch/demo`, never to your real home.
It opens the app on that week with the real brain.
Demo homes use raw key files (`OFFLOAD_KEYS=file`), so nothing touches your real Keychain.

### 7. Build and run the real app

Build the engine (the observer) and the app:

```bash
engine/build.sh
app/build.sh
```

Open the app on your real home, with the Keychain item name passed through:

```bash
open -n \
  --env OFFLOAD_REPO="$PWD" \
  --env OFFLOAD_ANTHROPIC_KEYCHAIN=offload.anthropic/api-key \
  app/.build/Offload.app \
  --args --home "$HOME/Library/Application Support/Offload"
```

`scripts/run.sh` does the same build and open, but it does not pass `OFFLOAD_ANTHROPIC_KEYCHAIN`.
Use the `open` line above when you want Claude models.

The app starts the brain by itself on 127.0.0.1 with a fresh token each launch.
It stops the brain when you quit.
Brain logs: `~/Library/Logs/Offload/brain.log` and `brain.err.log`. They hold no screen content.

### 8. Start the observer

The observer records your screen. It does not start on its own.

```bash
scripts/run.sh --install-agent
```

This writes and loads `~/Library/LaunchAgents/ai.offload.observer.plist`.
To remove it:

```bash
engine/.build/offload-observer uninstall-agent
launchctl bootout gui/$(id -u)/ai.offload.observer
```

Pause and resume at any time:

```bash
engine/.build/offload-observer pause
engine/.build/offload-observer resume
engine/.build/offload-observer status --json
```

### 9. Run the brain on its own (optional)

```bash
OFFLOAD_ANTHROPIC_KEYCHAIN=offload.anthropic/api-key \
  bun run brain/src/cli.ts serve --home "$HOME/Library/Application Support/Offload"
```

The first output line is `OFFLOAD_BRAIN_READY {"port":N,"token":"..."}`.
Attach the app to it with `--brain-url URL` and `OFFLOAD_TOKEN`.
Use `--model stub` for the deterministic test model with no Claude calls.
The API is in `brain/API.md`.

### 10. Control plane (optional, Stage 2)

The control plane is the company version: teams, roles, an hours-saved dashboard.
Today it runs only for tests and local development.
No deploy target is chosen yet (`plan/stage-2/plan.md`, "Deploy target: TBD").

```bash
cd control
docker compose up -d --wait        # Postgres 17 on 127.0.0.1:54329, data in tmpfs
bun install --frozen-lockfile
bun test tests
docker compose down
```

The compose file's password is a local test value. Never use it for a real database.
Running `bun run start` needs WorkOS settings and a device signing key (see `control/src/config.ts`). Check before you try it.

## Permissions the Mac will ask for

From `engine/Sources/offload-observer/LiveSources.swift` and `engine/README.md`.
Grant them in System Settings > Privacy & Security.

| Permission | Why Offload needs it | Without it |
|---|---|---|
| Screen Recording | Reads text in the focused window (ScreenCaptureKit + Vision OCR) and takes masked keyframes. | No screen text. Focus, idle and input counts still work. |
| Accessibility | Reads window titles and browser URLs. | Titles fall back to the app's window name. No URLs. |
| Input Monitoring | Counts keys and clicks per minute. It never reads which keys. | No input counts. They are left out, never guessed. |

There is no microphone permission. No shipped feature records audio (`app/Sources/Core/Dashboard.swift`).
When you run the observer from a terminal, macOS gives the permission to the terminal app, so grant it there.
The ⌥Space hotkey needs no permission.

## Privacy and safety

**What is captured.**
The app name, window title, URL, focus time, idle time and per-minute key and click counts.
Screen text by OCR, only when the screen changes.
Masked keyframes for the vision model (ADR 0003, ADR 0007).
Key values are never stored.

**Masking.**
Titles and screen text are masked before they are written.
This covers card numbers, CVV and expiry, SSN, SIN, bank routing and account numbers, IBAN, CUSIP, ISIN, one-time codes, API keys and secrets.
URLs lose their query, fragment and user info.
Password managers, Keychain Access, authenticators, banking apps and private windows are never read.
OCR stops while a password field is active (Secure Event Input) and while you are idle.
Person names are masked before model requests in PR #7 (s18), which is not merged yet.

**Encryption.**
Each day is stored in its own file, encrypted with AES-GCM.
Day keys are wrapped by a master key in the macOS Keychain.

**Retention.**
Data is kept for 30 days.
The observer purges at start, every hour, and on `offload-observer purge-now`.
An expired day cannot be exported, even if the observer is off.

**Numbers.**
Every time and saving figure is computed by code, never by the model (ADR 0005).
Every number links back to the events behind it.

**Approval gate.**
Nothing goes out of your Mac until you approve it (ADR 0006).
Each approval is exact and single use: it covers one batch, matched by hash.
Auto-run is off until you turn it on for one workflow.

**Dry runs.**
Each workflow first runs on last week's data.
You see its output next to what you actually did, before you approve anything.

**Kill switches.**
Pause the observer from the app or with `offload-observer pause`.
Stop a computer-use session with Esc or the app's menu item (`POST /computer/stop`).
Company-wide kill switches for cloud runs are in PR #12 (S2-07), which is not merged yet.

**Company version (Stage 2).**
Raw events, screen text, keyframes, titles, URLs, recipients, subjects and bodies never leave the Mac (ADR 0103).
Only aggregates, workflow definitions and run outcomes sync.
Per-person and working-time views are off by default and need employee notice (ADR 0108).
Each tenant is isolated by Postgres row-level security (ADR 0101).

ADRs: `plan/adr/0001` to `0009` (Stage 1) and `plan/stage-2/adr/0101` to `0111` (Stage 2).

## Run the tests

```bash
scripts/verify-all.sh          # every Stage 1 slice
scripts/verify-all.sh S2-      # the Stage 2 slices (needs Docker for Postgres 17)
scripts/verify-all.sh --list   # list the slices it would run
scripts/verify-all.sh s17      # only slices whose folder name contains "s17"
```

Run them one at a time.
Parallel runs share `app/.build` and break each other's builds.

Other checks:

```bash
app/build.sh test                 # Swift Testing suites for the app
engine/build.sh test              # Swift Testing suite for the engine
cd brain && bun test              # brain tests
scripts/live-captures.sh          # live screenshots of the app; needs an unlocked screen
```

GitHub Actions has no minutes on this account, so CI shows red.
The local `verify-all.sh` run is the source of truth until billing is back.

## Where things live

| Folder | What |
|---|---|
| `engine/` | The observer, in Swift. Records events into the encrypted store. No network code. |
| `brain/` | Bun + TypeScript. Finds tasks, ranks insights, drafts and runs workflows. API in `brain/API.md`. |
| `app/` | The SwiftUI + AppKit app: rail, cards, workflow review, dashboard. |
| `control/` | Stage 2 control plane: Bun, Hono, Postgres 17 with row-level security. |
| `web/` | Stage 2 admin web app: React + Vite. |
| `packages/hours-saved/` | The pure hours-saved formula (hs-1). |
| `schemas/` | JSON Schema contracts shared by brain, control plane and web. |
| `slices/` | One folder per build slice: `SPEC.md` and `verify.sh`. |
| `scripts/` | `demo.sh`, `run.sh`, `verify-all.sh`, `live-captures.sh`. |
| `plan/` | Plans and ADRs. Stage 2 is in `plan/stage-2/`. |
| `agent-control/` | Build status files for the agents and the operator. |
| `docs/` | Harness rules and the store contract. |
