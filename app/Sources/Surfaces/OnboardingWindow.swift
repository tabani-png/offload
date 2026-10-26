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
  /// s14: Continue on "What do you do?" with a value: PUT /context (the app delegate queues it until the brain is up).
  var onContext: ((UserContext) -> Void)?
  /// s14: GET /context, for the brain's suggestion chips and a context saved earlier. nil = keep the built-in chips.
  var loadContext: (() async -> ContextResponse?)?
  /// s14: the Claude captioner opt-in (off by default); the app delegate saves it and restarts the brain.
  @Published private(set) var claudeVision = false
  var onClaudeVision: ((Bool) -> Void)?

  func setClaudeVision(initial: Bool) { claudeVision = initial }

  func toggleClaudeVision() {
    claudeVision.toggle()
    onClaudeVision?(claudeVision)
  }
  /// Seeds the demo week and points the brain at it. Returns a calm error sentence, or nil when it worked.
  var onDemoWeek: (() async -> String?)?

  private let readPermissions: () async -> [PermissionState]
  private var poll: Timer?
  /// s29: "Your Claude API key", shown first when no key is stored. The four steps after it are unchanged.
  let claudeKey: ClaudeKeyModel?
  @Published private(set) var showingKeyStep = false
  private var keyWatch: AnyCancellable?

  init(readPermissions: @escaping () async -> [PermissionState], claudeKey: ClaudeKeyModel? = nil) {
    self.readPermissions = readPermissions
    self.claudeKey = claudeKey
    showingKeyStep = claudeKey.map { ClaudeKeyStep.shows(status: $0.status) } ?? false
    // Saved (checked, or "Save without checking"): move on to the first step.
    keyWatch = claudeKey?.$flow.map(\.phase).removeDuplicates().sink { [weak self] phase in
      guard phase == .saved else { return }
      DispatchQueue.main.async { self?.leaveKeyStep() }
    }
  }

  /// ↩ or Save key on the key screen: check with Anthropic, save when it works.
  func submitKey() {
    claudeKey?.submit()
  }

  /// Skip for now: no key, Claude stays off (the dashboard says where to add one).
  func skipKey() {
    claudeKey?.cancel()
    leaveKeyStep()
  }

  private func leaveKeyStep() {
    guard showingKeyStep else { return }
    showingKeyStep = false
    stepChanged()
  }

  func next() {
    if showingKeyStep { submitKey(); return }
    if flow.isLast { finish(); return }
    if flow.step == .context {
      if let c = flow.continueContext() { onContext?(c) }
    } else {
      flow.next()
    }
    stepChanged()
  }

  func back() {
    flow.back()
    stepChanged()
  }

  /// s14: Skip (⌘↩) on the context step: nothing is sent.
  func skipContext() {
    guard flow.step == .context else { return }
    flow.skipContext()
    stepChanged()
  }

  func setContext(_ f: ContextStepState.Field, _ text: String) { flow.context.set(f, text) }
  func chooseContext(_ f: ContextStepState.Field, _ chip: String) { flow.context.choose(f, chip) }

  private var contextLoaded = false

  private func stepChanged() {
    if flow.step == .permissions { startPolling() } else { stopPolling() }
    if flow.step == .context, !contextLoaded, let load = loadContext {
      contextLoaded = true
      Task {
        if let r = await load() { flow.context.adopt(r) }
      }
    }
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

  func preview(step: OnboardingStep, permissions: [PermissionState]? = nil, granted: [PermissionState]? = nil,
               context: ContextStepState? = nil, claudeVision: Bool = false, keyStep: Bool = false) {
    self.claudeVision = claudeVision
    showingKeyStep = keyStep && claudeKey != nil
    var f = OnboardingFlow()
    while f.step != step { f.next() }
    if let permissions { f.update(permissions) }
    if let granted { f.update(granted) }
    if let context { f.context = context }
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
      if model.showingKeyStep, let key = model.claudeKey {
        keyScreen(key, p)
      } else {
        steps(p)
      }
    }
    // Sized to its content, like a System Settings pane: no dead band above the buttons (s10a). The window
    // controller resizes to fit when the step changes.
    .padding(Tokens.Space.s32)
    .frame(width: Self.width, alignment: .topLeading)
    .fixedSize(horizontal: false, vertical: true)
    .background(p.canvas)
  }

  /// s29: the key screen, before the four steps.
  @ViewBuilder private func keyScreen(_ key: ClaudeKeyModel, _ p: Palette) -> some View {
    HStack(spacing: Tokens.Space.s8) {
      OffloadMark(size: Tokens.Space.s24)
      Text("Before you start").textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
      Spacer()
    }
    .padding(.bottom, Tokens.Space.s16)
    Text(ClaudeKeyStep.title).paragraphStyle(Tokens.TypeScale.display).foregroundStyle(p.ink1)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityAddTraits(.isHeader)
      .padding(.bottom, Tokens.Space.s16)
    ClaudeKeyStepView(model: key) { model.submitKey() }
      .frame(maxWidth: .infinity, alignment: .leading)
    KeyScreenButtons(model: model, key: key)
      .padding(.top, Tokens.Space.s32)
  }

  @ViewBuilder private func steps(_ p: Palette) -> some View {
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
      case .context: ContextStep(model: model)
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
      if model.flow.step == .context {
        // s14: the question is optional; Skip sends nothing.
        SecondaryButton(title: "Skip", key: "⌘↩") { model.skipContext() }
      }
      if case .openSettings = model.flow.primary {
        SecondaryButton(title: model.flow.primaryTitle, key: "⌘↩") { model.next() }
      } else {
        PrimaryButton(title: model.flow.primaryTitle, key: "↩") { model.next() }
      }
    }
    .padding(.top, Tokens.Space.s32)
  }
}

