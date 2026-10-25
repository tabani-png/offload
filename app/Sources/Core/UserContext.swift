import Foundation

// s14 (CONTEXT): the optional onboarding question "What do you do?". Role and industry are only context for how
// Offload names steps and drafts text. They go to the local brain (PUT /context), which passes them to model prompts
// (Claude through the router) inside a marked context block, and they never
// change a number (brain/src/api/s14-types.ts UserContextDTO, ContextResponse).

/// UserContextDTO. Absent keys mean "not set".
struct UserContext: Codable, Equatable, Sendable {
  var role: String?
  var industry: String?

  init(role: String? = nil, industry: String? = nil) {
    self.role = role
    self.industry = industry
  }

  var isEmpty: Bool { (role ?? "").isEmpty && (industry ?? "").isEmpty }

  /// The PUT /context body: only the keys that carry a value.
  var body: [String: String] {
    var b: [String: String] = [:]
    if let r = role, !r.isEmpty { b["role"] = r }
    if let i = industry, !i.isEmpty { b["industry"] = i }
    return b
  }

  /// The body as the brain receives it (sorted keys, so it is stable in tests).
  var bodyData: Data {
    (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data("{}".utf8)
  }
}

/// ContextResponse (GET and PUT /context).
struct ContextResponse: Codable, Equatable, Sendable {
  struct Suggestions: Codable, Equatable, Sendable {
    var roles: [String]
    var industries: [String]
  }
  var version: Int
  var context: UserContext
  var updatedAt: Double?
  var suggestions: Suggestions
}

/// The pure state of the onboarding context step: two one-line fields and their suggestion chips.
struct ContextStepState: Equatable, Sendable {
  enum Field: String, CaseIterable, Sendable {
    case role, industry

    var label: String { self == .role ? "Role" : "Industry" }
    var placeholder: String { self == .role ? "For example, Bookkeeper" : "For example, Accounting" }
  }

  /// The brain's limit (sanitised one line of at most 80 characters).
  static let maxLength = 80
  static let defaultRoles = ["Founder", "Recruiter", "Bookkeeper", "Support agent", "Sales ops"]
  static let defaultIndustries = ["Software", "Recruiting", "Accounting", "E-commerce", "Healthcare"]
  static let chipsPerField = 5

  static let title = "What do you do?"
  static let intro = "Optional. A word or two helps Offload name the work it finds the way you would."
  static let helper = "Only used as context when Offload names steps and drafts text, including in requests to Claude. It never changes a number."

  private(set) var role = ""
  private(set) var industry = ""
  private(set) var roleSuggestions = ContextStepState.defaultRoles
  private(set) var industrySuggestions = ContextStepState.defaultIndustries

  init(role: String = "", industry: String = "") {
    self.role = Self.limit(role)
    self.industry = Self.limit(industry)
  }

  func value(_ f: Field) -> String { f == .role ? role : industry }
  func suggestions(_ f: Field) -> [String] { f == .role ? roleSuggestions : industrySuggestions }

  /// While typing: one line, at most maxLength characters. Trimming waits until the value is sent.
  mutating func set(_ f: Field, _ text: String) {
    let v = Self.limit(text)
    if f == .role { role = v } else { industry = v }
  }

  /// A chip fills its field with its words.
  mutating func choose(_ f: Field, _ chip: String) { set(f, chip) }

  /// Whether a chip is what the field holds now (drawn selected).
  func isChosen(_ f: Field, _ chip: String) -> Bool {
    Self.clean(value(f)).caseInsensitiveCompare(chip) == .orderedSame
  }

  /// The brain's suggestions replace the built-in chips when it sends some; a stored context fills empty fields.
  mutating func adopt(_ r: ContextResponse) {
    let roles = r.suggestions.roles.map(Self.clean).filter { !$0.isEmpty }
    let industries = r.suggestions.industries.map(Self.clean).filter { !$0.isEmpty }
    if !roles.isEmpty { roleSuggestions = Array(roles.prefix(Self.chipsPerField)) }
    if !industries.isEmpty { industrySuggestions = Array(industries.prefix(Self.chipsPerField)) }
    if role.isEmpty, let v = r.context.role { role = Self.limit(v) }
    if industry.isEmpty, let v = r.context.industry { industry = Self.limit(v) }
  }

