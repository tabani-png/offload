import AppKit
import Combine
import SwiftUI

/// Main-actor state for the first-run window: the step, live permission reads while step 2 is up, and the
/// demo-week seeding.
@MainActor
final class OnboardingModel: ObservableObject {
  @Published private(set) var flow = OnboardingFlow()
  @Published private(set) var seeding = false
  @Published private(set) var note: String?

  var onFinish: (() -> Void)?
  /// Seeds the demo week and points the brain at it. Returns a calm error sentence, or nil when it worked.
  var onDemoWeek: (() async -> String?)?

  private let readPermissions: () async -> [PermissionState]
  private var poll: Timer?

  init(readPermissions: @escaping () async -> [PermissionState]) {
    self.readPermissions = readPermissions
  }

  func next() {
    if flow.isLast { finish(); return }
    flow.next()
    if flow.step == .permissions { startPolling() } else { stopPolling() }
  }

  func back() {
    flow.back()
    if flow.step == .permissions { startPolling() } else { stopPolling() }
  }

  func finish() {
    stopPolling()
    onFinish?()
  }

  func useDemoWeek() {
    guard !seeding, let go = onDemoWeek else { return }
    seeding = true
    note = nil
    Task {
      let problem = await go()
      seeding = false
      if let problem { note = problem } else { finish() }
    }
  }

  func refreshPermissions() {
    Task {
      let rows = await readPermissions()
      flow.update(rows)
    }
  }

  private func startPolling() {
    refreshPermissions()
    guard poll == nil else { return }
    let t = Timer(timeInterval: 1.5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.refreshPermissions() }
    }
    RunLoop.main.add(t, forMode: .common)
    poll = t
  }

  private func stopPolling() {
    poll?.invalidate()
    poll = nil
  }

  // MARK: snapshot support

  func preview(step: OnboardingStep, permissions: [PermissionState]? = nil, granted: [PermissionState]? = nil) {
    var f = OnboardingFlow()
    while f.step != step { f.next() }
    if let permissions { f.update(permissions) }
    if let granted { f.update(granted) }
    flow = f
  }
}

/// The first-run window's content: three calm steps, one primary action, a step counter.
struct OnboardingView: View {
  @ObservedObject var model: OnboardingModel
  @Environment(\.colorScheme) private var scheme

  static let width: CGFloat = 520

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 10) {
        OffloadMark(size: 22)
        Text(model.flow.step.counter).font(.system(size: 12)).monospacedDigit().foregroundStyle(p.ink3)
        Spacer()
      }
      .padding(.bottom, 18)
      Text(model.flow.step.title).textStyle(Tokens.TypeScale.display).foregroundStyle(p.ink1)
        .accessibilityAddTraits(.isHeader)
        .padding(.bottom, 16)
      Group {
        switch model.flow.step {
        case .watches: WatchesStep()
        case .permissions: PermissionsStep(flow: model.flow)
        case .comeBack: ComeBackStep(model: model)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Spacer(minLength: 20)
      if let note = model.note {
        Text(note).font(.system(size: 12)).foregroundStyle(p.ink2).padding(.bottom, 10)
      }
      HStack(spacing: 10) {
        if !model.flow.isFirst {
          SecondaryButton(title: "Back") { model.back() }
        }
        Spacer()
        if model.flow.isLast {
          SecondaryButton(title: model.seeding ? "Preparing demo week…" : "Use demo week") { model.useDemoWeek() }
            .disabled(model.seeding)
        }
        PrimaryButton(title: model.flow.primaryTitle, key: "↩") { model.next() }
      }
    }
    .padding(28)
    .frame(width: Self.width, height: 470, alignment: .topLeading)
    .background(p.canvas)
  }
}

private struct BulletList: View {
  var title: String
  var symbol: String
  var items: [String]
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: 8) {
      Text(title).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink2)
      ForEach(items, id: \.self) { item in
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Image(systemName: symbol).font(.system(size: 11, weight: .medium)).foregroundStyle(p.ink3).frame(width: 14)
          Text(item).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1).fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }
}

private struct WatchesStep: View {
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: 20) {
      BulletList(title: "What it notices", symbol: "eye", items: OnboardingFlow.watches)
      BulletList(title: "What it never keeps", symbol: "xmark", items: OnboardingFlow.neverStores)
      Text(OnboardingFlow.localNote).font(.system(size: 12)).foregroundStyle(p.ink3).fixedSize(horizontal: false, vertical: true)
    }
  }
}

