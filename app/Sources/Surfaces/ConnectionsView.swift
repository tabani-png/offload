import AppKit
import Combine
import SwiftUI

// s17: the Connections center window. A search field, one row per app with its status dot (green connected, amber
// needs you, grey not set up), and a detail sheet with the ways to set the app up and one white button. Composio
// sign-in is the s10e ConnectSheet, reused as it is. Keyboard-first: ⌘F search, ↑ ↓ move, ↩ open, esc back, 1-3 pick a
// way, ⌘↩ the primary. The API key goes from the secure field straight into the Keychain and is cleared.

@MainActor
final class ConnectionsModel: ObservableObject {
  @Published private(set) var list = ConnectionsList()
  @Published private(set) var page: ConnectionsPage?
  @Published private(set) var error: String?
  @Published var sheet: ConnectionSheetModel?
  @Published var focusSearch = false
  @Published var searchText = "" {
    didSet { if searchText != oldValue { run(list.type(searchText)) } }
  }

  let client: BrainClient
  let store: SecretStore
  var onOpenReview: ((String) -> Void)?
  var onOpenURL: ((URL) -> Void)?
  var onClose: (() -> Void)?
  private var searchTask: Task<Void, Never>?

  init(client: BrainClient, store: SecretStore) {
    self.client = client
    self.store = store
  }

  func load() async {
    await search(list.query)
  }

  private func search(_ q: String) async {
    do {
      let p = try await client.connections(query: q)
      page = p
      list.receive(p.rows)
      error = nil
    } catch {
      self.error = BrainError.message(for: error)
    }
  }

  func handle(_ k: ConnectionsList.Key) { run(list.handle(k)) }

  func select(_ id: String) { list.select(id) }

  private func run(_ effects: [ConnectionsList.Effect]) {
    for e in effects {
      switch e {
      case .search(let q):
        if searchText != list.query { searchText = list.query }
        searchTask?.cancel()
        searchTask = Task { [weak self] in
          // A short pause so typing does not send a request per key.
          try? await Task.sleep(nanoseconds: 150_000_000)
          guard !Task.isCancelled else { return }
          await self?.search(q)
        }
      case .open(let id):
        Task { await self.open(id) }
      case .close:
        onClose?()
      case .focusSearch:
        focusSearch = true
      }
    }
  }

  func open(_ id: String) async {
    do {
      let d = try await client.connection(id: id)
      let s = ConnectionSheetModel(detail: d, client: client, store: store)
      s.onOpenReview = { [weak self] wf in self?.onOpenReview?(wf) }
      s.onOpenURL = { [weak self] u in self?.onOpenURL?(u) }
      s.onClose = { [weak self] in
        self?.sheet = nil
        Task { await self?.load() }
      }
      sheet = s
    } catch {
      self.error = BrainError.message(for: error)
    }
  }

  /// Snapshots: a page and an open sheet without a brain.
  func preview(page p: ConnectionsPage, query: String = "", selected: String? = nil, sheet s: ConnectionSheetModel? = nil) {
    page = p
    _ = list.type(query)
    searchText = query
    searchTask?.cancel()
    list.receive(p.rows)
    if let selected { list.select(selected) }
    sheet = s
  }
}

/// One app's sheet. Drives the pure ConnectionSheetFlow; runs its effects against the brain and the Keychain.
@MainActor
final class ConnectionSheetModel: ObservableObject {
  @Published private(set) var flow: ConnectionSheetFlow
  /// The s10e connect sheet while a Composio sign-in runs.
  @Published private(set) var connect: ConnectSession?
  @Published var keyText = "" {
    didSet { flow.key.edit(keyText) }
  }
  @Published var serverText = "" {
    didSet { flow.serverText = serverText }
  }

  let client: BrainClient
  let store: SecretStore
  var onOpenReview: ((String) -> Void)?
  var onOpenURL: ((URL) -> Void)?
  var onClose: (() -> Void)?

  init(detail: ConnectionDetail, client: BrainClient, store: SecretStore) {
    flow = ConnectionSheetFlow(detail: detail)
    self.client = client
    self.store = store
  }

