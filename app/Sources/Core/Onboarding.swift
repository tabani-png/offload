import Foundation

// s09a first run: one small window, three calm steps. 1 what Offload watches and what it never stores; 2 the
// permissions, ticking on live as they are granted; 3 "Come back in a few days", with "Use demo week" for anyone
// who wants to see an insight now.

enum OnboardingStep: Int, CaseIterable, Sendable {
  /// s14: `context` is the optional "What do you do?" step (role and industry), between permissions and come back.
  case watches, permissions, context, comeBack

  var title: String {
    switch self {
    case .watches: return "Offload watches how you work, on this Mac"
    case .permissions: return "Allow what it needs"
    case .context: return ContextStepState.title
    case .comeBack: return "Come back in a few days"
    }
  }

  var counter: String { "\(rawValue + 1) of \(Self.allCases.count)" }
}

struct OnboardingFlow: Equatable, Sendable {
  private(set) var step: OnboardingStep = .watches
  private(set) var permissions: [PermissionState] = PermissionState.unknownRows
  /// Kinds that turned on while this window was open, for the tick.
  private(set) var justGranted: Set<PermissionKind> = []
  /// s14: the context step's two fields.
  var context = ContextStepState()

  static let watches: [String] = [
    "Which app and window are in front, and for how long",
    "The text on screen, read on this Mac and masked before it is saved",
    "How many keys and clicks, never which ones",
  ]

  static let neverStores: [String] = [
    "Passwords, banking and private windows: skipped entirely",
    "Card, account and ID numbers, one-time codes and keys: masked before writing",
    "Anything older than 7 days: deleted",
  ]

  static let localNote = "Everything is kept on this Mac, encrypted. With a Claude account set up, masked text, and masked screens, go to that account to read and draft. Nothing else leaves."

  static let comeBackBody = "Offload needs a few ordinary workdays to see what repeats. When a task starts to repeat, a dot appears on the rail. Nothing to do until then."

  mutating func next() {
    if let n = OnboardingStep(rawValue: step.rawValue + 1) { step = n }
  }

  mutating func back() {
    if let p = OnboardingStep(rawValue: step.rawValue - 1) { step = p }
  }

  /// s14: Continue on the context step: moves on and returns what to send (nil when both fields are empty).
  mutating func continueContext() -> UserContext? {
    guard step == .context else { return nil }
    let c = context.context
    next()
    return c
  }

  /// s14: Skip on the context step: moves on, the fields are cleared and nothing is sent.
  mutating func skipContext() {
    guard step == .context else { return }
    context = ContextStepState()
    next()
  }

  var isLast: Bool { step == .comeBack }
  var isFirst: Bool { step == .watches }

  /// Applies a fresh read; returns the kinds that just turned on.
  @discardableResult
  mutating func update(_ rows: [PermissionState]) -> Set<PermissionKind> {
    let before = Set(permissions.filter { $0.grant == .granted }.compactMap(\.kind))
    let after = Set(rows.filter { $0.grant == .granted }.compactMap(\.kind))
    let new = after.subtracting(before)
    // The first read is not "turning on": only changes seen while the window is open tick.
    let firstRead = permissions.allSatisfy { $0.grant == .unknown }
    permissions = rows
    if !firstRead { justGranted.formUnion(new) }
    return firstRead ? [] : new
  }

  var requiredMissing: [PermissionState] { permissions.filter { $0.required && $0.grant == .notGranted } }

  var primaryTitle: String {
    switch step {
    case .watches: return "Continue"
    case .permissions: return requiredMissing.isEmpty ? "Continue" : "Continue for now"
    case .context: return "Continue"
    case .comeBack: return "Done"
    }
  }

  /// Under the permission rows: what happens if one is left off.
  var permissionsNote: String {
    if permissions.contains(where: { $0.grant == .unknown }) {
      return "The observer is not answering yet, so these show as unknown. You can grant them now anyway."
    }
    if requiredMissing.isEmpty { return "All set." }
    let names = requiredMissing.map(\.name).joined(separator: " and ")
    return "You can continue now. Without \(names), Offload sees less until you turn \(requiredMissing.count == 1 ? "it" : "them") on, here or in the dashboard."
  }
}

