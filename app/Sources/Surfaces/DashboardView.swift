import AppKit
import SwiftUI

/// Dashboard window, s10d: a source-list sidebar (s23: Your time first, then Overview, Automations, This week,
/// Observing) and one page at a
/// time, the way a first-party Mac app separates an overview from its detail. Live, the sidebar sits in an
/// NSSplitViewController sidebar item (system material); snapshots draw the same rows in WindowChrome's sidebar
/// column. Every string comes from DashboardCopy or the s10d models.
struct DashboardSidebar: View {
  @ObservedObject var model: DashboardModel
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Tokens.Space.nudge) {
      ForEach(DashboardSection.allCases) { s in
        let selected = model.section == s
        Button { model.show(s) } label: {
          HStack(spacing: Tokens.Space.s8) {
            Image(systemName: s.symbol).symbolStyle(Tokens.TypeScale.Symbol.large)
              .foregroundStyle(selected ? p.ink1 : p.ink2)
              .frame(width: Tokens.Space.s20)
            Text(s.title).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
            Spacer(minLength: Tokens.Space.s4)
            badge(s, p)
          }
          .padding(.horizontal, Tokens.Space.s8)
          .frame(height: Tokens.Size.control - Tokens.Space.nudge)
          .background {
            if selected {
              RoundedRectangle(cornerRadius: Tokens.Radius.control, style: .continuous).fill(p.fillStrong)
            }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .help("\(s.title) \(s.shortcut)")
        .accessibilityAddTraits(selected ? .isSelected : [])
      }
      // s10f (M4): Connections is its own window; the sidebar reaches it (⌘K, as in the menu).
      Rectangle().fill(p.ring).frame(height: Tokens.Layout.hairline)
        .padding(.vertical, Tokens.Space.s8).padding(.horizontal, Tokens.Space.s8)
      ForEach(DashboardSidebarLink.allCases) { l in
        Button { model.onOpenConnections?() } label: {
          HStack(spacing: Tokens.Space.s8) {
            Image(systemName: l.symbol).symbolStyle(Tokens.TypeScale.Symbol.large).foregroundStyle(p.ink2)
              .frame(width: Tokens.Space.s20)
            Text(l.title).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
            Spacer(minLength: Tokens.Space.s4)
            Text(l.shortcut).textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
          }
          .padding(.horizontal, Tokens.Space.s8)
          .frame(height: Tokens.Size.control - Tokens.Space.nudge)
          .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .help("\(l.title) \(l.shortcut)")
      }
    }
    .padding(.horizontal, Tokens.Space.s12)
    .padding(.top, Tokens.Space.s8)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    // s10e: dimmed with the page while a sheet is up.
    .dimmed(model.sheetUp && !isSnapshot)
  }

  @Environment(\.isSnapshot) private var isSnapshot

  /// Amber only where something needs you.
  @ViewBuilder
  private func badge(_ s: DashboardSection, _ p: Palette) -> some View {
    switch s {
    case .automations:
      let n = model.automations.filter { $0.state == .needsYou || $0.state == .readyForReview }.count
      if n > 0 {
        HStack(spacing: Tokens.Space.s4) {
          Circle().fill(p.status(.needsYou)).frame(width: Tokens.Size.dotSmall, height: Tokens.Size.dotSmall)
          Text("\(n)").textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink2)
        }
        .accessibilityLabel("\(n) need you")
      }
    case .observing:
      if model.observerAction != .pause {
        Circle().fill(p.status(.needsYou)).frame(width: Tokens.Size.dotSmall, height: Tokens.Size.dotSmall)
          .accessibilityLabel("Not recording")
      }
    default:
      EmptyView()
    }
  }
}

/// The page for the selected section.
struct DashboardDetail: View {
  @ObservedObject var model: DashboardModel
  /// Snapshots: a fixed "now" for run times and the now-line, and the pointer frozen at this moment.
  var frozenNow: Date? = nil
  var frozenPointerAt: Date? = nil
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot

