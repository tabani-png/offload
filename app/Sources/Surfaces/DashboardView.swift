import SwiftUI

/// Dashboard window: the hero number (honestly labelled), automations with needs-you on top, a 7-day timeline
/// (one row per day, bars per span tinted by task, Offload's runs hatched), and the observer's state.
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
    VStack(alignment: .leading, spacing: 28) {
      if let d = model.data {
        if parts.contains(.hero) { HeroSection(data: d) }
        if parts.contains(.automations) { AutomationsSection(model: model, now: now) }
        if parts.contains(.timeline) { TimelineSection(model: model, data: d, now: now).id("section.timeline") }
        if parts.contains(.observing) { ObservingSection(model: model, observing: d.observing, now: now) }
      } else {
        EmptyState(title: "No automations yet.", message: "When you approve a workflow it shows up here\nwith the hours it saves.")
          .padding(.top, 80)
      }
    }
    .padding(.horizontal, 24)
    .padding(.top, 28)
    .padding(.bottom, 32)
    .frame(maxWidth: ReviewView.contentWidth + 48)
    .frame(maxWidth: .infinity)
  }
}

// MARK: hero

private struct HeroSection: View {
  var data: DashboardData
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let h = data.hours
    let counts = Dictionary(grouping: data.automations, by: \.state).mapValues(\.count)
    RingBox(padding: 20) {
      HStack(alignment: .top, spacing: 24) {
        VStack(alignment: .leading, spacing: 0) {
          Text("Hours saved this week").textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink2)
          HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(Format.hours(h.heroValue)).textStyle(Tokens.TypeScale.hero).monospacedDigit().foregroundStyle(p.ink1)
            Chip(text: h.isMeasured ? "Measured" : "Estimated", symbol: h.isMeasured ? "ruler" : "function")
          }
          .padding(.top, 6)
          if let m = h.measured, h.estimated > 0 {
            // Measured against estimated, on one neutral track: how much of the promise is real so far.
            HStack(spacing: 10) {
              ProgressHairline(fraction: m / h.estimated, height: 3).frame(width: 180)
              Text("\(Format.percent(m / h.estimated)) of the \(Format.hours(h.estimated)) estimate")
                .font(.system(size: 12)).monospacedDigit().foregroundStyle(p.ink2)
            }
            .padding(.top, 12)
          } else {
            Text(h.detail).font(.system(size: 12)).foregroundStyle(p.ink2).padding(.top, 10)
          }
          Text("Counts automations that ran this week. Measured is your time on the task before turning it on, minus after.")
            .font(.system(size: 11)).foregroundStyle(p.ink3)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 10)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(h.accessibilityLabel)
        Spacer(minLength: 0)
        VStack(alignment: .leading, spacing: 8) {
          count(counts[.active] ?? 0, "active", .done, p)
          count(counts[.readyForReview] ?? 0, "to review", .needsYou, p)
          count(counts[.needsYou] ?? 0, "needs you", .needsYou, p)
          if let paused = counts[.paused], paused > 0 { count(paused, "paused", .neutral, p) }
        }
        .padding(.top, 2)
      }
    }
  }

  private func count(_ n: Int, _ label: String, _ role: StatusRole, _ p: Palette) -> some View {
    HStack(spacing: 2) {
      StatusDot(role: n == 0 ? .neutral : role, size: 7)
      Text("\(n) \(label)").font(.system(size: 13)).monospacedDigit().foregroundStyle(n == 0 ? p.ink3 : p.ink1)
    }
  }
}

// MARK: automations

private struct AutomationsSection: View {
  @ObservedObject var model: DashboardModel
  var now: Date
  @Environment(\.colorScheme) private var scheme

  static let col: CGFloat = 112

