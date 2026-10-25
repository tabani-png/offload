import Foundation

// s14 (DEFAULTS): which task finder the brain starts with. The app probes Ollama (GET 127.0.0.1:11434/api/tags,
// 1.5 s) and passes the result here. Healthy with an embedding model pulled: `serve --understanding v2 --embedder
// ollama --captioner auto --embed-model M` (`--captioner claude` when you opted in, also in v1). Otherwise `--understanding v1` (the captioner stays off) and the
// dashboard shows one needs-you line. OFFLOAD_UNDERSTANDING=v1|v2 overrides. The demo week never adds v2 flags.

/// What the Ollama probe saw. nil (no probe) reads as not running.
struct OllamaProbeResult: Equatable, Sendable {
  /// GET /api/tags answered 200.
  var reachable: Bool
  /// models[].name from the answer.
  var models: [String]

  static let notRunning = OllamaProbeResult(reachable: false, models: [])
}

enum UnderstandingDefaults {
  static let tagsURL = URL(string: "http://127.0.0.1:11434/api/tags")!
  static let probeTimeout: TimeInterval = 1.5
  static let overrideVariable = "OFFLOAD_UNDERSTANDING"
  /// brain/src/understanding/embed.ts OLLAMA_EMBED_MODELS, in the order the app prefers them.
  static let embedModels = ["qwen3-embedding:0.6b", "bge-m3"]

  static let fallbackNotice = "Local models are not running: Offload uses its simpler task finder until Ollama is running."

  struct Decision: Equatable, Sendable {
    /// "v1" or "v2"; nil = the brain's own default (the demo week).
    var version: String?
    /// Appended to `serve`.
    var arguments: [String]
    /// The dashboard's needs-you line, when Offload falls back.
    var notice: String?
    /// One line for the app log.
    var reason: String
  }

  /// `{"models":[{"name":"bge-m3:latest",...}]}` → the names (the `model` field when `name` is absent).
  static func parseTags(_ data: Data) -> [String] {
    guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let models = o["models"] as? [[String: Any]] else { return [] }
    return models.compactMap { ($0["name"] as? String) ?? ($0["model"] as? String) }
  }

  /// The pulled embedding model, as the brain's `--embed-model` names it: qwen3-embedding:0.6b first, else bge-m3
  /// (pulled as "bge-m3" or "bge-m3:latest").
  static func embedModel(in models: [String]) -> String? {
    let names = Set(models.map { $0.lowercased() })
    if names.contains("qwen3-embedding:0.6b") { return "qwen3-embedding:0.6b" }
    if names.contains("bge-m3") || names.contains("bge-m3:latest") { return "bge-m3" }
    return nil
  }

  /// `claudeVision`: the opt-in (ClaudeVisionSetting). On: `--captioner claude` in v1 and v2; off: v2 asks for
  /// `--captioner auto` (the brain picks Claude only when it allows it and an account is set up, else Ollama, else off).
  static func decide(probe: OllamaProbeResult?, environment env: [String: String], demo: Bool,
                     claudeVision: Bool = false) -> Decision {
    var d = base(probe: probe, environment: env, demo: demo, claudeVision: claudeVision)
    if !demo && claudeVision {
      if let i = d.arguments.firstIndex(of: "--captioner") { d.arguments.removeSubrange(i...(i + 1)) }
      d.arguments += ["--captioner", "claude"]
      d.reason += "; Claude reads screens (opted in)"
    }
    return d
  }

  private static func base(probe: OllamaProbeResult?, environment env: [String: String], demo: Bool,
                           claudeVision: Bool) -> Decision {
    if demo {
      return Decision(version: nil, arguments: [], notice: nil, reason: "demo week: the brain's defaults (v1, sample model)")
    }
    let forced = env[overrideVariable].flatMap { ["v1", "v2"].contains($0) ? $0 : nil }
    let model = (probe?.reachable ?? false) ? embedModel(in: probe?.models ?? []) : nil
    if forced == "v1" {
      return Decision(version: "v1", arguments: ["--understanding", "v1"], notice: nil, reason: "\(overrideVariable)=v1")
    }
    if let model {
      return Decision(version: "v2",
                      arguments: ["--understanding", "v2", "--embedder", "ollama", "--captioner", "auto", "--embed-model", model],
                      notice: nil, reason: "Ollama is running with \(model)")
    }
    if forced == "v2" {
      // Asked for v2 without a local embedding model: the brain's deterministic embedder, no captioner.
      return Decision(version: "v2", arguments: ["--understanding", "v2", "--embedder", "stub"], notice: nil,
                      reason: "\(overrideVariable)=v2 without an Ollama embedding model")
    }
    let why = (probe?.reachable ?? false) ? "Ollama has no embedding model pulled" : "Ollama is not running"
    return Decision(version: "v1", arguments: ["--understanding", "v1"], notice: fallbackNotice, reason: why)
  }
}
