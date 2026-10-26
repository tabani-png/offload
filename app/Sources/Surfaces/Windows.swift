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

  init(title: String, subtitle: String, size: NSSize, minSize: NSSize, autosave: String, fullSize: Bool = false) {
    var mask: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]
    if fullSize { mask.insert(.fullSizeContentView) }
    window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                      styleMask: mask, backing: .buffered, defer: false)
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
  /// s10d: windows with a sidebar put the title after the sidebar's edge.
  var tracksSidebar: Bool { false }

  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    (tracksSidebar ? [.sidebarTrackingSeparator] : []) + [.flexibleSpace] + toolbarButtons.map { NSToolbarItem.Identifier($0.id) }
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
  private var bag: Set<AnyCancellable> = []

  init(model: ReviewModel) {
    self.model = model
    // The status is said once, in the body; the subtitle says where the workflow came from (s10a).
    super.init(title: "Review workflow", subtitle: "Drafted from your week",
               size: NSSize(width: 900, height: 880), minSize: NSSize(width: ReviewView.minWindowWidth, height: 520),
               autosave: "OffloadReview")
    let host = NSHostingView(rootView: ReviewView(model: model))
    host.sceneBridgingOptions = []  // our title and subtitle, not SwiftUI's (it would reset the subtitle)
    window.contentView = host
    // s10e: a new sheet takes the keys: nothing in the page keeps focus behind it.
    model.$sheet.removeDuplicates().sink { [weak self] s in if s != nil { self?.window.makeFirstResponder(nil) } }.store(in: &bag)
    model.loadDryRunIfNeeded()
    model.loadEditables()
  }

  /// s10d: open with nothing focused, so R, E and S act at once instead of typing into "Your voice".
  override func show() {
    super.show()
    DispatchQueue.main.async { [weak self] in self?.window.makeFirstResponder(nil) }
  }

  override var toolbarButtons: [ToolbarButton] {
    // s10d: one place to change the steps (the page already shows them read-only).
    [ToolbarButton(id: "skill", symbol: "square.and.pencil", label: "Edit the steps (E)") { [weak self] in self?.model.send(.edit) }]
  }

  override func handleKey(_ e: NSEvent) -> Bool {
    guard owns(e) else { return false }
    let editing = (e.window?.firstResponder as? NSTextView)?.isEditable == true
    // s14: T focuses the next step's tool row; while one is focused, ← → pick, ↩ keeps it, esc leaves the row.
    if model.sheet == nil, !editing, e.flags.intersection([.command, .control, .option]).isEmpty {
      if e.charactersIgnoringModifiers?.lowercased() == "t", !model.workflow.tools.isEmpty {
        model.focusNextTool()
        return true
      }
      if model.toolFocus != nil {
        switch e.keyCode {
        case 123: model.moveTool(-1); return true
        case 124: model.moveTool(1); return true
        case ReviewKey.escapeKeyCode: model.clearToolFocus(); return true
        default:
          if ReviewKey.returnKeyCodes.contains(e.keyCode) { model.confirmTool(); return true }
        }
      }
    }
    // s14: 1 and 2 keep the plan's first or second variant (only with no sheet up and nothing being typed).
    if model.sheet == nil, !editing, e.flags.intersection([.command, .control, .option]).isEmpty,
       let v = PlanChoice.variant(forKey: e.charactersIgnoringModifiers ?? "", plan: model.workflow.plan) {
      model.choosePlan(v)
      return true
    }
    guard let key = ReviewKey(characters: e.charactersIgnoringModifiers ?? "", keyCode: e.keyCode,
                              command: e.flags.contains(.command), control: e.flags.contains(.control),
                              option: e.flags.contains(.option), textEditing: editing) else { return false }
    if case .skill = model.sheet {
      // In the steps editor only Esc (close) and ⌘↩ (save) are ours; every other key types.
      if key == .escape { model.dismissSheet(); return true }
      if key == .approve { model.saveSkill(); return true }
      return false
    }
    model.send(key)
    return true
  }

  /// s10e: sheets are drawn inside the window by ReviewView (attached under the toolbar); nothing to present here.
}

// MARK: dashboard

/// s10d: sidebar and page in an NSSplitViewController, so the sidebar gets the system's own material and the
/// toolbar title sits after the sidebar edge, like Mail or Notes.
@MainActor
final class DashboardWindowController: TitledWindowController {
  let model: DashboardModel
  var onToggle: (() -> Void)?
  private var bag: Set<AnyCancellable> = []