/// Whether to show the first-run window.
enum OnboardingGate {
  static let defaultsKey = "ai.offload.onboarded.v1"

  static func shouldShow(arguments: [String], onboarded: Bool) -> Bool {
    if arguments.contains("--onboarding") { return true }
    let quiet = ["--skip-onboarding", "--mock", "--snapshot", "--open-card", "--open-review", "--open-dashboard", "--qa-glass"]
    if arguments.contains(where: quiet.contains) { return false }
    return !onboarded
  }
}

/// The demo week: the brain's fixture generator writes seven synthetic days ending yesterday into a demo home,
/// never into the real one.
enum DemoWeek {
  /// Seven days back from today, so the week ends yesterday.
  static func startDay(now: Date, calendar: Calendar = .current) -> String {
    let start = calendar.date(byAdding: .day, value: -7, to: calendar.startOfDay(for: now))!
    let c = calendar.dateComponents([.year, .month, .day], from: start)
    return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
  }

  /// scratch/demo in the repo, else a separate folder beside the real home.
  static func home(repo: URL?, appSupport: URL) -> URL {
    if let repo { return repo.appendingPathComponent("scratch/demo", isDirectory: true) }
    return appSupport.appendingPathComponent("Offload Demo", isDirectory: true)
  }

  /// `bun run brain/fixtures/gen.ts --out DIR --start DAY --encrypted` (raw key files: OFFLOAD_KEYS=file mode).
  static func generatorArguments(repo: URL, out: URL, start: String) -> [String] {
    ["run", repo.appendingPathComponent("brain/fixtures/gen.ts").path, "--out", out.path, "--start", start, "--encrypted"]
  }

  /// Refuses to seed into the real home (or anything that is not clearly a demo folder).
  static func isSafeDemoHome(_ demo: URL, realHome: URL) -> Bool {
    let d = demo.standardizedFileURL.path
    let r = realHome.standardizedFileURL.path
    if d == r || r.hasPrefix(d + "/") || d.hasPrefix(r + "/") { return false }
    let last = demo.lastPathComponent.lowercased()
    return last.contains("demo")
  }
}

/// How the app was asked to run (argv + env). Pure, so it is tested.
struct LaunchOptions: Equatable, Sendable {
  enum Brain: Equatable, Sendable {
    case mock
    /// Attach to a brain someone else started (`--brain-url URL`, token in OFFLOAD_TOKEN).
    case attach(URL)
    /// Launch and supervise the brain.
    case spawn
  }
  var brain: Brain
  var home: URL
  var demo: Bool
  var dryRunLimit: Int

  static func defaultHome(userHome: String = NSHomeDirectory()) -> URL {
    URL(fileURLWithPath: userHome).appendingPathComponent("Library/Application Support/Offload", isDirectory: true)
  }

  static func parse(arguments a: [String], environment env: [String: String], userHome: String = NSHomeDirectory()) -> LaunchOptions {
    func value(_ flag: String) -> String? {
      guard let i = a.firstIndex(of: flag), a.indices.contains(i + 1), !a[i + 1].hasPrefix("--") else { return nil }
      return a[i + 1]
    }
    let brain: Brain
    if a.contains("--mock") { brain = .mock }
    else if let u = value("--brain-url").flatMap(URL.init(string:)) { brain = .attach(u) }
    else { brain = .spawn }
    let homePath = value("--home") ?? env["OFFLOAD_HOME"].flatMap { $0.isEmpty ? nil : $0 }
    let home = homePath.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath, isDirectory: true) }
      ?? defaultHome(userHome: userHome)
    let limit = (value("--dry-run-limit") ?? env["OFFLOAD_DRYRUN_LIMIT"]).flatMap(Int.init).map { min(50, max(1, $0)) } ?? 5
    return LaunchOptions(brain: brain, home: home, demo: a.contains("--demo"), dryRunLimit: limit)
  }
}