  func choose(_ n: Int) { flow.chooseNumber(n) }
  func primary() {
    if let c = connect { c.primary(); return }
    run(flow.primary())
  }
  func back() {
    if let c = connect { c.cancel(); return }
    run(flow.back())
  }

  /// Snapshots: put the sheet in a state without a brain.
  func preview(_ change: (inout ConnectionSheetFlow) -> Void) { change(&flow) }

  private var id: String { flow.detail.row.id }

  private func run(_ effects: [ConnectionSheetFlow.Effect]) {
    for e in effects {
      switch e {
      case .signIn(let connector):
        let s = ConnectSession(connector: connector, returnsToConfirm: false, client: client)
        s.onOpenURL = { [weak self] u in self?.onOpenURL?(u) }
        s.onConnected = { [weak self] _ in self?.flow.signedIn() }
        s.onClose = { [weak self] in self?.connect = nil }
        connect = s
        s.primary()
      case .saveKey:
        // The value leaves the field here, once: into the Keychain, never into a request.
        guard let value = flow.key.take() else { return }
        keyText = ""
        let detail = flow.detail
        Task { [weak self] in
          guard let self else { return }
          do {
            let d = try await ConnectionKeySaver.save(value, detail: detail, store: self.store, client: self.client)
            self.flow.saved(d)
            self.run([.test])
          } catch SecretStoreError.invalid(let m) {
            self.flow.failed(m)
          } catch SecretStoreError.failed(let m) {
            self.flow.failed(m)
          } catch {
            self.flow.failed(BrainError.message(for: error))
          }
        }
      case .addServer(let setup):
        Task { [weak self] in
          guard let self else { return }
          do {
            let d = try await self.client.setupConnection(id: self.id, setup)
            if let t = d.lastTest { self.flow.tested(t) } else { self.run([.test]) }
          } catch {
            self.flow.failed(BrainError.message(for: error))
          }
        }
      case .test:
        Task { [weak self] in
          guard let self else { return }
          do { self.flow.tested(try await self.client.testConnection(id: self.id)) } catch { self.flow.failed(BrainError.message(for: error)) }
        }
      case .build:
        Task { [weak self] in
          guard let self else { return }
          do { self.flow.built(try await self.client.buildWorkflow(connectionId: self.id)) } catch { self.flow.failed(BrainError.message(for: error)) }
        }
      case .openReview(let wf):
        onOpenReview?(wf)
        onClose?()
      case .close:
        onClose?()
      }
    }
  }
}

// MARK: views

