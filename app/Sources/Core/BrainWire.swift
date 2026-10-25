import Foundation

// Swift mirror of brain/src/api/types.ts (API_VERSION 1). Field names match the TypeScript exactly, so the
// synthesized Codable keys are the JSON keys. Conventions from brain/API.md: times are unix epoch ms, ratios are
// 0..1, durations are minutes unless the name says otherwise. Unknown keys are ignored (changes are additive).
//
// The rail and card render the app's view models (Models.swift); the `to…()` mappers below are the only place
// wire shapes turn into them. A live HTTP BrainClient decodes these and calls the mappers.

enum BrainWire {
  static let apiVersion = 1

  static var decoder: JSONDecoder { JSONDecoder() }

  static func date(ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }
}

// MARK: GET /status

struct StatusResponse: Codable, Equatable {
  struct Observer: Codable, Equatable {
    var state: String  // "recording" | "paused" | "stale" | "no_data"
    var lastEventAt: Double?
  }
  struct StoreDay: Codable, Equatable {
    var day: String
    var source: String
    var events: Int
    var badLines: Int
    var errors: [String]
  }
  struct Store: Codable, Equatable {
    var days: [StoreDay]
    var events: Int
    var badLines: Int
  }
  struct Retention: Codable, Equatable {
    var keepDays: Int
    var nextPurgeDay: String?
    var nextPurgeAt: Double?
  }
  struct Analysis: Codable, Equatable {
    var generatedAt: Double
    var windowDays: [String]
    var tasks: Int
    var insights: Int
  }

  var version: Int
  var observer: Observer
  var store: Store
  var retention: Retention
  var analysis: Analysis

  func toObserverStatus() -> ObserverStatus {
    ObserverStatus(state: ObserverState(wire: observer.state), daysStored: store.days.count,
                   windowDays: retention.keepDays, nextPurge: retention.nextPurgeAt.map(BrainWire.date(ms:)),
                   insightsWaiting: analysis.insights)
  }
}

extension ObserverState {
  /// Wire states: recording (an event in the last 5 min), paused, stale, no_data. Anything newer reads as no data.
  init(wire: String) {
    switch wire {
    case "recording": self = .watching
    case "paused": self = .paused
    case "stale": self = .stale
    default: self = .noData
    }
  }
}

// MARK: GET /insights

struct FigureDTO: Codable, Equatable {
  var value: Double
  var unit: String
  var display: String
  var eventCount: Int
}

struct FiguresDTO: Codable, Equatable {
  var instances: FigureDTO
  var daysActive: FigureDTO
  var instancesPerDay: FigureDTO
  var medianMinutes: FigureDTO
  var p90Minutes: FigureDTO
  var activeMinutes: FigureDTO
  var share: FigureDTO
  var sameness: FigureDTO
}

struct ConnectorDTO: Codable, Equatable {
  var id: String
  var name: String
  var how: String  // "gmail-mcp" | "composio:<toolkit>" | "none"
  var reach: Double
  var limits: String?
  var role: String  // "primary" | "also"

  func toConnector() -> Connector {
    let kind: ConnectorKind
    if how == "gmail-mcp" { kind = .mcp }
    else if how.hasPrefix("composio:") { kind = .composio }
    else if id.contains("calendar") || id == "gcal" { kind = .calendar }
    else { kind = .localScript }
    // Connection state is not in API v1; the card shows every connector as still to connect.
    return Connector(id: id, name: name, kind: kind, connected: false)
  }
}

struct SavingRangeDTO: Codable, Equatable {
  var hoursSaved: Double
  var pct: Double
}

struct SavingDTO: Codable, Equatable {
  struct Range: Codable, Equatable { var low: SavingRangeDTO; var high: SavingRangeDTO }
  var weeklyItems: Double
  var weeklyHoursNow: Double
  var weeklyHoursAfter: Double
  var weeklyHoursSaved: Double
  var savingPct: Double
  var reviewSecondsPerItem: Double
  var range: Range
  var arithmetic: String
  var assumptions: [String]
}

struct ScoreDTO: Codable, Equatable {
  struct Factors: Codable, Equatable {
    var volume: Double, sameness: Double, reachability: Double, judgement: Double, risk: Double
  }
  var value: Double
  var formula: String
  var factors: Factors
}

struct ExampleDTO: Codable, Equatable {
  var instanceId: String
  var day: String
  var start: Double
  var minutes: Double
  var title: String
}

struct InsightDTO: Codable, Equatable {
  struct App: Codable, Equatable { var bundleId: String; var name: String; var host: String }
  struct Judge: Codable, Equatable { var judgement: Double; var risk: Double; var reasons: [String] }
  struct Identifiers: Codable, Equatable { var counterpartyCount: Int; var domainCount: Int; var topDomains: [String] }