/// s29: Skip for now and Save key (↩). Its own view so it redraws as the key check runs.
private struct KeyScreenButtons: View {
  @ObservedObject var model: OnboardingModel
  @ObservedObject var key: ClaudeKeyModel

  var body: some View {
    HStack(spacing: Tokens.Space.s8) {
      Spacer()
      SecondaryButton(title: ClaudeKeyStep.skipTitle) { model.skipKey() }
      PrimaryButton(title: key.flow.isChecking ? "Checking…" : ClaudeKeyStep.saveTitle, key: "↩") { model.submitKey() }
        .disabled(key.flow.isChecking)
    }
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

/// s14: "What do you do?" Two one-line fields with suggestion chips. Tab moves between the fields, ↩ continues,
/// ⌘↩ skips. In snapshots the fields are drawn as text (offscreen rendering cannot draw a live text field).
private struct ContextStep: View {
  @ObservedObject var model: OnboardingModel
  @FocusState private var focus: ContextStepState.Field?
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Tokens.Space.s20) {
      Text(ContextStepState.intro).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
        .fixedSize(horizontal: false, vertical: true)
      ForEach(ContextStepState.Field.allCases, id: \.self) { f in field(f, p) }
      // s14: the Claude captioner opt-in: off by default, Space (outside the fields) or a click toggles it.
      OptInRow(title: ClaudeVisionSetting.label, isOn: model.claudeVision, key: focus == nil ? "Space" : nil) {
        model.toggleClaudeVision()
      }
      HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
        Image(systemName: "lock").symbolStyle(Tokens.TypeScale.Symbol.small).foregroundStyle(p.ink3)
          .frame(width: Tokens.Space.s12)
        Text(ContextStepState.helper).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func field(_ f: ContextStepState.Field, _ p: Palette) -> some View {
    let value = model.flow.context.value(f)
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.row, style: .continuous)
    return VStack(alignment: .leading, spacing: Tokens.Space.s8) {
      Text(f.label).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink2)
      Group {
        if isSnapshot {
          Text(value.isEmpty ? f.placeholder : value).textStyle(Tokens.TypeScale.body)
            .foregroundStyle(value.isEmpty ? p.ink3 : p.ink1)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          TextField(f.placeholder, text: Binding(get: { model.flow.context.value(f) }, set: { model.setContext(f, $0) }))
            .textFieldStyle(.plain)
            .textStyle(Tokens.TypeScale.body)
            .foregroundStyle(p.ink1)
            .focused($focus, equals: f)
            .accessibilityLabel(f.label)
        }
      }
      .padding(.horizontal, Tokens.Space.s12)
      .frame(height: Tokens.Size.row)
      .background(shape.fill(p.fill))
      .overlay(shape.strokeBorder(focus == f ? p.ringStrong : p.ring, lineWidth: Tokens.Layout.hairline))
      .animation(Motion.outExpo(Tokens.Duration.fast), value: focus)
      FlowLayout(spacing: Tokens.Space.s8) {
        ForEach(model.flow.context.suggestions(f), id: \.self) { chip in
          SuggestionChip(text: chip, chosen: model.flow.context.isChosen(f, chip)) { model.chooseContext(f, chip) }
        }
      }
    }
  }
}

/// A suggestion: neutral, with a stronger ring while it is what the field holds (no colour: it is not a state).
private struct SuggestionChip: View {
  var text: String
  var chosen: Bool
  var action: () -> Void
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    Button(action: action) {
      Text(text).textStyle(Tokens.TypeScale.calloutEmphasis)
        .foregroundStyle(chosen ? p.ink1 : p.ink2)
        .padding(.horizontal, Tokens.Space.s12)
        .frame(height: Tokens.Size.chip)
        .background(Capsule().fill(chosen ? p.fillStrong : p.fill))
        .overlay(Capsule().strokeBorder(chosen ? p.ringStrong : p.ring, lineWidth: Tokens.Layout.hairline))
        .contentShape(Capsule())
        .animation(Motion.outExpo(Tokens.Duration.fast), value: chosen)
    }
    .buttonStyle(PressStyle())
    .accessibilityLabel(chosen ? "\(text), chosen" : text)
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
    // s29 review round 4: refit on every change that adds, removes or rewraps a row (OnboardingLayout), not only on
    // a step change: key errors, "Save without checking", the demo-week note, the permissions note, chips arriving.
    let keyFlow: AnyPublisher<ClaudeKeyFlow?, Never> = model.claudeKey.map { $0.$flow.map(Optional.some).eraseToAnyPublisher() }
      ?? Just(nil).eraseToAnyPublisher()
    layoutWatch = Publishers.CombineLatest4(model.$flow, model.$showingKeyStep, model.$note, keyFlow)
      .map { OnboardingLayout.of(flow: $0, showingKeyStep: $1, keyFlow: $3, note: $2) }
      .removeDuplicates().dropFirst()
      .sink { [weak self] _ in DispatchQueue.main.async { self?.fitToContent() } }
  }

  private var layoutWatch: AnyCancellable?

  private func fitToContent() {
    guard let host = window.contentView else { return }
    host.layoutSubtreeIfNeeded()
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
      // s14: on "What do you do?", ⌘↩ skips (nothing is sent).
      if self.model.flow.step == .context, ReviewKey.returnKeyCodes.contains(e.keyCode),
         e.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command) {
        self.model.skipContext()
        return nil
      }
      if e.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command) { return e }
      // s14: Space toggles the Claude opt-in on the context step, unless a text field is being typed in.
      if self.model.flow.step == .context, e.keyCode == 49,
         (self.window.firstResponder as? NSTextView)?.isEditable != true {
        self.model.toggleClaudeVision()
        return nil
      }
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
