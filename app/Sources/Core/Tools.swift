import Foundation

// s14 follow-up: tool suggestions per step (workflow detail `tools`, brain/src/plan/tools.ts StepToolsDTO) and the
// model router's status (GET /status `models`). Both optional, so older brains decode as before.

/// ToolOptionDTO.
struct ToolOption: Codable, Equatable, Identifiable, Sendable {
  var id: String
  var name: String
  /// "mcp" | "composio" | "api" | "computer" | "local"
  var via: String
  var why: String
  /// "none" | "minutes" | "about an hour"
  var setup: String
  var cost: String
  var connected: Bool
  var connectorId: String?
}

/// StepToolsDTO.
struct StepTools: Codable, Equatable, Identifiable, Sendable {
  var stepId: String
  var capability: String
  var need: String
  var options: [ToolOption]
  var chosen: String
  /// "default" | "user"
  var chosenBy: String
  /// What the runner uses for this step today (an option id, a connector id, or "local").
  var runsWith: String
  var suggestion: String

  var id: String { stepId }
  var chosenOption: ToolOption? { options.first { $0.id == chosen } }
}

/// Dry-run response `tools`: the tool each step stood for in this dry run.
struct DryRunTool: Codable, Equatable, Sendable {
  var stepId: String
  var tool: String
  var name: String
  var runsWith: String
}

/// Keyboard focus on the tool rows: T moves to the next step with tools, ← → pick an option, ↩ confirms.
struct ToolFocus: Equatable, Sendable {
  var stepId: String
  var index: Int

  /// T: the next step's row (wrapping), starting on that step's chosen option.
  static func next(after current: ToolFocus?, tools: [StepTools]) -> ToolFocus? {
    let rows = tools.filter { !$0.options.isEmpty }
    guard !rows.isEmpty else { return nil }
    var i = 0
    if let c = current, let at = rows.firstIndex(where: { $0.stepId == c.stepId }) { i = (at + 1) % rows.count }
    let r = rows[i]
    return ToolFocus(stepId: r.stepId, index: r.options.firstIndex { $0.id == r.chosen } ?? 0)
  }

  /// ← (-1) and → (+1), clamped to the row.
  mutating func move(_ delta: Int, tools: [StepTools]) {
    guard let r = tools.first(where: { $0.stepId == stepId }), !r.options.isEmpty else { return }
    index = min(r.options.count - 1, max(0, index + delta))
  }

  /// The option under the focus, when it is not already the chosen one.
  func pick(_ tools: [StepTools]) -> (stepId: String, toolId: String)? {
    guard let r = tools.first(where: { $0.stepId == stepId }), r.options.indices.contains(index) else { return nil }
    let o = r.options[index]
    return o.id == r.chosen ? nil : (stepId, o.id)
  }

  /// POST /workflows/:id/tools body.
  static func body(stepId: String, toolId: String) -> [String: String] { ["stepId": stepId, "toolId": toolId] }
}

/// What a step's suggestion row says.
struct ToolsCopy: Equatable, Sendable {
  struct Option: Equatable, Sendable, Identifiable {
    var id: String
    var name: String
    var why: String
    /// "About an hour to set up · paid plan, priced per sending volume"
    var detail: String
    var connected: Bool
    var chosen: Bool
  }

  var stepId: String
  var suggestion: String
  var options: [Option]
  /// "Sends through Gmail until Instantly is connected." when the runner still uses something else.
  var runsWithLine: String?

  static let hint = "T to choose a tool, then ← → and ↩"
  static let connectedChip = "Connected"
  static let inUse = "In use"
  static let changed = "Tool changed. Press R to run the dry run again with it."