  var id: String
  var rank: Int
  var taskId: String
  var kind: String
  var name: String
  var description: String
  var category: String
  var app: App
  var template: String
  var figures: FiguresDTO
  var saving: SavingDTO
  var score: ScoreDTO
  var judge: Judge
  var connectors: [ConnectorDTO]
  var identifiers: Identifiers
  var keywords: [String]
  var examples: [ExampleDTO]

  /// Plural noun for one instance, by category.
  var unitPlural: String {
    switch category {
    case "email": return "emails"
    case "chat": return "messages"
    case "call": return "calls"
    case "code": return "changes"
    case "sheet": return "updates"
    case "calendar": return "invites"
    case "social": return "posts"
    case "browse": return "visits"
    default: return "times"
    }
  }

  func toInsight(trackedMinutes: Double) -> Insight {
    Insight(
      id: id, kind: kind, taskPhrase: Self.phrase(name), unitPlural: unitPlural,
      timeShare: figures.share.value, instanceCount: Int(figures.instances.value.rounded()),
      medianMinutes: figures.medianMinutes.value, taskHours: figures.activeMinutes.value / 60,
      trackedHours: trackedMinutes / 60, sameness: figures.sameness.value,
      saving: SavingEstimate(savingPct: saving.savingPct,
                             reviewMinutesPerInstance: saving.reviewSecondsPerItem / 60,
                             hoursPerWeekLow: saving.range.low.hoursSaved,
                             hoursPerWeekHigh: saving.range.high.hoursSaved,
                             arithmetic: saving.arithmetic),
      connectors: connectors.map { $0.toConnector() },
      evidenceIds: examples.map(\.instanceId))
  }

  /// "Outreach emails" → "outreach emails"; keeps acronyms like "CRM updates".
  static func phrase(_ name: String) -> String {
    guard let first = name.first else { return name }
    let second = name.dropFirst().first
    if let second, second.isUppercase { return name }
    return first.lowercased() + name.dropFirst()
  }
}

struct InsightsResponse: Codable, Equatable {
  struct Window: Codable, Equatable { var days: [String]; var activeMinutes: Double; var events: Int }
  var version: Int
  var generatedAt: Double
  var window: Window
  var insights: [InsightDTO]

  func toInsights() -> [Insight] {
    insights.sorted { $0.rank < $1.rank }.map { $0.toInsight(trackedMinutes: window.activeMinutes) }
  }
}

// MARK: GET /insights/:id/evidence

struct SpanDTO: Codable, Equatable {
  var id: String
  var day: String
  var start: Double
  var end: Double
  var activeMinutes: Double
  var app: String
  var appName: String
  var title: String
  var host: String
  var taskId: String?
  var eventIds: [String]

  func toEvidenceSpan() -> EvidenceSpan {
    EvidenceSpan(id: id, start: BrainWire.date(ms: start), end: BrainWire.date(ms: end), activeMinutes: activeMinutes,
                 app: appName, title: title, urlHost: host.isEmpty ? nil : host, eventIds: eventIds)
  }
}

struct InstanceDTO: Codable, Equatable {
  var id: String
  var day: String
  var start: Double
  var end: Double
  var activeMinutes: Double
  var spanIds: [String]
  var counterparties: [String]
}

struct EvidenceResponse: Codable, Equatable {
  struct EventIds: Codable, Equatable { var eventIds: [String] }
  var version: Int
  var insightId: String
  var taskId: String
  var figures: [String: EventIds]
  var instances: [InstanceDTO]
  var spans: [SpanDTO]

  func toEvidenceSpans() -> [EvidenceSpan] { spans.map { $0.toEvidenceSpan() } }
}

// MARK: GET /dashboard

struct AutomationDTO: Codable, Equatable {
  var id: String
  var insightId: String
  var name: String
  var status: String  // "draft" | "dry_run" | "approved" | "paused"
  var connectors: [ConnectorDTO]
  var estimatedHoursSavedPerWeek: Double
  var measuredHoursSavedPerWeek: Double?

  func toAutomation() -> Automation {
    let s: AutomationStatus
    switch status {
    case "approved": s = .running
    case "dry_run": s = .awaitingApproval
    case "paused": s = .paused
    default: s = .draft
    }
    return Automation(id: id, name: name, status: s, hoursSavedEstimated: estimatedHoursSavedPerWeek,
                      hoursSavedMeasured: measuredHoursSavedPerWeek)
  }
}

struct DashboardResponse: Codable, Equatable {
  struct Totals: Codable, Equatable { var estimatedHoursSavedPerWeek: Double; var measuredHoursSavedPerWeek: Double? }
  struct Suggestion: Codable, Equatable { var insightId: String; var name: String; var weeklyHoursSaved: Double }
  var version: Int
  var automations: [AutomationDTO]
  var totals: Totals
  var suggestions: [Suggestion]

  func toAutomations() -> [Automation] { automations.map { $0.toAutomation() } }
}

struct ErrorResponse: Codable, Equatable {
  var error: String
  var message: String?
}
