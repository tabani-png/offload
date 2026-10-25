import SwiftUI

// s14: the review of a general workflow. The plan's chosen variant as typed steps (read, transform, decide, draft,
// commit), the choice between the two variants with how closely each matched last week, and the generic dry run:
// what Offload would do next to what you did, for any output type. Every string comes from PlanCopy and
// GeneralDryRunCopy; colour is used for state only (the match line).

struct PlanSection: View {
  @ObservedObject var model: ReviewModel
  var copy: PlanCopy
  /// s14: tool suggestions by step id.
  var tools: [String: ToolsCopy] = [:]
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Tokens.Space.s32) {
      WindowSection(title: copy.choicesTitle, trailing: copy.choicesTrailing) {
        VStack(alignment: .leading, spacing: Tokens.Space.s8) {
          ForEach(copy.choices) { c in
            PlanChoiceRow(choice: c) { model.choosePlan(c.id) }
              .disabled(model.choosingPlan)
          }
          Text(copy.reason).paragraphStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink3)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      WindowSection(title: copy.stepsTitle, trailing: copy.stepsTrailing) {
        RingBox {
          ForEach(Array(copy.steps.enumerated()), id: \.element.id) { i, step in
            if i > 0 { RowDivider(inset: Tokens.Space.s40) }
            PlanStepRow(step: step)
            if let t = tools[step.id] { ToolSuggestionView(model: model, copy: t) }
          }
        }
      }
    }
  }
}

/// One variant: its key, its name and agreement, the probe's arithmetic, and a check on the one in use.
private struct PlanChoiceRow: View {
  var choice: PlanCopy.Choice
  var action: () -> Void
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let p = Palette(scheme: scheme)
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.row, style: .continuous)
    Button(action: action) {
      HStack(alignment: .center, spacing: Tokens.Space.s12) {
        Keycap(label: "\(choice.number)", prominent: choice.chosen)
        VStack(alignment: .leading, spacing: Tokens.Space.nudge) {
          Text(choice.title).textStyle(Tokens.TypeScale.label).monospacedDigit()
            .foregroundStyle(choice.chosen ? p.ink1 : p.ink2)
          Text(choice.summary).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
            .fixedSize(horizontal: false, vertical: true)
          if !choice.arithmetic.isEmpty {
            Text(choice.arithmetic).textStyle(Tokens.TypeScale.footnote).monospacedDigit().foregroundStyle(p.ink3)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        if choice.chosen {
          HStack(spacing: Tokens.Space.s4) {
            Image(systemName: "checkmark").symbolStyle(Tokens.TypeScale.Symbol.regular, weight: .semibold)
            Text("In use").textStyle(Tokens.TypeScale.callout)
          }
          .foregroundStyle(p.ink1)
          .transition(.opacity)
        }
      }
      .padding(.horizontal, Tokens.Space.s12)
      .padding(.vertical, Tokens.Space.s12)
      .background(shape.fill(choice.chosen ? p.fillStrong : p.group))
      .overlay(shape.strokeBorder(choice.chosen ? p.ringStrong : p.ring, lineWidth: Tokens.Layout.hairline))
      .contentShape(shape)
      .animation(Motion.outExpo(Tokens.Duration.base), value: choice.chosen)
    }
    .buttonStyle(PressStyle())
    .accessibilityLabel("\(choice.title)\(choice.chosen ? ", in use" : ""). \(choice.summary)")
    .accessibilityHint(choice.chosen ? "" : "Press \(choice.number) to use this one.")
  }
}

