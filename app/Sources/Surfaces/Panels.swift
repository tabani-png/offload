import AppKit
import Combine
import SwiftUI

/// Borderless, non-activating, transparent panel. Floats above normal windows on every Space but stays out of
/// full-screen Spaces (no `.fullScreenAuxiliary`): when you go full screen you are focused, and the rail waits.
class FloatingPanel: NSPanel {
  private let keyable: Bool

  init(keyable: Bool) {
    self.keyable = keyable
    super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isFloatingPanel = true
    level = .floating
    hidesOnDeactivate = false
    becomesKeyOnlyIfNeeded = !keyable
    collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
    backgroundColor = .clear
    isOpaque = false
    hasShadow = false  // the SwiftUI glass draws its own tight contact shadow
    isMovable = false
    isReleasedWhenClosed = false
    animationBehavior = .none
  }

  override var canBecomeKey: Bool { keyable }
  override var canBecomeMain: Bool { false }
}

/// Hosting view that takes the first click, so buttons work without activating Offload first.
/// It also reports content-size changes instead of resizing the window itself: AppKit's automatic window
/// sizing for hosting views fights explicit frames and can loop the constraint pass.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
  var onContentSizeChange: (() -> Void)?
  private var pendingSizeChange = false

  required init(rootView: Content) {
    super.init(rootView: rootView)
    sizingOptions = [.intrinsicContentSize]
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("not used") }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func invalidateIntrinsicContentSize() {
    super.invalidateIntrinsicContentSize()
    guard !pendingSizeChange else { return }
    pendingSizeChange = true
    DispatchQueue.main.async { [weak self] in
      MainActor.assumeIsolated {
        self?.pendingSizeChange = false
        self?.onContentSizeChange?()
      }
    }
  }
}

/// Pads content for the shadow and lets it take its ideal size; NSHostingView then fits the panel to it.
struct Padded<Content: View>: View {
  var content: Content
  var body: some View { content.padding(Edge.shadowPad).fixedSize() }
}

extension NSPanel {
  /// Sizes the panel to its content and anchors it. Skips no-op frames so layout never re-enters.
  @MainActor
  func fit(to size: CGSize, origin: (CGSize) -> CGPoint?) {
    guard size.width > 0, size.height > 0, let o = origin(size) else { return }
    let frame = NSRect(origin: o, size: size).integral
    if frame != self.frame { setFrame(frame, display: true) }
  }
}

enum Edge {
  /// Gap between the rail and the screen edge, and between rail and card.
  static let margin: CGFloat = 8
  /// Room around content for the contact shadow and the badge overhang.
  static let shadowPad: CGFloat = 24
}

/// Pins the rail to the right edge of the main screen, vertically centred.
@MainActor
final class RailController {
  let panel = FloatingPanel(keyable: false)
  private let model: InboxModel
  private var screenObserver: Any?

  init(model: InboxModel, onInbox: @escaping () -> Void, onMore: @escaping (NSView) -> Void) {
    self.model = model
    var hostRef: NSView?
    let host = FirstMouseHostingView(rootView: Padded(
      content: LiveRail(model: model, onInbox: onInbox, onMore: { if let v = hostRef { onMore(v) } })))
    hostRef = host
    panel.contentView = host
    self.host = host
    host.onContentSizeChange = { [weak self] in self?.place() }
    screenObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
    ) { [weak self] _ in MainActor.assumeIsolated { self?.place() } }
  }

  private var host: NSView?

  func show() {
    place()
    panel.orderFrontRegardless()
  }

  /// Top of the inbox capsule, in screen coordinates (the card lines up with it).
  var inboxTop: CGFloat { panel.frame.maxY - Edge.shadowPad }
  var railLeft: CGFloat { panel.frame.maxX - Edge.shadowPad - RailView.width }

  /// Right-aligned and vertically centred: growing to the left (hover label) never moves the capsules.
  private func origin(for size: CGSize) -> CGPoint? {
    guard let vf = NSScreen.main?.visibleFrame else { return nil }
    return CGPoint(x: vf.maxX - Edge.margin - size.width + Edge.shadowPad, y: vf.midY - size.height / 2)
  }

  private func place() {
    guard let host else { return }
    panel.fit(to: host.fittingSize) { [weak self] in self?.origin(for: $0) }
  }
}

/// The insight card panel. Keyable but non-activating: it takes keys while the app you were in stays active,
/// so closing it hands focus straight back.
@MainActor
final class CardController {
  let panel = FloatingPanel(keyable: true)
  private let model: InboxModel
  private weak var rail: RailController?
  private let host: FirstMouseHostingView<AnyView>
  private var keyMonitor: Any?
  private var clickMonitor: Any?

  var isVisible: Bool { panel.isVisible }

  init(model: InboxModel, rail: RailController) {
    self.model = model
    self.rail = rail
    host = FirstMouseHostingView(rootView: AnyView(EmptyView()))
    host.rootView = makeRoot()
    panel.contentView = host
    host.onContentSizeChange = { [weak self] in self?.place() }
  }

  private func place() {
    panel.fit(to: host.fittingSize) { [weak self] in self?.origin(for: $0) }
  }

  private func makeRoot() -> AnyView {
    AnyView(Padded(content: LiveInsightCard(model: model).arriveOnAppear()))
  }

  func toggle() { isVisible ? hide() : show() }

  func show() {
    guard !isVisible else { panel.makeKey(); return }
    // Re-host so the arrival animation plays on every open.
    host.rootView = makeRoot()
    place()
    panel.orderFrontRegardless()
    panel.makeKey()
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard let self, event.window === self.panel else { return event }
      let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
      guard let key = CardKey(characters: event.charactersIgnoringModifiers ?? "", keyCode: event.keyCode,
                              hasCommandOrControl: flags.contains(.command) || flags.contains(.control)) else { return event }
      self.model.send(key)
      return nil
    }
    // Click anywhere outside Offload closes the card. A staged action keeps counting down and still lands.
    clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
      MainActor.assumeIsolated { self?.hide() }
    }
  }

  func hide() {
    if let m = keyMonitor { NSEvent.removeMonitor(m) }
    if let m = clickMonitor { NSEvent.removeMonitor(m) }
    keyMonitor = nil
    clickMonitor = nil
    panel.orderOut(nil)
  }

  /// Right edge just left of the rail, top level with the inbox capsule, kept on screen.
  /// Anchoring the top means the evidence list grows the card downward, away from the inbox.
  private func origin(for size: CGSize) -> CGPoint? {
    guard let vf = NSScreen.main?.visibleFrame, let rail else { return nil }
    let right = rail.railLeft - Edge.margin + Edge.shadowPad
    let top = min(rail.inboxTop + Edge.shadowPad, vf.maxY + Edge.shadowPad)
    let y = max(vf.minY - Edge.shadowPad, top - size.height)
    return CGPoint(x: right - size.width, y: y)
  }
}
