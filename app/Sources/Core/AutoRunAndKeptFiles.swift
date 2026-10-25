import Foundation

// s10d: the brain's s10b additions as the app reads them. POST /workflows/:id/auto-run answers a WorkflowSummaryDTO
// with `autoRunPin` (who auto-send covers, and the files it was pinned to); GET /observer adds `keptFiles` (files with
// your content kept until you delete them). brain/API.md "Auto-run pin and failures", "keptFiles".

struct AutoRunPinDTO: Codable, Equatable, Sendable {
  struct File: Codable, Equatable, Sendable {
    var file: String
    var sha256: String
    var changed: Bool
  }
  var pinnedAt: Double
  var recipients: Int
  var pinnedRecipients: [String]
  var newRecipients: Int
  var changedRecipients: Int
  var removedRecipients: Int
  var files: [File]
}

/// The answer to turning auto-send on or off, in the app's words.
struct AutoRunResult: Equatable, Sendable {
  var workflowId: String
  var enabled: Bool
  /// Addresses auto-send may write to without asking: rows pinned when it was turned on and unchanged since.
  var pinnedRecipients: [String]
  /// Rows that will wait for you (new or changed since the pin).
  var waiting: Int
  /// Pinned files ("facts.md", "tone/…", "SKILL.md") that changed since: they hold the whole batch.
  var changedFiles: [String]

  init(workflowId: String, enabled: Bool, pinnedRecipients: [String], waiting: Int = 0, changedFiles: [String] = []) {
    self.workflowId = workflowId
    self.enabled = enabled
    self.pinnedRecipients = pinnedRecipients
    self.waiting = waiting
    self.changedFiles = changedFiles
  }

  init(workflowId: String, enabled: Bool, pin: AutoRunPinDTO?) {
    self.init(workflowId: workflowId, enabled: enabled, pinnedRecipients: pin?.pinnedRecipients ?? [],
              waiting: (pin?.newRecipients ?? 0) + (pin?.changedRecipients ?? 0),
              changedFiles: pin?.files.filter(\.changed).map(\.file) ?? [])
  }
}

/// What the auto-send sheet says. Plain words: no "pin", no file names.
struct AutoRunCopy: Equatable, Sendable {
  var title: String
  var summary: String
  var detail: String?
  var people: [String]

  /// Before: what turning it on will do.
  static func offer(workflowName: String) -> AutoRunCopy {
    AutoRunCopy(title: "Send without asking?",
                summary: "\(workflowName) will send each batch on its own, but only to the people on your list today, written from your facts and voice as they are now. Anyone new, or anyone whose row changes, waits for you.",
                detail: "Turn it off any time. A batch you approved yourself is never stopped.", people: [])
  }

  /// After: what the brain pinned.
  init(_ r: AutoRunResult) {
    let n = r.pinnedRecipients.count
    title = "Auto-send is on"
    summary = "Auto-send covers \(n == 1 ? "this person" : "these \(n) people") and your current facts and voice. Anyone new waits for you."
    var notes: [String] = []
    if r.waiting > 0 { notes.append(r.waiting == 1 ? "1 person on your list already waits for you." : "\(r.waiting) people on your list already wait for you.") }
    if !r.changedFiles.isEmpty { notes.append("Your facts or voice changed since; the next batch waits for you.") }
    detail = notes.isEmpty ? nil : notes.joined(separator: " ")
    people = r.pinnedRecipients
  }

  init(title: String, summary: String, detail: String?, people: [String]) {
    self.title = title
    self.summary = summary
    self.detail = detail
    self.people = people
  }
}

/// One file the brain keeps until you delete it (GET /observer keptFiles).
struct KeptFileDTO: Codable, Equatable, Sendable {
  var path: String
  var kind: String
  var workflowId: String?
  var bytes: Double
  var updatedAt: Double
  var note: String
}

struct KeptFile: Equatable, Identifiable, Sendable {
  var path: String
  var kind: String
  var note: String
  var bytes: Int
  var id: String { path }

  /// "Recipient list", "Your facts", "Send log", "Your voice": what a person calls it.
  var name: String {
    switch kind {
    case "recipients": return "Recipient list"
    case "facts": return "Your facts"
    case "send_log": return "Send log"
    case "tone_card": return "Your voice"
    default: return URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
    }
  }

  /// "12 KB"
  var size: String {
    bytes < 1024 ? "\(bytes) bytes" : "\(Int((Double(bytes) / 1024).rounded(.up))) KB"
  }

  init(path: String, kind: String, note: String, bytes: Int) {
    self.path = path
    self.kind = kind
    self.note = note
    self.bytes = bytes
  }

  init(_ d: KeptFileDTO) {
    self.init(path: d.path, kind: d.kind, note: Self.shortNote(d.kind) ?? PlainWords.clean(d.note), bytes: Int(d.bytes))
  }

  /// s10e (P1): one short line per kind, under 60 characters, so no note truncates mid-word.
  static func shortNote(_ kind: String) -> String? {
    switch kind {
    case "recipients": return KeptFileCopy.footnote
    case "facts": return "What drafts may say about you. Yours to edit."
    case "send_log": return "One line per email sent: who, when, subject."
    case "tone_card": return "Your notes on how you write."
    default: return nil
    }
  }
}

extension MockBrainClient {
  /// 37 people on the sample list when auto-send is turned on.
  static let samplePinned: [String] = (nextBatch.map(\.email) + (1...29).map { "investor\($0)@example.vc" })

  static let sampleKeptFiles: [KeptFile] = [
    KeptFile(path: "/Users/you/Library/Application Support/Offload/workflows/wf_outreach/recipients.csv",
             kind: "recipients", note: "The people this workflow writes to. Yours to edit.", bytes: 6_144),
    KeptFile(path: "/Users/you/Library/Application Support/Offload/workflows/wf_outreach/facts.md",
             kind: "facts", note: "What drafts may say about you and your company.", bytes: 812),
    KeptFile(path: "/Users/you/Library/Application Support/Offload/workflows/wf_outreach/crm-log.csv",
             kind: "send_log", note: "One line per email sent: who, when and the subject.", bytes: 2_310),
  ]
}

extension BrainClient {
  func setAutoRun(workflowId: String, enabled: Bool) async throws -> AutoRunResult {
    AutoRunResult(workflowId: workflowId, enabled: enabled, pinnedRecipients: enabled ? MockBrainClient.samplePinned : [])
  }

  func keptFiles() async throws -> [KeptFile] { MockBrainClient.sampleKeptFiles }
}
