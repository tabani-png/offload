#!/usr/bin/env bash
# s19-messaging-playbook done-signal. Contract: slices/s19-messaging-playbook/SPEC.md.
# 1. brain typecheck   2. s19 suite (>= MIN_TESTS, every tag present and passing)   3. full brain suite
# 4. founder fixture end to end: gen.ts -> CLI tone build + draft -> POST /workflows/:id/playbook -> leak scan of
#    playbook.json and PLAYBOOK.md -> dry run with a playbook verdict per draft   5. no new dependencies
# 6. no s19 commit since BASE touches an out-of-scope path. One "FAIL ..." line per failing check. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
BASE=c70d2ec   # the commit this slice starts from
MIN_TESTS=45
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ "$(bun --version)" = "1.3.12" ] || fail "bun is $(bun --version), need 1.3.12"
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"

echo "== typecheck"
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)" && echo "typecheck ok" || { echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; }

echo "== s19 suite"
SUITE=tests/s19-messaging-playbook
if [ -d "$BRAIN/$SUITE" ]; then
  out="$(cd "$BRAIN" && bun test "$SUITE" 2>&1)"; code=$?
  echo "$out" | grep -E "^\s*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" || true
  [ $code -eq 0 ] || { echo "$out" | grep -E "\(fail\)|error:" | head -20; fail "s19 tests exited $code"; }
  ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
  [ "${ran:-0}" -ge "$MIN_TESTS" ] || fail "only ${ran:-0} s19 tests ran, need $MIN_TESTS"
  for tag in MASK READ KNOWN OUTCOME PLAYBOOK LEAK NUMBERS ROUTER SUCCESSOR DRYRUN API; do
    grep -rqE "\(\"$tag: " "$BRAIN/$SUITE" || { fail "no test named \"$tag: ...\""; continue; }
    t="$(cd "$BRAIN" && bun test "$SUITE" -t "$tag: " 2>&1)"
    n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
    echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: $n passing" || fail "tests for $tag did not pass"
  done
else
  ran=0
  fail "no $SUITE directory"
fi

echo "== full brain suite"
all="$(cd "$BRAIN" && bun test 2>&1)"; acode=$?
echo "$all" | grep -E "^ *[0-9]+ (pass|fail|skip)$|^Ran [0-9]+ tests" || true
[ $acode -eq 0 ] || { echo "$all" | grep -E "\(fail\)" | head -20; fail "full brain suite exited $acode"; }

FX="$(mktemp -d "${TMPDIR:-/tmp}/offload-s19-XXXXXX")"
trap 'rm -rf "$FX"' EXIT