/// One typed step: number (a lock beside it when it waits for your approval), type badge, title, the condition
/// when it only runs sometimes, the detail, the capability need in tertiary ink, and where it runs.
private struct PlanStepRow: View {
  var step: PlanCopy.Step
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s12) {
      Text(step.number)
        .textStyle(Tokens.TypeScale.caption).monospacedDigit()
        .foregroundStyle(p.ink3)
        .frame(width: Tokens.Space.s16, alignment: .trailing)
        .overlay(alignment: .leading) {
          if step.approval {
            Image(systemName: "lock.fill").symbolStyle(Tokens.TypeScale.Symbol.small).foregroundStyle(p.ink2)
              .offset(x: -Tokens.Space.s12)
              .accessibilityHidden(true)
          }
        }
      VStack(alignment: .leading, spacing: Tokens.Space.s4) {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
          TypeBadge(text: step.badge)
          Text(step.title).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
            .fixedSize(horizontal: false, vertical: true)
        }
        if let when = step.when {
          HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s4) {
            Image(systemName: "arrow.triangle.branch").symbolStyle(Tokens.TypeScale.Symbol.small)
            Text(when).paragraphStyle(Tokens.TypeScale.callout).fixedSize(horizontal: false, vertical: true)
          }
          .foregroundStyle(p.ink2)
        }
        Text(step.detail)
          .paragraphStyle(Tokens.TypeScale.callout)
          .foregroundStyle(p.ink2)
          .fixedSize(horizontal: false, vertical: true)
        if let line = needLine {
          Text(line).textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Text(step.place)
        .textStyle(Tokens.TypeScale.callout)
        .foregroundStyle(p.ink3)
        .multilineTextAlignment(.trailing)
        .frame(width: Tokens.Layout.placeColumn, alignment: .trailing)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, Tokens.Space.s16)
    .padding(.vertical, Tokens.Space.s12)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Step \(step.number), \(step.badge)\(step.approval ? ", after your approval" : ""). \(step.title). \(step.when ?? "") \(step.detail). \(step.place)")
  }

  private var needLine: String? {
    switch (step.need, step.approval) {
    case (let n?, true): return "\(n) · \(PlanCopy.approvalNote)"
    case (let n?, false): return n
    case (nil, true): return "Saved \(PlanCopy.approvalNote)"
    case (nil, false): return nil
    }
  }
}

/// The step's type: a quiet tag, no colour (a type is not a state).
private struct TypeBadge: View {
  var text: String
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    Text(text).textStyle(Tokens.TypeScale.caption).foregroundStyle(p.ink2)
      .padding(.horizontal, Tokens.Space.s8)
      .frame(height: Tokens.Size.tag)
      .background(Capsule().fill(p.fill))
      .overlay(Capsule().strokeBorder(p.ring, lineWidth: Tokens.Layout.hairline))
      .fixedSize()
  }
}

// MARK: generic dry run

struct GeneralDryRunSection: View {
  var copy: ReviewCopy
  var general: GeneralDryRunCopy
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    WindowSection(title: copy.dryRunTitle, trailing: copy.dryRunWith.map { "\($0) · \(general.trailing)" } ?? general.trailing) {
      VStack(alignment: .leading, spacing: Tokens.Space.s12) {
        ForEach(general.items) { item in GeneralDryRunCard(item: item) }
        Text(general.totals).textStyle(Tokens.TypeScale.footnote).monospacedDigit().foregroundStyle(p.ink3)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

private struct GeneralDryRunCard: View {
  var item: GeneralDryRunCopy.Item
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    RingBox {
      VStack(alignment: .leading, spacing: Tokens.Space.s4) {
        HStack(spacing: Tokens.Space.s8) {
          Text(item.heading).textStyle(Tokens.TypeScale.label).monospacedDigit().foregroundStyle(p.ink1)
            .lineLimit(1).truncationMode(.tail)
          Spacer(minLength: Tokens.Space.s12)
          Chip(text: item.saved, style: .positive)
        }
        Text(item.time).textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink3)
      }
      .padding(.horizontal, Tokens.Space.s16)
      .padding(.vertical, Tokens.Space.s12)
      RowDivider(inset: 0)
      HStack(alignment: .top, spacing: 0) {
        column(item.ours, p)
        Rectangle().fill(p.ring).frame(width: Tokens.Layout.hairline)
        column(item.theirs, p)
      }
      .fixedSize(horizontal: false, vertical: true)
      RowDivider(inset: 0)
      VStack(alignment: .leading, spacing: Tokens.Space.s4) {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
          Circle().fill(p.status(item.matchRole)).frame(width: Tokens.Size.dotSmall, height: Tokens.Size.dotSmall)
          Text(item.matchChip).textStyle(Tokens.TypeScale.calloutEmphasis).monospacedDigit().foregroundStyle(p.statusInk(item.matchRole))
          Text(item.matchLine).textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink2)
            .fixedSize(horizontal: false, vertical: true)
        }
        ForEach(item.warnings, id: \.self) { w in
          HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
            Circle().fill(p.status(.needsYou)).frame(width: Tokens.Size.dotSmall, height: Tokens.Size.dotSmall)
            Text(w).paragraphStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink1)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      .padding(.horizontal, Tokens.Space.s16)
      .padding(.vertical, Tokens.Space.s12)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(item.heading). \(item.matchChip)")
  }

  private func column(_ side: GeneralDryRunCopy.Side, _ p: Palette) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s8) {
      Text(side.title).textStyle(Tokens.TypeScale.caption).monospacedDigit().foregroundStyle(p.ink3)
      if !side.rows.isEmpty {
        VStack(alignment: .leading, spacing: Tokens.Space.s4) {
          ForEach(side.rows) { r in
            HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
              Text(r.label).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
                .frame(width: Tokens.Layout.labelColumn, alignment: .leading)
              Text(r.value)
                .textStyle(Tokens.TypeScale.callout).monospacedDigit()
                .italic(r.hidden)
                .foregroundStyle(r.hidden ? p.ink3 : p.ink1)
                .fixedSize(horizontal: false, vertical: true)
              if r.differs {
                Circle().fill(p.status(.needsYou)).frame(width: Tokens.Size.dotSmall, height: Tokens.Size.dotSmall)
                  .accessibilityLabel("Differs from Offload's")
              }
              Spacer(minLength: 0)
            }
          }
        }
      }
      if let text = side.text {
        // A quote block: the bar takes the text's own height.
        Text(text).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.leading, Tokens.Space.s12)
          .overlay(alignment: .leading) { Capsule().fill(p.ringStrong).frame(width: Tokens.Space.nudge) }
      }
      if !side.actions.isEmpty {
        VStack(alignment: .leading, spacing: Tokens.Space.s4) {
          ForEach(side.actions, id: \.self) { a in
            HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s4) {
              Image(systemName: "arrow.turn.down.right").symbolStyle(Tokens.TypeScale.Symbol.small).foregroundStyle(p.ink3)
              Text(a).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
            }
          }
        }
      }
    }
    .padding(Tokens.Space.s16)
    .frame(maxWidth: .infinity, alignment: .topLeading)
  }
}

