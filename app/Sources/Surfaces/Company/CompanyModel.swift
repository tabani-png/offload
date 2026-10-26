import Combine
import Foundation

/// S2-13: state for the Company window, its notice and share sheets, and the sync status the rail and the dashboard
/// show. Every request goes through `CompanyService`, which refuses anything but the acknowledgement before the
/// notice is read. Nothing here sends a workflow on its own: sharing is preview, then an explicit confirm.
@MainActor
final class CompanyModel: ObservableObject {
  enum Sheet: Equatable {
    case notice
    case share(SharePreview)
  }

  enum Connect: Equatable {
    case idle
    case waiting
    case failed(String)
  }

  @Published private(set) var status: CompanyStatus = .empty
  @Published private(set) var connect: Connect = .idle
  @Published private(set) var sheet: Sheet?
  @Published private(set) var showSource = false
  @Published private(set) var shareQueued = false
  @Published private(set) var busy = false
  @Published private(set) var message: String?
  @Published private(set) var workflows: [Automation] = []
  /// The pending sign-in page, while waiting: "Open sign-in page again" reopens it only when the person asks.
  @Published private(set) var signInURL: URL?

  /// Opens a link in the browser (the self-view). Never the sign-in page: the brain opens that itself.
  var onOpenURL: ((URL) -> Void)?

  let service: CompanyService
  private let loadWorkflows: @Sendable () async -> [Automation]
  private var connectTask: Task<Void, Never>?

  init(service: CompanyService, loadWorkflows: @escaping @Sendable () async -> [Automation] = { [] }) {
    self.service = service
    self.loadWorkflows = loadWorkflows
  }

  var syncState: CompanySyncState {
    if connect == .waiting { return .connecting }
    return CompanySyncState(status)
  }

  var selfViewURL: URL? { CompanySelfView.url(status) }
  var canShare: Bool { CompanyGate.allows(.share, status: status) }

  // MARK: actions

  /// The window's refresh (toolbar, on appear): a failure says so in one calm line.
  func refresh() {
    Task {
      do {
        status = try await service.refresh()
        message = nil
        await reloadWorkflows()
      } catch {
        message = CompanyError.message(for: error)
      }
    }
  }

  /// The app's background read (launch, the refresh timer, opening the dashboard): never an error. A brain without
  /// company sync reads as not set up, so the rail shows nothing and the menu offers a calm "Connect your company…".
  func refreshQuietly() async {
    let wasChecking = syncState == .checkingNotice
    let s = await service.statusQuietly()
    if s != status { status = s }
    // The notice arrived after sign-in (the brain read the config late): bring it up once, as connect would have.
    if wasChecking, status.waitingForNotice, sheet == nil, connect == .idle { sheet = .notice }
  }

  private func reloadWorkflows() async {
    workflows = status.isConnected ? await loadWorkflows().filter { $0.status != .draft } : []
  }

  /// The white button in the window: Connect, Read the notice, or nothing once syncing.
  func primary() {
    switch syncState {
    case .notConnected, .revoked: startConnect()
    case .waitingForNotice: openNotice()
    default: break
    }
  }

  func startConnect() {
    guard connect != .waiting else { return }
    connect = .waiting
    message = nil
    connectTask = Task { [weak self] in
      guard let self else { return }
      do {
        // The brain opened the sign-in page when it started the flow; here we only wait for it to finish.
        let pending: @Sendable (URL) -> Void = { url in Task { @MainActor in self.signInURL = url } }
        self.status = try await self.service.connect(onPending: pending)
        self.signInURL = nil
        self.connect = .idle
        await self.reloadWorkflows()
        if self.status.waitingForNotice { self.sheet = .notice }
      } catch {
        self.signInURL = nil
        self.connect = .failed(CompanyError.message(for: error))
        self.status = (try? await self.service.refresh()) ?? self.status
      }
    }
  }

  /// The person closed the sign-in tab: open the same pending page again (the brain does not reopen a running flow).
  func reopenSignIn() {
    if connect == .waiting, let url = signInURL { onOpenURL?(url) }
  }

  func openNotice() {
    guard status.notice != nil else { return }
    sheet = .notice
  }

  func acknowledge() {
    guard !busy else { return }
    busy = true
    Task {
      defer { busy = false }
      do {
        status = try await service.acknowledgeNotice()
        sheet = nil
      } catch {
        message = CompanyError.message(for: error)
      }
    }
  }

  func share(workflowId: String) {
    guard !busy else { return }
    busy = true
    Task {
      defer { busy = false }
      do {
        let p = try await service.sharePreview(workflowId: workflowId)
        showSource = false
        shareQueued = false
        sheet = .share(p)
      } catch {
        message = CompanyError.message(for: error)
      }
    }
  }

  func confirmShare() {
    guard case .share(let p) = sheet, !shareQueued, !busy else {
      if shareQueued { dismissSheet() }
      return
    }
    busy = true
    Task {
      defer { busy = false }
      do {
        let done = try await service.confirmShare(workflowId: p.localWorkflowId, hash: p.hash)
        sheet = .share(done)
        shareQueued = done.confirmed
      } catch {
        message = CompanyError.message(for: error)
        sheet = nil
      }
    }
  }

  func toggleSource() { showSource.toggle() }

  /// Esc: close the sheet. The notice stays required; nothing else is sent while it is unread.
  func dismissSheet() {
    sheet = nil
    shareQueued = false
    showSource = false
  }

  func openSelfView() {
    if let url = selfViewURL { onOpenURL?(url) }
  }

