import Foundation

// s10e (DESIGN-REVIEW-3 M1): connecting a tool from inside Offload. The brain does the hand-off (POST/GET
// /connectors/:id/link: Composio's browser sign-in, or a deterministic simulation with the offline sample model);
// the app shows one sheet that walks intro → waiting → connected. Connecting never approves or sends anything: the
// only effects this flow can produce are a link call, a poll, opening a browser URL and "connected".

enum ConnectVia: String, Codable, Equatable, Sendable {
  case composio
  case gmailMCP = "gmail-mcp"
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

  func toLink() -> ConnectLink {
    ConnectLink(connectorId: connectorId, name: name, via: ConnectVia(rawValue: via) ?? .composio,
                state: ConnectLinkState(rawValue: state) ?? .failed,
                url: url.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil },
                simulated: simulated, message: message,
                startedAt: startedAt.map(BrainWire.date(ms:)), connectedAt: connectedAt.map(BrainWire.date(ms:)))
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
    route = Self.via(for: c, link: flow.link) == .composio ? "Connects through Composio" : "Signs in with Google on this Mac"
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
      primary = "Try again"
      status = flow.failure ?? Self.didNotStart
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
