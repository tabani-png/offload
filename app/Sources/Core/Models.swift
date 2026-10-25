import Foundation

// View models the rail and card render. The wire shapes (a 1:1 mirror of brain/src/api/types.ts) live in
// BrainWire.swift and map onto these. Every number here comes from the brain's deterministic code (ADR 0005);
// the app only formats it.

/// GET /status
struct ObserverStatus: Codable, Equatable, Sendable {
  var state: ObserverState
  var daysStored: Int
  var windowDays: Int
  var nextPurge: Date?
  var insightsWaiting: Int
}

enum ObserverState: String, Codable, CaseIterable, Sendable {
  case watching  // wire "recording"
  case paused
  case stale     // no event for a while: the observer may have stopped
  case noData    // wire "no_data"
}

/// One item of GET /insights.
struct Insight: Codable, Equatable, Identifiable, Sendable {
  var id: String
  /// Stable task kind, e.g. "outreach".
  var kind: String
  /// Lower-case task phrase that completes "You spent 65% of your week on ___".
  var taskPhrase: String
  /// Plural noun for one instance, e.g. "emails".
  var unitPlural: String
  /// Share of tracked active time, 0...1.
  var timeShare: Double
  var instanceCount: Int
  var medianMinutes: Double
  var taskHours: Double
  var trackedHours: Double
  /// How alike the instances are, 0...1.
  var sameness: Double
  var saving: SavingEstimate
  var connectors: [Connector]
  var evidenceIds: [String]
  /// s10a: the brain's own display strings ("64.5%", "3.0 min"), shown as sent so no screen re-rounds them.
  var shareDisplay: String? = nil
  var medianDisplay: String? = nil
}

/// Weekly hours now − review time = hours saved, shown as a range (plan/CONTEXT.md, brain SavingDTO).
struct SavingEstimate: Codable, Equatable, Sendable {
  /// Saved share of the task's current time, 0...1 (brain `savingPct`).
  var savingPct: Double
  var reviewMinutesPerInstance: Double
  var hoursPerWeekLow: Double
  var hoursPerWeekHigh: Double
  /// The brain's own arithmetic line, shown verbatim when present (never recomputed by the app).
  var arithmetic: String? = nil
  /// The brain's point estimate (`weeklyHoursSaved`). s10a: the one saving every screen shows.
  var hoursPerWeek: Double? = nil
}

struct Connector: Codable, Equatable, Identifiable, Sendable {
  var id: String
  var name: String
  var kind: ConnectorKind
  var connected: Bool
  /// GET /connectors `missing_env`: a server lists it but an env var it names is unset (s08).
  var missingEnv: Bool = false
}

enum ConnectorKind: String, Codable, Sendable {
  case mcp, composio, localScript, calendar
}

/// One item of GET /insights/:id/evidence.
struct EvidenceSpan: Codable, Equatable, Identifiable, Sendable {
  var id: String
  var start: Date
  var end: Date
  var activeMinutes: Double
  var app: String
  var title: String
  var urlHost: String?
  /// Raw event ids behind this span, so every figure traces to rows.
  var eventIds: [String]
  /// Who the work was for (recipient, attendee), from the instance's counterparties. Shown first (s08).
  var counterparty: String? = nil
}

/// One item of GET /dashboard automations (only what the rail needs today; s08 extends it).
struct Automation: Codable, Equatable, Identifiable, Sendable {
  var id: String
  var name: String
  var status: AutomationStatus
  var hoursSavedEstimated: Double
  var hoursSavedMeasured: Double?

  var isActive: Bool { status != .done }
}

enum AutomationStatus: String, Codable, CaseIterable, Sendable {
  case draft, awaitingApproval, running, paused, done, failed
}

enum BrainJSON {
  static var encoder: JSONEncoder {
    let e = JSONEncoder()
    e.dateEncodingStrategy = .iso8601
    e.outputFormatting = [.sortedKeys]
    return e
  }

  static var decoder: JSONDecoder {
    let d = JSONDecoder()
    d.dateDecodingStrategy = .iso8601
    return d
  }
}
