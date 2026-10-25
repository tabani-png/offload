import AppKit
import Combine
import SwiftUI

/// A normal titled window with a unified toolbar (title + subtitle), the way first-party Mac apps look.
/// The app stays an accessory (no Dock icon); opening one of these activates it so keys land here.
@MainActor
class TitledWindowController: NSObject, NSWindowDelegate, NSToolbarDelegate {
  let window: NSWindow
  var onClose: (() -> Void)?
  private var keyMonitor: Any?

  init(title: String, subtitle: String, size: NSSize, minSize: NSSize, autosave: String) {
    window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    super.init()
    window.title = title
    window.subtitle = subtitle
    window.toolbarStyle = .unified
    window.minSize = minSize
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.tabbingMode = .disallowed
    let toolbar = NSToolbar(identifier: autosave)
    toolbar.delegate = self
    toolbar.displayMode = .iconOnly
    toolbar.allowsUserCustomization = false
    window.toolbar = toolbar
    window.center()
    window.setFrameAutosaveName(autosave)
  }

  func show() {
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    guard keyMonitor == nil else { return }
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard let self else { return event }
      return self.handleKey(event) ? nil : event
    }
  }

  /// Subclasses map keys. Return true when the key was ours.
  func handleKey(_ event: NSEvent) -> Bool { false }

  /// Is this event for our window (or a sheet on it)?
  func owns(_ event: NSEvent) -> Bool {
    guard let w = event.window else { return false }
    return w === window || w.sheetParent === window
  }

  func windowWillClose(_ notification: Notification) {
    if let m = keyMonitor { NSEvent.removeMonitor(m) }
    keyMonitor = nil
    onClose?()
  }

  // MARK: toolbar

  struct ToolbarButton {
    var id: String
    var symbol: String
    var label: String
    var action: () -> Void
  }

  var toolbarButtons: [ToolbarButton] { [] }

  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    [.flexibleSpace] + toolbarButtons.map { NSToolbarItem.Identifier($0.id) }
  }

  func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    toolbarDefaultItemIdentifiers(toolbar)
  }

  func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier,
               willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
    guard let b = toolbarButtons.first(where: { $0.id == id.rawValue }) else { return nil }
    let item = NSToolbarItem(itemIdentifier: id)
    item.label = b.label
    item.toolTip = b.label
    item.image = NSImage(systemSymbolName: b.symbol, accessibilityDescription: b.label)
    item.isBordered = true
    item.target = self
    item.action = #selector(toolbarAction(_:))
    return item
  }

  @objc private func toolbarAction(_ sender: NSToolbarItem) {
    toolbarButtons.first { $0.id == sender.itemIdentifier.rawValue }?.action()
  }
}

/// Flags as the key maps need them.
private extension NSEvent {
  var flags: NSEvent.ModifierFlags { modifierFlags.intersection(.deviceIndependentFlagsMask) }
}

// MARK: review

@MainActor
final class ReviewWindowController: TitledWindowController {
  let model: ReviewModel
  private var sheetWindow: NSWindow?
  private var bag: Set<AnyCancellable> = []

  init(model: ReviewModel) {
    self.model = model
    super.init(title: "Review workflow", subtitle: "Drafted from your week · \(model.workflow.state.label)",
               size: NSSize(width: 820, height: 880), minSize: NSSize(width: 700, height: 520), autosave: "OffloadReview")
    let host = NSHostingView(rootView: ReviewView(model: model))
    host.sceneBridgingOptions = []  // our title and subtitle, not SwiftUI's (it would reset the subtitle)
    window.contentView = host
    model.$sheet.removeDuplicates().sink { [weak self] in self?.present($0) }.store(in: &bag)
    model.$flow.map(\.workflow.state).removeDuplicates()
      .sink { [weak self] s in self?.window.subtitle = "Drafted from your week · \(s.label)" }.store(in: &bag)
    model.loadDryRunIfNeeded()
    model.loadEditables()
  }

  override var toolbarButtons: [ToolbarButton] {
    [ToolbarButton(id: "skill", symbol: "doc.text", label: "SKILL.md") { [weak self] in self?.model.send(.skill) }]
  }

  override func handleKey(_ e: NSEvent) -> Bool {
    guard owns(e) else { return false }
    let editing = (e.window?.firstResponder as? NSTextView)?.isEditable == true
    guard let key = ReviewKey(characters: e.charactersIgnoringModifiers ?? "", keyCode: e.keyCode,
                              command: e.flags.contains(.command), control: e.flags.contains(.control),
                              option: e.flags.contains(.option), textEditing: editing) else { return false }
    if case .skill = model.sheet {
      // In the SKILL.md sheet only Esc is ours (it closes the sheet).
      guard key == .escape else { return false }
      model.dismissSheet()
      return true
    }
    model.send(key)
    return true
  }

  private func present(_ sheet: ReviewSheet?) {
    if let open = sheetWindow {
      window.endSheet(open)
      sheetWindow = nil
    }
    guard let sheet else { return }
    let root: AnyView
    switch sheet {
    case .confirm: root = AnyView(ConfirmSheet(model: model))
    case .skill(let editing): root = AnyView(SkillSheet(model: model, editing: editing))
    }
    let host = NSHostingView(rootView: root)
    let w = NSWindow(contentRect: NSRect(origin: .zero, size: host.fittingSize), styleMask: [.titled], backing: .buffered, defer: false)
    w.contentView = host
    sheetWindow = w
    window.beginSheet(w) { [weak self] _ in
      // A sheet closed by AppKit (not by the model) still has to reset the flow.
      guard let self, self.sheetWindow === w else { return }
      self.sheetWindow = nil
      if self.model.sheet != nil { self.model.dismissSheet() }
    }
  }
}

// MARK: dashboard

@MainActor
final class DashboardWindowController: TitledWindowController {
  let model: DashboardModel
  var onToggle: (() -> Void)?

  init(model: DashboardModel) {
    self.model = model
    super.init(title: "Offload", subtitle: "Dashboard", size: NSSize(width: 820, height: 900),
               minSize: NSSize(width: 720, height: 520), autosave: "OffloadDashboard")
    let host = NSHostingView(rootView: DashboardView(model: model))
    host.sceneBridgingOptions = []
    window.contentView = host
  }

  override func handleKey(_ e: NSEvent) -> Bool {
    guard owns(e) else { return false }
    if e.flags.contains(.command), e.charactersIgnoringModifiers?.lowercased() == "d" {
      window.performClose(nil)
      return true
    }
    // Keys belong to text fields when one has focus (none today, but keep typing safe).
    if (e.window?.firstResponder as? NSTextView)?.isEditable == true { return false }
    guard let key = DashboardKey(characters: e.charactersIgnoringModifiers ?? "", keyCode: e.keyCode,
                                 command: e.flags.contains(.command) || e.flags.contains(.control)) else { return false }
    model.send(key)
    return true
  }
}
