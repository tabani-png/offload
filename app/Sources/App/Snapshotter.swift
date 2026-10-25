import AppKit
import SwiftUI

/// `Offload --snapshot DIR`: renders every component and surface offscreen in light and dark at 2x.
/// Needs no permissions. Each view is hosted in an NSHostingView inside an unshown window (that gives the size
/// and a real AppKit environment), then drawn with SwiftUI's ImageRenderer. `OFFLOAD_RENDERER=cachedisplay`
/// switches to NSView.cacheDisplay into an NSBitmapImageRep; that path clips SwiftUI shadows at layer bounds
/// (hard ticks at capsule corners), so it is kept only for comparison.
///
/// Limits, on purpose: behind-window blur cannot be captured offscreen, so glass is drawn with its simulated
/// fill over our own backdrop; pulses are frozen at a mid-phase; arrival animations show their rest state.
@MainActor
enum Snapshotter {
  static var scale: CGFloat = 2

  static func run(into dir: URL, scale: CGFloat = 2) -> Int32 {
    self.scale = scale
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      var written: [String] = []
      for scheme in [ColorScheme.dark, .light] {
        let suffix = scheme == .dark ? "dark" : "light"
        for (name, view) in surfaces() {
          let file = dir.appendingPathComponent("\(name)-\(suffix).png")
          try render(view, scheme: scheme, to: file)
          written.append(file.lastPathComponent)
        }
      }
      print("snapshot: wrote \(written.count) PNGs to \(dir.path)")
      written.forEach { print("  \($0)") }
      return 0
    } catch {
      FileHandle.standardError.write(Data("snapshot failed: \(error)\n".utf8))
      return 1
    }
  }

  // MARK: fixtures

  static let now = MockBrainClient.weekStart.addingTimeInterval(4 * 86_400 + 11 * 3600)
  static let status = ObserverStatus(state: .watching, daysStored: 4, windowDays: 7,
                                     nextPurge: now.addingTimeInterval(3 * 86_400), insightsWaiting: 3)

  static var rail: RailModel {
    RailModel(status: status, automations: MockBrainClient.sampleAutomations, micRecording: false)
  }

  static func state(_ build: (inout InboxState) -> Void = { _ in }) -> InboxState {
    var s = InboxState(insights: MockBrainClient.sampleInsights)
    build(&s)
    return s
  }

  static func surfaces() -> [(String, AnyView)] {
    let evidence = MockBrainClient.sampleEvidence[MockBrainClient.outreach.id]
    let base = state()
    let withEvidence = state { _ = $0.handle(.option(2), at: now) }
    let undo = state { _ = $0.handle(.option(1), at: now.addingTimeInterval(-1.6)) }
    let empty = InboxState(insights: [])
    let observer = rail.observerLabel

    func card(_ s: InboxState, ev: [EvidenceSpan]? = nil) -> AnyView {
      AnyView(Backdrop(padding: 28) {
        InsightCardView(state: s, evidence: ev, now: now, observerLabel: observer)
      })
    }

    return [
      ("components", AnyView(Backdrop(padding: 28) { ComponentSheet() })),
      ("rail", AnyView(Backdrop(padding: 28) {
        HStack(alignment: .top, spacing: 36) {
          RailView(rail: rail, hoveringStatus: false)
          RailView(rail: rail, hoveringStatus: true)
          RailView(rail: RailModel(
            status: ObserverStatus(state: .paused, daysStored: 4, windowDays: 7, nextPurge: now, insightsWaiting: 0),
            automations: [], micRecording: true), hoveringStatus: false)
        }
      })),
      ("card", card(base)),
      ("card-evidence", card(withEvidence, ev: evidence)),
      ("card-undo", card(undo)),
      ("card-empty", card(empty)),
      ("scene", AnyView(Scene(state: base, now: now, rail: rail))),
    ] + s08Surfaces() + s09aSurfaces()
  }

  // MARK: s09a fixtures

  static func onboardingModel(_ step: OnboardingStep, permissions: [PermissionState]? = nil,
                              granted: [PermissionState]? = nil) -> OnboardingModel {
    let m = OnboardingModel(readPermissions: { [] })
    m.preview(step: step, permissions: permissions, granted: granted)
    return m
  }

  static func onboardingChrome(_ m: OnboardingModel) -> AnyView {
    AnyView(Backdrop(padding: 32) {
      WindowChrome(title: "Welcome to Offload", subtitle: nil, width: OnboardingView.width) { OnboardingView(model: m) }
    })
  }

  static func s09aSurfaces() -> [(String, AnyView)] {
    let off = PermissionKind.allCases.map { PermissionState($0, granted: false) }
    var partly = off
    partly[0] = PermissionState(.screenRecording, granted: true)
    return [
      ("onboarding-watches", onboardingChrome(onboardingModel(.watches))),
      ("onboarding-permissions", onboardingChrome(onboardingModel(.permissions, permissions: off, granted: partly))),
      ("onboarding-comeback", onboardingChrome(onboardingModel(.comeBack))),
      ("review-real-schedule", {
        // The real brain's schedule note is a full sentence (live e2e); it must wrap, not widen the window.
        var w = MockBrainClient.outreachWorkflow
        w.schedule.summary = "Weekdays at 09:00 a new batch is drafted and waits for your review. · 20 a batch"
        let m = ReviewModel(workflow: w, dryRun: MockBrainClient.outreachDryRun, client: MockBrainClient(), clock: { reviewNow })
        return reviewChrome(m) { ReviewView(model: m, parts: [.header]) }
      }()),
      ("dashboard-permissions", dashboardChrome {
        DashboardView(model: dashboardModel(), parts: [.observing], frozenNow: reviewNow)
      }),
    ]
  }

  // MARK: s08 fixtures

  static let reviewNow = MockBrainClient.reviewNow

  static func reviewModel(_ keys: [(ReviewKey, Double)] = []) -> ReviewModel {
    let m = ReviewModel(workflow: MockBrainClient.outreachWorkflow, dryRun: MockBrainClient.outreachDryRun,
                        client: MockBrainClient(), clock: { reviewNow })
    m.preview(keys: keys.map { ($0.0, reviewNow.addingTimeInterval($0.1)) })
    return m
  }

  static func dashboardModel(pointer: PointerRequest? = nil) -> DashboardModel {
    let m = DashboardModel(client: MockBrainClient(), clock: { reviewNow })
    m.preview(MockBrainClient.sampleDashboard, pointer: pointer)
    return m
  }

  static let windowWidth: CGFloat = 820

  static func reviewChrome<C: View>(_ m: ReviewModel, @ViewBuilder _ content: () -> C) -> AnyView {
    AnyView(Backdrop(padding: 32) {
      WindowChrome(title: "Review workflow", subtitle: "Drafted from your week · \(m.workflow.state.label)",
                   toolbarItems: [ToolbarItemLook(symbol: "doc.text", title: nil)], width: windowWidth) { content() }
    })
  }

  static func dashboardChrome<C: View>(@ViewBuilder _ content: () -> C) -> AnyView {
    AnyView(Backdrop(padding: 32) {
      WindowChrome(title: "Offload", subtitle: "Dashboard", width: windowWidth) { content() }
    })
  }

  static func s08Surfaces() -> [(String, AnyView)] {
    let review = reviewModel()
    let confirm = reviewModel([(.approve, -2)])
    let armed = reviewModel([(.approve, -3), (.confirm, -1.6)])
    let evidencePointer = PointerRequest(targetId: "bar.\(MockBrainClient.evidenceBarId)", originId: "timeline.evidence",
                                         label: DashboardModel.evidenceLabel(
                                           MockBrainClient.timelineDays.flatMap(\.bars).first { $0.id == MockBrainClient.evidenceBarId }!,
                                           tasks: MockBrainClient.timelineTasks),
                                         startedAt: reviewNow)
    let crm = MockBrainClient.dashboardAutomations.first { $0.state == .needsYou }!
    let rowTarget = DashboardModel.pointerTarget(for: crm)
    let rowPointer = PointerRequest(targetId: rowTarget.id, originId: "lead.\(crm.id)", label: rowTarget.label, startedAt: reviewNow)
    let holdAt = reviewNow.addingTimeInterval(1.4 + 1.5)

    func confirmScene(_ m: ReviewModel) -> AnyView {
      reviewChrome(m) {
        ZStack(alignment: .top) {
          ReviewView(model: m, parts: [.header, .steps])
            .overlay(Color.black.opacity(0.28))
          // Sheets drop from the bottom of the toolbar.
          ConfirmSheet(model: m, frozenNow: reviewNow)
            .clipShape(UnevenRoundedRectangle(bottomLeadingRadius: 12, bottomTrailingRadius: 12, style: .continuous))
            .overlay(UnevenRoundedRectangle(bottomLeadingRadius: 12, bottomTrailingRadius: 12, style: .continuous)
              .strokeBorder(.white.opacity(0.10), lineWidth: 1))
            .compositingGroup()
            .shadow(color: .black.opacity(0.45), radius: 22, x: 0, y: 12)
        }
      }
    }

    return [
      ("review", reviewChrome(review) { ReviewView(model: review, parts: [.header, .steps, .tone]) }),
      ("review-dryrun", reviewChrome(review) { ReviewView(model: review, parts: [.dryRun]) }),
      ("review-confirm", confirmScene(confirm)),
      ("review-armed", confirmScene(armed)),
      ("review-skill", reviewChrome(review) {
        ZStack(alignment: .top) {
          ReviewView(model: review, parts: [.header, .steps]).overlay(Color.black.opacity(0.28))
          SkillSheet(model: review, editing: false)
            .clipShape(UnevenRoundedRectangle(bottomLeadingRadius: 12, bottomTrailingRadius: 12, style: .continuous))
            .compositingGroup()
            .shadow(color: .black.opacity(0.45), radius: 22, x: 0, y: 12)
        }
      }),
      ("dashboard", dashboardChrome { DashboardView(model: dashboardModel(), frozenNow: reviewNow) }),
      ("timeline", AnyView(TimelineSheet(model: dashboardModel()))),
      ("pointer", dashboardChrome {
        DashboardView(model: dashboardModel(pointer: evidencePointer), parts: [.hero, .automations, .timeline],
                      frozenNow: reviewNow, frozenPointerAt: holdAt)
      }),
      ("pointer-row", dashboardChrome {
        DashboardView(model: dashboardModel(pointer: rowPointer), parts: [.hero, .automations],
                      frozenNow: reviewNow, frozenPointerAt: holdAt)
      }),
    ]
  }

  // MARK: rendering

  static func render(_ view: AnyView, scheme: ColorScheme, to url: URL) throws {
    let root = view
      .environment(\.colorScheme, scheme)
      .environment(\.isSnapshot, true)
    let host = NSHostingView(rootView: root)
    host.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
    // Whole points: fractional sizes leave half-covered edge pixels that flatten to a dark hairline.
    let fit = host.fittingSize
    let size = CGSize(width: fit.width.rounded(.up), height: fit.height.rounded(.up))
    guard size.width > 0, size.height > 0 else { throw SnapshotError.emptyView(url.lastPathComponent) }
    host.frame = NSRect(origin: .zero, size: size)

    // An unshown window gives SwiftUI a real host environment; it is never ordered on screen.
    let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.appearance = host.appearance
    window.contentView = host
    host.layoutSubtreeIfNeeded()
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    host.layoutSubtreeIfNeeded()

    if ProcessInfo.processInfo.environment["OFFLOAD_RENDERER"] != "cachedisplay" {
      let r = ImageRenderer(content: root.frame(width: size.width, height: size.height))
      r.scale = scale
      guard let cg = r.cgImage, let opaque = flatten(cg) else { throw SnapshotError.bitmap }
      let bmp = NSBitmapImageRep(cgImage: opaque)
      guard let png = bmp.representation(using: .png, properties: [:]) else { throw SnapshotError.encode }
      try png.write(to: url)
      return
    }

    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { throw SnapshotError.bitmap }
    rep.size = size
    host.cacheDisplay(in: host.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else { throw SnapshotError.encode }
    try png.write(to: url)
  }

  /// Every snapshot sits on an opaque backdrop, so drop the alpha channel (smaller files).
  static func flatten(_ image: CGImage) -> CGImage? {
    guard let ctx = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    // Edge pixels come back partly transparent; under-paint with the backdrop's own corner colour so they
    // blend into the right tone instead of flattening to black.
    if let corner = image.cropping(to: CGRect(x: 4, y: 4, width: 1, height: 1)) {
      ctx.draw(corner, in: rect)
    }
    ctx.draw(image, in: rect)
    return ctx.makeImage()
  }

  enum SnapshotError: Error { case emptyView(String), bitmap, encode }
}

