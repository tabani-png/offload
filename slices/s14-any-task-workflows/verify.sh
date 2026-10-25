#!/usr/bin/env bash
# s14-any-task-workflows done-signal. Contract: slices/s14-any-task-workflows/SPEC.md.
# 1. brain typecheck   2. s14 suite (>= MIN_TESTS, every tag present and passing)   3. full brain suite
# 4. real generator (encrypted) + real CLI draft + dry-run --understanding v2 per persona: plan step types, gates,
#    capability targets and the dry run's output type   5. founder fixture still drafts investor_outreach
# 6. vision code never imports the model   7. app tests incl. S14 suites   8. onboarding-context snapshots
# 9. no s14 commit since BASE touches an out-of-scope path. One "FAIL ..." line per failing check. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
BASE=815c4ae   # the commit this slice starts from
MIN_TESTS=45
export OFFLOAD_BUILD_DIR="${OFFLOAD_BUILD_DIR:-/tmp/offload-build-s14}"
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"

echo "== typecheck"
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)" && echo "typecheck ok" || { echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; }

echo "== s14 suite"
out="$(cd "$BRAIN" && bun test tests/s14-any-task-workflows 2>&1)"; code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" || true
[ $code -eq 0 ] || { echo "$out" | grep -E "\(fail\)|error:" | head -20; fail "s14 tests exited $code"; }
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
[ "${ran:-0}" -ge "$MIN_TESTS" ] || fail "only ${ran:-0} s14 tests ran, need $MIN_TESTS"
for tag in NOTES PLAN DRYRUN TONE CONTEXT DEFAULTS KNOWN TOOLS ROUTER CLAUDE; do
  grep -rqE "\(\"$tag: " "$BRAIN"/tests/s14-any-task-workflows || { fail "no test named \"$tag: ...\""; continue; }
  t="$(cd "$BRAIN" && bun test tests/s14-any-task-workflows -t "$tag: " 2>&1)"
  n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
  echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: $n passing" || fail "tests for $tag did not pass"
done

echo "== full brain suite"
all="$(cd "$BRAIN" && bun test 2>&1)"; acode=$?
echo "$all" | grep -E "^Ran [0-9]+ tests" || true
[ $acode -eq 0 ] || { echo "$all" | grep -E "\(fail\)" | head -20; fail "full brain suite exited $acode"; }

FX="$(mktemp -d "${TMPDIR:-/tmp}/offload-s14-XXXXXX")"
trap 'rm -rf "$FX"' EXIT

