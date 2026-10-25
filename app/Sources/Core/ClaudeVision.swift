import Foundation

// s14 follow-up: the opt-in Claude captioner. Off by default. When on, the brain starts with `--captioner claude`
// in v1 and v2 alike (Claude captioning does not need Ollama); otherwise v2 asks for `--captioner auto`. The demo
// week never gets a captioner flag. GET /status `captioner` gains optional `usage` and `needsYou`.

/// The persisted opt-in (UserDefaults). Pure apart from the defaults it is given.
struct ClaudeVisionSetting: Equatable, Sendable {
  static let defaultsKey = "ai.offload.claudeVision.v1"
  static let label = "Read screens with Claude (your company account). Images are masked first."
  static let appliesNextLaunch = "Applies the next time Offload starts"

  var enabled: Bool = false

  static func load(_ defaults: UserDefaults) -> ClaudeVisionSetting {
    ClaudeVisionSetting(enabled: defaults.bool(forKey: defaultsKey))
  }

  func save(_ defaults: UserDefaults) { defaults.set(enabled, forKey: Self.defaultsKey) }

  mutating func toggle() { enabled.toggle() }
}

/// CaptionerStatusDTO (GET /status `captioner`), every field optional so older brains decode.
struct CaptionerStatus: Codable, Equatable, Sendable {
  struct Usage: Codable, Equatable, Sendable {
    struct Frame: Codable, Equatable, Sendable { var inputTokens: Int; var outputTokens: Int }
    var frames: Int
    var inputTokens: Int
    var outputTokens: Int
    var lastFrame: Frame?
  }
  var enabled: Bool?
  /// "off" | "stub" | "ollama" | "claude"
  var captioner: String?
  var model: String?
  var healthy: Bool?
  var usage: Usage?
  /// The brain's own words when the captioner needs you (shown as a needs-you line); null when nothing does.
  var needsYou: String?

  var isClaude: Bool { captioner == "claude" }

  /// "Claude read 42 screens · 61,200 tokens in, 8,400 out" while the Claude captioner runs. Numbers are the brain's.
  var usageLine: String? {
    guard isClaude, let u = usage else { return nil }
    return "Claude read \(Figures.count(u.frames, "screens")) · \(Format.count(u.inputTokens)) tokens in, \(Format.count(u.outputTokens)) out"
  }

  /// The needs-you line, as a sentence; nil when empty.
  var needsYouLine: String? {
    guard let n = needsYou?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty else { return nil }
    return BrainError.sentence(n)
  }
}