  func togglePause() {
    guard !busy else { return }
    busy = true
    let pause = !CompanyControls.isPaused(status)
    Task {
      defer { busy = false }
      do { status = try await service.setPaused(pause) } catch { message = CompanyError.message(for: error) }
    }
  }

  // MARK: snapshots

  func preview(status: CompanyStatus, connect: Connect = .idle, sheet: Sheet? = nil, showSource: Bool = false,
               queued: Bool = false, workflows: [Automation] = [], signIn: URL? = nil) {
    self.status = status
    self.signInURL = signIn
    self.connect = connect
    self.sheet = sheet
    self.showSource = showSource
    self.shareQueued = queued
    self.workflows = workflows
  }
}

// MARK: samples

/// One fictional company for snapshots and the mock brain. Nothing real: no tenant, no addresses, no tokens.
enum CompanySamples {
  static let control = URL(string: "https://acme.offload.example")!
  static let notice = CompanyNotice(
    noticeVersionId: "3f6c2a1e-9b0d-4c4e-8f57-2d1a6b7c9e10",
    title: "How Offload works at Acme Robotics",
    markdown: """
    ## Why we use Offload
    Offload helps you hand repetitive work to automations you approve. The company uses the **results** to see which \
    workflows save time, so we can share the good ones with every team.

    ## Your choices
    - You can pause sharing at any time from the Company window.
    - You can see everything the company holds about you on the web.
    - Questions go to people-ops@acme.example.

    Retention: workflow results are kept for 24 months as team totals.
    """,
    features: [.workflowMetrics])

  static func status(_ phase: CompanyPhase, acknowledged: Bool = true, lastSync: Date? = nil, queued: Int = 0,
                     features: [CompanyFeature: Bool] = [.workflowMetrics: true, .perPersonViews: false, .workingTime: false]) -> CompanyStatus {
    var s = CompanyStatus.empty
    s.phase = phase
    s.controlURL = phase == .notConfigured ? nil : control
    guard phase == .connected || phase == .paused else { return s }
    s.tenantId = "7d1e0c8a-5b2f-4a3e-9c61-0f4b2d8e6a35"
    s.tenantName = "Acme Robotics"
    s.paused = phase == .paused
    s.notice = notice
    s.noticeAcknowledged = acknowledged
    s.features = features
    s.featuresKnown = true
    s.lastSyncAt = lastSync
    s.queued = queued
    return s
  }

  static let workflows = [
    Automation(id: "wf-outreach", name: "Follow up on demo requests", status: .running, hoursSavedEstimated: 3.5, hoursSavedMeasured: 3.1),
    Automation(id: "wf-invoices", name: "File supplier invoices", status: .running, hoursSavedEstimated: 1.8, hoursSavedMeasured: nil),
    Automation(id: "wf-standup", name: "Write the Monday update", status: .paused, hoursSavedEstimated: 0.6, hoursSavedMeasured: nil),
  ]

  static let proposal = """
  {"confirmed":false,"proposal":{"id":"01JAZ3S5D0V1CE0000000000AC","kind":"workflow_proposal","createdAt":1761400200000,\
  "localWorkflowId":"wf-outreach","workflowId":null,"version":null,"name":"Follow up on demo requests",\
  "description":"Drafts a follow-up for each new demo request and logs it in the team sheet.",\
  "trigger":{"type":"cron","cron":"0 9 * * 1-5","timezone":"America/New_York"},"steps":[\
  {"id":"read","title":"Read new demo requests","detail":"From the shared inbox","class":"read","capability":"mail.read",\
  "connection":{"kind":"gmail","ownership":"company","connectionId":null,"label":"Gmail"},"gate":"none"},\
  {"id":"draft","title":"Draft a follow-up","detail":"In your voice","class":"draft","capability":"mail.draft","connection":null,"gate":"none"},\
  {"id":"send","title":"Send the follow-ups","detail":"After you approve","class":"commit","capability":"mail.send",\
  "connection":{"kind":"gmail","ownership":"company","connectionId":null,"label":"Gmail"},"gate":"approval"},\
  {"id":"log","title":"Log each reply","detail":"One row per request","class":"commit","capability":"sheet.append",\
  "connection":{"kind":"composio_org","ownership":"company","connectionId":null,"label":"Google Sheets"},"gate":"none"}],\
  "skillMd":"# Follow up on demo requests\\nWrite to [address] about [link].","factsKeys":["product_name","pricing_page","calendar_link"],\
  "limits":{"maxItemsPerRun":25,"maxRunsPerDay":1},"definitionHash":"\(String(repeating: "ab", count: 32))"}}
  """

  static var share: SharePreview { try! SharePreview.decode(Data(proposal.utf8)) }
}

/// In-memory company for the mock brain (`--mock`) and snapshots. Connect "signs in" at once; nothing leaves.
actor MockCompanyAPI: CompanyAPI {
  private var current: CompanyStatus

  init(_ status: CompanyStatus = CompanySamples.status(.notConnected)) { current = status }

  func status() async throws -> CompanyStatus { current }

  func connect() async throws -> URL {
    current = CompanySamples.status(.connected, acknowledged: false)
    return CompanySamples.control.appendingPathComponent("auth/login")
  }

  func acknowledge(noticeVersionId: String) async throws { current.noticeAcknowledged = true }
  func sharePreview(workflowId: String) async throws -> SharePreview { CompanySamples.share }

  func confirmShare(workflowId: String, hash: String) async throws -> SharePreview {
    var p = CompanySamples.share
    p.confirmed = true
    return p
  }

  func setPaused(_ paused: Bool) async throws -> CompanyStatus {
    current.paused = paused
    current.phase = paused ? .paused : .connected
    return current
  }

  func refreshConfig() async throws {}
}