echo "== personas (real generator, encrypted, real CLI draft + dry-run, v2)"
if (cd "$ROOT" && bun run brain/fixtures/gen-domains.ts --out "$FX/domains" --seed 7 --encrypted >/dev/null); then
  for p in recruiter bookkeeper support salesops mixed; do
    for rank in 1 2; do
      [ "$p" != "mixed" ] && [ "$rank" = "2" ] && continue
      home="$FX/domains/$p"
      wf="$(cd "$ROOT" && OFFLOAD_TOKEN= OFFLOAD_KEYS=file bun run brain/src/cli.ts draft --insight "$rank" --home "$home" --understanding v2 --json 2>/dev/null)" \
        || { fail "$p #$rank: cli draft exited non-zero"; continue; }
      printf '%s' "$wf" > "$FX/$p-$rank-wf.json"
      id="$(printf '%s' "$wf" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).id)')"
      dr="$(cd "$ROOT" && OFFLOAD_TOKEN= OFFLOAD_KEYS=file bun run brain/src/cli.ts dry-run --workflow "$id" --home "$home" --understanding v2 --model stub --limit 5 --json 2>/dev/null)" \
        || { fail "$p #$rank: cli dry-run exited non-zero"; continue; }
      printf '%s' "$dr" > "$FX/$p-$rank-dr.json"
      res="$(bun -e '
        const [wfFile, drFile, truthFile, persona, rank] = process.argv.slice(1);
        const wf = JSON.parse(await Bun.file(wfFile).text());
        const dr = JSON.parse(await Bun.file(drFile).text());
        const truth = JSON.parse(await Bun.file(truthFile).text());
        // Expected output type per real task (truth label) and the apps its capability targets must name.
        const want = {
          screen: { out: "stage_change", types: ["read", "decide", "draft", "commit"], targets: ["app-preview", "greenhouse"] },
          invoice: { out: "form_fields", types: ["read", "transform", "commit"], targets: ["app-preview", "xero"] },
          ticket: { out: "ticket_reply", types: ["read", "draft", "commit"], targets: ["zendesk"] },
          enrich: { out: "rows", types: ["read", "transform", "commit"], targets: ["google-sheets", "linkedin"] },
        };
        const problems = [];
        const plan = wf.plan;
        if (plan === undefined) { console.log("no plan in workflow.json"); process.exit(1); }
        const variant = plan.variants.find((v) => v.id === plan.chosen);
        const types = variant.steps.map((s) => s.type);
        const label = Object.keys(want).find((k) => want[k].out === plan.outputType);
        if (label === undefined) problems.push(`output type ${plan.outputType} is no persona task`);
        const truthLabels = [truth.topTask.label, ...(truth.second ? [truth.second.label] : [])];
        if (label !== undefined && !truthLabels.includes(label)) problems.push(`drafted ${label}, persona tasks are ${truthLabels.join(",")}`);
        const w = want[label] ?? { types: [], targets: [] };
        // The expected types appear in this order (other steps may sit between them).
        let k = 0;
        for (const t of types) if (t === w.types[k]) k += 1;
        if (k < w.types.length) problems.push(`steps ${types.join(">")} lack ${w.types.join(">")}`);
        const commits = variant.steps.filter((s) => s.type === "commit");
        if (commits.length === 0) problems.push("no commit step");
        if (commits.some((s) => s.gated !== true)) problems.push("a commit step is not gated");
        const legacy = wf.steps.map((s) => s.type);
        const firstSide = wf.steps.findIndex((s) => s.sideEffect);
        if (firstSide < 0 || legacy.indexOf("approval_gate") < 0 || legacy.indexOf("approval_gate") > firstSide) problems.push("no approval_gate before the first side effect");
        const targets = new Set(variant.steps.filter((s) => s.capability).map((s) => s.capability.target));
        for (const t of w.targets) if (![...targets].some((x) => x === t || x.includes(t))) problems.push(`no capability target ${t} (got ${[...targets].join(",")})`);
        if (wf.autoRun !== false) problems.push("auto-run is on");
        const g = dr.general;
        if (g === undefined) problems.push("dry run has no general section");
        else {
          if (g.outputType !== plan.outputType) problems.push(`dry run output ${g.outputType} != plan ${plan.outputType}`);
          if (g.instances.length < 3) problems.push(`only ${g.instances.length} dry-run instances`);
          if (g.instances.some((i) => i.ours.kind !== plan.outputType || i.evidence.eventIds.length === 0)) problems.push("an instance has the wrong kind or no evidence");
          if (dr.sideEffects.attempted === 0 || dr.sideEffects.denied !== dr.sideEffects.attempted) problems.push(`side effects ${dr.sideEffects.denied}/${dr.sideEffects.attempted} denied`);
        }
        const score = plan.probe.map((s) => `${s.variant} ${Math.round(s.agreement * 100)}%`).join(" vs ");
        console.log(problems.length ? problems.join("; ") : `ok ${label}: ${types.join(">")} (chose ${plan.chosen}: ${score}), ${g.instances.length} ${g.outputType} instances`);
        process.exit(problems.length ? 1 : 0);
      ' "$FX/$p-$rank-wf.json" "$FX/$p-$rank-dr.json" "$home/truth.json" "$p" "$rank")" && echo "$p #$rank: $res" || fail "$p #$rank: $res"
    done
  done
else
  fail "gen-domains generator failed"
fi

echo "== founder fixture (gen.ts): the email demo still drafts its template"
if (cd "$ROOT" && bun run brain/fixtures/gen.ts --out "$FX/founder" --seed 42 --encrypted >/dev/null); then
  fw="$(cd "$ROOT" && OFFLOAD_TOKEN= OFFLOAD_KEYS=file bun run brain/src/cli.ts draft --insight 1 --home "$FX/founder" --json 2>/dev/null)" || fail "founder draft exited non-zero"
  printf '%s' "$fw" | grep -q '"template": "investor_outreach"' && echo "founder: investor_outreach" || fail "founder #1 is not the investor_outreach template"