  var body: some View {
    let p = Palette(scheme: scheme)
    let autos = model.automations
    WindowSection(title: "Automations", trailing: nil) {
      RingBox {
        HStack(spacing: 0) {
          Spacer()
          Text("Last run").frame(width: Self.col, alignment: .leading)
          Text("Next run").frame(width: Self.col, alignment: .leading)
          Text("Saved a week").frame(width: 92, alignment: .trailing)
        }
        .textStyle(Tokens.TypeScale.caption)
        .foregroundStyle(p.ink3)
        .padding(.horizontal, 16)
        .frame(height: 30)
        RowDivider(inset: 0)
        ForEach(Array(autos.enumerated()), id: \.element.id) { i, a in
          if i > 0 && a.state != .needsYou && autos[i - 1].state != .needsYou { RowDivider(inset: 40) }
          AutomationRow(automation: a, selected: model.selection.selectedId == a.id, now: now,
                        onConnect: { model.onConnect?($0) })
            .id("row.\(a.id)")
            .contentShape(Rectangle())
            .onTapGesture(count: 2) { if let wf = a.workflowId { model.onOpenWorkflow?(wf) } }
            .onTapGesture { model.select(a.id) }
        }
      }
      HStack(spacing: 6) {
        KeyHint(keys: ["J", "K"]); Text("select").padding(.trailing, 8)
        KeyHint(keys: ["P"]); Text("point to what needs you").padding(.trailing, 8)
        KeyHint(keys: ["↩"]); Text("open")
      }
      .font(.system(size: 12))
      .foregroundStyle(p.ink3)
    }
  }
}

private struct AutomationRow: View {
  let a: DashboardAutomation
  var selected: Bool
  var now: Date
  var onConnect: (Connector) -> Void
  @Environment(\.colorScheme) private var scheme

  init(automation: DashboardAutomation, selected: Bool, now: Date, onConnect: @escaping (Connector) -> Void) {
    self.a = automation
    self.selected = selected
    self.now = now
    self.onConnect = onConnect
  }

  var body: some View {
    let p = Palette(scheme: scheme)
    let needsYou = a.state == .needsYou
    let amber = p.status(.needsYou)
    HStack(alignment: .top, spacing: 0) {
      StatusDot(role: StatusRole.forWorkflow(a.state), size: 8)
        .frame(width: 24, height: 18)
        .padding(.trailing, 4)
        .pointerTarget("lead.\(a.id)")
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 8) {
          Text(a.name).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1).lineLimit(1)
          if a.state != .active { Chip(text: a.state.label, style: a.state == .paused || a.state == .drafting ? .neutral : .recommended) }
        }
        if let reason = a.needsYouReason, needsYou {
          Text(reason).font(.system(size: 12)).foregroundStyle(p.ink1.opacity(0.8))
            .fixedSize(horizontal: false, vertical: true)
            .pointerTarget("row.\(a.id)")
        }
        HStack(spacing: 6) {
          ForEach(a.connectors) { c in
            ConnectorChip(connector: c, compact: true, actionTarget: "conn.\(a.id).\(c.id)", onAction: onConnect)
          }
          if needsYou {
            HStack(spacing: 4) { Keycap(label: "P"); Text("show me").font(.system(size: 11)).foregroundStyle(p.ink3) }
              .padding(.leading, 4)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background { if !needsYou { Color.clear.pointerTarget("row.\(a.id)") } }
      Text(Format.runTime(a.lastRunAt, now: now, past: true))
        .font(.system(size: 12)).monospacedDigit().foregroundStyle(a.lastRunAt == nil ? p.ink3 : p.ink2)
        .frame(width: AutomationsSection.col, alignment: .leading).padding(.top, 1)
      Text(nextRun)
        .font(.system(size: 12)).monospacedDigit().foregroundStyle(a.nextRunAt == nil ? p.ink3 : p.ink2)
        .frame(width: AutomationsSection.col, alignment: .leading).padding(.top, 1)
      VStack(alignment: .trailing, spacing: 2) {
        Text(Format.hours(a.measuredHoursPerWeek ?? a.estimatedHoursPerWeek))
          .font(.system(size: 13, weight: .medium)).monospacedDigit()
          .foregroundStyle(a.state == .active ? p.ink1 : p.ink2)
        Text(a.measuredHoursPerWeek == nil ? "estimated" : "measured")
          .font(.system(size: 11)).foregroundStyle(p.ink3)
      }
      .frame(width: 92, alignment: .trailing)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 12)
    .background {
      let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
      if needsYou {
        shape.fill(amber.opacity(p.isDark ? 0.09 : 0.08))
          .overlay(shape.strokeBorder(amber.opacity(selected ? 0.7 : 0.35), lineWidth: selected ? 1.5 : 1))
          .padding(4)
      } else if selected {
        shape.fill(p.fillStrong).overlay(shape.strokeBorder(p.ringStrong, lineWidth: 1)).padding(4)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(a.name), \(a.state.label). \(a.needsYouReason ?? "")")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private var nextRun: String {
    switch a.state {
    case .readyForReview: return "After you approve"
    case .needsYou: return "Waiting on you"
    case .paused: return "Paused"
    case .drafting: return "Not yet"
    case .active: return a.nextRunAt.map { Format.runTime($0, now: now, past: false) } ?? "On schedule"
    }
  }
}

// MARK: timeline

struct TimelineSection: View {
  @ObservedObject var model: DashboardModel
  var data: DashboardData
  var now: Date
  @Environment(\.colorScheme) private var scheme

  static let labelWidth: CGFloat = 64
  static let rowHeight: CGFloat = 24

  var body: some View {
    let p = Palette(scheme: scheme)
    let layout = TimelineLayout.fitting(data.days)
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .center) {
        Text("This week").textStyle(Tokens.TypeScale.title).foregroundStyle(p.ink1).accessibilityAddTraits(.isHeader)
        Text("\(Format.hours(data.days.reduce(0) { $0 + $1.activeMinutes } / 60)) tracked")
          .font(.system(size: 12)).monospacedDigit().foregroundStyle(p.ink3).padding(.leading, 6)
        Spacer()
        SecondaryButton(title: "Show the evidence", key: "2") { model.showEvidence() }
          .pointerTarget("timeline.evidence")
      }
      RingBox(padding: 16) {
        VStack(alignment: .leading, spacing: 6) {
          axis(layout, p)
          ForEach(data.days) { day in row(day, layout: layout, p: p) }
          legend(p).padding(.top, 10)
        }
      }
    }
  }