struct ConnectionsView: View {
  @ObservedObject var model: ConnectionsModel
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot
  @FocusState private var searchFocused: Bool

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: 0) {
      searchField(p)
        .padding(.horizontal, Tokens.Space.s24)
        .padding(.top, Tokens.Space.s20)
      Text(model.page.map(ConnectionsCopy.universeLine) ?? " ")
        .textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
        .padding(.horizontal, Tokens.Space.s24 + Tokens.Space.s4)
        .padding(.top, Tokens.Space.s8)
      if let e = model.error {
        Text(e).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.statusInk(.needsYou))
          .padding(.horizontal, Tokens.Space.s24).padding(.top, Tokens.Space.s8)
      }
      Group {
        if isSnapshot { rowList(p); Spacer(minLength: 0) } else { ScrollView { rowList(p) } }
      }
      Divider().opacity(0.5)
      HStack(spacing: Tokens.Space.s12) {
        hint("↑↓", "move")
        hint("↩", "open")
        hint("esc", model.list.query.isEmpty ? "close" : "clear")
        Spacer()
        Text(ConnectionsCopy.nothingSent).textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3).lineLimit(1)
      }
      .padding(.horizontal, Tokens.Space.s24)
      .padding(.vertical, Tokens.Space.s12)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .attachedSheet(model.sheet != nil) {
      if let s = model.sheet { ConnectionSheetView(model: s) }
    }
    .onChange(of: model.focusSearch) { _, on in
      if on { searchFocused = true; model.focusSearch = false }
    }
  }

  private func rowList(_ p: Palette) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s4) {
      let rows = model.list.rows
      if rows.isEmpty, model.page != nil {
        Text(ConnectionsCopy.empty).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink3).padding(.top, Tokens.Space.s24)
      }
      ForEach(Array(rows.enumerated()), id: \.element.id) { i, r in
        ConnectionRowView(row: r, selected: i == model.list.selected)
          .onTapGesture {
            model.select(r.id)
            model.handle(.open)
          }
      }
    }
    .padding(.horizontal, Tokens.Space.s16)
    .padding(.vertical, Tokens.Space.s12)
  }

  private func searchField(_ p: Palette) -> some View {
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.row, style: .continuous)
    return HStack(spacing: Tokens.Space.s8) {
      Image(systemName: "magnifyingglass").symbolStyle(Tokens.TypeScale.Symbol.regular).foregroundStyle(p.ink3)
      if isSnapshot {
        Text(model.searchText.isEmpty ? ConnectionsCopy.searchPlaceholder : model.searchText).textStyle(Tokens.TypeScale.body)
          .foregroundStyle(model.searchText.isEmpty ? p.ink3 : p.ink1).frame(maxWidth: .infinity, alignment: .leading)
      } else {
        TextField(ConnectionsCopy.searchPlaceholder, text: $model.searchText)
          .textFieldStyle(.plain)
          .textStyle(Tokens.TypeScale.body)
          .foregroundStyle(p.ink1)
          .focused($searchFocused)
      }
      Keycap(label: "⌘F")
    }
    .padding(.horizontal, Tokens.Space.s12)
    .frame(height: Tokens.Size.control + Tokens.Space.s4)
    .background(shape.fill(p.isDark ? p.fill : .white.opacity(0.8)))
    .overlay(shape.strokeBorder(searchFocused ? p.ringStrong : p.ring, lineWidth: 1))
  }

  private func hint(_ key: String, _ label: String) -> some View {
    let p = Palette(scheme: scheme)
    return HStack(spacing: Tokens.Space.s4) {
      Keycap(label: key)
      Text(label).textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
    }
  }
}

struct ConnectionRowView: View {
  var row: ConnectionRow
  var selected: Bool
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.row, style: .continuous)
    HStack(alignment: .center, spacing: Tokens.Space.s12) {
      StatusDot(role: row.status.role).frame(width: Tokens.Space.s16)
      VStack(alignment: .leading, spacing: Tokens.Space.nudge) {
        Text(row.name).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
        Text(row.statusLine).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3).lineLimit(1)
      }
      Spacer(minLength: Tokens.Space.s8)
      if row.verified {
        Chip(text: ConnectionsCopy.verifiedChip, style: .neutral)
      } else if row.reads + row.commits > 0 {
        Text(ConnectionsCopy.rowCounts(row)).textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
      }
      Text(row.status.label).textStyle(Tokens.TypeScale.calloutEmphasis).foregroundStyle(row.status == .notSetUp ? p.ink3 : p.statusInk(row.status.role))
        .frame(width: 76, alignment: .trailing)
    }
    .padding(.horizontal, Tokens.Space.s12)
    .frame(height: Tokens.Size.row + Tokens.Space.s12)
    .background(shape.fill(selected ? p.fillStrong : .clear))
    .overlay(shape.strokeBorder(selected ? p.ringStrong : .clear, lineWidth: 1))
    .contentShape(shape)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(row.name), \(row.status.label)")
    .accessibilityAddTraits(.isButton)
  }
}

struct ConnectionSheetView: View {
  @ObservedObject var model: ConnectionSheetModel
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot
  @FocusState private var fieldFocused: Bool

  var body: some View {
    if let c = model.connect {
      ConnectSheet(session: c)
    } else {
      content
    }
  }

  private var content: some View {
    let p = Palette(scheme: scheme)
    let f = model.flow
    return VStack(alignment: .leading, spacing: 0) {
      header(f, p)
      middle(f, p)
      statusBox(f, p)
      footer(f, p)
    }
    .padding(Tokens.Space.s24)
    .frame(width: Tokens.Layout.connectSheet, alignment: .leading)
    .background(p.sheetFill)
    .animation(isSnapshot ? nil : Motion.outExpo(Tokens.Duration.base), value: f.phase)
    .onAppear { fieldFocused = Self.entering(f.phase) }
    .onChange(of: f.phase) { _, ph in fieldFocused = Self.entering(ph) }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Set up \(f.name)")
  }