  var body: some View {
    let p = Palette(scheme: scheme)
    Group {
      if isSnapshot {
        content
      } else {
        ScrollViewReader { proxy in
          ScrollView { content }
            .onChange(of: model.pointer) { _, new in
              guard let id = new?.targetId else { return }
              withAnimation(Motion.outExpo(Tokens.Duration.slow)) { proxy.scrollTo(DashboardView.scrollId(for: id), anchor: .center) }
            }
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(p.canvas)
    .pointerLayer(model.pointer, frozenAt: frozenPointerAt)
    // s10e: auto-send and connect are sheets drawn in the window, attached under the toolbar.
    .attachedSheet(!isSnapshot && model.sheetUp) { DashboardSheetContent(model: model) }
  }

  private var now: Date { frozenNow ?? model.now }

  private var content: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s32) {
      if model.section == .time {
        // s23: the home page: where the time goes leads, workflows come last (TimeView, TimeScreen order).
        TimeView(model: model)
      } else if let d = model.data {
        let copy = DashboardCopy(d, now: now)
        switch model.section {
        case .time:
          EmptyView()
        case .overview:
          HeroSection(copy: copy)
          NeedsYouSection(model: model, copy: copy)
          ObservingSummary(model: model, observing: d.observing)
          // S2-13: last, under where your time goes. State only; "Connect…" is a quiet secondary, never the primary.
          if let c = model.company, CompanyEntry.showsOnDashboard(c.state) {
            WindowSection(title: CompanyCopy.title) {
              CompanySyncRow(status: c.status, state: c.state, now: now, onOpen: { model.onOpenCompany?() })
            }
          }
        case .automations:
          AutomationsSection(model: model, copy: copy)
        case .week:
          TimelineSection(model: model, data: d, now: now, tracked: copy.tracked).id("section.timeline")
        case .observing:
          ObservingSection(model: model, observing: d.observing, now: now)
          KeptFilesSection(model: model)
        }
      } else if let problem = model.problem {
        EmptyState(title: "The dashboard is not available yet.", message: problem)
          .padding(.top, Tokens.Space.s48)
      } else {
        EmptyState(title: "No automations yet.", message: "When you approve a workflow it shows up here\nwith the hours it saves.")
          .padding(.top, Tokens.Space.s48)
      }
    }
    .frame(maxWidth: ReviewView.contentWidth, alignment: .leading)
    .padding(.horizontal, Tokens.Space.s32)
    .padding(.top, Tokens.Space.s24)
    .padding(.bottom, Tokens.Space.s32)
    .frame(maxWidth: .infinity, alignment: .top)
  }
}

/// Fallback composition: sidebar and page side by side (live uses a split view controller, snapshots WindowChrome).
struct DashboardView: View {
  @ObservedObject var model: DashboardModel
  var frozenNow: Date? = nil
  var frozenPointerAt: Date? = nil
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    HStack(spacing: 0) {
      DashboardSidebar(model: model)
        .frame(width: Tokens.Layout.sidebar)
        .background(Palette(scheme: scheme).sidebarFill)
      DashboardDetail(model: model, frozenNow: frozenNow, frozenPointerAt: frozenPointerAt)
    }
  }

  /// Pointer targets live inside rows; scroll the row (or the timeline) into view first.
  static func scrollId(for target: String) -> String {
    if target.hasPrefix("bar.") { return "section.timeline" }
    let parts = target.split(separator: ".")
    return parts.count >= 2 ? "row.\(parts[1])" : target
  }
}

// MARK: overview

private struct HeroSection: View {
  var copy: DashboardCopy
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    WindowSection(title: copy.heroTitle) {
      RingBox(padding: Tokens.Space.s20) {
        HStack(alignment: .top, spacing: Tokens.Space.s24) {
          VStack(alignment: .leading, spacing: 0) {
            if let value = copy.heroValue {
              HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s12) {
                Text(value).textStyle(Tokens.TypeScale.hero).monospacedDigit().foregroundStyle(p.ink1)
                if let q = copy.heroQualifier { Chip(text: q) }
              }
            } else if let placeholder = copy.heroPlaceholder {
              // Nothing was saved, so no number is shown in the hero's place.
              Text(placeholder).textStyle(Tokens.TypeScale.largeTitle).foregroundStyle(p.ink1)
            }
            Text(copy.heroDetail)
              .paragraphStyle(Tokens.TypeScale.body).monospacedDigit().foregroundStyle(p.ink2)
              .fixedSize(horizontal: false, vertical: true)
              .padding(.top, Tokens.Space.s8)
            if let note = copy.heroNote {
              Text(note)
                .paragraphStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Tokens.Space.s12)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityElement(children: .combine)
          VStack(alignment: .leading, spacing: Tokens.Space.s8) {
            ForEach(copy.counts) { c in
              HStack(spacing: Tokens.Space.nudge) {
                StatusDot(role: c.n == 0 ? .neutral : c.role, size: Tokens.Size.dotSmall)
                Text("\(c.n) \(c.label)").textStyle(Tokens.TypeScale.body).monospacedDigit()
                  .foregroundStyle(c.n == 0 ? p.ink3 : p.ink1)
              }
            }
          }
          .fixedSize()
        }
      }
    }
  }
}

