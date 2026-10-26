#!/usr/bin/env bash
# s12-understanding done-signal. Contract: slices/s12-understanding/SPEC.md.
# 1. bun test tests/s12-understanding (>= MIN_TESTS, 0 failures)   2. bunx tsc --noEmit
# 3. real generator (encrypted) + real CLI --understanding v2 per persona: #1 is the truth task (its apps), share +-3 pts,
#    label not email   4. founder fixture: v1 default and v2 both rank email.outreach first   5. agreement report
# 6. no s12 commit since BASE touches an out-of-scope path. Prints one "FAIL ..." line per failing check. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
BASE=a3f7f28   # the commit this slice starts from
MIN_TESTS=40
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
if [ ! -d "$BRAIN/node_modules/typescript" ]; then
  (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"
fi

echo "== tests"
out="$(cd "$BRAIN" && bun test tests/s12-understanding 2>&1)"
code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" || true
[ $code -eq 0 ] || { echo "$out" | grep -E "\(fail\)|error:" | head -20; fail "bun test exited $code"; }
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
failed="$(echo "$out" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
[ -n "$ran" ] || { ran=0; fail "could not read the test count"; }
[ "${failed:-1}" = "0" ] || fail "${failed:-?} failing tests"
[ "$ran" -ge "$MIN_TESTS" ] || fail "only $ran s12 tests ran, need at least $MIN_TESTS"

echo "== typecheck"
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)"
if [ $? -ne 0 ]; then echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; else echo "typecheck ok"; fi

FX="$(mktemp -d "${TMPDIR:-/tmp}/offload-s12-XXXXXX")"
trap 'rm -rf "$FX"' EXIT

echo "== personas (real generator, encrypted, real CLI --understanding v2)"
if (cd "$ROOT" && bun run brain/fixtures/gen-domains.ts --out "$FX/domains" --seed 7 --encrypted >/dev/null); then
  for p in recruiter bookkeeper support salesops mixed; do
    [ -s "$FX/domains/$p/truth.json" ] || { fail "$p: no truth.json"; continue; }
    js="$(cd "$ROOT" && OFFLOAD_TOKEN= bun run brain/src/cli.ts analyze --home "$FX/domains/$p" --understanding v2 --embedder stub --top 3 --json 2>/dev/null)" \
      || { fail "$p: cli analyze --understanding v2 exited non-zero"; continue; }
    printf '%s' "$js" > "$FX/$p.json"
    res="$(cd "$ROOT" && bun -e '
      const [file, truthFile] = process.argv.slice(1);
      const a = JSON.parse(await Bun.file(file).text());
      const t = JSON.parse(await Bun.file(truthFile).text());
      // The truth task(s) must be the top insight(s): the mixed persona has two, in either order.
      const want = [t.topTask, ...(t.second ? [t.second] : [])];
      const got = a.insights.slice(0, want.length);
      const problems = [];
      const surf = (i) => new Set((i?.understanding?.surfaces ?? []).flatMap((s) => [s.app, s.host].filter(Boolean)));
      const used = new Set();
      const lines = [];
      for (const w of want) {
        const k = got.findIndex((i, n) => !used.has(n) && w.apps.every((x) => surf(i).has(x)));
        if (k < 0) { problems.push(`no top insight has the surfaces of "${w.name}" (${w.apps.join(",")}); got ${got.map((i) => i.name).join(" | ")}`); continue; }
        used.add(k);
        const i = got[k];
        const share = i.figures.share.value * 100, truth = w.share * 100;
        if (Math.abs(share - truth) > 3) problems.push(`${w.label} share ${share.toFixed(1)} vs truth ${truth.toFixed(1)}`);
        if (i.kind.startsWith("email.")) problems.push(`${w.label} labelled ${i.kind}`);
        lines.push(`#${k + 1} "${i.name}" [${i.kind}] share ${share.toFixed(1)}% (truth ${truth.toFixed(1)}%)`);
      }
      console.log(problems.length ? problems.join("; ") : `ok ${lines.join("; ")}`);
      process.exit(problems.length ? 1 : 0);
    ' "$FX/$p.json" "$FX/domains/$p/truth.json")" && echo "$p: $res" || fail "$p: $res"
  done
else
  fail "gen-domains generator failed"
fi

echo "== founder fixture (gen.ts): v1 default unchanged, v2 keeps outreach first"
if (cd "$ROOT" && bun run brain/fixtures/gen.ts --out "$FX/founder" --seed 42 --encrypted >/dev/null); then
  r1="$(cd "$ROOT" && OFFLOAD_TOKEN= bun run brain/src/cli.ts analyze --home "$FX/founder" --top 3 2>&1)" || fail "v1 analyze exited non-zero"
  echo "$r1" | grep -q "^#1 Outreach emails  \[email.outreach\]" || fail "v1: #1 is not email.outreach"
  r1b="$(cd "$ROOT" && OFFLOAD_TOKEN= bun run brain/src/cli.ts analyze --home "$FX/founder" --top 3 --understanding v1 2>&1)"
  [ "$r1" = "$r1b" ] || fail "--understanding v1 differs from the default"
  r2="$(cd "$ROOT" && OFFLOAD_TOKEN= bun run brain/src/cli.ts analyze --home "$FX/founder" --top 3 --understanding v2 --embedder stub 2>&1)" || fail "v2 analyze exited non-zero"
  echo "$r2" | grep -m1 "^#1" || true
  echo "$r2" | grep -q "^#1 .*\[email.outreach\]" || fail "v2: founder #1 is not email.outreach"
else
  fail "gen.ts fixture failed"
fi
bad="$(cd "$ROOT" && OFFLOAD_TOKEN= bun run brain/src/cli.ts analyze --home "$FX/founder" --understanding v3 2>&1)"; c=$?
[ $c -eq 2 ] || fail "--understanding v3 should be a usage error (exit 2), got $c"

echo "== agreement report"
(cd "$ROOT" && bun run brain/fixtures/domains-report.ts --seed 7) || fail "domains-report failed"

echo "== scope (files touched by s12 commits since $BASE)"
# Only this slice's commits are checked, so other slices (s11 vision, gen.ts work) merging later cannot fail it.
. "$ROOT/scripts/lib/slice-changes.sh"   # s12 commits not on main, plus edits made inside merge commits
touched="$(SLICE_GREP='s12' slice_changes "$BASE" 2>/dev/null)"
for f in $touched; do
  case "$f" in
    app/*|engine/*|packet/*|schemas/*|brain/src/connectors/*|brain/src/workflows/*|brain/src/vision/*|brain/fixtures/gen.ts) fail "s12 commit touched out-of-scope $f";;
  esac
done
echo "scope checked ($(echo "$touched" | grep -c . ) files in s12 commits)"

if [ $fails -ne 0 ]; then echo "s12 verify: $fails check(s) failed"; exit 1; fi
echo "s12 verify: PASS ($ran tests)"