  private func axis(_ layout: TimelineLayout, _ p: Palette) -> some View {
    HStack(spacing: 0) {
      Color.clear.frame(width: Self.labelWidth)
      GeometryReader { geo in
        ForEach(layout.hours.filter { $0 % 2 == 0 }, id: \.self) { h in
          Text(String(format: "%02d", h))
            .font(.system(size: 10)).monospacedDigit().foregroundStyle(p.ink3)
            .fixedSize()
            .position(x: geo.size.width * Double(h - layout.startHour) / Double(layout.endHour - layout.startHour), y: 6)
        }
      }
    }
    .frame(height: 12)
  }

  private func row(_ day: TimelineDay, layout: TimelineLayout, p: Palette) -> some View {
    let isToday = Calendar.current.isDate(day.date, inSameDayAs: now)
    return HStack(spacing: 0) {
      HStack(spacing: 4) {
        Text(Format.dayShort(day.date)).font(.system(size: 12)).monospacedDigit()
          .foregroundStyle(isToday ? p.ink1 : p.ink2)
      }
      .frame(width: Self.labelWidth, alignment: .leading)
      GeometryReader { geo in
        let w = geo.size.width
        ZStack(alignment: .leading) {
          // Hour grid, every 2 h.
          ForEach(layout.hours.filter { $0 % 2 == 0 }, id: \.self) { h in
            Rectangle().fill(p.ring.opacity(0.6)).frame(width: 1)
              .offset(x: w * Double(h - layout.startHour) / Double(layout.endHour - layout.startHour))
          }
          ForEach(day.bars) { bar in
            let e = layout.extent(bar, dayStart: day.date)
            BarView(bar: bar, tint: p.task(data.tasks.first { $0.id == bar.taskId }?.tint ?? 3))
              .frame(width: max(2, w * e.width), height: 14)
              .pointerTarget("bar.\(bar.id)")
              .offset(x: w * e.x)
              .help("\(Format.clock(bar.start))–\(Format.clock(bar.end)) · \(data.tasks.first { $0.id == bar.taskId }?.name ?? "")\(bar.automated ? " · Offload ran it" : "")")
          }
          if isToday {
            let x = layout.fraction(now, dayStart: day.date)
            Rectangle().fill(p.ink2).frame(width: 1.5, height: Self.rowHeight).offset(x: w * x)
            Text("now").font(.system(size: 10)).foregroundStyle(p.ink2).fixedSize().offset(x: w * x + 4, y: -1)
          }
        }
        .frame(height: Self.rowHeight)
      }
      .frame(height: Self.rowHeight)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(Format.dayMonth(day.date)): \(Format.hours(day.activeMinutes / 60)) tracked")
  }

  private func legend(_ p: Palette) -> some View {
    HStack(spacing: 14) {
      ForEach(data.tasks) { t in
        HStack(spacing: 6) {
          RoundedRectangle(cornerRadius: 3, style: .continuous).fill(p.task(t.tint)).frame(width: 14, height: 9)
          Text(t.name).font(.system(size: 12)).foregroundStyle(p.ink2)
        }
      }
      HStack(spacing: 6) {
        BarView(bar: TimelineBar(id: "legend", taskId: "", start: now, end: now, automated: true, title: "", counterparty: nil),
                tint: p.ink2)
          .frame(width: 14, height: 9)
        Text("Offload ran it, you reviewed").font(.system(size: 12)).foregroundStyle(p.ink2)
      }
      Spacer(minLength: 0)
    }
  }
}

/// One span. By hand: solid tint. Offload's run: a light tint with diagonal hatching and a ring, so it reads as
/// "not your time" even without colour.
struct BarView: View {
  var bar: TimelineBar
  var tint: Color

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 3, style: .continuous)
    if bar.automated {
      shape.fill(tint.opacity(0.22))
        .overlay(HatchShape(spacing: 3.5).stroke(tint.opacity(0.9), lineWidth: 1.2).clipShape(shape))
        .overlay(shape.strokeBorder(tint.opacity(0.9), lineWidth: 1))
    } else {
      shape.fill(tint)
    }
  }
}