  /// What Continue sends: the trimmed values, nil when both are empty (then nothing is sent).
  var context: UserContext? {
    let r = Self.clean(role), i = Self.clean(industry)
    if r.isEmpty && i.isEmpty { return nil }
    return UserContext(role: r.isEmpty ? nil : r, industry: i.isEmpty ? nil : i)
  }

  var hasValue: Bool { context != nil }

  /// One line: line breaks and tabs become spaces; at most maxLength characters.
  static func limit(_ s: String) -> String {
    let oneLine = String(s.map { $0.isNewline || $0 == "\t" ? " " : $0 })
    return String(oneLine.prefix(maxLength))
  }

  /// One line, trimmed, inner runs of spaces collapsed, at most maxLength characters.
  static func clean(_ s: String) -> String {
    let words = limit(s).split(whereSeparator: { $0 == " " }).map(String.init)
    return String(words.joined(separator: " ").prefix(maxLength))
  }
}

/// Holds a context the brain could not take yet (it is still starting, or between restarts) and sends it once the
/// brain is up. Only the newest value is kept; nothing is written to disk by the app.
struct ContextOutbox: Equatable, Sendable {
  private(set) var pending: UserContext?

  /// Continue with a value: it waits here until it is sent.
  mutating func queue(_ c: UserContext) { pending = c }

  /// The brain took it, or refused it for good (a 400 is not retried).
  mutating func settle() { pending = nil }

  /// Worth trying again when the brain comes up: it was not running, starting, or slow to answer.
  static func shouldRetry(_ error: Error) -> Bool {
    switch error as? BrainError {
    case .unreachable?, .starting?, .timedOut?, .server?: return true
    case nil: return true
    default: return false
    }
  }
}

/// The mock brain's context and plan choices, in memory for the life of the process (`--mock`, tests).
enum MockContext {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var context = UserContext()
  nonisolated(unsafe) private static var updatedAt: Double?
  nonisolated(unsafe) private static var chosen: [String: String] = [:]
  nonisolated(unsafe) private static var tools: [String: [String: String]] = [:]

  static func reset() {
    lock.lock(); defer { lock.unlock() }
    context = UserContext()
    updatedAt = nil
    chosen = [:]
    tools = [:]
  }

  static func chooseTool(_ workflowId: String, _ stepId: String, _ toolId: String) {
    lock.lock(); defer { lock.unlock() }
    tools[workflowId, default: [:]][stepId] = toolId
  }

  /// PUT semantics: a key that is absent, null or "" clears that value.
  static func store(_ c: UserContext) {
    lock.lock(); defer { lock.unlock() }
    let r = c.role.map(ContextStepState.clean) ?? ""
    let i = c.industry.map(ContextStepState.clean) ?? ""
    context = UserContext(role: r.isEmpty ? nil : r, industry: i.isEmpty ? nil : i)
    updatedAt = Date().timeIntervalSince1970 * 1000
  }

  static func response() -> ContextResponse {
    lock.lock(); defer { lock.unlock() }
    return ContextResponse(version: 1, context: context, updatedAt: updatedAt,
                           suggestions: .init(roles: ContextStepState.defaultRoles, industries: ContextStepState.defaultIndustries))
  }

  static func choose(_ workflowId: String, _ variant: String) {
    lock.lock(); defer { lock.unlock() }
    chosen[workflowId] = variant
  }

  /// The workflow with the variant you picked applied (the probe's pick until you pick).
  static func plan(for w: Workflow) -> Workflow {
    lock.lock(); defer { lock.unlock() }
    var out = w
    if let v = chosen[w.id], var plan = w.plan {
      plan.chosen = v
      plan.chosenBy = "user"
      out.plan = plan
    }
    for (step, tool) in tools[w.id] ?? [:] {
      guard let i = out.tools.firstIndex(where: { $0.stepId == step }) else { continue }
      out.tools[i].chosen = tool
      out.tools[i].chosenBy = "user"
      if let o = out.tools[i].options.first(where: { $0.id == tool }), o.connected { out.tools[i].runsWith = tool }
    }
    return out
  }
}
