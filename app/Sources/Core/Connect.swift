import Foundation

// s10e (DESIGN-REVIEW-3 M1): connecting a tool from inside Offload. The brain does the hand-off (POST/GET
// /connectors/:id/link: Composio's browser sign-in, or a deterministic simulation with the offline sample model);
// the app shows one sheet that walks intro → waiting → connected. Connecting never approves or sends anything: the
// only effects this flow can produce are a link call, a poll, opening a browser URL and "connected".

enum ConnectVia: String, Codable, Equatable, Sendable {
  case composio
  case gmailMCP = "gmail-mcp"
}

/// s10e (operator scope): how a connector is reached, for any tool in any domain. mcp and composio work today; api and
/// computer are declared so the brain can offer them later (s13 adds the auto-fallback chain and computer use).
enum ConnectMethod: String, Codable, Equatable, Sendable, CaseIterable {
  case mcp, composio, api, computer

  /// Plain words (no internal names): how the sheet says it connects.
  var route: String {
    switch self {
    case .mcp: return "Through a connector on this Mac"
    case .composio: return "Through Composio"
    case .api: return "Through the app's own sign-in"
    case .computer: return "By using the app on screen, the way you do"
    }
  }

  /// The button that tries this method after another one failed.
  var tryTitle: String {
    switch self {
    case .mcp: return "Use a connector on this Mac instead"
    case .composio: return "Use Composio instead"
    case .api: return "Use the app's own sign-in instead"
    case .computer: return "Use the app on screen instead"
    }
  }
}

enum ConnectLinkState: String, Codable, Equatable, Sendable {
  case idle, waiting, connected, failed
}

/// One answer from the brain's link route.
struct ConnectLink: Equatable, Sendable {
  var connectorId: String
  var name: String
  var via: ConnectVia
  var state: ConnectLinkState
  /// The browser hand-off. nil for a simulated link and for a sign-in that opens its own window.
  var url: URL?
  /// The offline sample model's demo sign-in: no browser, no account, nothing can be sent through it.
  var simulated: Bool
  /// The brain's sentence for a person, shown as sent.
  var message: String
  var startedAt: Date?
  var connectedAt: Date?
  /// s10e: the method this link uses, every method the connector can use (in order), and the one to offer next when
  /// this one failed. `detail` is the brain's plain sentence about the method's state.
  var method: ConnectMethod? = nil
  var methods: [ConnectMethod] = []
  var next: ConnectMethod? = nil
  var detail: String = ""
}

/// Wire mirror of the brain's ConnectLinkDTO (brain/src/api/types.ts).
struct ConnectLinkDTO: Codable, Equatable {
  var connectorId: String
  var name: String
  var via: String
  var state: String
  var url: String?
  var simulated: Bool
  var message: String
  var startedAt: Double?
  var connectedAt: Double?
  var method: String? = nil
  var methods: [String]? = nil
  var next: String? = nil
  var detail: String? = nil

  func toLink() -> ConnectLink {
    ConnectLink(connectorId: connectorId, name: name, via: ConnectVia(rawValue: via) ?? .composio,
                state: ConnectLinkState(rawValue: state) ?? .failed,
                url: url.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil },
                simulated: simulated, message: message,
                startedAt: startedAt.map(BrainWire.date(ms:)), connectedAt: connectedAt.map(BrainWire.date(ms:)),
                method: method.flatMap(ConnectMethod.init(rawValue:)) ?? (via == "gmail-mcp" ? .mcp : .composio),
                methods: (methods ?? []).compactMap(ConnectMethod.init(rawValue:)),
                next: next.flatMap(ConnectMethod.init(rawValue:)), detail: detail ?? "")
  }
}

/// The connect sheet's state machine. Pure; time is passed in.
struct ConnectFlow: Equatable, Sendable {
  enum Phase: Equatable, Sendable { case intro, starting, waiting, connected, failed }
  enum Effect: Equatable, Sendable {
    /// POST /connectors/:id/link.
    case startLink
    /// GET /connectors/:id/link again in `pollInterval`.
    case poll
    /// Open the sign-in page in the browser (only for a real, non-simulated https URL, once).
    case openURL(URL)
    /// Done: refresh connector states and go back to where the sheet came from.
    case connected
  }

  static let pollInterval: Double = 1
  /// Waiting longer than this gives up with a plain sentence; Try again starts over.
  static let giveUp: Double = 300

  let connector: Connector
  private(set) var phase: Phase
  private(set) var link: ConnectLink?
  private(set) var failure: String?
  private(set) var waitingSince: Date?
  /// s10e: the method the next start asks for (nil = the brain's first choice).
  private(set) var requestedMethod: ConnectMethod?
  private var opened = false

  init(connector: Connector) {
    self.connector = connector
    phase = connector.state == .connected ? .connected : .intro
  }

  /// The primary: Connect (or Try again).
  mutating func connect(at now: Date) -> [Effect] {
    switch phase {
    case .intro, .failed:
      phase = .starting
      failure = nil
      waitingSince = nil
      opened = false
      return [.startLink]
    case .connected:
      return [.connected]
    case .starting, .waiting:
      return []
    }
  }

  /// An answer from the brain (the start call or a poll).
  mutating func receive(_ l: ConnectLink, at now: Date) -> [Effect] {
    guard phase == .starting || phase == .waiting else { return [] }
    link = l
    switch l.state {
    case .connected:
      phase = .connected
      return [.connected]
    case .failed:
      phase = .failed
      failure = l.message.isEmpty ? ConnectCopy.didNotStart : l.message
      return []
    case .waiting, .idle:
      phase = .waiting
      if waitingSince == nil { waitingSince = now }
      var out: [Effect] = []
      if let url = l.url, !l.simulated, !opened {
        opened = true
        out.append(.openURL(url))
      }
      out.append(.poll)
      return out
    }
  }