else
  fail "gen.ts fixture failed"
fi

echo "== images: masked by the engine, local or the user's own Anthropic account only"
# Only vision/claude.ts (and the selector routed.ts, which names it) may talk to Anthropic; no vision file imports the
# text model or the Agent SDK; the Claude captioner keeps its host guard; no test or script makes a real API call.
if grep -rnE "models/model|claude-agent-sdk" "$BRAIN/src/vision"; then fail "brain/src/vision imports the text model"; fi
if grep -rlE "anthropic" "$BRAIN/src/vision" | grep -vE "/vision/(claude|routed)\.ts$"; then fail "a vision file other than claude.ts talks to Anthropic"; fi
grep -q 'u.hostname.toLowerCase() !== ANTHROPIC_HOST' "$BRAIN/src/vision/claude.ts" || fail "the Claude captioner lost its host guard"
if grep -rnE "new (ClaudeCaptioner|ApiBackend)\(" "$BRAIN/tests" | grep -v "fetch" | grep -vE "env: \{\}|\(\{ env: \{\} \}\)|baseURL: \"https://evil"; then fail "a test builds a Claude client without a stubbed fetch"; fi
if grep -rnE 'type: "image"|"base64"|image/jpeg|\.jpg' "$BRAIN/src/plan" "$BRAIN/src/context" 2>/dev/null; then fail "plan/context code sends images"; fi

echo "== app (S14 suites)"
aout="$("$ROOT/app/build.sh" test 2>&1)"; acode=$?
plain="$(printf '%s\n' "$aout" | sed $'s/\x1b\\[[0-9;]*m//g')"
printf '%s\n' "$plain" | grep -E 'Test run with' | tail -n 1 || true
[ $acode -eq 0 ] || { printf '%s\n' "$plain" | grep -E '✘|error:' | head -20; fail "app tests exited $acode"; }
s14="$(printf '%s\n' "$plain" | grep -cE '✔ Suite "S14 .*" passed' || true)"
[ "$s14" -ge 5 ] || fail "expected at least 5 S14 app suites to pass, got $s14"

echo "== snapshots"
BIN="$OFFLOAD_BUILD_DIR/Offload.app/Contents/MacOS/Offload"
"$ROOT/app/build.sh" >/dev/null 2>&1 || fail "app build failed"
if [ -x "$BIN" ]; then
  "$BIN" --snapshot "$FX/png" >/dev/null 2>&1 || true
  for s in onboarding-context review-plan review-dryrun-general; do
    for scheme in dark light; do
      [ -s "$FX/png/$s-$scheme.png" ] || fail "missing fresh $s-$scheme.png"
      [ -s "$ROOT/app/snapshots/$s-$scheme.png" ] || fail "missing committed app/snapshots/$s-$scheme.png"
    done
  done
fi

echo "== scope (files touched by s14 commits since $BASE)"
touched="$(git -C "$ROOT" log --format= --name-only --grep='s14' "$BASE..HEAD" 2>/dev/null | sort -u)"
for f in $touched; do
  case "$f" in
    # vision/{claude,routed,types,worker}.ts are in scope since the Claude captioner scope add (SPEC section 7).
    brain/src/vision/claude.ts|brain/src/vision/routed.ts|brain/src/vision/types.ts|brain/src/vision/worker.ts) ;;
    engine/*|packet/*|schemas/*|brain/src/connectors/*|brain/src/vision/*|brain/fixtures/gen.ts|brain/fixtures/gen-domains.ts) fail "s14 commit touched out-of-scope $f";;
    brain/src/workflows/gate.ts|brain/src/workflows/allowlist.ts|brain/src/workflows/executor.ts|brain/src/workflows/batch.ts|brain/src/workflows/runner.ts) fail "s14 commit touched s13's $f";;
  esac
done
echo "scope checked ($(echo "$touched" | grep -c . ) files in s14 commits)"

if [ $fails -ne 0 ]; then echo "s14 verify: $fails check(s) failed"; exit 1; fi
echo "s14 verify: PASS (${ran} s14 tests)"