  private static func entering(_ ph: ConnectionSheetFlow.Phase) -> Bool { ph == .enterKey || ph == .enterServer }

  @ViewBuilder
  private func header(_ f: ConnectionSheetFlow, _ p: Palette) -> some View {
    HStack(alignment: .center, spacing: Tokens.Space.s12) {
      StatusDot(role: f.detail.row.status.role).frame(width: Tokens.Space.s16)
      VStack(alignment: .leading, spacing: Tokens.Space.nudge) {
        Text("Set up \(f.name)").textStyle(Tokens.TypeScale.sheetTitle).foregroundStyle(p.ink1)
        Text(f.detail.row.verified ? ConnectionsCopy.verifiedChip : "Every action is shown to you field by field before it runs.")
          .textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
      }
    }
    if !f.detail.sampleCommit.isEmpty {
      Text("Offload can use: \(f.detail.sampleCommit.prefix(3).joined(separator: ", ")).")
        .paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, Tokens.Space.s12)
    }
  }

  @ViewBuilder
  private func middle(_ f: ConnectionSheetFlow, _ p: Palette) -> some View {
    switch f.phase {
    case .enterKey:
      keyEntry(f, p)
    case .enterServer:
      serverEntry(f, p)
    case .choose, .ready:
      methodList(f, p)
    default:
      EmptyView()
    }
  }

  @ViewBuilder
  private func methodList(_ f: ConnectionSheetFlow, _ p: Palette) -> some View {
    VStack(spacing: Tokens.Space.s4) {
      ForEach(Array(f.detail.methods.enumerated()), id: \.offset) { i, m in
        OptionRow(number: i + 1, title: m.title, recommended: m.recommended, state: m.method == f.method ? .chosen : .idle)
          .onTapGesture { model.choose(i + 1) }
      }
    }
    .padding(.top, Tokens.Space.s16)
    if let info = f.methodInfo, f.phase == .choose { steps(info, p) }
  }

  @ViewBuilder
  private func keyEntry(_ f: ConnectionSheetFlow, _ p: Palette) -> some View {
    field(p) {
      if isSnapshot {
        Text(model.keyText.isEmpty ? ConnectionsCopy.keyPlaceholder : String(repeating: "•", count: min(model.keyText.count, 32)))
          .foregroundStyle(model.keyText.isEmpty ? p.ink3 : p.ink1).frame(maxWidth: .infinity, alignment: .leading)
      } else {
        SecureField(ConnectionsCopy.keyPlaceholder, text: $model.keyText).textFieldStyle(.plain).focused($fieldFocused)
      }
    }
    let problem: String? = model.keyText.isEmpty ? nil : f.key.problem
    Text(problem ?? "Saved straight into your Mac's Keychain. Offload never shows it again.")
      .paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(problem == nil ? p.ink3 : p.statusInk(.needsYou))
      .padding(.top, Tokens.Space.s8)
  }

  @ViewBuilder
  private func serverEntry(_ f: ConnectionSheetFlow, _ p: Palette) -> some View {
    field(p) {
      if isSnapshot {
        Text(model.serverText.isEmpty ? ConnectionsCopy.serverPlaceholder : model.serverText)
          .foregroundStyle(model.serverText.isEmpty ? p.ink3 : p.ink1).frame(maxWidth: .infinity, alignment: .leading)
      } else {
        TextField(ConnectionsCopy.serverPlaceholder, text: $model.serverText).textFieldStyle(.plain).focused($fieldFocused)
      }
    }
    let problem = f.serverProblem
    Text(problem ?? "Offload lists what the server offers and calls nothing.")
      .paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(problem == nil ? p.ink3 : p.statusInk(.needsYou))
      .padding(.top, Tokens.Space.s8)
  }

  @ViewBuilder
  private func footer(_ f: ConnectionSheetFlow, _ p: Palette) -> some View {
    if case .built(let b) = f.phase, let missing = ConnectionsCopy.missingLine(b) {
      Text(missing).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3).padding(.top, Tokens.Space.s8)
    }
    HStack(spacing: Tokens.Space.s8) {
      Spacer()
      SecondaryButton(title: Self.entering(f.phase) ? "Back" : "Close", key: "esc") { model.back() }
      if let t = f.primaryTitle {
        PrimaryButton(title: t, key: "⌘↩") { model.primary() }.disabled(!f.primaryEnabled)
      }
    }
    .padding(.top, Tokens.Space.s20)
  }

  private func steps(_ info: ConnectionMethodInfo, _ p: Palette) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s4) {
      Text(info.detail).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2).fixedSize(horizontal: false, vertical: true)
      ForEach(Array(info.steps.enumerated()), id: \.offset) { i, s in
        Text("\(i + 1). \(s)").paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3).fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.top, Tokens.Space.s12)
  }

  private func field<F: View>(_ p: Palette, @ViewBuilder _ f: () -> F) -> some View {
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.row, style: .continuous)
    return HStack(spacing: Tokens.Space.s8) {
      Image(systemName: model.flow.phase == .enterKey ? "lock" : "server.rack").symbolStyle(Tokens.TypeScale.Symbol.regular).foregroundStyle(p.ink3)
      f().textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
    }
    .padding(.horizontal, Tokens.Space.s12)
    .frame(height: Tokens.Size.control + Tokens.Space.s4)
    .background(shape.fill(p.isDark ? p.fill : .white))
    .overlay(shape.strokeBorder(p.ringStrong, lineWidth: 1))
    .padding(.top, Tokens.Space.s16)
  }

  @ViewBuilder
  private func statusBox(_ f: ConnectionSheetFlow, _ p: Palette) -> some View {
    let line: String? = {
      if case .working(let w) = f.phase { return w }
      return f.status
    }()
    if let line {
      RingBox {
        HStack(alignment: .center, spacing: Tokens.Space.s12) {
          switch f.phase {
          case .working: Spinner(role: .working)
          case .failed: StatusDot(role: .needsYou).frame(width: Tokens.Space.s16, height: Tokens.Space.s16)
          case .ready, .built: StatusDot(role: .done).frame(width: Tokens.Space.s16, height: Tokens.Space.s16)
          default: StatusDot(role: f.detail.row.status.role).frame(width: Tokens.Space.s16, height: Tokens.Space.s16)
          }
          Text(line).paragraphStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1).fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, Tokens.Space.s16)
        .padding(.vertical, Tokens.Space.s12)
      }
      .padding(.top, Tokens.Space.s16)
    }
  }
}

