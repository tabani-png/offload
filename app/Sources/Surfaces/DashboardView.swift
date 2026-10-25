import AppKit
import SwiftUI

/// Dashboard window: time saved (only what was measured is a number; s10a), automations with what needs you on
/// top, a 7-day timeline (one row per day, neutral ink per task, Offload's runs hatched), and the observer's
/// state. Every string comes from DashboardCopy.
struct DashboardView: View {
  enum Part: CaseIterable { case hero, automations, timeline, observing }

  @ObservedObject var model: DashboardModel
  var parts: Set<Part> = Set(Part.allCases)
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
              withAnimation(Motion.outExpo(Tokens.Duration.slow)) { proxy.scrollTo(Self.scrollId(for: id), anchor: .center) }
            }
        }
      }
    }
    .background(p.canvas)
    .pointerLayer(model.pointer, frozenAt: frozenPointerAt)
  }

  /// Pointer targets live inside rows; scroll the row (or the timeline) into view first.
  static func scrollId(for target: String) -> String {
    if target.hasPrefix("bar.") { return "section.timeline" }
    let parts = target.split(separator: ".")
    return parts.count >= 2 ? "row.\(parts[1])" : target
  }

  private var now: Date { frozenNow ?? model.now }

  private var content: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s32) {
      if let d = model.data {
        let copy = DashboardCopy(d, now: now)
        if parts.contains(.hero) { HeroSection(copy: copy) }
        if parts.contains(.automations) { AutomationsSection(model: model, copy: copy) }
        if parts.contains(.timeline) { TimelineSection(model: model, data: d, now: now, tracked: copy.tracked).id("section.timeline") }
        if parts.contains(.observing) { ObservingSection(model: model, observing: d.observing, now: now) }
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
    .frame(maxWidth: .infinity)
  }
}

// MARK: hero

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
            Text(copy.heroNote)
              .paragraphStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
              .fixedSize(horizontal: false, vertical: true)
              .padding(.top, Tokens.Space.s12)
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

// MARK: automations

private struct AutomationsSection: View {
  @ObservedObject var model: DashboardModel
  var copy: DashboardCopy
  @Environment(\.colorScheme) private var scheme

  static let col: CGFloat = 112
  static let savedCol: CGFloat = 92

  var body: some View {
    let p = Palette(scheme: scheme)
    let autos = model.automations
    WindowSection(title: "Automations", trailing: nil) {
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
        RowDivider(inset: 0)
        ForEach(Array(autos.enumerated()), id: \.element.id) { i, a in
          if i > 0 { RowDivider(inset: Tokens.Space.s40) }
          if let row = copy.rows.first(where: { $0.id == a.id }) {
            AutomationRow(automation: a, row: row, selected: model.selection.selectedId == a.id,
                          onConnect: { model.onConnect?($0) })
              .id("row.\(a.id)")
              .contentShape(Rectangle())
              .onTapGesture(count: 2) { if let wf = a.workflowId { model.onOpenWorkflow?(wf) } }
              .onTapGesture { model.select(a.id) }
          }
        }
      }
      KeyLegend(items: [(["J", "K"], "select"), (["P"], "point to what needs you"), (["↩"], "open")])
    }
  }
}

private struct AutomationRow: View {
  let a: DashboardAutomation
  var row: DashboardCopy.Row
  var selected: Bool
  var onConnect: (Connector) -> Void
  @Environment(\.colorScheme) private var scheme

