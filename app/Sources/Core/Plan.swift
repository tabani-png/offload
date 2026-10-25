import Foundation

// s14 (PLAN, DRYRUN): Swift mirror of brain/src/api/s14-types.ts. The workflow detail gains an optional `plan`
// (WorkflowPlanDTO) and the dry run an optional `general` (GeneralDryRunDTO); both are absent for the email
// workflows, so older brains and the email demo decode exactly as before. Field names match the TypeScript.

/// CapabilityNeedDTO: a plain-words need the connector chain resolves ("create bill in Xero").
struct CapabilityNeed: Codable, Equatable, Sendable {
  var need: String
  var target: String
  var targetName: String
  var capability: String
  /// "read" | "send" | "log"
  var role: String
  /// "catalog" | "local_file" | "computer_use"
  var via: String
}

/// CapabilityResolutionDTO.
struct CapabilityResolution: Codable, Equatable, Sendable {
  var target: String
  var capability: String
  /// "resolved" | "pending" | "unavailable"
  var status: String
  var method: String?
  var reason: String
}

/// PlanStepType.
enum PlanStepType: String, Codable, CaseIterable, Sendable {
  case read, transform, decide, draft, commit

  /// The step's badge.
  var badge: String {
    switch self {
    case .read: return "Read"
    case .transform: return "Transform"
    case .decide: return "Decide"
    case .draft: return "Draft"
    case .commit: return "Commit"
    }
  }

  var symbol: String {
    switch self {
    case .read: return "doc.text.magnifyingglass"
    case .transform: return "arrow.triangle.2.circlepath"
    case .decide: return "arrow.triangle.branch"
    case .draft: return "pencil.line"
    case .commit: return "square.and.arrow.down"
    }
  }
}

/// PlanStepDTO.
struct PlanStep: Codable, Equatable, Identifiable, Sendable {
  var id: String
  /// The wire value; `kind` reads it (an unknown type from a newer brain shows as a read).
  var type: String
  var title: String
  var detail: String
  var capability: CapabilityNeed?
  var gated: Bool
  var when: String?
  var writesText: Bool
  var sourceSteps: [String]

  var kind: PlanStepType { PlanStepType(rawValue: type) ?? .read }
}

/// PlanVariantDTO.
struct PlanVariant: Codable, Equatable, Identifiable, Sendable {
  /// "a" | "b"
  var id: String
  var label: String
  var summary: String
  var steps: [PlanStep]
}

/// ProbeScoreDTO.
struct ProbeScore: Codable, Equatable, Sendable {
  var variant: String
  var instances: Int
  var matched: Int
  var extra: Int
  var missed: Int
  /// matched / (matched + extra + missed), 0..1.
  var agreement: Double
  var arithmetic: String
}

/// OutputType.
enum PlanOutputType: String, Sendable {
  case email, ticketReply = "ticket_reply", message, formFields = "form_fields", rows, stageChange = "stage_change", record

  var writesText: Bool { self == .email || self == .ticketReply || self == .message }
}

/// WorkflowPlanDTO.
struct WorkflowPlan: Codable, Equatable, Sendable {
  var version: Int
  var outputType: String
  var goal: String
  var variants: [PlanVariant]
  /// "a" | "b"
  var chosen: String
  /// "dry_run" | "user"
  var chosenBy: String
  var probe: [ProbeScore]
  var reason: String
  var designedBy: String
  var capabilities: [CapabilityResolution]

  var output: PlanOutputType? { PlanOutputType(rawValue: outputType) }
  var chosenVariant: PlanVariant? { variants.first { $0.id == chosen } ?? variants.first }
  func score(_ variant: String) -> ProbeScore? { probe.first { $0.variant == variant } }
  var pickedByYou: Bool { chosenBy == "user" }
}

// MARK: generic dry run

/// OutputFieldDTO. `value` nil: the screen showed the field was filled, not its value.
struct PlanOutputField: Codable, Equatable, Sendable {
  var label: String
  var value: String?
}

/// OutputDTO (ours) and OutputDTO & { excerpt } (theirs).
struct PlanOutput: Codable, Equatable, Sendable {
  var kind: String
  var summary: String
  var fields: [PlanOutputField]
  var text: String?
  var actions: [String]
  var excerpt: String? = nil
}

/// GeneralDryRunInstanceDTO.
struct GeneralDryRunInstance: Codable, Equatable, Identifiable, Sendable {
  struct Match: Codable, Equatable, Sendable { var matched: Int; var total: Int; var value: Double; var arithmetic: String }
  struct Steps: Codable, Equatable, Sendable { var ours: [String]; var theirs: [String] }
  struct Evidence: Codable, Equatable, Sendable { var eventIds: [String]; var spanIds: [String]; var frameIds: [String] }
  struct Estimate: Codable, Equatable, Sendable { var observedMinutes: Double; var reviewSeconds: Double; var savedMinutes: Double }
  /// `{ verb, fields: [label, value][] }`: the commit the chain would make after your approval.
  struct Commit: Codable, Equatable, Sendable { var verb: String; var fields: [[String]] }

  var instanceId: String
  var day: String
  var start: Double
  var ours: PlanOutput
  var theirs: PlanOutput
  var match: Match
  var steps: Steps
  var evidence: Evidence
  var estimate: Estimate
  var commit: Commit?
  var warnings: [String]

  var id: String { instanceId }
  var startDate: Date { BrainWire.date(ms: start) }
}

/// GeneralDryRunDTO.
struct GeneralDryRun: Codable, Equatable, Sendable {
  struct Totals: Codable, Equatable, Sendable {
    var instances: Int; var matched: Int; var total: Int; var agreement: Double; var arithmetic: String
  }
  struct Tone: Codable, Equatable, Sendable {
    /// "sent_mail" | "observed_text" | "none"
    var source: String
    var examples: Int
  }
  var outputType: String
  var variant: String
  var instances: [GeneralDryRunInstance]
  var totals: Totals
  var tone: Tone?
}

/// Keyboard: 1 and 2 pick the plan's first and second variant in the review window.
enum PlanChoice {
  static func variant(forKey characters: String, plan: WorkflowPlan?) -> String? {
    guard let plan, let n = Int(characters), n >= 1, n <= plan.variants.count else { return nil }
    return plan.variants[n - 1].id
  }

  /// POST /workflows/:id/plan body.
  static func body(_ variant: String) -> [String: String] { ["variant": variant] }
}
