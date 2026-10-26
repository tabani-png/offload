---
id: s28-dmg
title: DMG for testers - app/build.sh dmg makes Offload-<version>.dmg (app + /Applications link + tester note); app/release.sh puts it on a GitHub prerelease
depends_on: [s25-standalone-install (bundled brain, signing env, --brain-check), ADR 0002 (plain swiftc), ADR 0014]
parallel_safe: true
human_gated: false (Developer ID signing and notarization of the DMG run only when the operator sets the env vars; the real release is run by the operator from main)
verify: bash slices/s28-dmg/verify.sh
paths_in_scope: [app/build.sh, app/release.sh, app/INSTALL-TESTERS.md, app/README.md, slices/s28-dmg/**, LAUNCH.md]
paths_out_of_scope: [brain/**, engine/**, control/**, web/**, schemas/**, packages/**]
---

# s28-dmg

## Summary
s25 made Offload.app standalone (about 395 MB, brain inside). Testers still need one file to download. There is
no Apple Developer ID yet, so the build is ad hoc signed and Gatekeeper blocks it the first time; the tester note
explains "Open Anyway". When a Developer ID exists the same command signs, notarizes and staples the DMG too.

## Design
1. **`app/build.sh dmg`** builds the engine (`engine/build.sh`, so the observer is bundled), then the app (as the
   default build), then stages `Offload.app`, an `Applications -> /Applications` link and `INSTALL-TESTERS.md`
   (APFS clones) and runs plain `hdiutil create -format ULFO -volname Offload`. Output:
   `$OFFLOAD_BUILD_DIR/Offload-<CFBundleShortVersionString>.dmg` (default `app/.build`). No new dependencies.
2. **Signing.** `OFFLOAD_SIGN_IDENTITY` set: the DMG is signed with it (`codesign --timestamp`, ad hoc `-` uses
   `--timestamp=none`). `OFFLOAD_NOTARY_PROFILE` set: after the app is notarized and stapled (s25), the DMG is
   submitted with `notarytool --wait`, must be `Accepted`, then stapled and validated. With neither set the build
   prints `dmg: not signed and not notarized (ad hoc build; testers use Open Anyway, see app/INSTALL-TESTERS.md)`.
   Ad hoc identity plus a notary profile is refused before anything is built. `app/build.sh sign-dmg DMG` (re)signs
   an existing DMG with the same env (used by verify to test the signing path without a second build).
3. **`app/INSTALL-TESTERS.md`**: plain short English. Install (drag to Applications), open an unsigned build
   (Privacy & Security, "Open Anyway"), the three permissions and why, uninstall (the app, Application Support,
   logs). Copied into the DMG.
4. **`app/release.sh [--dry-run] [--dmg PATH]`**: refuses a dirty tree (tracked files) and a HEAD that is on no
   origin branch; a real release also needs HEAD on origin/main. Builds the DMG (or, dry run only, takes `--dmg`),
   writes `<dmg>.sha256` (`shasum -a 256`) and notes (INSTALL-TESTERS text, commit SHA, SHA-256, "unsigned",
   "private repo: collaborators only"), then `gh release create v<version>-beta.<n> <dmg> <dmg>.sha256
   --repo tabani-png/offload --prerelease --title "Offload <version> beta (unsigned)" --notes-file <notes>`.
   `<n>` is one more than the highest existing `v<version>-beta.*` tag (`OFFLOAD_BETA_N` overrides). `--dry-run`
   does everything except `gh release create` and prints what it would upload. The title says "(unsigned)" only
   for ad hoc builds.

## Acceptance (verify.sh)
- NOTE: `app/INSTALL-TESTERS.md` names Open Anyway, Privacy & Security, Screen Recording, Accessibility, Input
  Monitoring, `~/Library/Application Support/Offload` and how to delete the app.
- BUILD: `app/build.sh dmg` into a temp build dir exits 0, makes `Offload-<version>.dmg`, prints the ad hoc skip line.
- IMAGE: `hdiutil imageinfo` reports UDZO or ULFO; mounted with `hdiutil attach -nobrowse -readonly` at a temp
  mount point the volume name is "Offload", `Offload.app`, the `Applications` link to `/Applications` and the
  tester note are there, and the mounted app passes `codesign --verify --strict --deep`.
- PROOF: the app copied off the image to a temp folder runs `Offload --brain-check` with `env -i`, temp HOME, PATH
  without bun, no OFFLOAD_REPO, read-only, as s25 PROOF does: bundled source in the copy and HTTP 200.
- SIGN: `OFFLOAD_SIGN_IDENTITY=- app/build.sh sign-dmg DMG` signs the image and `codesign --verify` passes.
- NOTARY: build.sh has a DMG notarytool + stapler step; ad hoc + notary profile on `dmg` is refused before a build.
- RELEASE: `app/release.sh --dry-run --dmg DMG` either refuses (dirty tree or HEAD not on origin, when that is the
  state) or prints the tag, the SHA-256, the upload list and the `gh release create` line, and its notes carry the
  commit SHA, the checksum, "unsigned", "Open Anyway" and the private-repo line. It never calls `gh release create`.
- CLEAN: the DMG, the mount and temp files are gone at the end (TMPDIR /tmp/s28-tmp).
- s25 verify and `app/build.sh test` still pass (run separately).