/// Our own backdrop: a soft dusk gradient (dark) or a pale morning one (light). Stands in for a desktop
/// so glass has something to sit on. No third-party wallpaper.
struct Backdrop<Content: View>: View {
  var padding: CGFloat
  @ViewBuilder var content: Content
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    content
      .padding(padding)
      .background(BackdropFill())
  }
}

struct BackdropFill: View {
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let dark = scheme == .dark
    ZStack {
      LinearGradient(
        colors: dark
          ? [Color(hex: 0x1C2333), Color(hex: 0x2A2C3E), Color(hex: 0x3A2F3C), Color(hex: 0x15161B)]
          : [Color(hex: 0xDCE3EE), Color(hex: 0xE8E6EE), Color(hex: 0xF1E7E1), Color(hex: 0xE6E9EF)],
        startPoint: .topLeading, endPoint: .bottomTrailing)
      RadialGradient(colors: [Color(hex: dark ? 0x46628F : 0xA9C3E6).opacity(dark ? 0.55 : 0.55), .clear],
                     center: .topTrailing, startRadius: 10, endRadius: 520)
      RadialGradient(colors: [Color(hex: dark ? 0x8A5A6A : 0xF3C9B5).opacity(dark ? 0.30 : 0.45), .clear],
                     center: .bottomLeading, startRadius: 10, endRadius: 480)
    }
  }
}

