# Offload: install notes for testers

This is a test build. It needs a Mac with Apple silicon (M1 or later) and macOS 14 or later.

## Install

1. Open the `.dmg` file.
2. Drag `Offload.app` onto the `Applications` folder in the same window.
3. Eject the Offload disk. Open Offload from your Applications folder, not from the disk.

## Open a build that is not signed yet

This build is not signed by Apple yet, so macOS blocks it the first time. This is expected.

1. Open Offload once. macOS says it cannot check the app. Click **Done** (or **Cancel**).
2. Open **System Settings**, then **Privacy & Security**.
3. Scroll down to **Security**. Next to the line about Offload, click **Open Anyway**.
4. Enter your Mac password if asked, then click **Open Anyway** again.

You only do this once. If you do not see "Open Anyway", open Offload again and go back to step 2.

## Permissions

Offload asks for three permissions in **System Settings > Privacy & Security**. Offload still opens if you say no.

| Permission | Why |
|---|---|
| Screen Recording | Reads the text on your screen, to tell one piece of work from another. Needed for insights. |
| Accessibility | Reads window titles and browser addresses. Recommended. |
| Input Monitoring | Counts keys and clicks. It never records which keys. Optional. |

Everything stays on your Mac, encrypted. If you turn on Claude, only masked text and masked screenshots go to
your Claude account. Keys you paste into Offload go into your Mac's Keychain.

## Uninstall

1. Quit Offload.
2. Drag `Offload.app` from Applications to the Trash.
3. Delete its data folder (`~/Library/Application Support/Offload`) and its logs (`~/Library/Logs/Offload`).
   In Terminal:

```
rm -rf ~/Library/Application\ Support/Offload ~/Library/Logs/Offload
rm -f ~/Library/LaunchAgents/ai.offload.observer.plist
```

4. Optional: remove Offload from the three lists in **Privacy & Security** (select it, then click the minus button).