private struct PermissionsStep: View {
  var flow: OnboardingFlow
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: 14) {
      Text("macOS asks once for each. Open Settings, turn Offload on, and come back: the ticks appear on their own.")
        .textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2).fixedSize(horizontal: false, vertical: true)
      RingBox {
        ForEach(Array(flow.permissions.enumerated()), id: \.element.id) { i, perm in
          if i > 0 { RowDivider(inset: 44) }
          HStack(spacing: 12) {
            ZStack {
              Circle().fill(perm.grant == .granted ? p.status(.done) : p.track).frame(width: 20, height: 20)
              if perm.grant == .granted {
                Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
              }
            }
            .scaleEffect(perm.kind.map { flow.justGranted.contains($0) } == true ? 1.0 : 0.96)
            .animation(Motion.outExpo(Tokens.Duration.slow), value: perm.grant)
            .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
              HStack(spacing: 6) {
                Text(perm.name).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
                Text(perm.required ? "Required" : "Optional").font(.system(size: 11)).foregroundStyle(p.ink3)
              }
              Text(perm.purpose).font(.system(size: 12)).foregroundStyle(p.ink3).lineLimit(1)
            }
            Spacer(minLength: 8)
            if perm.grant == .granted {
              Text("Allowed").font(.system(size: 12)).foregroundStyle(p.ink2)
            } else if let url = perm.settingsURL {
              SecondaryButton(title: "Open Settings") { NSWorkspace.shared.open(url) }
            }
          }
          .padding(.horizontal, 12).frame(minHeight: 54)
          .accessibilityElement(children: .combine)
          .accessibilityLabel("\(perm.name), \(perm.label). \(perm.purpose)")
        }
      }
      Text(flow.permissionsNote).font(.system(size: 12)).foregroundStyle(p.ink3).fixedSize(horizontal: false, vertical: true)
    }
  }
}

private struct ComeBackStep: View {
  @ObservedObject var model: OnboardingModel
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: 16) {
      Text(OnboardingFlow.comeBackBody).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
        .fixedSize(horizontal: false, vertical: true)
      RingBox(padding: 14) {
        HStack(alignment: .top, spacing: 12) {
          Image(systemName: "sparkles").font(.system(size: 13)).foregroundStyle(p.ink2).frame(width: 16)
          VStack(alignment: .leading, spacing: 4) {
            Text("Want to see it work now?").textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
            Text("Use demo week loads a sample founder's week (100 outreach emails a day) into a separate demo folder, so the first insight is waiting. Your own week is not touched.")
              .font(.system(size: 12)).foregroundStyle(p.ink3).fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      HStack(spacing: 8) {
        Keycap(label: "⌥Space")
        Text("opens the insight card any time.").font(.system(size: 12)).foregroundStyle(p.ink3)
      }
    }
  }
}

/// A small titled window, no toolbar, centred. ↩ = the primary action, Esc closes.
@MainActor
final class OnboardingWindowController: NSObject, NSWindowDelegate {
  let window: NSWindow
  let model: OnboardingModel
  var onClose: (() -> Void)?
  private var keyMonitor: Any?

  init(model: OnboardingModel) {
    self.model = model
    let host = NSHostingView(rootView: OnboardingView(model: model))
    host.sceneBridgingOptions = []
    window = NSWindow(contentRect: NSRect(origin: .zero, size: host.fittingSize), styleMask: [.titled, .closable],
                      backing: .buffered, defer: false)
    super.init()
    window.title = "Welcome to Offload"
    window.titlebarAppearsTransparent = true
    window.isReleasedWhenClosed = false
    window.contentView = host
    window.delegate = self
    window.center()
  }

  func show() {
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    guard keyMonitor == nil else { return }
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
      guard let self, e.window === self.window else { return e }
      if e.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command) { return e }
      if ReviewKey.returnKeyCodes.contains(e.keyCode) { self.model.next(); return nil }
      if e.keyCode == ReviewKey.escapeKeyCode { self.window.performClose(nil); return nil }
      return e
    }
  }

  func windowWillClose(_ notification: Notification) {
    if let m = keyMonitor { NSEvent.removeMonitor(m) }
    keyMonitor = nil
    onClose?()
  }
}
