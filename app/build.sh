#!/usr/bin/env bash
# Builds Offload.app with plain swiftc. SwiftPM is not used on this machine (plan ADR 0002): the Command Line
# Tools' libPackageDescription does not link. No Xcode, no asset catalogs.
#
#   app/build.sh                 build app/.build/Offload.app
#   app/build.sh test [args]     build and run the S06 … S10F, S14, S17 and S2-13 Swift Testing suites (extra args go to the runner)
#   app/build.sh snapshot DIR    build, then render every component and surface to PNGs in DIR
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
    codesign --force --sign - "$APP/Contents/MacOS/libOffloadCore.dylib" "$APP/Contents/MacOS/offload-observer" >/dev/null 2>&1 || true
  fi
  codesign --force --sign - "$APP" >/dev/null 2>&1 || true
}

build_tests() {
  local main="$OUT/TestMain.swift"
  printf 'import Testing\n@main struct OffloadTestRunner { static func main() async { await Testing.__swiftPMEntryPoint() as Never } }\n' > "$main"
  # shellcheck disable=SC2046
  swiftc -target "$TARGET" -parse-as-library -module-name OffloadTests \
    -F "$FW" -I "$DEVLIB" -L "$DEVLIB" -framework Testing \
    -plugin-path "$CLT/usr/lib/swift/host/plugins/testing" \
    -Xlinker -rpath -Xlinker "$FW" -Xlinker -rpath -Xlinker "$DEVLIB" \
    $(swift_files "$HERE/Sources/Core" "$ROOT/slices/s06-design-system/tests" "$ROOT/slices/s07-rail-and-card/tests" "$ROOT/slices/s08-review-and-dashboard/tests" "$ROOT/slices/s09a-wiring/tests" "$ROOT/slices/s10a-ui-polish/tests" "$ROOT/slices/s10d-ui-round3/tests" "$ROOT/slices/s10e-ui-round4/tests" "$ROOT/slices/s14-any-task-workflows/tests" "$ROOT/slices/s17-connect-anything/tests" "$ROOT/slices/s10f-ui-round5/tests" "$ROOT/slices/S2-13-mac-company-surfaces/tests") \
    "$main" -o "$OUT/offload-tests"
}

case "${1:-}" in
  test)
    shift
    build_tests
    "$OUT/offload-tests" "$@"
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