echo "== founder fixture end to end (gen.ts, CLI tone build + draft, brain API playbook + dry run)"
home="$FX/founder"
if (cd "$ROOT" && bun run brain/fixtures/gen.ts --out "$home" --seed 42 --encrypted >/dev/null); then
  (cd "$ROOT" && OFFLOAD_TOKEN= OFFLOAD_KEYS=file bun run brain/src/cli.ts tone build --home "$home" --source fixture --model stub >/dev/null 2>&1) || fail "cli tone build exited non-zero"
  wf="$(cd "$ROOT" && OFFLOAD_TOKEN= OFFLOAD_KEYS=file bun run brain/src/cli.ts draft --insight 1 --home "$home" --json 2>/dev/null)" || fail "cli draft exited non-zero"
  printf '%s' "$wf" > "$FX/wf.json"
  res="$(cd "$BRAIN" && OFFLOAD_KEYS=file bun -e '
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    import { createBrain } from "./src/api/server.ts";
    import { FIXTURE_FACTS } from "./fixtures/sent-mail.ts";
    import { StubModel } from "./src/models/model.ts";
    const [home, wfFile] = process.argv.slice(1);
    const wf = JSON.parse(readFileSync(wfFile, "utf8"));
    const problems = [];
    if (wf.template !== "investor_outreach") problems.push(`insight 1 drafted ${wf.template}, not investor_outreach`);
    await Bun.write(join(home, "workflows", wf.id, "facts.md"), FIXTURE_FACTS);
    const token = "v".repeat(40);
    const brain = createBrain({ home, token, workflows: { model: new StubModel() } });
    const call = async (path, method = "GET", body) => {
      const r = await brain.handle(new Request(`http://127.0.0.1${path}`, { method, headers: { authorization: `Bearer ${token}`, host: "127.0.0.1", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      return { status: r.status, body: await r.json() };
    };
    const built = await call(`/workflows/${wf.id}/playbook`, "POST", { action: "build" });
    if (built.status !== 200) problems.push(`build ${built.status} ${JSON.stringify(built.body).slice(0, 200)}`);
    const pb = built.body.playbook ?? {};
    const files = ["playbook.json", "PLAYBOOK.md"].map((f) => readFileSync(join(home, "workflows", wf.id, f), "utf8"));
    // The founder, the company, every investor and fund of the fixture, and the private figures must be gone.
    const LEAKS = ["Muhammad", "Ali", "Offload", "offload.so", "+44", "7700", "2.5M", "$2.5", "Anna", "Northzone", "northzone", "Spotify", "Raycast", "James", "Accel", "Priya", "LocalGlobe", "Balderton", "@"];
    for (const [i, text] of files.entries()) for (const l of LEAKS) if (new RegExp(`(^|[^A-Za-z])${l.replace(/[.$+]/g, "\\$&")}($|[^A-Za-z])`).test(text)) problems.push(`${i === 0 ? "playbook.json" : "PLAYBOOK.md"} contains ${l}`);
    if (pb.stats?.intent?.[0]?.value !== "book_meeting") problems.push(`top intent ${pb.stats?.intent?.[0]?.value}`);
    if (pb.stats?.cta?.[0]?.value !== "meeting") problems.push(`top cta ${pb.stats?.cta?.[0]?.value}`);
    if (!(pb.stats?.proof ?? []).some((p) => p.value === "traction")) problems.push("no traction proof");
    if (pb.outcomes?.replied !== 12 || pb.outcomes?.noReply !== 6) problems.push(`outcomes ${pb.outcomes?.replied}/${pb.outcomes?.noReply}, want 12/6`);
    if (!(pb.skeletons?.length >= 3 && pb.skeletons.length <= 5)) problems.push(`${pb.skeletons?.length} skeletons`);
    for (const s of ["## The message", "## Do", "## Don", "## Templates", "## Example skeletons", "## Cadence", "## Avoid", "## What got replies"]) if (!files[1].includes(s)) problems.push(`PLAYBOOK.md has no "${s}"`);
    const dr = await call(`/workflows/${wf.id}/dry-run`, "POST", { limit: 5 });
    if (dr.status !== 200) problems.push(`dry run ${dr.status}`);
    const inst = dr.body.instances ?? [];
    if (inst.length === 0) problems.push("dry run has no instances");
    for (const i of inst) if (!["yes", "partly", "no"].includes(i.playbook?.verdict) || !Array.isArray(i.playbook?.rules) || i.playbook.rules.length === 0) problems.push(`instance ${i.instanceId} has no playbook verdict`);
    const verdicts = inst.map((i) => i.playbook?.verdict).join(",");
    console.log(problems.length ? problems.join("; ") : `ok playbook v${pb.version}: ${pb.sources?.messages} messages, ${pb.outcomes?.replied} replied / ${pb.outcomes?.noReply} no reply; dry run verdicts ${verdicts}`);
    process.exit(problems.length ? 1 : 0);
  ' "$home" "$FX/wf.json" 2>&1)" && echo "founder: $res" || fail "founder: $(echo "$res" | tail -5)"
else
  fail "gen.ts fixture failed"
fi

echo "== no new dependencies"
git -C "$ROOT" diff --quiet "$BASE" HEAD -- brain/package.json brain/bun.lock || fail "brain/package.json or bun.lock changed"

echo "== scope (files touched by s19 commits since $BASE)"
touched="$(git -C "$ROOT" log --no-merges --format= --name-only --grep='^s19' "$BASE..HEAD" 2>/dev/null | sort -u)"
# Only paths that still differ from BASE: a file an s19 commit created and a later one renamed away is not a change.
net="$(git -C "$ROOT" diff --name-only "$BASE" HEAD 2>/dev/null)"
for f in $touched; do
  echo "$net" | grep -qxF "$f" || continue
  case "$f" in
    brain/src/playbook/*|brain/fixtures/playbook-personas.ts|brain/tests/s19-messaging-playbook/*|slices/s19-messaging-playbook/*) ;;
    brain/src/models/model.ts|brain/src/models/router.ts|brain/src/tone/draft.ts|brain/src/workflows/dryrun.ts|brain/src/workflows/runner.ts|brain/src/workflows/autorun.ts) ;;
    brain/src/api/workflow-routes.ts|brain/src/api/types.ts|brain/API.md|plan/adr/0011-messaging-playbook.md|plan/adr/0012-playbook-review-fixes.md|plan/stage-2/adr/0112-playbook-on-promotion.md) ;;
    *) fail "s19 commit touched out-of-scope $f";;
  esac
done
echo "scope checked ($(echo "$touched" | grep -c . ) files in s19 commits)"

if [ $fails -ne 0 ]; then echo "s19 verify: $fails check(s) failed"; exit 1; fi
echo "s19 verify: PASS (${ran} s19 tests)"
