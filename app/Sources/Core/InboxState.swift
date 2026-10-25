import Foundation

/// A key the insight card understands. Everything else falls through to the system.
enum CardKey: Equatable, Sendable {
  case option(Int)  // 1, 2, 3
  case next         // J
  case previous     // K
  case dismiss      // E
  case escape       // Esc

  /// Maps a keyDown. Command/Control chords are never ours, so ⌘W, ⌃K and friends keep working.
  init?(characters: String, keyCode: UInt16, hasCommandOrControl: Bool) {
    if hasCommandOrControl { return nil }
    if keyCode == 53 { self = .escape; return }
    switch characters.lowercased() {
    case "1", "2", "3", "4", "5", "6", "7", "8", "9", "0": self = .option(Int(characters)!)
    case "j": self = .next
    case "k": self = .previous
    case "e": self = .dismiss
    case "\u{1b}": self = .escape
    default: return nil
    }
  }
}

/// A choice that waits for the undo window before it lands.
enum PendingAction: Equatable, Sendable {
  case build(String)   // insight id → POST /workflows/draft
  case notNow(String)  // snooze
  case dismiss(String) // E

  var insightId: String {
    switch self { case .build(let id), .notNow(let id), .dismiss(let id): return id }
  }
}

/// Reversible by default: an action waits `duration` seconds and Esc takes it back.
struct UndoWindow: Equatable, Sendable {
  var action: PendingAction
  var startedAt: Date
  var duration: Double = Tokens.undoSeconds

  func elapsed(at now: Date) -> Double { max(0, now.timeIntervalSince(startedAt)) }
  func isExpired(at now: Date) -> Bool { elapsed(at: now) >= duration }
  func fractionRemaining(at now: Date) -> Double { max(0, min(1, 1 - elapsed(at: now) / duration)) }
  var deadline: Date { startedAt.addingTimeInterval(duration) }

  /// Rounds up: shows "1s" right until it lands, never "0s" while still undoable.
  func secondsLeftLabel(at now: Date) -> String {
    let left = max(0, duration - elapsed(at: now))
    return "\(Int(left.rounded(.up)))s"
  }
}

enum CardEffect: Equatable, Sendable {
  case staged(PendingAction)
  case undone(PendingAction)
  case committed(PendingAction)
  case showEvidence(String)
  case hideEvidence
  case moved(to: Int)
  case becameEmpty
  case close
}

/// The card's keyboard state machine. Pure value type, time is passed in, so it is fully testable.
///
/// 1 Build the workflow (staged) · 2 Show the evidence (toggle) · 3 Not now (staged) · E dismiss (staged)
/// J/K next/previous · Esc peels one layer: undo, then evidence, then the card.
/// A new choice while one is staged lands the staged one first, so nothing is lost silently.
struct InboxState: Equatable, Sendable {
  private(set) var insights: [Insight]
  private(set) var index: Int = 0
  private(set) var evidenceOpen = false
  private(set) var pending: UndoWindow?
  private(set) var committed: [PendingAction] = []

  init(insights: [Insight]) { self.insights = insights }

  var current: Insight? { insights.indices.contains(index) ? insights[index] : nil }
  var isEmpty: Bool { insights.isEmpty }
  var positionLabel: String { isEmpty ? "" : "\(index + 1) of \(insights.count)" }

  /// The insight a staged action is about (it stays on screen during the window).
  var pendingInsight: Insight? {
    guard let id = pending?.action.insightId else { return nil }
    return insights.first { $0.id == id }
  }

  mutating func replaceInsights(_ new: [Insight]) {
    let keep = current?.id
    insights = new
    index = keep.flatMap { id in new.firstIndex { $0.id == id } } ?? min(index, max(0, new.count - 1))
  }

  /// Lands an expired staged action. Call on a timer.
  mutating func tick(at now: Date) -> [CardEffect] {
    guard let p = pending, p.isExpired(at: now) else { return [] }
    return land()
  }

  mutating func handle(_ key: CardKey, at now: Date) -> [CardEffect] {
    var effects: [CardEffect] = []

    if let p = pending {
      if key == .escape && !p.isExpired(at: now) {
        pending = nil
        return [.undone(p.action)]
      }
      effects += land()
    }

    switch key {
    case .escape:
      if evidenceOpen { evidenceOpen = false; effects.append(.hideEvidence) }
      else { effects.append(.close) }

    case .option(let n):
      guard let insight = current else { break }
      switch n {
      case 1: effects.append(stage(.build(insight.id), at: now))
      case 2:
        evidenceOpen.toggle()
        effects.append(evidenceOpen ? .showEvidence(insight.id) : .hideEvidence)
      case 3: effects.append(stage(.notNow(insight.id), at: now))
      default: break
      }

    case .dismiss:
      guard let insight = current else { break }
      effects.append(stage(.dismiss(insight.id), at: now))

    case .next, .previous:
      let target = index + (key == .next ? 1 : -1)
      guard insights.indices.contains(target) else { break }
      index = target
      evidenceOpen = false
      effects.append(.moved(to: target))
    }
    return effects
  }

  private mutating func stage(_ action: PendingAction, at now: Date) -> CardEffect {
    pending = UndoWindow(action: action, startedAt: now)
    return .staged(action)
  }

  private mutating func land() -> [CardEffect] {
    guard let p = pending else { return [] }
    pending = nil
    committed.append(p.action)
    if let i = insights.firstIndex(where: { $0.id == p.action.insightId }) {
      insights.remove(at: i)
      if i < index { index -= 1 }
      index = min(index, max(0, insights.count - 1))
      evidenceOpen = false
    }
    var out: [CardEffect] = [.committed(p.action)]
    if insights.isEmpty { out.append(.becameEmpty) }
    return out
  }
}

/// What the rail shows. Built from /status + /dashboard automations.
struct RailDot: Equatable, Identifiable, Sendable {
  var id: String
  var role: StatusRole
  var pulses: Bool
}

struct RailModel: Equatable, Sendable {
  static let maxDots = 5

  var inboxBadge: String?
  var inboxNeedsYou: Bool
  var dots: [RailDot]
  var overflowCount: Int
  var observerLabel: String
  var observerPaused: Bool
  var micRole: StatusRole

  init(status: ObserverStatus, automations: [Automation], micRecording: Bool) {
    inboxBadge = Self.badgeLabel(status.insightsWaiting)
    inboxNeedsYou = status.insightsWaiting > 0
    let observerRole = StatusRole.forObserver(status.state)
    var all = [RailDot(id: "observer", role: observerRole, pulses: observerRole.pulses(context: .observer))]
    all += automations.filter(\.isActive).map {
      let role = StatusRole.forAutomation($0.status)
      return RailDot(id: $0.id, role: role, pulses: role.pulses(context: .automation))
    }
    dots = Array(all.prefix(Self.maxDots))
    overflowCount = max(0, all.count - Self.maxDots)
    let day = min(status.daysStored, status.windowDays)
    let word: String = {
      switch status.state {
      case .watching: return "Watching"
      case .paused: return "Paused"
      case .stale: return "Not recording"
      case .noData: return "No data yet"
      }
    }()
    observerLabel = status.state == .noData ? word : "\(word) · Day \(day) of \(status.windowDays)"
    observerPaused = status.state == .paused
    micRole = StatusRole.forMic(recording: micRecording)
  }

  static func badgeLabel(_ n: Int) -> String? {
    if n <= 0 { return nil }
    return n > 9 ? "9+" : String(n)
  }
}
