#!/usr/bin/env bash
# Builds Offload.app with plain swiftc. SwiftPM is not used on this machine (plan ADR 0002): the Command Line
# Tools' libPackageDescription does not link. No Xcode, no asset catalogs.
#
#   app/build.sh                 build app/.build/Offload.app
#   app/build.sh test [args]     build and run the S06 … S10F, S14, S17, S2-13, S23 and S25 Swift Testing suites (extra args go to the runner)
#   app/build.sh snapshot DIR    build, then render every component and surface to PNGs in DIR
#   app/build.sh sign APP        (re)sign an existing Offload.app with the env below (s25)
#
# s25 (plan ADR 0014): the app carries its brain. Contents/Helpers/bun is the pinned bun (PINNED_BUN), the brain's
# JS sits in Contents/Resources/offload laid out like the repo (brain/src, brain/node_modules production only,
# schemas), and the Agent SDK's native claude binary is Contents/Helpers/claude. No repo and no bun are needed on the
# Mac. OFFLOAD_BUNDLE_BRAIN=0 skips the brain (quick UI builds; the app then falls back to the repo, dev only).
# OFFLOAD_BUN_SOURCE=PATH picks the bun binary to bundle (it must be PINNED_BUN).
#
# Signing: ad hoc (codesign --sign -) unless OFFLOAD_SIGN_IDENTITY is set, e.g. "Developer ID Application: NAME (TEAM)".
# Then every binary is signed inside-out with the hardened runtime and a secure timestamp; Helpers/bun gets
# app/brain.entitlements (JIT). OFFLOAD_NOTARY_PROFILE=NAME (a `xcrun notarytool store-credentials NAME` keychain
# profile; no secret is read or printed here) also submits to notarytool, waits, and staples the ticket.
# OFFLOAD_SIGN_IDENTITY=- signs ad hoc with the hardened runtime (used by slices/s25 to test the entitlements).
#
# Layout: Sources/Core is Foundation-only (models, BrainClient, formatting, keyboard + undo state machine,
# token values). The test binary is Core + the tests of slices s06, s07, s08 and s09a.
# The app binary is Core + Design + Surfaces + App.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="${OFFLOAD_BUILD_DIR:-$HERE/.build}"
CLT="$(xcode-select -p)"
FW="$CLT/Library/Developer/Frameworks"
DEVLIB="$CLT/Library/Developer/usr/lib"
TARGET="$(uname -m)-apple-macos14.0"
APP="$OUT/Offload.app"
PINNED_BUN=1.3.12   # the bun the bundled brain runs on (s25, ADR 0014). Bump on purpose, after the brain suite passes on it.
mkdir -p "$OUT"

swift_files() { find "$@" -name '*.swift' -type f 2>/dev/null | sort; }

build_app() {
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  # shellcheck disable=SC2046
  swiftc -target "$TARGET" -module-name Offload -O -parse-as-library \
    $(swift_files "$HERE/Sources/Core" "$HERE/Sources/Design" "$HERE/Sources/Surfaces" "$HERE/Sources/App") \
    -framework AppKit -framework SwiftUI -framework Carbon \
    -o "$APP/Contents/MacOS/Offload"
  cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
  # s09a: bundle the observer beside the app when it has been built (the app finds it in Contents/MacOS first).
  if [ -x "$ROOT/engine/.build/offload-observer" ]; then
    cp "$ROOT/engine/.build/offload-observer" "$APP/Contents/MacOS/offload-observer"
    [ -f "$ROOT/engine/.build/libOffloadCore.dylib" ] && cp "$ROOT/engine/.build/libOffloadCore.dylib" "$APP/Contents/MacOS/"
  fi
  bundle_brain
  sign_app "$APP"
}

# APFS clones when the volume can (no extra disk), else a plain copy.
clone() { cp -c "$1" "$2" 2>/dev/null || cp "$1" "$2"; }
clone_dir() { cp -cR "$1" "$2" 2>/dev/null || cp -R "$1" "$2"; }