// MARK: tool suggestions

/// Under a step: the suggestion in one sentence, then its 1 to 3 tools side by side. T focuses the row (a blue ring
/// on the option under the focus), ← → move, ↩ keeps it; a click keeps it at once.
struct ToolSuggestionView: View {
  @ObservedObject var model: ReviewModel
  var copy: ToolsCopy
  @Environment(\.colorScheme) private var scheme

  private var focusIndex: Int? { model.toolFocus?.stepId == copy.stepId ? model.toolFocus?.index : nil }

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Tokens.Space.s8) {
      HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
        Image(systemName: "sparkles").symbolStyle(Tokens.TypeScale.Symbol.small).foregroundStyle(p.ink2)
        Text(copy.suggestion).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink1)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
        if focusIndex == nil { Keycap(label: "T") }
      }
      HStack(alignment: .top, spacing: Tokens.Space.s8) {
        ForEach(Array(copy.options.enumerated()), id: \.element.id) { i, o in
          option(o, focused: focusIndex == i, p)
        }
      }
      .fixedSize(horizontal: false, vertical: true)
      if let line = copy.runsWithLine {
        Text(line).textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
      }
      if focusIndex != nil {
        Text(ToolsCopy.hint).textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
      }
    }
    .padding(.leading, Tokens.Space.s16 + Tokens.Space.s16 + Tokens.Space.s12)
    .padding(.trailing, Tokens.Space.s16)
    .padding(.bottom, Tokens.Space.s12)
    .animation(Motion.outExpo(Tokens.Duration.fast), value: focusIndex)
  }

  private func option(_ o: ToolsCopy.Option, focused: Bool, _ p: Palette) -> some View {
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.row, style: .continuous)
    return Button { model.chooseTool(stepId: copy.stepId, toolId: o.id) } label: {
      VStack(alignment: .leading, spacing: Tokens.Space.s4) {
        HStack(spacing: Tokens.Space.s8) {
          Text(o.name).textStyle(Tokens.TypeScale.calloutEmphasis).foregroundStyle(p.ink1)
          if o.connected { Chip(text: ToolsCopy.connectedChip, style: .positive) }
          Spacer(minLength: 0)
          if o.chosen {
            HStack(spacing: Tokens.Space.nudge) {
              Image(systemName: "checkmark").symbolStyle(Tokens.TypeScale.Symbol.small, weight: .semibold)
              Text(ToolsCopy.inUse).textStyle(Tokens.TypeScale.footnote)
            }
            .foregroundStyle(p.ink1)
          }
        }
        Text(o.why).paragraphStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink2)
          .fixedSize(horizontal: false, vertical: true)
        Text(o.detail).paragraphStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(Tokens.Space.s12)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(shape.fill(o.chosen ? p.fillStrong : p.fill))
      .overlay(shape.strokeBorder(focused ? p.status(.working) : (o.chosen ? p.ringStrong : p.ring),
                                  lineWidth: Tokens.Layout.hairline))
      .contentShape(shape)
    }
    .buttonStyle(PressStyle())
    .disabled(model.choosingTool)
    .accessibilityLabel("\(o.name)\(o.chosen ? ", in use" : "")\(o.connected ? ", connected" : ""). \(o.why) \(o.detail)")
  }
}
