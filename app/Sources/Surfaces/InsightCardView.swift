import AppKit
import SwiftUI

/// The insight card plus its detached hint. Pure render of (state, evidence, now): the live wrapper feeds a
/// ticking clock while an undo window runs; snapshots pass a fixed time. Every string comes from CardCopy (s10a).
///
/// Keys, the same on every surface (s10a SPEC "Keycaps"): J next and K previous, shown in that order; 1/2/3 choose;
/// E dismisses the insight; Esc undoes a pending choice, otherwise it closes the card.
struct InsightCardView: View {
  var state: InboxState
  var evidence: [EvidenceSpan]?
  var now: Date
  var pressedOption: Int? = nil
  var observerLabel: String = "Watching"
  var onConnect: (Connector) -> Void = { _ in }
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(spacing: Tokens.Space.s12) {
      Card {
        if let insight = state.current {
          content(insight)
            .id(insight.id)
            .transition(.rise(reduceMotion: reduceMotion))
        } else {
          empty
            .transition(.rise(reduceMotion: reduceMotion))
        }
      }
      .animation(Motion.outExpo(), value: state.current?.id)
      .animation(Motion.outExpo(), value: state.evidenceOpen)
      .animation(Motion.outExpo(Tokens.Duration.fast), value: state.pending)

      if !state.isEmpty && state.pending == nil {
        hint.transition(.opacity)
      }
    }
  }

  // MARK: insight

  @ViewBuilder
  private func content(_ insight: Insight) -> some View {
    let p = Palette(scheme: scheme)
    let copy = CardCopy(insight)
    header(p)
      .padding(.horizontal, Tokens.Space.s20)
      .padding(.top, Tokens.Space.s16)

    VStack(alignment: .leading, spacing: 0) {
      // s10d: broken where both lines come out even, so "your week" is never left alone on line two.
      Text(BalancedWrap.lines(copy.title, width: Self.titleWidth, measure: Self.measureTitle).joined(separator: "\n"))
        .paragraphStyle(Tokens.TypeScale.display)
        .foregroundStyle(p.ink1)
        .fixedSize(horizontal: false, vertical: true)
      Text(copy.facts)
        .textStyle(Tokens.TypeScale.body)
        .monospacedDigit()
        .foregroundStyle(p.ink2)
        .padding(.top, Tokens.Space.s8)
      ProgressHairline(fraction: insight.timeShare)
        .padding(.top, Tokens.Space.s12)
        .accessibilityLabel("Share of tracked time")
    }
    .padding(.horizontal, Tokens.Space.s20)
    .padding(.top, Tokens.Space.s12)

    Well {
      if let chip = copy.savingChip {
        Chip(text: chip, style: .positive)
      }
      arithmetic(copy.arithmetic, p)
      // s10d: the likely range belongs to the receipt it qualifies, as its footnote.
      Text(copy.range).textStyle(Tokens.TypeScale.footnote).monospacedDigit().foregroundStyle(p.ink3)
        .fixedSize(horizontal: false, vertical: true)
      HStack(alignment: .center, spacing: Tokens.Space.s8) {
        Text(copy.usesLabel).textStyle(Tokens.TypeScale.caption).foregroundStyle(p.ink3)
        FlowLayout(spacing: Tokens.Space.s8) {
          ForEach(insight.connectors) { c in ConnectorChip(connector: c) { onConnect($0) } }
        }
      }
      if state.evidenceOpen {
        evidenceList(insight, copy, p)
          .transition(.rise(reduceMotion: reduceMotion))
      }
    }
    .padding(.horizontal, Tokens.Space.s8)
    .padding(.top, Tokens.Space.s16)

    options(insight)
      .padding(.horizontal, Tokens.Space.s8)
      .padding(.top, Tokens.Space.s8)
      .padding(.bottom, state.pending == nil ? Tokens.Space.s8 : Tokens.Space.s16)

    if let pending = state.pending {
      pendingStrip(pending, p)
        .transition(.opacity)
    }
  }

  private func header(_ p: Palette) -> some View {
    HStack(spacing: Tokens.Space.s8) {
      StatusDot(role: .needsYou, size: Tokens.Size.dotSmall)
        .frame(width: Tokens.Space.s12, height: Tokens.Space.s12)
      Text("Insight").textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink2)
      Text(state.positionLabel).textStyle(Tokens.TypeScale.label).monospacedDigit().foregroundStyle(p.ink3)
      Spacer()
      if state.insights.count > 1 {
        // J next, K previous: the order the hint and the dashboard use. The key that has nowhere to go is
        // dimmed, the way a disabled control is.
        Keycap(label: "J").opacity(state.index == state.insights.count - 1 ? 0.4 : 1)
          .help("J: next insight")
        Keycap(label: "K").opacity(state.index == 0 ? 0.4 : 1)
          .help("K: previous insight")
      }
    }
  }

  /// The brain's arithmetic as a receipt: what each line is, how it is worked out, and the hours a week on the
  /// right. Digits are the brain's own; only the unit moves to the column note.
  private func arithmetic(_ steps: [ArithmeticStep], _ p: Palette) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s4) {
      HStack {
        Spacer()
        Text("a week").textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
      }
      ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
        let last = i == steps.count - 1
        if last { Rectangle().fill(p.ring).frame(height: Tokens.Layout.hairline) }
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
          Text(s.label).textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
            .frame(width: Self.receiptLabel, alignment: .leading)
          Text(s.formula).textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink2)
            .lineLimit(1).truncationMode(.middle)
          Spacer(minLength: Tokens.Space.s8)
          Text(s.result)
            .textStyle(last ? Tokens.TypeScale.calloutEmphasis : Tokens.TypeScale.callout)
            .monospacedDigit().foregroundStyle(last ? p.ink1 : p.ink2)
            .fixedSize()
        }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(steps.map { "\($0.label): \($0.text)" }.joined(separator: ". "))
  }

  static let receiptLabel: CGFloat = Tokens.Layout.receiptLabel
  /// The title's measure: the card less its 20-pt sides.
  static let titleWidth: Double = 400 - Tokens.Space.s20 * 2

  static func measureTitle(_ s: String) -> Double {
    let style = Tokens.TypeScale.display
    let font = NSFont.systemFont(ofSize: style.size, weight: .medium)
    return Double((s as NSString).size(withAttributes: [.font: font, .kern: style.tracking]).width)
  }

  private func options(_ insight: Insight) -> some View {
    let chosen: Int? = {
      switch state.pending?.action {
      case .build: return 1
      case .notNow: return 3
      default: return nil
      }
    }()
    let rows: [(Int, String, Bool)] = [
      (1, "Build the workflow", true),
      (2, state.evidenceOpen ? "Hide the evidence" : "Show the evidence", false),
      (3, "Not now", false),
    ]
    return VStack(spacing: Tokens.Space.s8) {
      ForEach(rows, id: \.0) { n, title, rec in
        OptionRow(number: n, title: title, recommended: rec,
                  state: rowState(n, chosen: chosen),
                  pressed: pressedOption == n)
          .help(n == 3 ? "3: not now, until tomorrow. E: dismiss this insight for good." : "")
      }
    }
  }

  private func rowState(_ n: Int, chosen: Int?) -> OptionRow.State {
    guard state.pending != nil else { return n == 2 && state.evidenceOpen ? .highlighted : .idle }
    return n == chosen ? .chosen : .muted
  }

  private func evidenceList(_ insight: Insight, _ copy: CardCopy, _ p: Palette) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s8) {
      Rectangle().fill(p.ring).frame(height: Tokens.Layout.hairline).padding(.vertical, Tokens.Space.nudge)
      if let spans = evidence {
        let e = EvidenceCopy(spans: spans, insight: insight)
        SectionHeader(title: e.header, trailing: e.trailing)
        // Fixed columns, so every subject starts at the same x whatever the sender's name.
        VStack(alignment: .leading, spacing: Tokens.Space.s4) {
          // Two lines, like a mail list: who and when, then the subject with the whole width.
          ForEach(e.rows) { row in
            VStack(alignment: .leading, spacing: 0) {
              HStack(spacing: Tokens.Space.s8) {
                Text(row.who ?? row.subject)
                  .textStyle(Tokens.TypeScale.calloutEmphasis).foregroundStyle(p.ink1)
                  .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: Tokens.Space.s8)
                Text(row.time)
                  .textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink3)
              }
              HStack(spacing: Tokens.Space.s8) {
                Text(row.who == nil ? "" : row.subject)
                  .textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
                  .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: Tokens.Space.s8)
                Text(row.duration)
                  .textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink3)
              }
            }
            .padding(.vertical, Tokens.Space.nudge)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(row.time), \(row.who.map { "\($0), " } ?? "")\(row.subject), \(row.duration)")
          }
        }
        if let more = e.elsewhere {
          Text(more).textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
        }
      } else {
        Text("Loading the evidence…").textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
      }
    }
  }

  private func pendingStrip(_ pending: UndoWindow, _ p: Palette) -> some View {
    let seconds = pending.secondsShown(at: now)
    let message = UndoCopy.message(pending.action, seconds: seconds)
    return VStack(spacing: Tokens.Space.s12) {
      HStack(spacing: Tokens.Space.s8) {
        StatusDot(role: .working, size: Tokens.Size.dotSmall).frame(width: Tokens.Space.s12, height: Tokens.Space.s12)
        Text(message).textStyle(Tokens.TypeScale.label).monospacedDigit().foregroundStyle(p.ink1)
        Spacer()
        Text("Undo").textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
        Keycap(label: "esc")
      }
      // The bar shows the seconds the label says: "4s" of 5 is 80%, stepping once a second.
      ProgressHairline(fraction: pending.hairline(at: now), role: .working)
        .animation(Motion.outExpo(Tokens.Duration.base), value: seconds)
    }
    .padding(.horizontal, Tokens.Space.s20)
    .padding(.bottom, Tokens.Space.s16)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(message). Press Escape to undo.")
  }

  // MARK: empty

  private var empty: some View {
    let p = Palette(scheme: scheme)
    return VStack(spacing: 0) {
      HStack(spacing: Tokens.Space.s8) {
        Text("Inbox").textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink2)
        Spacer()
        Text("Close").textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
        Keycap(label: "esc")
      }
      .padding(.horizontal, Tokens.Space.s20)
      .padding(.top, Tokens.Space.s16)
      EmptyState(title: "Nothing to decide.",
                 message: "Still watching. Offload speaks up\nwhen a task starts to repeat.",
                 statusLabel: observerLabel)
        .padding(.top, Tokens.Space.s24)
        .padding(.bottom, Tokens.Space.s32)
    }
  }

  // MARK: hint

  private var hint: some View {
    HintPill {
      // s10d: one way out in the hint. E still dismisses an insight for good; it is in the 3 row's tooltip.
      Keycap(label: "1"); Keycap(label: "2"); Keycap(label: "3")
      Text("choose").padding(.trailing, Tokens.Space.s8)
      Keycap(label: "esc")
      Text("close")
    }
  }
}

/// Live card: re-renders every frame only while an undo countdown runs.
struct LiveInsightCard: View {
  @ObservedObject var model: InboxModel

  var body: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 30, paused: model.state.pending == nil)) { ctx in
      InsightCardView(state: model.state,
                      evidence: model.state.current.flatMap { model.evidence[$0.id] },
                      now: ctx.date,
                      pressedOption: model.pressedOption,
                      observerLabel: model.rail.observerLabel,
                      onConnect: { model.onConnect?($0) })
    }
  }
}