# s25: the brain inside the bundle. See the header and plan ADR 0014.
bundle_brain() {
  local H="$APP/Contents/Helpers" R="$APP/Contents/Resources/offload"
  rm -rf "$H" "$R"
  if [ "${OFFLOAD_BUNDLE_BRAIN:-1}" = "0" ]; then
    echo "build.sh: OFFLOAD_BUNDLE_BRAIN=0, the brain is not bundled (dev only: the app falls back to the repo)" >&2
    return 0
  fi
  local bun="${OFFLOAD_BUN_SOURCE:-}"
  [ -n "$bun" ] || bun="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
  if [ ! -x "$bun" ]; then
    echo "build.sh: bundling the brain needs bun $PINNED_BUN (set OFFLOAD_BUN_SOURCE, or OFFLOAD_BUNDLE_BRAIN=0)" >&2
    exit 1
  fi
  local v; v="$("$bun" --version)"
  if [ "$v" != "$PINNED_BUN" ]; then
    echo "build.sh: $bun is bun $v; the bundled brain is pinned to bun $PINNED_BUN (PINNED_BUN in app/build.sh)" >&2
    exit 1
  fi
  mkdir -p "$H" "$R/brain"
  clone "$bun" "$H/bun"
  clone_dir "$ROOT/brain/src" "$R/brain/src"
  clone_dir "$ROOT/brain/fixtures" "$R/brain/fixtures"   # brain/src imports fixtures/sent-mail.ts; the demo week runs gen.ts
  clone_dir "$ROOT/schemas" "$R/schemas"                 # brain/src imports ../../../schemas/*.json
  cp "$ROOT/brain/package.json" "$ROOT/brain/bun.lock" "$R/brain/"
  if ! "$H/bun" install --cwd "$R/brain" --production --frozen-lockfile --ignore-scripts --no-progress >"$OUT/brain-install.log" 2>&1; then
    tail -20 "$OUT/brain-install.log" >&2
    echo "build.sh: bun install --production failed for the bundled brain (log: $OUT/brain-install.log)" >&2
    exit 1
  fi
  rm -f "$R/brain/bun.lock"
  find "$R" -name .DS_Store -delete
  # The Agent SDK's native claude binary lives in Helpers (code belongs there, not in Resources); the SDK still finds
  # it through its package path, which becomes a link inside the bundle. Helpers also comes first on the brain's PATH.
  local arch; arch="$(uname -m | sed 's/x86_64/x64/')"
  local sdk="$R/brain/node_modules/@anthropic-ai/claude-agent-sdk-darwin-$arch"
  if [ -f "$sdk/claude" ] && [ ! -L "$sdk/claude" ]; then
    mv "$sdk/claude" "$H/claude"
    ln -s ../../../../../../Helpers/claude "$sdk/claude"
  else
    echo "build.sh: warning: no Agent SDK claude binary for darwin-$arch; workflows that run the Agent SDK will not start" >&2
  fi
}

# s25: ad hoc by default; Developer ID + hardened runtime (+ notarization) only when the env asks for it.
sign_app() {
  local app="$1" id="${OFFLOAD_SIGN_IDENTITY:-}" notary="${OFFLOAD_NOTARY_PROFILE:-}"
  if [ -n "$notary" ] && { [ -z "$id" ] || [ "$id" = "-" ]; }; then
    echo "build.sh: OFFLOAD_NOTARY_PROFILE needs OFFLOAD_SIGN_IDENTITY set to a Developer ID Application identity; ad hoc builds cannot be notarized" >&2
    exit 1
  fi
  local obs="$app/Contents/MacOS/offload-observer" lib="$app/Contents/MacOS/libOffloadCore.dylib"
  if [ -z "$id" ]; then
    # Default, as before s25: ad hoc. Helpers/bun and Helpers/claude keep their vendors' signatures.
    [ -e "$lib" ] && { codesign --force --sign - "$lib" >/dev/null 2>&1 || true; }
    [ -e "$obs" ] && { codesign --force --sign - "$obs" >/dev/null 2>&1 || true; }
    codesign --force --sign - "$app" >/dev/null 2>&1 || true
    return 0
  fi
  local ts="--timestamp"; [ "$id" = "-" ] && ts="--timestamp=none"
  local -a sign=(codesign --force --options runtime "$ts" --sign "$id")
  # Inside-out: nested code first, the app last (no --deep).
  [ -e "$app/Contents/Helpers/bun" ] && "${sign[@]}" --entitlements "$HERE/brain.entitlements" "$app/Contents/Helpers/bun"
  # Helpers/claude stays signed by Anthropic (Developer ID, hardened runtime, timestamp): verify, do not re-sign.
  if [ -e "$app/Contents/Helpers/claude" ] && ! codesign --verify --strict "$app/Contents/Helpers/claude" 2>/dev/null; then
    echo "build.sh: Contents/Helpers/claude has no valid vendor signature" >&2
    exit 1
  fi
  [ -e "$lib" ] && "${sign[@]}" "$lib"
  [ -e "$obs" ] && "${sign[@]}" "$obs"
  "${sign[@]}" "$app"
  codesign --verify --strict --deep "$app"
  echo "signed $app ($([ "$id" = "-" ] && echo "ad hoc, hardened runtime" || echo "identity from OFFLOAD_SIGN_IDENTITY, hardened runtime"))"
  [ -n "$notary" ] && notarize "$app"
  return 0
}