/// What needs you, on the overview: one line each, and the one action that clears it.
private struct NeedsYouSection: View {
  @ObservedObject var model: DashboardModel
  var copy: DashboardCopy
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let rows = model.automations.filter { $0.state == .needsYou || $0.state == .readyForReview }
    WindowSection(title: "Needs you", trailing: nil) {
      RingBox {
        if rows.isEmpty && model.allNotices.isEmpty {
          Text("Nothing needs you. Everything that is on is running.")
            .textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
            .padding(Tokens.Space.s16)
        }
        // s14: Offload's own lines first (no action here: they clear on their own once the cause is fixed).
        ForEach(Array(model.allNotices.enumerated()), id: \.offset) { i, line in
          if i > 0 { RowDivider(inset: Tokens.Space.s40) }
          HStack(alignment: .center, spacing: Tokens.Space.s12) {
            StatusDot(role: .needsYou, size: Tokens.Size.dot)
              .frame(width: Tokens.Space.s16, height: Tokens.Space.s16)
            Text(line).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink1)
              .fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .padding(.horizontal, Tokens.Space.s16)
          .padding(.vertical, Tokens.Space.s12)
          .accessibilityElement(children: .combine)
        }
        ForEach(Array(rows.enumerated()), id: \.element.id) { i, a in
          if i > 0 || !model.allNotices.isEmpty { RowDivider(inset: Tokens.Space.s40) }
          let row = copy.rows.first { $0.id == a.id }
          HStack(alignment: .center, spacing: Tokens.Space.s12) {
            StatusDot(role: .needsYou, size: Tokens.Size.dot)
              .frame(width: Tokens.Space.s16, height: Tokens.Space.s16)
            VStack(alignment: .leading, spacing: Tokens.Space.s4) {
              Text(a.name).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
              Text(row?.reason ?? (a.state == .readyForReview ? "Drafted from your week. Nothing runs until you approve it." : a.state.label))
                .paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
                .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // s10e (M8): the first item's action is the view's one white button.
            let primary = DashboardPrimary.overview(model.data ?? MockBrainClient.sampleDashboard) == .needsYou(a.id)
            if a.state == .needsYou, let c = a.connectors.first(where: { $0.state != .connected }) {
              let title = c.state == .missingEnv ? "Sign in to \(c.name)" : "Connect \(c.name)"
              if primary { PrimaryButton(title: title, key: "↩") { model.openConnect(c) } }
              else { SecondaryButton(title: title + "…") { model.openConnect(c) } }
            } else if let wf = a.workflowId {
              if primary { PrimaryButton(title: "Review", key: "↩") { model.onOpenWorkflow?(wf) } }
              else { SecondaryButton(title: "Review") { model.onOpenWorkflow?(wf) } }
            }
          }
          .padding(.horizontal, Tokens.Space.s16)
          .padding(.vertical, Tokens.Space.s12)
          .accessibilityElement(children: .combine)
        }
      }
    }
  }
}

/// One line on the overview: the observer's state, with the same action as the Observing page.
private struct ObservingSummary: View {
  @ObservedObject var model: DashboardModel
  var observing: ObservingState
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    var shown = observing
    shown.state = model.paused ? .paused : observing.state
    let role = StatusRole.forObserver(shown.state)
    return WindowSection(title: "Observing", trailing: "Kept on this Mac, encrypted, \(observing.keepDays) days") {
      RingBox {
        HStack(spacing: Tokens.Space.s8) {
          StatusDot(role: role, pulses: role.pulses(context: .observer), size: Tokens.Size.dot)
            .frame(width: Tokens.Space.s16)
          Text(shown.stateLabel).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
          Text(observing.daysLabel).textStyle(Tokens.TypeScale.body).monospacedDigit().foregroundStyle(p.ink2)
          Spacer()
          if case .permission = DashboardPrimary.overview(model.data ?? MockBrainClient.sampleDashboard),
             model.observerAction.duplicatesPermission {
            PrimaryButton(title: model.observerAction.title) { model.performObserverAction() }
          } else {
            SecondaryButton(title: model.observerAction.title) { model.performObserverAction() }
          }
        }
        .padding(.horizontal, Tokens.Space.s16).frame(height: Tokens.Size.toolbar - Tokens.Space.s4)
      }
    }
  }
}

// MARK: automations

private struct AutomationsSection: View {
  @ObservedObject var model: DashboardModel
  var copy: DashboardCopy
  @Environment(\.colorScheme) private var scheme

  static let col: CGFloat = Tokens.Layout.runColumn
  static let savedCol: CGFloat = Tokens.Layout.savedColumn

  var body: some View {
    let p = Palette(scheme: scheme)
    let autos = model.automations
    WindowSection(title: "Automations", trailing: nil) {
      if autos.isEmpty {
        // s10e (M4): nothing approved yet: say so, offer the one way forward, no table and no keys for no rows.
        RingBox(padding: Tokens.Space.s32) {
          VStack(spacing: Tokens.Space.s20) {
            EmptyState(title: AutomationsEmptyCopy.title, message: AutomationsEmptyCopy.message)
            PrimaryButton(title: AutomationsEmptyCopy.action, key: "⌥Space") { model.onOpenInbox?() }
          }
          .frame(maxWidth: .infinity)
        }
      } else {
      RingBox {
        HStack(spacing: 0) {
          Spacer()
          Text(copy.columns[0]).frame(width: Self.col, alignment: .leading)
          Text(copy.columns[1]).frame(width: Self.col, alignment: .leading)
          Text(copy.columns[2]).frame(width: Self.savedCol, alignment: .trailing)
        }
        .textStyle(Tokens.TypeScale.caption)
        .foregroundStyle(p.ink3)
        .padding(.horizontal, Tokens.Space.s16)
        .frame(height: Tokens.Size.control)
        .pointerObstacle("columns")
        RowDivider(inset: 0)
        ForEach(Array(autos.enumerated()), id: \.element.id) { i, a in
          if i > 0 { RowDivider(inset: Tokens.Space.s40) }
          if let row = copy.rows.first(where: { $0.id == a.id }) {
            AutomationRow(automation: a, row: row, selected: model.selection.selectedId == a.id, model: model)
              .id("row.\(a.id)")
              .contentShape(Rectangle())
              .onTapGesture(count: 2) { if let wf = a.workflowId { model.onOpenWorkflow?(wf) } }
              .onTapGesture { model.select(a.id) }
          }
        }
      }
      KeyLegend(items: [(["J", "K"], "select"), (["P"], "point to what needs you"), (["↩"], "open")])
        .pointerObstacle("legend")
      }
    }
  }
}

