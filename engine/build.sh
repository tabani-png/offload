#!/usr/bin/env bash
# Builds the engine with plain swiftc. SwiftPM is not used: on this machine the Command Line Tools ship a
# libPackageDescription.dylib that does not match its module, so Package.swift fails to link (plan ADR 0002).
#
#   engine/build.sh            build OffloadCore (dylib) and offload-observer into engine/.build/
#   engine/build.sh test [...] also build and run the Swift Testing suite; extra args go to the runner (--filter X)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OFFLOAD_BUILD_DIR:-$HERE/.build}"   # OFFLOAD_BUILD_DIR lets parallel agents build without clashing
CLT="$(xcode-select -p)"
FW="$CLT/Library/Developer/Frameworks"
DEVLIB="$CLT/Library/Developer/usr/lib"
mkdir -p "$OUT"

swift_files() { find "$1" -name '*.swift' -type f 2>/dev/null | sort; }

build_core() {
  # shellcheck disable=SC2046
  swiftc -parse-as-library -emit-library -emit-module -module-name OffloadCore -enable-testing -O \
    -Xlinker -install_name -Xlinker @rpath/libOffloadCore.dylib \
    $(swift_files "$HERE/Sources/OffloadCore") -emit-module-path "$OUT/OffloadCore.swiftmodule" \
    -o "$OUT/libOffloadCore.dylib"
}

build_exe() {
  local name="$1"
  # shellcheck disable=SC2046
  swiftc -module-name "${name//-/_}" -O -I "$OUT" -L "$OUT" -lOffloadCore \
    -Xlinker -rpath -Xlinker @executable_path \
    $(swift_files "$HERE/Sources/$name") -o "$OUT/$name"
}

build_tests() {
  local main="$OUT/TestMain.swift"
  printf 'import Testing\n@main struct OffloadTestRunner { static func main() async { await Testing.__swiftPMEntryPoint() as Never } }\n' > "$main"
  # shellcheck disable=SC2046
  swiftc -parse-as-library -module-name OffloadCoreTests -I "$OUT" -L "$OUT" -lOffloadCore \
    -F "$FW" -I "$DEVLIB" -L "$DEVLIB" -framework Testing \
    -plugin-path "$CLT/usr/lib/swift/host/plugins/testing" \
    -Xlinker -rpath -Xlinker "$FW" -Xlinker -rpath -Xlinker "$DEVLIB" -Xlinker -rpath -Xlinker @executable_path \
    $(swift_files "$HERE/Tests") "$main" -o "$OUT/offload-tests"
}

build_core
build_exe offload-observer

if [ "${1:-}" = "test" ]; then
  shift
  build_tests
  OFFLOAD_ENGINE_DIR="$HERE" OFFLOAD_BUILD_DIR="$OUT" "$OUT/offload-tests" "$@"
fi