# s25: zip, submit with the keychain profile, wait, staple. The profile holds the credentials; nothing is printed here.
notarize() {
  local app="$1" tmp out
  tmp="$(mktemp -d)"
  ditto -c -k --keepParent "$app" "$tmp/Offload.zip"
  out="$(xcrun notarytool submit "$tmp/Offload.zip" --keychain-profile "$OFFLOAD_NOTARY_PROFILE" --wait 2>&1)" || true
  rm -rf "$tmp"
  echo "$out" | grep -E "^\s*(id|status):" || true
  if ! echo "$out" | grep -qE "^\s*status: Accepted"; then
    echo "build.sh: notarization was not accepted. See: xcrun notarytool log <id> --keychain-profile \"\$OFFLOAD_NOTARY_PROFILE\"" >&2
    exit 1
  fi
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  echo "notarized and stapled $app"
}

build_tests() {
  local main="$OUT/TestMain.swift"
  printf 'import Testing\n@main struct OffloadTestRunner { static func main() async { await Testing.__swiftPMEntryPoint() as Never } }\n' > "$main"
  # shellcheck disable=SC2046
  swiftc -target "$TARGET" -parse-as-library -module-name OffloadTests \
    -F "$FW" -I "$DEVLIB" -L "$DEVLIB" -framework Testing \
    -plugin-path "$CLT/usr/lib/swift/host/plugins/testing" \
    -Xlinker -rpath -Xlinker "$FW" -Xlinker -rpath -Xlinker "$DEVLIB" \
    $(swift_files "$HERE/Sources/Core" "$ROOT/slices/s06-design-system/tests" "$ROOT/slices/s07-rail-and-card/tests" "$ROOT/slices/s08-review-and-dashboard/tests" "$ROOT/slices/s09a-wiring/tests" "$ROOT/slices/s10a-ui-polish/tests" "$ROOT/slices/s10d-ui-round3/tests" "$ROOT/slices/s10e-ui-round4/tests" "$ROOT/slices/s14-any-task-workflows/tests" "$ROOT/slices/s17-connect-anything/tests" "$ROOT/slices/s10f-ui-round5/tests" "$ROOT/slices/S2-13-mac-company-surfaces/tests" "$ROOT/slices/s23-time-breakdown/tests" "$ROOT/slices/s25-standalone-install/tests") \
    "$main" -o "$OUT/offload-tests"
}

case "${1:-}" in
  test)
    shift
    build_tests
    "$OUT/offload-tests" "$@"
    ;;
  sign)
    sign_app "${2:?usage: app/build.sh sign PATH/Offload.app}"
    ;;
  snapshot)
    dir="${2:?usage: app/build.sh snapshot DIR}"
    build_app
    "$APP/Contents/MacOS/Offload" --snapshot "$dir"
    ;;
  *)
    build_app
    echo "built $APP"
    ;;
esac