private struct AutomationRow: View {
  let a: DashboardAutomation
  var row: DashboardCopy.Row
  var selected: Bool
  @ObservedObject var model: DashboardModel
  @Environment(\.colorScheme) private var scheme

  init(automation: DashboardAutomation, row: DashboardCopy.Row, selected: Bool, model: DashboardModel) {
    self.a = automation
    self.row = row
    self.selected = selected
    self.model = model
  }

  var body: some View {
    let p = Palette(scheme: scheme)
    let needsYou = a.state == .needsYou
    HStack(alignment: .firstTextBaseline, spacing: 0) {
      StatusDot(role: StatusRole.forWorkflow(a.state), size: Tokens.Size.dot)
        .frame(width: Tokens.Space.s24, height: Tokens.Space.s16)
        .padding(.trailing, Tokens.Space.s4)
        .pointerTarget("lead.\(a.id)")
        .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 4 }
      VStack(alignment: .leading, spacing: Tokens.Space.s8) {
        HStack(spacing: Tokens.Space.s8) {
          Text(row.name).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1).lineLimit(1)
          if let chip = row.chip { Chip(text: chip, style: row.chipNeedsYou ? .recommended : .neutral) }
        }
        .pointerObstacle("name.\(a.id)")
        if let reason = row.reason {
          Text(reason).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink1)
            .fixedSize(horizontal: false, vertical: true)
            .pointerTarget("row.\(a.id)")
        }
        FlowLayout(spacing: Tokens.Space.s8) {
          ForEach(a.connectors) { c in
            ConnectorChip(connector: c, compact: true, actionTarget: "conn.\(a.id).\(c.id)") { model.openConnect($0) }
              .pointerObstacle("chip.\(a.id).\(c.id)")
          }
          if needsYou {
            HStack(spacing: Tokens.Space.s4) {
              Keycap(label: "P")
              Text("show me").textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
            }
            .pointerObstacle("hint.\(a.id)")
          }
        }
        if a.state == .active { autoSend(p) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background { if !needsYou { Color.clear.pointerTarget("row.\(a.id)") } }
      Text(row.lastRun)
        .textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(a.lastRunAt == nil ? p.ink3 : p.ink2)
        .frame(width: AutomationsSection.col, alignment: .leading)
        .pointerObstacle("last.\(a.id)")
      Text(row.nextRun)
        .textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(a.nextRunAt == nil ? p.ink3 : p.ink2)
        .frame(width: AutomationsSection.col, alignment: .leading)
        .pointerObstacle("next.\(a.id)")
      VStack(alignment: .trailing, spacing: Tokens.Space.nudge) {
        Text(row.saved)
          .textStyle(Tokens.TypeScale.label).monospacedDigit()
          .foregroundStyle(a.state == .active ? p.ink1 : p.ink2)
        Text(row.savedQualifier)
          .textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
      }
      .frame(width: AutomationsSection.savedCol, alignment: .trailing)
      .pointerObstacle("saved.\(a.id)")
    }
    .padding(.horizontal, Tokens.Space.s12)
    .padding(.vertical, Tokens.Space.s12)
    // s10f (P9): the whole row, so the pointer's label goes below it instead of over its columns.
    .pointerTarget("rowband.\(a.id)")
    .background {
      // Selection is neutral (s10a): amber stays on the dot and the chip, where it means "needs you".
      if selected {
        let shape = RoundedRectangle(cornerRadius: Tokens.Radius.inset, style: .continuous)
        shape.fill(p.fillStrong).overlay(shape.strokeBorder(p.ringStrong, lineWidth: Tokens.Layout.hairline)).padding(Tokens.Space.s4)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(row.name), \(a.state.label). \(row.reason ?? "")")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  /// "Waits for you to approve each batch · Send without asking…" or "Sends on its own to 37 people · Turn off".
  private func autoSend(_ p: Palette) -> some View {
    HStack(spacing: Tokens.Space.s8) {
      Text(a.autoRun
           ? "Sends on its own\(a.autoRunPeople.map { " to \($0) people" } ?? "")"
           : "Asks you before each batch")
        .textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
      // s10e (P12): a small bordered ghost button, not a link inside a table row.
      Button { a.autoRun ? model.turnOffAutoSend(a) : model.offerAutoSend(a) } label: {
        Text(a.autoRun ? "Turn off" : "Send without asking…")
          .textStyle(Tokens.TypeScale.calloutEmphasis).foregroundStyle(p.ink1)
          .padding(.horizontal, Tokens.Space.s8)
          .frame(height: Tokens.Size.chip)
          .overlay(Capsule().strokeBorder(p.ringStrong, lineWidth: Tokens.Layout.hairline))
          .contentShape(Capsule())
      }
      .buttonStyle(PressStyle())
    }
    .pointerObstacle("autosend.\(a.id)")
  }
}

// MARK: timeline

struct TimelineSection: View {
  @ObservedObject var model: DashboardModel
  var data: DashboardData
  var now: Date
  var tracked: String
  @Environment(\.colorScheme) private var scheme

  static let labelWidth: CGFloat = 64
  static let rowHeight: CGFloat = 24
  static let barHeight: CGFloat = 14

  /// s10e: the week on screen (the mock has the card's week and this week; live has this week).
  private var week: TimelineWeek { TimelineWeek.available(data).contains(model.week) ? model.week : .this }
  private var days: [TimelineDay] { week == .before ? data.beforeDays : data.days }
  /// The drawn bars per day: packed so every class keeps its minutes exactly (M6).
  private var drawn: [TimelineDay] {
    days.map { var d = $0; d.bars = TimelinePack.display(d.bars, focus: data.focusTaskId); return d }
  }

  var body: some View {
    let p = Palette(scheme: scheme)
    let shown = drawn
    let layout = TimelineLayout.fitting(shown).including(now, days: shown).evenSpan
    let share = WeekShare(days: shown, tasks: data.tasks)
    VStack(alignment: .leading, spacing: Tokens.Space.s12) {
      HStack(alignment: .center, spacing: Tokens.Space.s8) {
        Text(week.title).textStyle(Tokens.TypeScale.title).foregroundStyle(p.ink1).accessibilityAddTraits(.isHeader)
        Text("\(Figures.hours(share.trackedMinutes / 60)) tracked").textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink3)
        Spacer()
        if TimelineWeek.available(data).count > 1 { weekSwitch(p) }
        // The key is in the legend under the chart, so the "2" is never read as a count.
        SecondaryButton(title: "Show the evidence") { model.send(.evidence) }
          .pointerTarget("timeline.evidence")
      }
      .pointerObstacle("week.header")
      RingBox(padding: Tokens.Space.s16) {
        VStack(alignment: .leading, spacing: Tokens.Space.s8) {
          // s10e (M6): the share the card prints, on the chart that proves it.
          HStack(spacing: Tokens.Space.s8) {
            Spacer()
            Text(share.header).textStyle(Tokens.TypeScale.calloutEmphasis).monospacedDigit().foregroundStyle(p.ink1)
          }
          .pointerObstacle("share")
          axis(layout, p).pointerObstacle("axis")
          ForEach(shown) { day in row(day, layout: layout, p: p).pointerObstacle("row.\(day.id)") }
          legend(shown, p).padding(.top, Tokens.Space.s8).pointerObstacle("legend")
        }
      }
      if let line = proofLine {
        Text(line).paragraphStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink2)
          .fixedSize(horizontal: false, vertical: true)
          .pointerObstacle("proof")
      }
      KeyLegend(items: [(["2"], "point to the evidence")] + (TimelineWeek.available(data).count > 1 ? [(["W"], "switch week")] : []))
    }
  }

