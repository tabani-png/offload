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
      HStack(spacing: Tokens.Space.s8) {
        OffloadMark(size: Tokens.Space.s24)
        Text(model.flow.step.counter).textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink3)
        Spacer()
      }
      .padding(.bottom, Tokens.Space.s16)
      Text(model.flow.step.title).paragraphStyle(Tokens.TypeScale.display).foregroundStyle(p.ink1)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
        .padding(.bottom, Tokens.Space.s16)
      Group {
        switch model.flow.step {
        case .watches: WatchesStep()
        case .permissions: PermissionsStep(flow: model.flow)
        case .comeBack: ComeBackStep(model: model)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if let note = model.note {
        Text(note).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2).padding(.top, Tokens.Space.s16)
      }
      HStack(spacing: Tokens.Space.s8) {
        if !model.flow.isFirst {
          SecondaryButton(title: "Back") { model.back() }
        }
        Spacer()
        if model.flow.isLast {
          SecondaryButton(title: model.seeding ? "Preparing demo week…" : "Use demo week") { model.useDemoWeek() }
            .disabled(model.seeding)
        }
        if case .openSettings = model.flow.primary {
          SecondaryButton(title: model.flow.primaryTitle, key: "⌘↩") { model.next() }
        } else {
          PrimaryButton(title: model.flow.primaryTitle, key: "↩") { model.next() }
        }
      }
      .padding(.top, Tokens.Space.s32)
    }
    // Sized to its content, like a System Settings pane: no dead band above the buttons (s10a). The window
    // controller resizes to fit when the step changes.
    .padding(Tokens.Space.s32)
    .frame(width: Self.width, alignment: .topLeading)
    .fixedSize(horizontal: false, vertical: true)
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
    VStack(alignment: .leading, spacing: Tokens.Space.s8) {
      Text(title).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink2)
      ForEach(items, id: \.self) { item in
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
          Image(systemName: symbol).symbolStyle(Tokens.TypeScale.Symbol.regular).foregroundStyle(p.ink3)
            .frame(width: Tokens.Space.s16)
          Text(item).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1).fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }
}

private struct WatchesStep: View {
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Tokens.Space.s20) {
      BulletList(title: "What it notices", symbol: "eye", items: OnboardingFlow.watches)
      // A minus, not an ×: on a Mac an × is a close or remove button.
      BulletList(title: "What it never keeps", symbol: "minus.circle", items: OnboardingFlow.neverStores)
      Text(OnboardingFlow.localNote).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

private struct PermissionsStep: View {
  var flow: OnboardingFlow
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Tokens.Space.s16) {
      Text("macOS asks once for each. Open Settings, turn Offload on, and come back: the ticks appear on their own.")
        .paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2).fixedSize(horizontal: false, vertical: true)
      RingBox {
        ForEach(Array(flow.permissions.enumerated()), id: \.element.id) { i, perm in
          if i > 0 { RowDivider(inset: Tokens.Space.s48) }
          HStack(spacing: Tokens.Space.s12) {
            ZStack {
              Circle().fill(perm.grant == .granted ? p.status(.done) : p.track).frame(width: Tokens.Space.s20, height: Tokens.Space.s20)
              if perm.grant == .granted {
                Image(systemName: "checkmark").symbolStyle(Tokens.TypeScale.Symbol.small, weight: .bold).foregroundStyle(.white)
              }
            }
            .scaleEffect(perm.kind.map { flow.justGranted.contains($0) } == true ? 1.0 : 0.96)
            .animation(Motion.outExpo(Tokens.Duration.slow), value: perm.grant)
            .frame(width: Tokens.Space.s20)
            VStack(alignment: .leading, spacing: Tokens.Space.nudge) {
              HStack(spacing: Tokens.Space.s8) {
                Text(perm.name).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
                Text(perm.kind?.importance ?? (perm.required ? "Recommended" : "Optional"))
                  .textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
              }
              Text(perm.purpose).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Tokens.Space.s8)
            if perm.grant == .granted {
              Text("Allowed").textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
            } else if let url = perm.settingsURL {
              if flow.primary == .openSettings(perm.kind ?? .screenRecording), perm.kind == .screenRecording {
                PrimaryButton(title: "Open Settings", key: "↩") { NSWorkspace.shared.open(url) }
              } else {
                SecondaryButton(title: "Open Settings") { NSWorkspace.shared.open(url) }
              }
            }
          }
          .padding(.horizontal, Tokens.Space.s12).frame(minHeight: Tokens.Size.toolbar + Tokens.Space.s4)
          .accessibilityElement(children: .combine)
          .accessibilityLabel("\(perm.name), \(perm.label). \(perm.purpose)")
        }
      }
      Text(flow.permissionsNote).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3).fixedSize(horizontal: false, vertical: true)
    }
  }
}

private struct ComeBackStep: View {
  @ObservedObject var model: OnboardingModel
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Tokens.Space.s16) {
      Text(OnboardingFlow.comeBackBody).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
        .fixedSize(horizontal: false, vertical: true)
      RingBox(padding: Tokens.Space.s16) {
        HStack(alignment: .top, spacing: Tokens.Space.s12) {
          Image(systemName: "sparkles").symbolStyle(Tokens.TypeScale.Symbol.regular).foregroundStyle(p.ink2)
            .frame(width: Tokens.Space.s16)
          VStack(alignment: .leading, spacing: Tokens.Space.s4) {
            Text("Want to see it work now?").textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
            Text("Loads a sample founder's week (100 outreach emails a day) into a separate folder, so the first insight is waiting. Your own week is not touched.")
              .paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3).fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      HStack(spacing: Tokens.Space.s4) {
        // The same Keycap as every other shortcut: one cap per key.
        Keycap(label: "⌥"); Keycap(label: "Space")
        Text("opens the insight card any time.").textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
          .padding(.leading, Tokens.Space.s4)
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
    // Each step is sized to its content; keep the top edge where it is when it changes.
    stepWatch = model.$flow.map(\.step).removeDuplicates().dropFirst().sink { [weak self] _ in
      DispatchQueue.main.async { self?.fitToContent() }
    }
  }

  private var stepWatch: AnyCancellable?

  private func fitToContent() {
    guard let host = window.contentView else { return }
    let size = host.fittingSize
    var frame = window.frameRect(forContentRect: NSRect(origin: .zero, size: size))
    frame.origin.x = window.frame.minX
    frame.origin.y = window.frame.maxY - frame.height
    window.setFrame(frame, display: true, animate: true)
  }

  func show() {
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    guard keyMonitor == nil else { return }
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
      guard let self, e.window === self.window else { return e }
      if e.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command) { return e }
      if ReviewKey.returnKeyCodes.contains(e.keyCode) {
        // s10e (M8): while Screen Recording is off, ↩ opens its Settings pane (the white primary); ⌘↩ continues.
        if case .openSettings(let k) = self.model.flow.primary, !e.modifierFlags.contains(.command) {
          NSWorkspace.shared.open(k.settingsURL)
        } else {
          self.model.next()
        }
        return nil
      }
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