// MARK: window

final class ConnectionsWindowController: TitledWindowController {
  let model: ConnectionsModel

  init(model: ConnectionsModel) {
    self.model = model
    super.init(title: ConnectionsCopy.title, subtitle: ConnectionsCopy.subtitle, size: NSSize(width: 760, height: 640),
               minSize: NSSize(width: 620, height: 460), autosave: "OffloadConnections")
    let host = NSHostingView(rootView: ConnectionsView(model: model))
    host.sceneBridgingOptions = []
    window.contentView = host
  }

  override func handleKey(_ e: NSEvent) -> Bool {
    guard owns(e) else { return false }
    let cmd = e.modifierFlags.contains(.command)
    if let s = model.sheet {
      if e.keyCode == ReviewKey.escapeKeyCode { s.back(); return true }
      if ReviewKey.returnKeyCodes.contains(e.keyCode), cmd || (s.flow.phase != .enterKey && s.flow.phase != .enterServer) { s.primary(); return true }
      if !cmd, s.flow.phase == .choose || s.flow.phase == .ready, let c = e.charactersIgnoringModifiers, let n = Int(c), (1...3).contains(n) {
        s.choose(n)
        return true
      }
      return false
    }
    if cmd, e.charactersIgnoringModifiers?.lowercased() == "f" { model.handle(.find); return true }
    switch e.keyCode {
    case 126: model.handle(.up); return true
    case 125: model.handle(.down); return true
    case ReviewKey.escapeKeyCode: model.handle(.escape); return true
    default:
      if ReviewKey.returnKeyCodes.contains(e.keyCode) { model.handle(.open); return true }
      return false
    }
  }
}
