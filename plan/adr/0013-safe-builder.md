# 0013 Making the builder safe to turn on for a normal user

Date: 2026-10-26. Status: proposed (s26). Needs an operator decision; nothing here is implemented.

## Context
The brief runner (s24, `brain/src/builder/`) builds a `tool`, `setup` or `remove_step` brief until frozen acceptance
checks pass. It is OFF by default (`OFFLOAD_BUILDER_ENABLED=1` turns it on) because builder code runs under macOS
`sandbox-exec` as the SAME user, and the sandbox does not mediate `sysctl KERN_PROCARGS2`: any builder command (and
the model-written check script, which also executes) can read the full argv and environment of every other process
of that user. Re-checked on this Mac (macOS 26.5.1, 2026-10-26): KERN_PROCARGS2 on a same-user `bun` process returns
its 61 environment entries; on processes of other users (`root`, `_corespeechd`) it fails with EINVAL. So the leak is
"same uid", not "any process". Note: `/bin/ps` is setuid root and still shows other users' argv (not their
environment), so argv secrets stay visible to any local user.

What s24 already does: no secret in any argv or env of the build's own processes (the key goes through
`apiKeyHelper`), a brain whose launch environment holds a secret refuses to build, every artifact byte is scanned for
known secrets, no network in the sandbox, a frozen harness and a per-run supervisor. What it cannot do: protect a
secret in another same-user process (a terminal with an exported token, an editor plugin, another agent session).

## Which fix kinds need the builder
| fix kind | path | builder? |
|---|---|---|
| workflow | s05/s14 drafter -> dry run -> exact approval -> s13 chain (MCP, Composio, API, computer use) through the gate. Proven end to end by s26. | no |
| leave_alone | nothing is built (the choice answers 409 "nothing to build") | no |
| tool | a new script or small program | yes |
| remove_step | a pipeline that replaces a manual sub-process (e.g. image from post text) | yes |
| setup | mostly a change to a config file (agent rules, permission allowlists, editor settings, snippets, shortcuts). That part needs no executed code: it can be a reviewed diff applied with an undo copy. Only a setup that needs a script (a hook, a helper command) needs the builder. | only for scripted setup |

So two of five kinds need the builder outright, one partly. The workflow path, which covers most repeated work across
fields, does not run model-written code at all.

## Options
### A. A separate, hidden macOS user for builder commands
The runner (in the brain) keeps the agent loop, the harness and the credentials. Builder Bash commands and checks run
as a dedicated standard user (`_offloadbuild`, no admin, hidden) inside the same `sandbox-exec` profile, in a
workspace shared through a group-owned folder. Different uid = KERN_PROCARGS2 on the person's processes fails.
- Cost: an admin password once to create the user (`sysadminctl`), a privileged launchd helper (SMAppService
  daemon, signed and notarized) whose only verb is "run this argv as `_offloadbuild` in this workspace". That helper
  is new root-owned attack surface and must be tiny and audited. Medium engineering (about one slice plus an
  independent security review). No runtime cost. macOS toolchain, so macOS-specific checks still run.
- Residuals: argv of the person's processes is still readable through setuid `/bin/ps` (the profile must deny
  `process-exec` of setuid binaries and of `/bin/ps`, and Offload must keep secrets out of argv, as today); same
  kernel, so a local privilege escalation is not contained; `sandbox-exec` is a deprecated API.

### B. A Linux micro-VM per build (Apple Virtualization / Containerization framework)
The runner stays on the Mac with the agent loop, harness and credentials; only the workspace is shared into a
lightweight Linux VM (virtiofs), no network device, commands and checks reach a supervisor in the guest over vsock.
This is the "container mode" s24's design note asks for. Apple's Containerization framework (macOS 26, Apple
silicon; Apple reports sub-second starts) runs each container in such a VM; on older Macs the builder stays off.
- Cost: the app gets the `com.apple.security.virtualization` entitlement; a kernel and a small root image (python3,
  bun) shipped or downloaded once (on the order of 100-300 MB); about 1 GB of memory while a build runs; large
  engineering (Swift VM host, guest supervisor, image pipeline, about two slices plus a security review). No admin
  password, no root helper.
- Residuals: a separate kernel, so no host process, Keychain or file outside the workspace is reachable. A build
  that must exercise macOS itself (an AppleScript, a macOS app's settings) cannot be checked in a Linux guest; those
  stay config patches or stay off. Requires macOS 26 on Apple silicon.

### C. Keep same-user execution; keep secrets out of every same-user process (Keychain only) and check before building
Move every Offload secret to the Keychain (already so for connector keys, s17) and, before and during a build, read
the environment and argv of every same-user process (the same sysctl) and refuse or stop the build when any holds a
secret-shaped name or value.
- Cost: small (one slice). No new entitlement, no admin.
- Residuals: it is a check, not a wall. It races (a process started mid-build), it only knows secret SHAPES, and on a
  developer's Mac it will refuse most of the time (agent sessions, terminals and editors routinely carry tokens in
  their environment; this very session saw a sibling agent's token in its environment while checking this ADR).
  Anything else the sandbox fails to mediate is not covered.

## Recommendation
**B (micro-VM)**, with two cheap steps first:
1. Split `setup` into a "config patch" kind that needs no builder (a reviewed diff of a named file, dry run = the
   diff, apply after exact approval with an undo copy). This ships the most common setup fixes (coding-agent rules
   and allowlists, the neutral week's top held-back task) without running model-written code.
2. Keep the builder OFF for normal users until B lands. `OFFLOAD_BUILDER_ENABLED=1` stays an operator-only switch.

Why B over A: it removes the whole class (same uid, same kernel, Keychain, files) instead of one channel, needs no
root helper and no admin password, and it is the container mode s24 already designed for. Why not C: it cannot be made
reliable on the Macs of the people most likely to use the builder. A is the fallback if B's macOS 26 / Apple
silicon floor is not acceptable.

Install is a separate question: a built tool that is installed runs as the person, outside any sandbox. Installing
must stay its own exact approval (s24 `verifyArtifact`), show every file, and say plainly that it will run as them.

## Consequences
- Until B: tool and remove_step fixes end at an approved brief and a one-time hand-off of the builder prompt (s22);
  a build is refused with the reason and the approval is kept (s24, pinned by s26 SETUP/REMOVE/TOOL tests).
- B needs: an app entitlement change, a guest image pipeline, a vsock supervisor protocol (the s24 supervisor's
  nonce protocol carries over), and a verify step that proves the guest has no network and no host mounts besides the
  workspace.