  init(automation: DashboardAutomation, row: DashboardCopy.Row, selected: Bool, onConnect: @escaping (Connector) -> Void) {
    self.a = automation
    self.row = row
    self.selected = selected
    self.onConnect = onConnect
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
        if let reason = row.reason {
          Text(reason).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink1)
            .fixedSize(horizontal: false, vertical: true)
            .pointerTarget("row.\(a.id)")
        }
        FlowLayout(spacing: Tokens.Space.s8) {
          ForEach(a.connectors) { c in
            ConnectorChip(connector: c, compact: true, actionTarget: "conn.\(a.id).\(c.id)", onAction: onConnect)
          }
          if needsYou {
            HStack(spacing: Tokens.Space.s4) {
              Keycap(label: "P")
              Text("show me").textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
            }
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background { if !needsYou { Color.clear.pointerTarget("row.\(a.id)") } }
      Text(row.lastRun)
        .textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(a.lastRunAt == nil ? p.ink3 : p.ink2)
        .frame(width: AutomationsSection.col, alignment: .leading)
      Text(row.nextRun)
        .textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(a.nextRunAt == nil ? p.ink3 : p.ink2)
        .frame(width: AutomationsSection.col, alignment: .leading)
      VStack(alignment: .trailing, spacing: Tokens.Space.nudge) {
        Text(row.saved)
          .textStyle(Tokens.TypeScale.label).monospacedDigit()
          .foregroundStyle(a.state == .active ? p.ink1 : p.ink2)
        Text(row.savedQualifier)
          .textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
      }
      .frame(width: AutomationsSection.savedCol, alignment: .trailing)
    }
    .padding(.horizontal, Tokens.Space.s12)
    .padding(.vertical, Tokens.Space.s12)
    .background {
      // Selection is neutral (s10a): amber stays on the dot and the chip, where it means "needs you".
      if selected {
        let shape = RoundedRectangle(cornerRadius: Tokens.Radius.inset, style: .continuous)
        shape.fill(p.fillStrong).overlay(shape.strokeBorder(p.ringStrong, lineWidth: 1)).padding(Tokens.Space.s4)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(row.name), \(a.state.label). \(row.reason ?? "")")
    .accessibilityAddTraits(selected ? .isSelected : [])
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

  var body: some View {
    let p = Palette(scheme: scheme)
    let layout = TimelineLayout.fitting(data.days).evenSpan
    VStack(alignment: .leading, spacing: Tokens.Space.s12) {
      HStack(alignment: .center, spacing: Tokens.Space.s8) {
        Text("This week").textStyle(Tokens.TypeScale.title).foregroundStyle(p.ink1).accessibilityAddTraits(.isHeader)
        Text(tracked).textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink3)
        Spacer()
        SecondaryButton(title: "Show the evidence", key: "2") { model.showEvidence() }
          .pointerTarget("timeline.evidence")
      }
      RingBox(padding: Tokens.Space.s16) {
        VStack(alignment: .leading, spacing: Tokens.Space.s8) {
          axis(layout, p)
          ForEach(data.days) { day in row(day, layout: layout, p: p) }
          legend(p).padding(.top, Tokens.Space.s8)
        }
      }
    }
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
    let bars = TimelineMerge.merge(day.bars)
    return HStack(spacing: 0) {
      Text(Format.dayShort(day.date))
        .textStyle(isToday ? Tokens.TypeScale.calloutEmphasis : Tokens.TypeScale.callout).monospacedDigit()
        .foregroundStyle(isToday ? p.ink1 : p.ink2)
        .frame(width: Self.labelWidth, alignment: .leading)
      GeometryReader { geo in
        let w = geo.size.width
        ZStack(alignment: .leading) {
          // Hour grid, at every labelled tick.
          ForEach(layout.ticks, id: \.self) { h in
            Rectangle().fill(p.ring).frame(width: 1).offset(x: x(h, layout, w))
          }
          ForEach(bars) { bar in
            let e = layout.extent(bar, dayStart: day.date)
            BarView(bar: bar, ink: p.task(rank(bar.taskId)))
              .frame(width: max(Tokens.Space.nudge, w * e.width), height: Self.barHeight)
              .pointerTarget("bar.\(bar.id)")
              .offset(x: w * e.x)
              .help("\(Format.clock(bar.start))–\(Format.clock(bar.end)) · \(name(bar.taskId))\(bar.automated ? " · Offload ran it, you reviewed" : "")")
          }
          if isToday {
            let nx = layout.fraction(now, dayStart: day.date)
            Rectangle().fill(p.ink1).frame(width: 1.5, height: Self.rowHeight).offset(x: w * nx)
            Text("now").textStyle(Tokens.TypeScale.micro).foregroundStyle(p.ink2).fixedSize()
              .offset(x: w * nx + Tokens.Space.s4, y: -Tokens.Space.s12)
          }
        }
        .frame(height: Self.rowHeight)
      }
      .frame(height: Self.rowHeight)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(Format.dayMonth(day.date)): \(Figures.hours(day.activeMinutes / 60)) tracked")
  }

  private func rank(_ taskId: String) -> Int { data.tasks.first { $0.id == taskId }?.tint ?? 3 }
  private func name(_ taskId: String) -> String { data.tasks.first { $0.id == taskId }?.name ?? "" }

  /// The legend draws the very same BarView as the chart, so the swatch and the bar can never differ.
  private func legend(_ p: Palette) -> some View {
    FlowLayout(spacing: Tokens.Space.s16, lineSpacing: Tokens.Space.s8) {
      ForEach(data.tasks) { t in
        HStack(spacing: Tokens.Space.s8) {
          BarView(bar: Self.swatch(taskId: t.id, automated: false), ink: p.task(t.tint))
            .frame(width: Tokens.Space.s16, height: Self.barHeight)
          Text(t.name).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2).lineLimit(1).fixedSize()
        }
      }
      if data.days.contains(where: { $0.bars.contains(where: \.automated) }) {
        HStack(spacing: Tokens.Space.s8) {
          BarView(bar: Self.swatch(taskId: data.tasks.first?.id ?? "", automated: true), ink: p.task(0))
            .frame(width: Tokens.Space.s16, height: Self.barHeight)
          Text("Offload ran it, you reviewed").textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
            .lineLimit(1).fixedSize()
        }
      }
    }
  }

  static func swatch(taskId: String, automated: Bool) -> TimelineBar {
    TimelineBar(id: "legend.\(taskId).\(automated)", taskId: taskId, start: .distantPast, end: .distantPast,
                automated: automated, title: "", counterparty: nil)
  }
}

/// One span. By hand: solid ink. Offload's run: a faint fill with diagonal hatching and a ring in the same ink,
/// so it reads as "not your time" without a colour.
struct BarView: View {
  var bar: TimelineBar
  var ink: Color

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.bar, style: .continuous)
    if bar.automated {
      shape.fill(ink.opacity(0.18))
        .overlay(HatchShape(spacing: 3.5).stroke(ink, lineWidth: 1.2).clipShape(shape))
        .overlay(shape.strokeBorder(ink, lineWidth: 1))
    } else {
      shape.fill(ink)
    }
  }
}

