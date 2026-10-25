import SwiftUI

/// The insight card plus its detached hint. Pure render of (state, evidence, now): the live wrapper feeds a
/// ticking clock while an undo window runs; snapshots pass a fixed time.
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
    VStack(spacing: 10) {
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
    header(p)
      .padding(.horizontal, 20)
      .padding(.top, 16)

    VStack(alignment: .leading, spacing: 0) {
      Text(Format.headline(insight))
        .textStyle(Tokens.TypeScale.display)
        .foregroundStyle(p.ink1)
        .lineSpacing(1)
        .fixedSize(horizontal: false, vertical: true)
      Text(Format.arithmetic(insight))
        .textStyle(Tokens.TypeScale.body)
        .monospacedDigit()
        .foregroundStyle(p.ink2)
        .padding(.top, 8)
      ProgressHairline(fraction: insight.timeShare)
        .padding(.top, 12)
        .accessibilityLabel("Share of tracked time")
    }
    .padding(.horizontal, 20)
    .padding(.top, 12)

    Well {
      HStack(spacing: 8) {
        Chip(text: "Saves " + Format.savingRange(insight.saving).replacingOccurrences(of: " back", with: ""),
             style: .positive, symbol: "arrow.down.right")
        Spacer(minLength: 0)
      }
      // Verbatim from the brain, broken at its own "→" steps so it reads as a short calculation.
      Text(Format.savingArithmetic(insight).replacingOccurrences(of: " → ", with: "\n→ "))
        .font(.system(size: 11))
        .monospacedDigit()
        .lineSpacing(2)
        .foregroundStyle(p.ink3)
        .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 6) {
        Text("Uses").textStyle(Tokens.TypeScale.caption).foregroundStyle(p.ink3)
          .padding(.trailing, 2)
        ForEach(insight.connectors) { c in
          ConnectorChip(connector: c) { onConnect($0) }
        }
      }
      if state.evidenceOpen {
        evidenceList(insight, p)
          .transition(.rise(reduceMotion: reduceMotion))
      }
    }
    .padding(.horizontal, 8)
    .padding(.top, 16)

    options(insight)
      .padding(12)

    if let pending = state.pending {
      pendingStrip(pending, p)
        .transition(.opacity)
    }
  }

  private func header(_ p: Palette) -> some View {
    HStack(spacing: 6) {
      StatusDot(role: .needsYou, size: 7)
        .frame(width: 10, height: 10)
      Text("Insight").textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink2)
      Text(state.positionLabel).textStyle(Tokens.TypeScale.label).monospacedDigit().foregroundStyle(p.ink3)
      Spacer()
      if state.insights.count > 1 {
        Keycap(label: "K").opacity(state.index == 0 ? 0.45 : 1)
        Keycap(label: "J").opacity(state.index == state.insights.count - 1 ? 0.45 : 1)
          .padding(.trailing, 4)
      }
      Keycap(label: "esc")
    }
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
    return VStack(spacing: 6) {
      ForEach(rows, id: \.0) { n, title, rec in
        OptionRow(number: n, title: title, recommended: rec,
                  state: rowState(n, chosen: chosen),
                  pressed: pressedOption == n)
      }
    }
  }

  private func rowState(_ n: Int, chosen: Int?) -> OptionRow.State {
    guard state.pending != nil else { return n == 2 && state.evidenceOpen ? .highlighted : .idle }
    return n == chosen ? .chosen : .muted
  }

  private func evidenceList(_ insight: Insight, _ p: Palette) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Rectangle().fill(p.ring).frame(height: 1).padding(.vertical, 2)
      SectionHeader(title: evidence.flatMap { Self.usualApp($0) }.map { "Evidence · \($0)" } ?? "Evidence",
                    trailing: evidence.map { "\($0.count) of \(Format.count(insight.instanceCount)) \(insight.unitPlural)" })
      if let spans = evidence {
        // The usual app is said once in the header; a row names its app only when it is a different one.
        let usual = Self.usualApp(spans)
        ForEach(spans) { span in
          HStack(spacing: 10) {
            Text(Format.spanTime(span))
              .font(.system(size: 12))
              .monospacedDigit()
              .foregroundStyle(p.ink3)
              .fixedSize()
              .frame(minWidth: 62, alignment: .leading)
            evidenceTitle(EvidenceTitle.make(title: span.title, counterparty: span.counterparty), p)
              .frame(maxWidth: .infinity, alignment: .leading)
            if span.app != usual {
              Text(span.app)
                .font(.system(size: 12))
                .foregroundStyle(p.ink3)
                .lineLimit(1)
                .fixedSize()
            }
            Text(Format.spanDuration(span))
              .font(.system(size: 12))
              .monospacedDigit()
              .foregroundStyle(p.ink3)
              .frame(width: 38, alignment: .trailing)
          }
          .frame(height: 18)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("\(Format.spanTime(span)), \(EvidenceTitle.make(title: span.title, counterparty: span.counterparty).plain), \(span.app), \(Format.spanDuration(span))")
        }
      } else {
        Text("Loading spans…").font(.system(size: 12)).foregroundStyle(p.ink3)
      }
    }
  }

  /// The app most spans happened in (ties: the first seen).
  static func usualApp(_ spans: [EvidenceSpan]) -> String? {
    var counts: [String: Int] = [:]
    for sp in spans { counts[sp.app, default: 0] += 1 }
    return spans.map(\.app).first { counts[$0] == counts.values.max() }
  }

  /// Who it was for first, then the subject, cut at the tail: "Pellow Partners  Deck and data ro…".
  /// The counterparty keeps its full width unless it alone would take more than the row.
  private func evidenceTitle(_ t: EvidenceTitle, _ p: Palette) -> some View {
    HStack(spacing: 6) {
      if let lead = t.lead {
        Text(lead)
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(p.ink1)
          .lineLimit(1)
          .truncationMode(.tail)
          .layoutPriority(1)
      }
      if !t.subject.isEmpty {
        Text(t.subject)
          .font(.system(size: 12))
          .foregroundStyle(t.lead == nil ? p.ink1 : p.ink2)
          .lineLimit(1)
          .truncationMode(.tail)
      }
    }
  }

  private func pendingStrip(_ pending: UndoWindow, _ p: Palette) -> some View {
    let message: String = {
      switch pending.action {
      case .build: return "Drafting the workflow"
      case .notNow: return "Snoozed until tomorrow"
      case .dismiss: return "Dismissed"
      }
    }()
    return VStack(spacing: 0) {
      HStack(spacing: 8) {
        StatusDot(role: .working, size: 7).frame(width: 10, height: 10)
        Text(message).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
        Spacer()
        Text("Undo").font(.system(size: 12)).foregroundStyle(p.ink2)
        Keycap(label: "esc")
        Text(pending.secondsLeftLabel(at: now))
          .textStyle(Tokens.TypeScale.mono)
          .foregroundStyle(p.ink3)
          .frame(width: 18, alignment: .trailing)
      }
      .padding(.horizontal, 20)
      .padding(.bottom, 14)
      ProgressHairline(fraction: pending.fractionRemaining(at: now), role: .working)
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(message). Press Escape to undo.")
  }

  // MARK: empty

  private var empty: some View {
    let p = Palette(scheme: scheme)
    return VStack(spacing: 0) {
      HStack(spacing: 6) {
        Text("Inbox").textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink2)
        Spacer()
        Keycap(label: "esc")
      }
      .padding(.horizontal, 20)
      .padding(.top, 16)
      EmptyState(title: "Nothing to decide.",
                 message: "Still watching. Offload speaks up\nwhen a task starts to repeat.",
                 statusLabel: observerLabel)
        .padding(.top, 28)
        .padding(.bottom, 32)
    }
  }

  // MARK: hint

  private var hint: some View {
    HintPill {
      Text("Press")
      Keycap(label: "1"); Keycap(label: "2"); Keycap(label: "3")
      Text("to choose ·")
      Keycap(label: "E")
      Text("dismiss")
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
