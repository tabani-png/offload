#!/usr/bin/env bash
# s22-solution-designer done-signal. Contract: slices/s22-solution-designer/SPEC.md.
# 1. brain typecheck   2. s22 suite (>= MIN_TESTS, every tag present and passing)   3. full brain suite
# 4. real generator + real CLI `solutions --insight 1 --json` on the founder week: top kind workflow, no saving above
#    observed time, every option that saves time has evidence   5. no s22 commit since BASE touches an out-of-scope path.
# One "FAIL ..." line per failing check. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
BASE=9f46fdb   # the commit this slice starts from
MIN_TESTS=30
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"

echo "== typecheck"
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)" && echo "typecheck ok" || { echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; }

echo "== s22 suite"
[ -d "$BRAIN/src/solutions" ] || fail "brain/src/solutions does not exist"
out="$(cd "$BRAIN" && bun test tests/s22-solution-designer 2>&1)"; code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" || true
[ $code -eq 0 ] || { echo "$out" | grep -E "\(fail\)|error:" | head -20; fail "s22 tests exited $code"; }
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
[ "${ran:-0}" -ge "$MIN_TESTS" ] || fail "only ${ran:-0} s22 tests ran, need $MIN_TESTS"
for tag in KINDS SAVING RULES DESIGN BRIEF API CLI BIAS; do
  grep -rqE "\(\"$tag: " "$BRAIN"/tests/s22-solution-designer || { fail "no test named \"$tag: ...\""; continue; }
  t="$(cd "$BRAIN" && bun test tests/s22-solution-designer -t "$tag: " 2>&1)"
  n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
  echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: $n passing" || fail "tests for $tag did not pass"
done

echo "== full brain suite"
all="$(cd "$BRAIN" && bun test 2>&1)"; acode=$?
echo "$all" | grep -E "^Ran [0-9]+ tests" || true
[ $acode -eq 0 ] || { echo "$all" | grep -E "\(fail\)" | head -20; fail "full brain suite exited $acode"; }

FX="$(mktemp -d "${TMPDIR:-/tmp}/offload-s22-XXXXXX")"
trap 'rm -rf "$FX"' EXIT

echo "== founder week (real generator, real CLI)"
if (cd "$ROOT" && bun run brain/fixtures/gen.ts --out "$FX/home" --seed 42 >/dev/null 2>&1); then
  sol="$(cd "$ROOT" && OFFLOAD_TOKEN= OFFLOAD_KEYS=file bun run brain/src/cli.ts solutions --insight 1 --home "$FX/home" --json 2>"$FX/err")" \
    || { cat "$FX/err" | head -5; fail "cli solutions exited non-zero"; }
  printf '%s' "$sol" > "$FX/sol.json"
  res="$(bun -e '
    const r = JSON.parse(await Bun.file(process.argv[1]).text());
    const bad = [];
    if (r.top !== "workflow") bad.push(`top is ${r.top}, want workflow`);
    for (const o of r.options) {
      if (o.weeklyHoursSaved > r.observedWeeklyHours + 1e-9) bad.push(`${o.kind} saves ${o.weeklyHoursSaved} > observed ${r.observedWeeklyHours}`);
      if (o.weeklyHoursSaved > 0 && o.evidence.spanIds.length === 0) bad.push(`${o.kind} saves time but has no evidence`);
    }
    if (r.options.length !== 5) bad.push(`${r.options.length} options, want 5`);
    console.log(bad.length === 0 ? `ok top ${r.top}, ${r.options.map((o) => o.kind + " " + o.weeklyHoursSaved.toFixed(1)).join(", ")}` : "BAD " + bad.join("; "));
  ' "$FX/sol.json" 2>&1)"
  echo "$res"
  case "$res" in ok*) ;; *) fail "founder solutions: $res" ;; esac
else
  fail "fixture generator failed"
fi

echo "== scope"
. "$ROOT/scripts/lib/slice-changes.sh"   # this branch's own net changes; merges of main are not counted
slice_files --allow-skip "$BASE"; scope_rc=$?
case $scope_rc in
  0) ;;
  3) echo "scope: SKIPPED ($SLICE_ERROR)" ;;
  *) fail "scope check could not run: $SLICE_ERROR" ;;
esac
changed="$SLICE_FILES"
while IFS= read -r p; do
  [ -n "$p" ] || continue
  case "$p" in
    engine/*|packet/*|schemas/*|app/*|brain/tools/import-screenwatch.ts|brain/src/understanding/induce.ts|brain/src/understanding/embed.ts|brain/src/plan/steps.ts|brain/src/insights/saving.ts|brain/src/store/vault.ts|brain/src/connectors/chain.ts|brain/src/connectors/targets.ts|brain/src/workflows/gate.ts|brain/src/workflows/allowlist.ts|brain/src/workflows/executor.ts|brain/src/workflows/batch.ts|brain/src/workflows/runner.ts|brain/src/workflows/chain-executor.ts)
      fail "out-of-scope path changed: $p" ;;
  esac
done <<< "$changed"
[ $scope_rc -ne 0 ] || echo "scope checked ($(printf '%s' "$changed" | grep -c .) files)"

[ "$fails" -eq 0 ] && echo "s22-solution-designer: PASS" || { echo "s22-solution-designer: $fails failing check(s)"; exit 1; }
