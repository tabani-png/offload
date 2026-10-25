import Foundation

// s10e (DESIGN-REVIEW-3 M8): one white primary per view, and it is the action that unblocks the product.

/// The review window's footer primary.
enum ReviewPrimary: Equatable, Sendable {
  /// A step needs a connector that is not connected: connect it first; Approve is secondary.
  case connect(Connector)
  case approve

  static func forWorkflow(_ w: Workflow) -> ReviewPrimary {
    for s in w.steps {
      guard let id = s.connectorId, let c = w.connectors.first(where: { $0.id == id }), c.state != .connected else { continue }
      return .connect(c)
    }
    return .approve
  }

  var title: String {
    switch self {
    case .connect(let c): return c.state == .missingEnv ? "Sign in to \(c.name)" : "Connect \(c.name)"
    case .approve: return "Approve"
    }
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