  /// This week, with the automation on and measured: the overview's hero, tied to these bars.
  private var proofLine: String? {
    guard week == .this, let a = data.automations.first(where: { $0.state == .active && $0.activatedAt != nil }),
          let on = a.activatedAt, let focus = a.taskId,
          let proof = MeasuredProof(before: data.beforeDays, after: data.days, focus: focus, activatedAt: on, now: now)
    else { return nil }
    return proof.line
  }

  private func weekSwitch(_ p: Palette) -> some View {
    HStack(spacing: 0) {
      ForEach(TimelineWeek.available(data), id: \.self) { w in
        Button { model.week = w } label: {
          Text(w.title).textStyle(Tokens.TypeScale.calloutEmphasis)
            .foregroundStyle(week == w ? p.ink1 : p.ink3)
            .padding(.horizontal, Tokens.Space.s12)
            .frame(height: Tokens.Size.control - Tokens.Space.s4)
            .background { if week == w { Capsule().fill(p.fillStrong).overlay(Capsule().strokeBorder(p.ring, lineWidth: Tokens.Layout.hairline)) } }
            .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
      }
    }
    .padding(Tokens.Space.nudge)
    .background(Capsule().fill(p.fill))
    .overlay(Capsule().strokeBorder(p.ring, lineWidth: Tokens.Layout.hairline))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Week")
  }

  private func x(_ h: Int, _ layout: TimelineLayout, _ w: CGFloat) -> CGFloat {
    w * Double(h - layout.startHour) / Double(layout.endHour - layout.startHour)
  }

  private func axis(_ layout: TimelineLayout, _ p: Palette) -> some View {
    HStack(spacing: 0) {
      Color.clear.frame(width: Self.labelWidth)
      GeometryReader { geo in
        ForEach(layout.ticks, id: \.self) { h in
          Text(String(format: "%02d", h))
            .textStyle(Tokens.TypeScale.micro).monospacedDigit().foregroundStyle(p.ink3)
            .fixedSize()
            .position(x: x(h, layout, geo.size.width), y: Tokens.Space.s8)
        }
      }
    }
    .frame(height: Tokens.Space.s16)
  }

  private func row(_ day: TimelineDay, layout: TimelineLayout, p: Palette) -> some View {
    let isToday = Calendar.current.isDate(day.date, inSameDayAs: now)
    return HStack(spacing: 0) {
      Text(Format.dayShort(day.date))
        .textStyle(isToday ? Tokens.TypeScale.calloutEmphasis : Tokens.TypeScale.callout).monospacedDigit()
        .foregroundStyle(isToday ? p.ink1 : p.ink2)
        .frame(width: Self.labelWidth, alignment: .leading)
        .pointerObstacle("day.\(day.id)")
      GeometryReader { geo in
        let w = geo.size.width
        ZStack(alignment: .leading) {
          ForEach(layout.ticks, id: \.self) { h in
            Rectangle().fill(p.ring).frame(width: Tokens.Layout.hairline).offset(x: x(h, layout, w))
          }
          ForEach(day.bars) { bar in
            let e = layout.extent(bar, dayStart: day.date)
            let width = max(bar.automated ? Tokens.Layout.runMinWidth : Tokens.Space.nudge, w * e.width)
            BarView(bar: bar, focus: bar.taskId == data.focusTaskId)
              .frame(width: width, height: bar.automated ? Self.rowHeight - Tokens.Space.s4 : Self.barHeight)
              .pointerTarget("bar.\(bar.id)")
              .offset(x: min(w * e.x, w - width))
              .help("\(Format.clock(bar.start)) · \(Figures.minutes(bar.drawnMinutes)) · \(name(bar.taskId))\(bar.automated ? " · Offload ran it; the block is your review time" : "")")
          }
          if isToday {
            let nx = layout.fraction(now, dayStart: day.date)
            Rectangle().fill(p.ink1).frame(width: Tokens.Layout.nowLine, height: Self.rowHeight).offset(x: w * nx)
            Text("now \(Format.clock(now))").textStyle(Tokens.TypeScale.micro).monospacedDigit().foregroundStyle(p.ink2).fixedSize()
              .padding(.horizontal, Tokens.Space.s4)
              .background(Capsule().fill(p.canvas.opacity(0.9)))
              .offset(x: w * nx + Tokens.Space.s4)
              .pointerObstacle("now")
          }
        }
        .frame(height: Self.rowHeight)
      }
      .frame(height: Self.rowHeight)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(Format.dayMonth(day.date)): \(Figures.hours(day.bars.reduce(0) { $0 + $1.drawnMinutes } / 60)) tracked")
  }

  private func name(_ taskId: String) -> String {
    taskId == data.focusTaskId ? (data.tasks.first { $0.id == taskId }?.name ?? "") : "Everything else"
  }

  /// The legend draws the very same BarView as the chart, so the swatch and the bar can never differ.
  private func legend(_ shown: [TimelineDay], _ p: Palette) -> some View {
    let focus = data.tasks.first { $0.tint == 0 }
    return FlowLayout(spacing: Tokens.Space.s16, lineSpacing: Tokens.Space.s8) {
      if let focus {
        item(Self.swatch(taskId: focus.id, automated: false), focus: true, text: "\(focus.name), by hand", p)
      }
      if shown.contains(where: { $0.bars.contains(where: \.automated) }) {
        item(Self.swatch(taskId: focus?.id ?? "", automated: true), focus: true, text: "Offload ran it, you reviewed", p)
      }
      item(Self.swatch(taskId: "other", automated: false), focus: false, text: "Everything else", p)
    }
  }

  private func item(_ bar: TimelineBar, focus: Bool, text: String, _ p: Palette) -> some View {
    HStack(spacing: Tokens.Space.s8) {
      BarView(bar: bar, focus: focus).frame(width: Tokens.Layout.runMinWidth, height: bar.automated ? Self.rowHeight - Tokens.Space.s4 : Self.barHeight)
      Text(text).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2).lineLimit(1).fixedSize()
    }
  }

  static func swatch(taskId: String, automated: Bool) -> TimelineBar {
    TimelineBar(id: "legend.\(taskId).\(automated)", taskId: taskId, start: .distantPast, end: .distantPast,
                automated: automated, title: "", counterparty: nil)
  }
}

/// One span. s10e (P3): by hand, the focus task is ink at 85% with a 1-px ring (white stays the primary's); everything
/// else is the neutral. Offload's run is a full-height block: 15% green fill and a 1.5-px green ring, at least 16 pt.
struct BarView: View {
  var bar: TimelineBar
  var focus: Bool
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.bar, style: .continuous)
    if bar.automated {
      let green = p.status(.done)
      shape.fill(green.opacity(0.15))
        .overlay(shape.strokeBorder(green, lineWidth: Tokens.Layout.nowLine))
    } else if focus {
      let ink = p.isDark ? Color.white : Color.black
      shape.fill(ink.opacity(TimelineInk.focusFill))
        .overlay(shape.strokeBorder(ink.opacity(TimelineInk.focusRing), lineWidth: Tokens.Layout.hairline))
    } else {
      shape.fill(p.task(3))
    }
  }
}