// MARK: observing

private struct ObservingSection: View {
  @ObservedObject var model: DashboardModel
  var observing: ObservingState
  var now: Date
  @Environment(\.colorScheme) private var scheme

  static let labelColumn: CGFloat = 120

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
          SecondaryButton(title: model.paused ? "Resume watching" : "Pause watching") { model.togglePause() }
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
        ForEach(Array(observing.permissions.enumerated()), id: \.element.id) { i, perm in
          if i > 0 { RowDivider(inset: Self.labelColumn + Tokens.Space.s24) }
          PermissionRow(permission: perm, header: i == 0 ? "Permissions" : nil)
        }
      }
    }
  }
}

/// One permission: what it is for, its real state from the observer, and Open Settings to the right pane (s09a).
/// Label column with no glyphs, so every label starts at the same x.
struct PermissionRow: View {
  var permission: PermissionState
  var header: String?
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
          Text(permission.purpose).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3).lineLimit(1)
        }
      }
      Spacer(minLength: Tokens.Space.s8)
      if permission.offersSettings, let url = permission.settingsURL {
        SecondaryButton(title: "Open Settings") { SystemSettings.open(url) }
      }
    }
    .padding(.horizontal, Tokens.Space.s16).padding(.vertical, Tokens.Space.s8)
    .frame(minHeight: Tokens.Size.toolbar - Tokens.Space.s4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(permission.name), \(permission.label). \(permission.purpose)")
  }
}

/// Opens a System Settings pane. Snapshot renders never get here.
enum SystemSettings {
  static func open(_ url: URL) {
    NSWorkspace.shared.open(url)
  }
}
