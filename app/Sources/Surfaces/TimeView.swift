import SwiftUI

/// s23 "Your time": the dashboard's first page. It leads with where the time went (by task, by app, by kind of work),
/// then what could be faster with the hours it frees, then the kind of fix, and workflows last, only as the answer to
/// a finding. Every figure is the brain's own display (TimeScreen); nothing here computes, rounds or claims a share.
struct TimeView: View {
  @ObservedObject var model: DashboardModel
  @Environment(\.colorScheme) private var scheme

  /// Rows shown per dimension before "and N more".
  static let visibleRows = 6

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Tokens.Space.s32) {
      if let b = model.time {
        let screen = TimeScreen(b)
        header(screen, p)
        // Drawn in TimeScreen.sections order: breakdown, findings, then workflows.
        ForEach(screen.sections, id: \.self) { section in
          switch section {
          case .breakdown: breakdown(screen, p)
          case .findings: findings(screen, p)
          case .workflows: workflows(screen, p)
          }
        }
      } else if let problem = model.timeProblem {
        EmptyState(title: "Your time is not available yet.", message: problem)
          .padding(.top, Tokens.Space.s48)
      } else {
        EmptyState(title: "Reading your week.", message: "Where your time goes shows here in a moment.")
          .padding(.top, Tokens.Space.s48)
      }
    }
  }

  // MARK: header: the window and its total

  private func header(_ s: TimeScreen, _ p: Palette) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s12) {
      HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s12) {
        Text(TimeScreen.title).textStyle(Tokens.TypeScale.largeTitle).foregroundStyle(p.ink1)
          .accessibilityAddTraits(.isHeader)
        Text(s.windowLine).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
        Spacer(minLength: Tokens.Space.s12)
      }
      if model.timeWeekDays.count > 1 { dayPicker(p) }
    }
  }

  private func dayPicker(_ p: Palette) -> some View {
    let days: [String?] = [nil] + model.timeWeekDays.map { Optional($0) }
    return HStack(spacing: 0) {
      ForEach(days, id: \.self) { day in
        let selected = model.timeDay == day
        Button { model.showTimeDay(day) } label: {
          Text(day.map(TimeScreen.dayShort) ?? "Week").textStyle(Tokens.TypeScale.calloutEmphasis)
            .foregroundStyle(selected ? p.ink1 : p.ink3)
            .padding(.horizontal, Tokens.Space.s12)
            .frame(height: Tokens.Size.control - Tokens.Space.s4)
            .background { if selected { Capsule().fill(p.fillStrong).overlay(Capsule().strokeBorder(p.ring, lineWidth: Tokens.Layout.hairline)) } }
            .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .accessibilityAddTraits(selected ? .isSelected : [])
      }
    }
    .padding(Tokens.Space.nudge)
    .background(Capsule().fill(p.fill))
    .overlay(Capsule().strokeBorder(p.ring, lineWidth: Tokens.Layout.hairline))
    .fixedSize()
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Week or day")
  }

  // MARK: 1. where the time goes

  private func breakdown(_ s: TimeScreen, _ p: Palette) -> some View {
    WindowSection(title: "Where the time goes") {
      if s.sections == [.breakdown] && s.findings.isEmpty && s.rows(.task).isEmpty {
        RingBox(padding: Tokens.Space.s20) {
          Text(s.emptyLine).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
            .fixedSize(horizontal: false, vertical: true)
        }
      } else {
        VStack(alignment: .leading, spacing: Tokens.Space.s12) {
          tiles(s, p)
          dimensionPicker(p)
          rows(s, model.timeDimension, p)
        }
      }
    }
  }

  /// The total and the three largest kinds of work, as metrics.
  private func tiles(_ s: TimeScreen, _ p: Palette) -> some View {
    let kinds = Array(s.rows(.kind).prefix(3))
    return HStack(alignment: .top, spacing: Tokens.Space.s12) {
      tile(value: s.breakdown.total.display, label: s.breakdown.window.kind == .day ? "Tracked this day" : "Tracked this week", p)
      ForEach(kinds) { k in tile(value: k.hours, label: k.name, p) }
    }
  }

  private func tile(value: String, label: String, _ p: Palette) -> some View {
    RingBox(padding: Tokens.Space.s16) {
      VStack(alignment: .leading, spacing: Tokens.Space.s4) {
        Text(value).textStyle(Tokens.TypeScale.display).monospacedDigit().foregroundStyle(p.ink1)
        Text(label).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3).lineLimit(1)
      }
    }
  }

  private func dimensionPicker(_ p: Palette) -> some View {
    HStack(spacing: 0) {
      ForEach(TimeDimension.allCases) { d in
        let selected = model.timeDimension == d
        Button { model.timeDimension = d } label: {
          Text(d.title).textStyle(Tokens.TypeScale.calloutEmphasis)
            .foregroundStyle(selected ? p.ink1 : p.ink3)
            .padding(.horizontal, Tokens.Space.s12)
            .frame(height: Tokens.Size.control - Tokens.Space.s4)
            .background { if selected { Capsule().fill(p.fillStrong).overlay(Capsule().strokeBorder(p.ring, lineWidth: Tokens.Layout.hairline)) } }
            .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .accessibilityAddTraits(selected ? .isSelected : [])
      }
    }
    .padding(Tokens.Space.nudge)
    .background(Capsule().fill(p.fill))
    .overlay(Capsule().strokeBorder(p.ring, lineWidth: Tokens.Layout.hairline))
    .fixedSize()
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Break down by")
  }

  private func rows(_ s: TimeScreen, _ d: TimeDimension, _ p: Palette) -> some View {
    let all = s.rows(d)
    let shown = Array(all.prefix(Self.visibleRows))
    let top = max(shown.first?.share ?? 1, 0.0001)
    return RingBox {
      ForEach(Array(shown.enumerated()), id: \.element.id) { i, row in
        if i > 0 { RowDivider() }
        HStack(spacing: Tokens.Space.s12) {
          Text(row.name).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
            .lineLimit(1).truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
          // The bar is relative to the largest row; the hours are the brain's display.
          Capsule().fill(p.track)
            .frame(width: Tokens.Layout.placeColumn, height: Tokens.Space.s4)
            .overlay(alignment: .leading) {
              Capsule().fill(p.ink3).frame(width: Tokens.Layout.placeColumn * min(1, row.share / top), height: Tokens.Space.s4)
            }
            .accessibilityHidden(true)
          Text(row.hours).textStyle(Tokens.TypeScale.label).monospacedDigit().foregroundStyle(p.ink1)
            .frame(width: Tokens.Layout.receiptLabel, alignment: .trailing)
        }
        .padding(.horizontal, Tokens.Space.s16)
        .frame(minHeight: Tokens.Size.row)
        .accessibilityElement(children: .combine)
      }
      if all.count > shown.count {
        RowDivider()
        Text("and \(all.count - shown.count) more").textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
          .padding(.horizontal, Tokens.Space.s16)
          .frame(minHeight: Tokens.Size.row)
      }
    }
  }

  // MARK: 2. what could be faster (then the kind of fix)

  private func findings(_ s: TimeScreen, _ p: Palette) -> some View {
    WindowSection(title: TimeScreen.findingsTitle, trailing: s.fixKindsNote) {
      if s.findings.isEmpty {
        RingBox(padding: Tokens.Space.s20) {
          Text(s.noFindingsLine).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
        }
      } else {
        RingBox {
          ForEach(Array(s.findings.enumerated()), id: \.element.id) { i, f in
            if i > 0 { RowDivider() }
            finding(f, p)
          }
        }
      }
    }
  }

  private func finding(_ f: TimeScreen.Finding, _ p: Palette) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s4) {
      HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s12) {
        // Parts in TimeScreen order: name, hours freed, then the kind of fix when there is one.
        ForEach(Array(f.parts.enumerated()), id: \.offset) { _, part in
          switch part {
          case .name:
            // The task's own time opens the arithmetic line below (the same digits as its row above).
            Text(f.name).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1).lineLimit(1).truncationMode(.tail)
              .frame(maxWidth: .infinity, alignment: .leading)
          case .hours:
            Text(f.hoursLine).textStyle(Tokens.TypeScale.calloutEmphasis).monospacedDigit().foregroundStyle(p.ink1)
              .fixedSize()
          case .fixKind:
            if let label = f.fixLabel { Chip(text: label) }
          }
        }
      }
      Text(f.arithmetic).paragraphStyle(Tokens.TypeScale.footnote).monospacedDigit().foregroundStyle(p.ink3)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, Tokens.Space.s16)
    .padding(.vertical, Tokens.Space.s12)
    .accessibilityElement(children: .combine)
  }

  // MARK: 3. workflows, last, as the answer to a finding

  private func workflows(_ s: TimeScreen, _ p: Palette) -> some View {
    WindowSection(title: TimeScreen.workflowsTitle) {
      VStack(alignment: .leading, spacing: Tokens.Space.s8) {
        Text(TimeScreen.workflowsNote).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
          .fixedSize(horizontal: false, vertical: true)
        RingBox {
          ForEach(Array(s.workflows.enumerated()), id: \.element.id) { i, w in
            if i > 0 { RowDivider() }
            HStack(spacing: Tokens.Space.s12) {
              Text(w.name).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1).lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
              SecondaryButton(title: "Draft workflow") { model.openInsight(w.insightId) }
            }
            .padding(.horizontal, Tokens.Space.s16)
            .frame(minHeight: Tokens.Size.row + Tokens.Space.s8)
          }
        }
      }
    }
  }
}