/// The full composition: a desktop with the rail at the right edge and the card beside it.
struct Scene: View {
  var state: InboxState
  var now: Date
  var rail: RailModel

  var body: some View {
    ZStack(alignment: .topTrailing) {
      BackdropFill()
      HStack(alignment: .top, spacing: Edge.margin + 2) {
        InsightCardView(state: state, evidence: nil, now: now, observerLabel: rail.observerLabel)
        RailView(rail: rail, hoveringStatus: false)
      }
      .padding(.top, 72)
      .padding(.trailing, Edge.margin)
    }
    .frame(width: 960, height: 640)
  }
}

/// Every s06 component on one sheet.
struct ComponentSheet: View {
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    Card(width: 520) {
      VStack(alignment: .leading, spacing: 18) {
        row("Type") {
          VStack(alignment: .leading, spacing: 4) {
            Text("Display 20 · Medium").textStyle(Tokens.TypeScale.display).foregroundStyle(p.ink1)
            Text("Title 15 · Medium").textStyle(Tokens.TypeScale.title).foregroundStyle(p.ink1)
            Text("Body 13 · secondary ink").textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
            Text("Caption 11 · tertiary ink").textStyle(Tokens.TypeScale.caption).foregroundStyle(p.ink3)
          }
        }
        row("Keycap") {
          HStack(spacing: 6) {
            Keycap(label: "1"); Keycap(label: "2"); Keycap(label: "J"); Keycap(label: "K"); Keycap(label: "E")
            Keycap(label: "esc"); Keycap(label: "⌥"); Keycap(label: "space"); Keycap(label: "1", pressed: true)
          }
        }
        row("Status") {
          HStack(spacing: 14) {
            dot(.working, "Working", pulses: true)
            dot(.needsYou, "Needs you")
            dot(.done, "Done")
            dot(.recording, "Recording", pulses: true)
            dot(.neutral, "Paused")
          }
        }
        row("Chip") {
          HStack(spacing: 6) {
            Chip(text: "Gmail", dot: .neutral)
            Chip(text: "Saves 20–24 h a week", style: .positive, symbol: "arrow.down.right")
            Chip(text: "Recommended", style: .recommended)
          }
        }
        row("Options") {
          VStack(spacing: 6) {
            OptionRow(number: 1, title: "Build the workflow", recommended: true)
            OptionRow(number: 2, title: "Show the evidence", state: .highlighted)
            OptionRow(number: 3, title: "Not now", state: .muted)
          }
        }
        row("Buttons") {
          HStack(spacing: 8) {
            PrimaryButton(title: "Approve and turn on")
            SecondaryButton(title: "Not now", key: "3")
          }
        }
        row("Progress") {
          VStack(spacing: 10) {
            ProgressHairline(fraction: 0.65)
            ProgressHairline(fraction: 0.4, role: .working)
          }
        }
        row("Section") {
          SectionHeader(title: "Evidence", trailing: "6 of 500 emails")
        }
        row("Empty") {
          EmptyState(title: "Nothing to decide.", message: "Still watching.", statusLabel: "Watching · Day 4 of 7")
        }
      }
      .padding(24)
    }
  }

  private func row<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
    HStack(alignment: .top, spacing: 16) {
      Text(label)
        .textStyle(Tokens.TypeScale.caption)
        .foregroundStyle(Palette(scheme: scheme).ink3)
        .frame(width: 64, alignment: .leading)
        .padding(.top, 3)
      content().frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func dot(_ role: StatusRole, _ label: String, pulses: Bool = false) -> some View {
    HStack(spacing: 0) {
      StatusDot(role: role, pulses: pulses)
      Text(label).font(.system(size: 12)).foregroundStyle(Palette(scheme: scheme).ink2)
    }
  }
}

/// The timeline on its own, on the window canvas, for a close look.
struct TimelineSheet: View {
  @ObservedObject var model: DashboardModel
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    TimelineSection(model: model, data: model.data!, now: Snapshotter.reviewNow)
      .padding(24)
      .frame(width: Snapshotter.windowWidth)
      .background(Palette(scheme: scheme).canvas)
  }
}