// MARK: observing

private struct ObservingSection: View {
  @ObservedObject var model: DashboardModel
  var observing: ObservingState
  var now: Date
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let state: ObserverState = model.paused ? .paused : observing.state
    var shown = observing
    shown.state = state
    let role = StatusRole.forObserver(state)
    return WindowSection(title: "Observing", trailing: "Kept on this Mac, encrypted, \(observing.keepDays) days") {
      RingBox {
        HStack(spacing: 0) {
          StatusDot(role: role, pulses: role.pulses(context: .observer), size: 8).frame(width: 24)
          Text(shown.stateLabel).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1).padding(.leading, 4)
          Text(" · \(observing.daysLabel)").font(.system(size: 13)).monospacedDigit().foregroundStyle(p.ink2)
          Spacer()
          SecondaryButton(title: model.paused ? "Resume watching" : "Pause watching") { model.togglePause() }
        }
        .padding(.horizontal, 12).frame(height: 50)
        RowDivider(inset: 40)
        HStack(spacing: 0) {
          Image(systemName: "trash").font(.system(size: 11)).foregroundStyle(p.ink3).frame(width: 24)
          Text("Next purge").font(.system(size: 13)).foregroundStyle(p.ink2).frame(width: 112, alignment: .leading).padding(.leading, 4)
          Text(observing.purgeLabel(now: now)).font(.system(size: 13)).foregroundStyle(p.ink1)
          Spacer()
        }
        .padding(.horizontal, 12).frame(height: 40)
        RowDivider(inset: 40)
        HStack(spacing: 0) {
          Image(systemName: "hand.raised").font(.system(size: 11)).foregroundStyle(p.ink3).frame(width: 24)
          Text("Permissions").font(.system(size: 13)).foregroundStyle(p.ink2).frame(width: 112, alignment: .leading).padding(.leading, 4)
          HStack(spacing: 16) {
            ForEach(observing.permissions) { perm in
              HStack(spacing: 6) {
                Circle().fill(p.status(perm.role)).frame(width: 6, height: 6)
                Text(perm.name).font(.system(size: 13)).foregroundStyle(p.ink1)
                Text(perm.label).font(.system(size: 12)).foregroundStyle(p.ink3)
              }
              .accessibilityElement(children: .combine)
            }
          }
          Spacer()
        }
        .padding(.horizontal, 12).frame(height: 40)
      }
    }
  }
}
