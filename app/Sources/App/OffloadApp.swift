import AppKit
import SwiftUI

@main
enum OffloadMain {
  static func main() {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--snapshot") {
      guard args.indices.contains(i + 1) else {
        FileHandle.standardError.write(Data("usage: Offload --snapshot DIR [--scale N]\n".utf8))
        exit(64)
      }
      MainActor.assumeIsolated {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        var scale: CGFloat = 2
        if let s = args.firstIndex(of: "--scale"), args.indices.contains(s + 1), let v = Double(args[s + 1]), v > 0 {
          scale = CGFloat(v)
        }
        exit(Snapshotter.run(into: URL(fileURLWithPath: args[i + 1], isDirectory: true), scale: scale))
      }
    }
    MainActor.assumeIsolated {
      let app = NSApplication.shared
      let delegate = AppDelegate()
      app.delegate = delegate
      app.setActivationPolicy(.accessory)  // menu-bar style: no Dock icon (LSUIElement also set)
      app.run()
    }
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let model = InboxModel(client: MockBrainClient())
  private var rail: RailController!
  private var card: CardController!
  private var hotKey: HotKey?

  func applicationDidFinishLaunching(_ notification: Notification) {
    rail = RailController(model: model,
                          onInbox: { [weak self] in self?.card.toggle() },
                          onMore: { [weak self] view in self?.showMoreMenu(from: view) })
    card = CardController(model: model, rail: rail)
    model.onClose = { [weak self] in self?.card.hide() }
    model.onCommit = { action in
      // s05 wires this to POST /workflows/draft and friends.
      NSLog("Offload: committed %@", String(describing: action))
    }
    rail.show()
    hotKey = HotKey { [weak self] in MainActor.assumeIsolated { self?.card.toggle() } }
    if hotKey == nil { NSLog("Offload: %@ is taken by another app; open the card from the rail", HotKey.displayName) }
    Task {
      await model.load()
      runQAHooks()
    }
  }

  /// QA only. `--open-card` opens the card at launch; OFFLOAD_DEMO_KEYS="2,j,1" replays keys through the
  /// same path real keystrokes take, one per second. Used for live smoke tests without Accessibility access.
  private func runQAHooks() {
    guard CommandLine.arguments.contains("--open-card") else { return }
    card.show()
    let keys = (ProcessInfo.processInfo.environment["OFFLOAD_DEMO_KEYS"] ?? "")
      .split(separator: ",").map { String($0) }
    for (i, k) in keys.enumerated() {
      DispatchQueue.main.asyncAfter(deadline: .now() + Double(i + 1)) { [weak self] in
        let code: UInt16 = k == "esc" ? 53 : 0
        if let key = CardKey(characters: k == "esc" ? "\u{1b}" : k, keyCode: code, hasCommandOrControl: false) {
          self?.model.send(key)
          NSLog("Offload QA: sent %@ -> %@", k, self?.model.state.positionLabel ?? "")
        }
      }
    }
  }

  private func showMoreMenu(from view: NSView) {
    let menu = NSMenu()
    menu.addItem(withTitle: "Open Inbox  \(HotKey.displayName)", action: #selector(openInbox), keyEquivalent: "").target = self
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit Offload", action: #selector(quit), keyEquivalent: "q").target = self
    let point = NSPoint(x: 0, y: view.bounds.midY)
    menu.popUp(positioning: nil, at: point, in: view)
  }

  @objc private func openInbox() { card.show() }
  @objc private func quit() { NSApp.terminate(nil) }
}