  init(model: DashboardModel) {
    self.model = model
    super.init(title: "Offload", subtitle: model.section.title, size: NSSize(width: 980, height: 760),
               minSize: NSSize(width: 860, height: 520), autosave: "OffloadDashboard2", fullSize: true)
    let split = NSSplitViewController()
    let side = NSViewController()
    let sideHost = NSHostingView(rootView: DashboardSidebar(model: model))
    sideHost.sceneBridgingOptions = []
    side.view = sideHost
    let sideItem = NSSplitViewItem(sidebarWithViewController: side)
    sideItem.minimumThickness = Tokens.Layout.sidebar
    sideItem.maximumThickness = Tokens.Layout.sidebar + Tokens.Space.s48
    sideItem.canCollapse = false
    let detail = NSViewController()
    let detailHost = NSHostingView(rootView: DashboardDetail(model: model))
    detailHost.sceneBridgingOptions = []
    detail.view = detailHost
    split.addSplitViewItem(sideItem)
    split.addSplitViewItem(NSSplitViewItem(viewController: detail))
    let frame = window.frame
    window.contentViewController = split
    window.setFrame(frame, display: false)
    window.setFrameUsingName("OffloadDashboard2")
    model.$section.removeDuplicates().sink { [weak self] s in self?.window.subtitle = s.title }.store(in: &bag)
  }

  override var tracksSidebar: Bool { true }

  override func handleKey(_ e: NSEvent) -> Bool {
    guard owns(e) else { return false }
    if let c = model.connect {
      if e.keyCode == ReviewKey.escapeKeyCode { c.cancel(); return true }
      if ReviewKey.returnKeyCodes.contains(e.keyCode) { c.primary(); return true }
      return false
    }
    if model.autoSend != nil {
      if e.keyCode == ReviewKey.escapeKeyCode { model.dismissAutoSend(); return true }
      if ReviewKey.returnKeyCodes.contains(e.keyCode) {
        if case .offer = model.autoSend { if e.flags.contains(.command) { model.confirmAutoSend() } } else { model.dismissAutoSend() }
        return true
      }
      return false
    }
    if e.flags.contains(.command), e.charactersIgnoringModifiers?.lowercased() == "d" {
      window.performClose(nil)
      return true
    }
    // s10f (M4): ⌘K, the sidebar's Connections link.
    if DashboardSidebarLink.forShortcut(character: e.charactersIgnoringModifiers ?? "", command: e.flags.contains(.command)) == .connections,
       let open = model.onOpenConnections {
      open()
      return true
    }
    // ⌘1…⌘4: the sidebar's places.
    if e.flags.contains(.command), let n = Int(e.charactersIgnoringModifiers ?? ""), let s = DashboardSection.forShortcut(n) {
      model.show(s)
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

// MARK: company (S2-13)

/// S2-13: the Company window (connect, notice, share, sync state). Additive: the app opens it from its menu with a
/// model on the brain's company-sync routes. Esc closes a sheet; ⌘↩ is the sheet's (or the page's) white action.
@MainActor
final class CompanyWindowController: TitledWindowController {
  let model: CompanyModel

  init(model: CompanyModel) {
    self.model = model
    super.init(title: CompanyCopy.title, subtitle: CompanyCopy.subtitle, size: NSSize(width: CompanyView.width, height: 720),
               minSize: NSSize(width: CompanyNoticeSheet.width + Tokens.Space.s48, height: 560), autosave: "OffloadCompany")
    let host = NSHostingView(rootView: CompanyWindowRoot(model: model))
    host.sceneBridgingOptions = []
    window.contentView = host
  }

  override var toolbarButtons: [ToolbarButton] {
    [ToolbarButton(id: "company-refresh", symbol: "arrow.clockwise", label: "Check sync status") { [weak self] in self?.model.refresh() }]
  }

  override func handleKey(_ e: NSEvent) -> Bool {
    guard owns(e) else { return false }
    if (e.window?.firstResponder as? NSTextView)?.isEditable == true { return false }
    if e.keyCode == ReviewKey.escapeKeyCode, model.sheet != nil { model.dismissSheet(); return true }
    guard ReviewKey.returnKeyCodes.contains(e.keyCode), e.flags.contains(.command) else { return false }
    switch model.sheet {
    case .notice: model.acknowledge()
    case .share: model.confirmShare()
    case nil: model.primary()
    }
    return true
  }
}

extension NSAppearance {
  var isDark: Bool { bestMatch(from: [.darkAqua, .aqua]) == .darkAqua }
}
