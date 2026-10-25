import Foundation

// s09a on the s05c routes: the tone card (GET/PUT /workflows/:id/tone), SKILL.md text edits (GET/PUT
// /workflows/:id/skill: the description and each step's title and detail only) and the observer passthrough
// (GET /observer). Wire shapes mirror brain/src/api/types.ts field for field.

/// ToneCardDTO.
struct ToneCard: Codable, Equatable, Sendable {
  var workflowId: String
  /// investor_outreach | scheduling | follow_up | other
  var bucket: String
  /// null until `tone build` ran or a card was saved.
  var text: String?
  var edited: Bool
  var path: String
  var updatedAt: Double?
  var maxBytes: Int

  /// "Investor outreach"
  var bucketLabel: String {
    let words = bucket.split(separator: "_").map(String.init)
    guard let first = words.first else { return bucket }
    return ([first.prefix(1).uppercased() + first.dropFirst()] + words.dropFirst()).joined(separator: " ")
  }

  /// Too long for the brain to accept (UTF-8 bytes)?
  static func fits(_ text: String, maxBytes: Int) -> Bool { text.utf8.count <= maxBytes }
}

/// SkillStepDTO.
struct SkillStep: Codable, Equatable, Identifiable, Sendable {
  var id: String
  var type: String
  var title: String
  var detail: String
  var connector: String?
  var sideEffect: Bool

  var isGate: Bool { type == "approval_gate" }
}

/// SkillDTO.
struct SkillDoc: Codable, Equatable, Sendable {
  struct Limits: Codable, Equatable, Sendable { var descriptionChars: Int; var titleChars: Int; var detailChars: Int }
  var workflowId: String
  var skillMd: String
  var description: String
  var steps: [SkillStep]
  /// Ids of the approval-gate steps; never editable.
  var gates: [String]
  var limits: Limits
}

/// SkillUpdate: only what changed. Gate steps are never sent.
struct SkillEdit: Equatable, Sendable {
  var description: String?
  var steps: [(id: String, title: String?, detail: String?)]

  static func == (a: SkillEdit, b: SkillEdit) -> Bool {
    a.description == b.description && a.steps.count == b.steps.count
      && zip(a.steps, b.steps).allSatisfy { $0.id == $1.id && $0.title == $1.title && $0.detail == $1.detail }
  }

  var isEmpty: Bool { description == nil && steps.isEmpty }

  /// The diff between what the brain sent and the edited copy.
  static func diff(from old: SkillDoc, to new: SkillDoc) -> SkillEdit {
    let gates = Set(old.gates)
    var steps: [(id: String, title: String?, detail: String?)] = []
    for s in new.steps where !gates.contains(s.id) {
      guard let o = old.steps.first(where: { $0.id == s.id }) else { continue }
      let t = s.title == o.title ? nil : s.title
      let d = s.detail == o.detail ? nil : s.detail
      if t != nil || d != nil { steps.append((s.id, t, d)) }
    }
    return SkillEdit(description: new.description == old.description ? nil : new.description, steps: steps)
  }

  var body: [String: Any] {
    var b: [String: Any] = [:]
    if let description { b["description"] = description }
    if !steps.isEmpty {
      b["steps"] = steps.map { s -> [String: String] in
        var o = ["id": s.id]
        if let t = s.title { o["title"] = t }
        if let d = s.detail { o["detail"] = d }
        return o
      }
    }
    return b
  }

  /// Local checks the brain also makes, so the sheet can say what is wrong before saving.
  static func problems(_ doc: SkillDoc) -> [String] {
    var out: [String] = []
    func check(_ name: String, _ v: String, max: Int, multiline: Bool) {
      let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
      if t.isEmpty { out.append("\(name) cannot be blank.") }
      if t.count > max { out.append("\(name) is longer than \(max) characters.") }
      if !multiline && t.contains(where: \.isNewline) { out.append("\(name) must be one line.") }
      if t.split(whereSeparator: \.isNewline).contains(where: { l in
        let s = l.trimmingCharacters(in: .whitespaces)
        return s.hasPrefix("#") || s.hasPrefix("---") || s.hasPrefix("```")
      }) { out.append("\(name) cannot contain headings, --- or code fences.") }
    }
    check("The description", doc.description, max: doc.limits.descriptionChars, multiline: true)
    for (i, s) in doc.steps.enumerated() where !doc.gates.contains(s.id) {
      check("Step \(i + 1)'s title", s.title, max: doc.limits.titleChars, multiline: false)
      check("Step \(i + 1)'s detail", s.detail, max: doc.limits.detailChars, multiline: true)
    }
    return out
  }
}

/// ObserverResponse (GET /observer). Always 200; a missing observer is `available: false`.
struct ObserverResponseDTO: Decodable, Equatable, Sendable {
  var version: Int
  var available: Bool
  var bin: String
  var checkedAt: Double
  var error: String?
  var permissions: ObserverReport.Permissions?
  var status: ObserverReport?

  /// The observer's state as the app reads it; nil when the brain could not ask it.
  var report: ObserverReport? {
    guard available, var s = status else { return nil }
    if s.permissions == nil { s.permissions = permissions }
    return s
  }
}

/// Defaults so the mock (and any older brain) keeps working: tone from the workflow, SKILL.md read-only.
extension BrainClient {
  func toneCard(workflowId: String) async throws -> ToneCard {
    let w = try await workflow(id: workflowId)
    return ToneCard(workflowId: w.id, bucket: "investor_outreach", text: w.toneCard.isEmpty ? nil : w.toneCard,
                    edited: w.toneEdited, path: "", updatedAt: nil, maxBytes: 16_384)
  }

  func saveToneCard(workflowId: String, text: String) async throws -> ToneCard {
    var c = try await toneCard(workflowId: workflowId)
    c.text = text
    c.edited = true
    return c
  }

  func skill(workflowId: String) async throws -> SkillDoc {
    let w = try await workflow(id: workflowId)
    return SkillDoc(workflowId: w.id, skillMd: w.skillMarkdown, description: w.summary,
                    steps: w.steps.map { SkillStep(id: $0.id, type: $0.type.rawValue, title: $0.title, detail: $0.detail,
                                                   connector: $0.connectorId, sideEffect: $0.type.isSideEffect) },
                    gates: w.steps.filter(\.isGate).map(\.id),
                    limits: .init(descriptionChars: 400, titleChars: 80, detailChars: 400))
  }

  func saveSkill(workflowId: String, edit: SkillEdit) async throws -> SkillDoc {
    var d = try await skill(workflowId: workflowId)
    if let desc = edit.description { d.description = desc }
    for s in edit.steps {
      guard let i = d.steps.firstIndex(where: { $0.id == s.id }) else { continue }
      if let t = s.title { d.steps[i].title = t }
      if let x = s.detail { d.steps[i].detail = x }
    }
    return d
  }

  /// nil: ask the observer CLI instead.
  func observer() async throws -> ObserverReport? { nil }

  /// nil: no stored dry run (or an older brain); the review runs one.
  func latestDryRun(workflowId: String) async throws -> DryRun? { nil }
}