/// s10e: the dashboard's sheet, in the window.
struct DashboardSheetContent: View {
  @ObservedObject var model: DashboardModel
  var body: some View {
    if let s = model.connect { ConnectSheet(session: s) }
    else if model.autoSend != nil { AutoSendSheetView(model: model) }
  }
}

// MARK: observing

private struct ObservingSection: View {
  @ObservedObject var model: DashboardModel
  var observing: ObservingState
  var now: Date
  @Environment(\.colorScheme) private var scheme

  static let labelColumn: CGFloat = Tokens.Layout.labelColumn

  var body: some View {
    let p = Palette(scheme: scheme)
    let state: ObserverState = model.paused ? .paused : observing.state
    var shown = observing
    shown.state = state
    let role = StatusRole.forObserver(state)
    return WindowSection(title: "Observing", trailing: "Kept on this Mac, encrypted, \(observing.keepDays) days") {
      RingBox {
        HStack(spacing: Tokens.Space.s8) {
          StatusDot(role: role, pulses: role.pulses(context: .observer), size: Tokens.Size.dot)
            .frame(width: Tokens.Space.s16)
          Text(shown.stateLabel).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
          Text(observing.daysLabel).textStyle(Tokens.TypeScale.body).monospacedDigit().foregroundStyle(p.ink2)
          Spacer()
          // s10e (M8): the permission row below carries Open Settings; this row says where to look instead of repeating it.
          if model.observerAction.duplicatesPermission {
            Text("Allow Screen Recording below").textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
          } else {
            SecondaryButton(title: model.observerAction.title) { model.performObserverAction() }
          }
        }
        .padding(.horizontal, Tokens.Space.s16).frame(height: Tokens.Size.toolbar - Tokens.Space.s4)
        RowDivider(inset: Tokens.Space.s16)
        HStack(spacing: Tokens.Space.s8) {
          Text("Next deletion").textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
            .frame(width: Self.labelColumn, alignment: .leading)
          Text(observing.purgeLabel(now: now)).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
          Spacer()
        }
        .padding(.horizontal, Tokens.Space.s16).frame(height: Tokens.Size.row + Tokens.Space.s4)
        RowDivider(inset: Tokens.Space.s16)
        // s14: the Claude captioner opt-in, and what it read (the brain's numbers, formatted only).
        VStack(alignment: .leading, spacing: Tokens.Space.s8) {
          OptInRow(title: ClaudeVisionSetting.label, isOn: model.claudeVision, note: model.claudeVisionNote) {
            model.toggleClaudeVision()
          }
          if let usage = observing.captioner?.usageLine {
            Text(usage).textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink2)
              .padding(.leading, Tokens.Space.s32 + Tokens.Space.s12)
          }
        }
        .padding(.horizontal, Tokens.Space.s16).padding(.vertical, Tokens.Space.s12)
        RowDivider(inset: Tokens.Space.s16)
        // s14: the model router: this month's Claude spend against the budget, in one plain line.
        if let models = observing.models {
          HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
            Text("Models").textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
              .frame(width: Self.labelColumn, alignment: .leading)
            VStack(alignment: .leading, spacing: Tokens.Space.nudge) {
              Text(models.spendLine).textStyle(Tokens.TypeScale.body).monospacedDigit().foregroundStyle(p.ink1)
              if let line = models.captionsLine {
                Text(line).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
              }
            }
            Spacer()
          }
          .padding(.horizontal, Tokens.Space.s16).padding(.vertical, Tokens.Space.s12)
          RowDivider(inset: Tokens.Space.s16)
        }
        ForEach(Array(observing.permissions.enumerated()), id: \.element.id) { i, perm in
          if i > 0 { RowDivider(inset: Self.labelColumn + Tokens.Space.s24) }
          PermissionRow(permission: perm, header: i == 0 ? "Permissions" : nil,
                        style: PermissionButtonStyle.forRow(perm, primary: DashboardPrimary.observing(observing.permissions)))
        }
      }
    }
  }
}