  /// s10e: after a failure, try the method the brain offered next ("Use Composio instead").
  mutating func tryNext(at now: Date) -> [Effect] {
    guard phase == .failed, let n = link?.next else { return connect(at: now) }
    requestedMethod = n
    return connect(at: now)
  }

  /// The method in use (or about to be), for the sheet's route line.
  var method: ConnectMethod? { requestedMethod ?? link?.method }

  /// The brain could not be reached or refused.
  mutating func fail(_ message: String) {
    guard phase == .starting || phase == .waiting else { return }
    phase = .failed
    failure = message
  }

  /// Called on the poll timer.
  mutating func tick(at now: Date) -> [Effect] {
    guard phase == .waiting else { return [] }
    if let since = waitingSince, now.timeIntervalSince(since) >= Self.giveUp {
      phase = .failed
      failure = ConnectCopy.gaveUp(connector.name)
      return []
    }
    return [.poll]
  }

  /// Esc: stop waiting (the brain's link stays where it is; nothing was changed by us).
  mutating func cancel() {
    if phase != .connected { phase = .intro }
  }
}

/// Every string the connect sheet shows.
struct ConnectCopy: Equatable, Sendable {
  var title: String
  var symbol: String
  var purpose: String
  var route: String
  /// The one white button; nil while waiting (only Cancel then).
  var primary: String?
  /// The state line: waiting, connected or failed.
  var status: String?
  var note: String?

  static let didNotStart = "The sign-in did not start. Nothing was changed."
  static func gaveUp(_ name: String) -> String {
    "Still waiting for \(name) after 5 minutes, so Offload stopped checking. Nothing was changed."
  }

  init(flow: ConnectFlow, returnsToConfirm: Bool) {
    let c = flow.connector
    let signIn = c.state == .missingEnv
    let verb = signIn ? "Sign in to \(c.name)" : "Connect \(c.name)"
    title = verb
    symbol = Self.symbol(c.id)
    purpose = Self.purpose(c)
    // s10e: the method in use, in plain words; before the brain has said, from how the connector is reached.
    if let m = flow.method {
      route = m.route
    } else {
      route = Self.via(for: c, link: flow.link) == .composio ? "Connects through Composio" : "Signs in with Google on this Mac"
    }
    note = nil
    switch flow.phase {
    case .intro:
      primary = verb
      status = nil
      note = "Connecting sends nothing. You still approve every batch."
    case .starting:
      primary = nil
      status = "Starting the sign-in…"
    case .waiting:
      primary = nil
      if let l = flow.link, l.simulated, !l.message.isEmpty { status = l.message } else { status = "Finish in your browser." }
      note = flow.link?.simulated == true ? nil : "Offload checks every second and carries on by itself."
    case .connected:
      primary = returnsToConfirm ? "Back to Turn on" : "Done"
      status = "\(c.name) connected"
    case .failed:
      // s10e: when the brain offers another way, that is the one white button ("Use Composio instead").
      primary = flow.link?.next?.tryTitle ?? "Try again"
      let detail = flow.link?.detail ?? ""
      status = detail.isEmpty ? (flow.failure ?? Self.didNotStart) : detail
      if flow.link?.next != nil { note = "Nothing was changed. The other way asks you to sign in once." }
    }
  }

  var allStrings: [String] { [title, purpose, route, primary ?? "", status ?? "", note ?? ""] }

  /// How the connector is reached: what the brain said, else the connector's kind.
  static func via(for c: Connector, link: ConnectLink? = nil) -> ConnectVia {
    if let l = link { return l.via }
    switch c.kind {
    case .mcp: return .gmailMCP
    case .composio, .calendar, .localScript: return .composio
    }
  }

  static func symbol(_ id: String) -> String {
    switch id {
    case "gmail": return "envelope"
    case "google-sheets", "gsheets": return "tablecells"
    case "google-calendar", "gcal": return "calendar"
    case "slack": return "bubble.left.and.bubble.right"
    case "hubspot", "attio": return "person.2"
    case "notion": return "doc.text"
    default: return "link"
    }
  }

  /// One line on what Offload reads and sends with it.
  static func purpose(_ c: Connector) -> String {
    switch c.id {
    case "gmail":
      return "Offload reads your sent mail to write in your voice, and sends only the batches you approve."
    case "google-sheets", "gsheets":
      return "Offload reads your investor list and adds one row for each email you approved."
    case "google-calendar", "gcal":
      return "Offload reads when you are free to offer times. It never books anything without you."
    case "hubspot", "attio":
      return "Offload adds notes from replies to \(c.name). You approve each batch first."
    default:
      return "Offload uses \(c.name) only in the steps you approve."
    }
  }
}

/// s10e: the mock brain's link simulation (snapshots, --mock, tests): waiting, then connected after `delay` seconds.
enum MockLinks {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var started: [String: Date] = [:]
  nonisolated(unsafe) private static var done: Set<String> = []
  nonisolated(unsafe) static var delay: Double = 1.5

  static func reset() {
    lock.lock(); defer { lock.unlock() }
    started = [:]
    done = []
  }

  static func start(_ id: String, now: Date = Date()) {
    lock.lock(); defer { lock.unlock() }
    if started[id] == nil { started[id] = now }
  }

  /// True once the simulated sign-in has finished.
  static func poll(_ id: String, now: Date = Date()) -> Bool {
    lock.lock(); defer { lock.unlock() }
    if done.contains(id) { return true }
    guard let s = started[id], now.timeIntervalSince(s) >= delay else { return false }
    done.insert(id)
    return true
  }

  static var connected: Set<String> {
    lock.lock(); defer { lock.unlock() }
    return done
  }
}
