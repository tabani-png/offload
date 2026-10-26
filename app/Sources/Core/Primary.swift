import Foundation

// s10e (DESIGN-REVIEW-3 M8): one white primary per view, and it is the action that unblocks the product.

/// The review window's footer primary.
enum ReviewPrimary: Equatable, Sendable {
  /// A step needs a connector that is not connected: connect it first; Approve is secondary.
  case connect(Connector)
  /// s10f (DESIGN-REVIEW-4 M3): the dry run came from the offline sample model, so nothing on screen is in your
  /// voice yet: run it again with your voice before anything else. Approve and Connect are secondary.
  case runWithVoice
  case approve

  /// s10f (M8): below this window width the primary uses its short title, so it never truncates.
  static let compactBelow: Double = 720

  static func forWorkflow(_ w: Workflow, sample: Bool = false) -> ReviewPrimary {
    if sample { return .runWithVoice }
    for s in w.steps {
      guard let id = s.connectorId, let c = w.connectors.first(where: { $0.id == id }), c.state != .connected else { continue }
      return .connect(c)
    }
    return .approve
  }

  var title: String { title(compact: false) }

  /// "Connect Google Sheets"; compact: "Connect Sheets" (a vendor prefix dropped). Sign-in, Run with my voice and
  /// Approve are short already.
  func title(compact: Bool) -> String {
    switch self {
    case .connect(let c):
      if c.state == .missingEnv { return "Sign in to \(c.name)" }
      return "Connect \(compact ? Self.shortName(c.name) : c.name)"
    case .runWithVoice: return "Run with my voice"
    case .approve: return "Approve"
    }
  }

  static func shortName(_ name: String) -> String {
    for prefix in ["Google ", "Microsoft ", "Apple ", "Zoho "] where name.hasPrefix(prefix) && name.count > prefix.count {
      return String(name.dropFirst(prefix.count))
    }
    return name
  }
}

/// Which dashboard action is the one white button.
enum DashboardPrimary: Equatable, Sendable {
  case needsYou(String)
  case permission(PermissionKind)

  /// Overview: the first needs-you automation's action; else the first missing permission Offload needs; else none.
  static func overview(_ d: DashboardData) -> DashboardPrimary? {
    if let a = DashboardOrder.sorted(d.automations).first(where: { $0.state == .needsYou || $0.state == .readyForReview }) {
      return .needsYou(a.id)
    }
    if let k = observing(d.observing.permissions) { return .permission(k) }
    return nil
  }

  /// Observing: the first required permission that is off.
  static func observing(_ rows: [PermissionState]) -> PermissionKind? {
    rows.first { $0.required && $0.grant == .notGranted }?.kind
  }
}

/// How a permission row's Open Settings is drawn.
enum PermissionButtonStyle: Equatable, Sendable {
  case primary, secondary, quiet, none

  static func forRow(_ p: PermissionState, primary: PermissionKind?) -> PermissionButtonStyle {
    guard p.offersSettings else { return .none }
    if p.kind != nil && p.kind == primary { return .primary }
    return p.required ? .secondary : .quiet
  }
}

extension ObserverAction {
  /// Open Settings on the observer row is the same as a permission row's: the row then says where to look instead.
  var duplicatesPermission: Bool {
    if case .openSettings = self { return true }
    return false
  }
}

extension OnboardingFlow {
  enum Primary: Equatable, Sendable {
    case next
    case openSettings(PermissionKind)
  }

  /// While Screen Recording (what insights need) is off on the permissions step, its Open Settings is the primary.
  var primary: Primary {
    if step == .permissions, let p = permissions.first(where: { $0.kind == .screenRecording && $0.grant == .notGranted }) {
      return .openSettings(p.kind ?? .screenRecording)
    }
    return .next
  }
}