/// Files with your content that the 7-day deletion does not touch (brain s10b keptFiles): said plainly, with
/// Reveal in Finder, so nothing is kept that you cannot find.
private struct KeptFilesSection: View {
  @ObservedObject var model: DashboardModel
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    WindowSection(title: "Kept until you delete them", trailing: nil) {
      RingBox {
        if model.keptFiles.isEmpty {
          Text("Nothing. Everything Offload saw is deleted after 7 days.")
            .textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2).padding(Tokens.Space.s16)
        }
        ForEach(Array(model.keptFiles.enumerated()), id: \.element.id) { i, f in
          if i > 0 { RowDivider(inset: Tokens.Space.s16) }
          HStack(spacing: Tokens.Space.s12) {
            VStack(alignment: .leading, spacing: Tokens.Space.nudge) {
              HStack(spacing: Tokens.Space.s8) {
                Text(f.name).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
                Text(f.size).textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink3)
              }
              Text(f.note).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Tokens.Space.s8)
            SecondaryButton(title: "Reveal in Finder") { model.onReveal?(f.path) }
          }
          .padding(.horizontal, Tokens.Space.s16).padding(.vertical, Tokens.Space.s8)
          .accessibilityElement(children: .combine)
        }
      }
      if !model.keptFiles.isEmpty {
        Text(KeptFileCopy.footer)
          .paragraphStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

/// One permission: what it is for, its real state from the observer, and Open Settings to the right pane (s09a).
/// Label column with no glyphs, so every label starts at the same x.
struct PermissionRow: View {
  var permission: PermissionState
  var header: String?
  /// s10e: one white Open Settings (the first missing permission Offload needs); optional ones are a quiet link.
  var style: PermissionButtonStyle = .secondary
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    HStack(spacing: Tokens.Space.s8) {
      Text(header ?? "").textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
        .frame(width: ObservingSection.labelColumn, alignment: .leading)
      Circle().fill(p.status(permission.role)).frame(width: Tokens.Size.dotSmall, height: Tokens.Size.dotSmall)
      VStack(alignment: .leading, spacing: Tokens.Space.nudge) {
        HStack(spacing: Tokens.Space.s8) {
          Text(permission.name).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
          Text(permission.label)
            .textStyle(Tokens.TypeScale.callout)
            .foregroundStyle(permission.role == .needsYou ? p.statusInk(.needsYou) : p.ink3)
        }
        if !permission.purpose.isEmpty {
          Text(permission.purpose).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
            .lineLimit(2).fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: Tokens.Space.s8)
      if permission.offersSettings, let url = permission.settingsURL {
        switch style {
        case .primary: PrimaryButton(title: "Open Settings") { SystemSettings.open(url) }
        case .secondary: SecondaryButton(title: "Open Settings") { SystemSettings.open(url) }
        case .quiet:
          Button { SystemSettings.open(url) } label: {
            Text("Open Settings").textStyle(Tokens.TypeScale.calloutEmphasis).foregroundStyle(p.ink2)
          }
          .buttonStyle(PressStyle())
        case .none: EmptyView()
        }
      }
    }
    .padding(.horizontal, Tokens.Space.s16).padding(.vertical, Tokens.Space.s8)
    .frame(minHeight: Tokens.Size.toolbar - Tokens.Space.s4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(permission.name), \(permission.label). \(permission.purpose)")
  }
}

// MARK: auto-send sheet

/// Turning auto-send on, then what the brain pinned it to (s10b autoRunPin), in plain words.
struct AutoSendSheetView: View {
  @ObservedObject var model: DashboardModel
  @Environment(\.colorScheme) private var scheme

  static let width: CGFloat = Tokens.Layout.confirmSheet - Tokens.Space.s48 * 2

  var body: some View {
    let p = Palette(scheme: scheme)
    let copy: AutoRunCopy? = {
      switch model.autoSend {
      case .offer(_, _, let name): return AutoRunCopy.offer(workflowName: name)
      case .result(let r): return AutoRunCopy(r)
      case nil: return nil
      }
    }()
    VStack(alignment: .leading, spacing: 0) {
      if let copy {
        Text(copy.title).paragraphStyle(Tokens.TypeScale.sheetTitle).foregroundStyle(p.ink1)
        Text(copy.summary).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.top, Tokens.Space.s8)
        if !copy.people.isEmpty {
          RingBox {
            VStack(alignment: .leading, spacing: 0) {
              ForEach(Array(copy.people.prefix(5).enumerated()), id: \.offset) { _, email in
                Text(email).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2).lineLimit(1)
                  .frame(height: Tokens.Space.s24)
              }
              if copy.people.count > 5 {
                Text("and \(copy.people.count - 5) more").textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
                  .frame(height: Tokens.Space.s24)
              }
            }
            .padding(.horizontal, Tokens.Space.s16).padding(.vertical, Tokens.Space.s8)
          }
          .padding(.top, Tokens.Space.s16)
        }
        if let detail = copy.detail {
          Text(detail).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, Tokens.Space.s12)
        }
        HStack(spacing: Tokens.Space.s8) {
          Spacer()
          if case .offer = model.autoSend {
            SecondaryButton(title: "Cancel", key: "esc") { model.dismissAutoSend() }
            PrimaryButton(title: model.autoSendWorking ? "Turning on…" : "Send without asking", key: "⌘↩") { model.confirmAutoSend() }
              .disabled(model.autoSendWorking)
          } else {
            PrimaryButton(title: "Done", key: "↩") { model.dismissAutoSend() }
          }
        }
        .padding(.top, Tokens.Space.s20)
      }
    }
    .padding(Tokens.Space.s24)
    .frame(width: Self.width)
    .background(p.sheetFill)
  }
}

/// Opens a System Settings pane. Snapshot renders never get here.
enum SystemSettings {
  static func open(_ url: URL) {
    NSWorkspace.shared.open(url)
  }
}