  init(_ t: StepTools, connectors: [Connector] = []) {
    stepId = t.stepId
    suggestion = PlainWords.clean(t.suggestion)
    options = t.options.map {
      Option(id: $0.id, name: $0.name, why: PlainWords.clean($0.why), detail: "\(Self.setup($0.setup)) · \($0.cost)",
             connected: $0.connected, chosen: $0.id == t.chosen)
    }
    if t.runsWith != t.chosen, let chosen = t.chosenOption {
      runsWithLine = "Sends through \(Self.name(t.runsWith, tools: t, connectors: connectors)) until \(chosen.name) is connected."
    } else {
      runsWithLine = nil
    }
  }

  static func setup(_ s: String) -> String {
    switch s {
    case "none": return "No setup"
    case "minutes": return "A few minutes to set up"
    case "about an hour": return "About an hour to set up"
    default: return BrainError.sentence(s).replacingOccurrences(of: ".", with: "")
    }
  }

  /// An id as a name: an option's, a connector's, "this Mac" for local, else the id with a capital.
  static func name(_ id: String, tools: StepTools, connectors: [Connector]) -> String {
    if let o = tools.options.first(where: { $0.id == id || $0.connectorId == id }) { return o.name }
    if let c = connectors.first(where: { $0.id == id }) { return c.name }
    if let c = MockBrainClient.knownConnectors.first(where: { $0.id == id }) { return c.name }
    if id == "local" { return "this Mac" }
    return id.prefix(1).uppercased() + id.dropFirst()
  }

  /// The dry run header's "With Instantly and Google Sheets" (unique names, in step order); nil without tools.
  static func with(_ tools: [DryRunTool]?) -> String? {
    guard let tools, !tools.isEmpty else { return nil }
    var names: [String] = []
    for t in tools where !names.contains(t.name) { names.append(t.name) }
    let list = names.count == 1 ? names[0] : names.dropLast().joined(separator: ", ") + " and " + names.last!
    return "With \(list)"
  }

  var allStrings: [String] {
    [suggestion, runsWithLine ?? "", Self.hint, Self.connectedChip, Self.inUse, Self.changed]
      + options.flatMap { [$0.name, $0.why, $0.detail] }
  }
}

extension MockBrainClient {
  /// Connector names the app knows without a brain, for "Sends through …".
  static let knownConnectors: [Connector] = [gmail, sheets, calendar, hubspot]
}

// MARK: model router (GET /status `models`)

struct ModelsStatus: Codable, Equatable, Sendable {
  struct Route: Codable, Equatable, Sendable {
    var calls: Int?
    var inputTokens: Int?
    var outputTokens: Int?
    var cacheReadTokens: Int?
    var costUsd: Double?
    var escalations: Int?
    var tier: String?
    var model: String?
  }
  /// "api" | "claude-code" | "stub"
  var backend: String?
  var metered: Bool?
  var month: String?
  var spentUsd: Double?
  var budgetUsd: Double?
  var captionsLocal: Bool?
  var blocked: Bool?
  var needsYou: String?
  var routes: [String: Route]?

  /// "Claude this month: $1.24 of $20 budget" / "… $1.24, no budget set". The brain's figures, formatted only.
  var spendLine: String {
    if backend == "stub" { return "Sample model: nothing is sent to Claude." }
    if metered == false { return "Claude this month: on your Claude plan, not billed per call." }
    let spent = Self.usd(spentUsd ?? 0)
    guard let b = budgetUsd else { return "Claude this month: \(spent), no budget set" }
    return "Claude this month: \(spent) of \(Self.usd(b, whole: true)) budget"
  }

  static let captionsLocalLine = "Screens are read on this Mac to stay within the budget."

  var captionsLine: String? { captionsLocal == true ? Self.captionsLocalLine : nil }

  var needsYouLine: String? {
    guard let n = needsYou?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty else { return nil }
    return BrainError.sentence(n)
  }

  /// "$1.24"; a whole budget drops the cents ("$20").
  static func usd(_ v: Double, whole: Bool = false) -> String {
    if whole && v == v.rounded() { return "$\(Format.count(Int(v)))" }
    return "$" + String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), v)
  }
}
