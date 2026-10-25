import SwiftUI

/// The workflow review window: a normal titled window, no sidebar, content centred at most 720 pt wide.
/// Header, steps (the approval gate set apart in amber with a lock), the tone card (editable inline), the dry run
/// ("Our draft" against "What you sent", diff-lite), and one action bar with a single white Approve.
struct ReviewView: View {
  enum Part: CaseIterable { case header, steps, tone, dryRun }

  @ObservedObject var model: ReviewModel
  /// Snapshots: render only these parts, without a scroll view, at a fixed time.
  var parts: Set<Part> = Set(Part.allCases)
  var frozenNow: Date? = nil
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot

  static let contentWidth: CGFloat = 720

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(spacing: 0) {
      if isSnapshot {
        content
      } else {
        ScrollViewReader { proxy in
          ScrollView { content }
            .onChange(of: model.scrollRequest) { _, id in
              guard let id else { return }
              withAnimation(Motion.outExpo(Tokens.Duration.slow)) { proxy.scrollTo(id, anchor: .top) }
            }
        }
      }
      ReviewActionBar(model: model)
    }
    .background(p.canvas)
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 28) {
      if parts.contains(.header) { ReviewHeader(model: model) }
      if parts.contains(.steps) { StepsSection(workflow: model.workflow) }
      if parts.contains(.tone) { ToneSection(model: model) }
      if parts.contains(.dryRun) { DryRunSection(model: model).id(ReviewModel.dryRunSectionId) }
    }
    .padding(.horizontal, 24)
    .padding(.top, 28)
    .padding(.bottom, 32)
    .frame(maxWidth: Self.contentWidth + 48)
    .frame(maxWidth: .infinity)
  }
}

// MARK: header

private struct ReviewHeader: View {
  @ObservedObject var model: ReviewModel
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let w = model.workflow
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        StatusDot(role: StatusRole.forWorkflow(w.state), size: 7).frame(width: 10, height: 10)
        Text(w.state.label).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink2)
      }
      Text(w.name)
        .font(.system(size: 26, weight: .medium)).tracking(-0.6)
        .foregroundStyle(p.ink1)
        .padding(.top, 8)
      Text(w.summary)
        .textStyle(Tokens.TypeScale.body)
        .foregroundStyle(p.ink2)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 6)
      HStack(spacing: 8) {
        ForEach(w.connectors) { c in ConnectorChip(connector: c) { model.onConnect?($0) } }
        Spacer(minLength: 8)
        Chip(text: "Saves ~" + Format.perWeek(w.estimatedHoursPerWeek), style: .positive, symbol: "arrow.down.right")
      }
      .padding(.top, 16)
      // s09a: the brain's schedule note is a sentence, not a chip label; it wraps instead of widening the window.
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: "clock").font(.system(size: 10, weight: .medium))
        Text(w.schedule.summary).font(.system(size: 12)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
      }
      .foregroundStyle(p.ink2)
      .padding(.top, 10)
    }
  }
}

// MARK: steps

private struct StepsSection: View {
  var workflow: Workflow
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let gates = workflow.steps.filter(\.isGate).count
    WindowSection(title: "Steps", trailing: "\(workflow.steps.count) steps · \(gates == 1 ? "1 approval gate" : "\(gates) approval gates")") {
      RingBox {
        ForEach(Array(workflow.steps.enumerated()), id: \.element.id) { i, step in
          if i > 0 && !step.isGate && !workflow.steps[i - 1].isGate { RowDivider(inset: 56) }
          StepRow(index: i + 1, step: step, connector: step.connectorId.flatMap { id in workflow.connectors.first { $0.id == id } })
        }
      }
    }
  }
}

private struct StepRow: View {
  var index: Int
  var step: WorkflowStep
  var connector: Connector?
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let amber = p.status(.needsYou)
    HStack(alignment: .top, spacing: 12) {
      Text("\(index)")
        .font(.system(size: 11, weight: .medium)).monospacedDigit()
        .foregroundStyle(step.isGate ? p.statusInk(.needsYou) : p.ink3)
        .frame(width: 14, alignment: .trailing)
        .padding(.top, 6)
      ZStack {
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .fill(step.isGate ? amber.opacity(p.isDark ? 0.18 : 0.16) : p.fill)
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .strokeBorder(step.isGate ? amber.opacity(0.45) : p.ring, lineWidth: 1)
        Image(systemName: step.type.symbol)
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(step.isGate ? p.statusInk(.needsYou) : p.ink2)
      }
      .frame(width: 26, height: 26)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 8) {
          Text(step.title).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
          if step.isGate { Chip(text: "Approval gate", style: .recommended) }
        }
        Text(step.detail)
          .font(.system(size: 12))
          .foregroundStyle(step.isGate ? p.ink1.opacity(0.78) : p.ink2)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
      if let connector {
        HStack(spacing: 5) {
          Circle().fill(p.status(ConnectorChipModel(connector).role)).frame(width: 6, height: 6)
          Text(connector.name).font(.system(size: 12)).foregroundStyle(p.ink3)
        }
        .padding(.top, 5)
      } else if step.type != .approvalGate {
        Text("On this Mac").font(.system(size: 12)).foregroundStyle(p.ink3).padding(.top, 5)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, step.isGate ? 14 : 11)
    .background {
      if step.isGate {
        // The gate is set apart: an amber band with its own ring, inset inside the box (concentric 12 → 8).
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(amber.opacity(p.isDark ? 0.09 : 0.08))
          .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(amber.opacity(0.35), lineWidth: 1))
          .padding(4)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(step.isGate ? "Step \(index), approval gate. \(step.title). \(step.detail)"
                                    : "Step \(index). \(step.title). \(step.detail)")
  }
}

// MARK: tone

private struct ToneSection: View {
  @ObservedObject var model: ReviewModel
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot

  var body: some View {
    let p = Palette(scheme: scheme)
    WindowSection(title: "Your voice", trailing: toneTrailing) {
      if model.workflow.toneCard.isEmpty && !(model.toneLoaded && model.tone != nil) {
        RingBox(padding: 16) {
          Text(model.toneLoaded ? "The brain did not send a tone card for this workflow." : "Loading the tone card…")
            .font(.system(size: 13)).foregroundStyle(p.ink2)
        }
      } else {
      RingBox(padding: 0) {
        Group {
          if isSnapshot {
            // TextEditor is an AppKit text view, which offscreen rendering cannot draw; same text, same metrics.
            Text(model.toneDraft)
              .font(.system(size: 13)).lineSpacing(3)
              .foregroundStyle(p.ink1)
              .fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .topLeading)
              .padding(.horizontal, 5)
          } else {
            TextEditor(text: $model.toneDraft)
              .font(.system(size: 13))
              .lineSpacing(3)
              .foregroundStyle(p.ink1)
              .scrollContentBackground(.hidden)
              .frame(height: 150)  // the whole card without an inner scroll at the 720-pt column
              .accessibilityLabel("Tone card, editable")
          }
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 12)
      }
      if model.tone?.text == nil && model.toneLoaded && !isSnapshot {
        Text("No tone card yet: write a few lines on how you sound, or build one from your sent mail (tone build).")
          .font(.system(size: 12)).foregroundStyle(p.ink3)
      }
      if model.toneUnsaved {
        HStack {
          Spacer()
          SecondaryButton(title: model.saving ? "Saving…" : "Save tone card") { model.saveTone() }
            .disabled(model.saving)
        }
      }
      }
    }
  }

  private var toneTrailing: String? {
    if let t = model.tone {
      if model.toneUnsaved { return "Not saved yet" }
      return t.text == nil ? "\(t.bucketLabel) · empty" : (t.edited ? "\(t.bucketLabel) · edited by you" : "\(t.bucketLabel) · built from your sent mail")
    }
    if model.workflow.toneCard.isEmpty { return nil }
    return model.toneEdited ? "Edited · used on the next dry run" : "From 40 sent emails · click to edit"
  }
}

// MARK: dry run

private struct DryRunSection: View {
  @ObservedObject var model: ReviewModel
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let trailing: String = {
      guard let d = model.dryRun else { return model.runningDryRun ? "Running on last week's emails…" : "" }
      return "\(d.items.count) of last week's emails · ran \(Format.clock(d.ranAt)) · \(d.deniedSideEffects) sends and logs held by the gate"
    }()
    WindowSection(title: "Dry run", trailing: trailing) {
      if let d = model.dryRun {
        VStack(spacing: 12) {
          ForEach(d.items) { DryRunCard(item: $0) }
          HStack(spacing: 6) {
            Image(systemName: "lock.fill").font(.system(size: 10)).foregroundStyle(p.status(.needsYou))
            Text("Nothing was sent. Every send and log in the dry run stopped at the gate and was written to its log.")
              .font(.system(size: 12)).foregroundStyle(p.ink3)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      } else {
        RingBox(padding: 20) {
          Text(model.runningDryRun ? "Drafting against last week's real emails…" : "No dry run yet. Press R to run one.")
            .font(.system(size: 13)).foregroundStyle(p.ink2)
        }
      }
    }
  }
}

private struct DryRunCard: View {
  var item: DryRunItem
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let diff = DiffLite.diff(ours: item.ourDraft, theirs: item.whatYouSent)
    RingBox {
      // Counterparty first, then the subject cut at the tail (never a middle cut), then the time per item.
      HStack(spacing: 8) {
        Text(item.recipient.display)
          .textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
          .lineLimit(1).layoutPriority(2)
        Text(item.subject)
          .font(.system(size: 13)).foregroundStyle(p.ink2)
          .help(item.subject)
          .lineLimit(1).truncationMode(.tail).layoutPriority(1)
        Spacer(minLength: 12)
        Text(Format.reviewTime(observedMinutes: item.observedMinutes, reviewSeconds: item.reviewSeconds))
          .font(.system(size: 12)).monospacedDigit().foregroundStyle(p.ink3)
          .lineLimit(1).fixedSize()
        Chip(text: "−\(Format.decimal(item.minutesSaved)) min", style: .positive)
      }
      .padding(.horizontal, 14)
      .frame(height: 42)
      RowDivider(inset: 0)
      HStack(alignment: .top, spacing: 0) {
        column("Our draft", segments: diff.ours, p: p)
        Rectangle().fill(p.ring).frame(width: 1)
        column("What you sent · \(Format.weekdayClock(item.sentAt))", segments: diff.theirs, p: p)
      }
      .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(item.recipient.display), \(item.subject)")
  }

  private func column(_ title: String, segments: [DiffLite.Segment], p: Palette) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).textStyle(Tokens.TypeScale.caption).foregroundStyle(p.ink3)
      if segments.isEmpty {
        Text("No draft. This kind of task has no drafting dry run yet.")
          .font(.system(size: 12.5)).foregroundStyle(p.ink3)
      } else {
        DiffText(segments: segments)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .topLeading)
  }
}

// MARK: action bar

struct ReviewActionBar: View {
  @ObservedObject var model: ReviewModel
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(spacing: 0) {
      Rectangle().fill(p.isDark ? .black.opacity(0.55) : .black.opacity(0.10)).frame(height: 1)
      HStack(spacing: 8) {
        if case .discarding(let c) = model.flow.phase {
          TimelineView(.animation(minimumInterval: 1.0 / 30)) { ctx in
            CountdownStrip(text: "Discarding", countdown: c, now: ctx.date)
          }
        } else {
          SecondaryButton(title: "Discard", key: "⌘⌫") { model.send(.discard) }
          if let m = model.message {
            Text(m).font(.system(size: 12)).foregroundStyle(p.ink2).lineLimit(2).fixedSize(horizontal: false, vertical: true)
              .padding(.leading, 6)
          }
          Spacer(minLength: 12)
          SecondaryButton(title: model.runningDryRun ? "Running…" : "Run dry run again", key: "R") { model.send(.rerun) }
            .disabled(model.runningDryRun)
          SecondaryButton(title: "Edit", key: "E") { model.send(.edit) }
          if model.flow.canApprove {
            // One white action per view: while the confirmation is up, it holds the primary and this one rests.
            PrimaryButton(title: "Approve", key: "⌘↩") { model.send(.approve) }
              .opacity(model.flow.isConfirmOpen ? 0.3 : 1)
              .disabled(model.flow.isConfirmOpen)
          }
        }
      }
      .padding(.horizontal, 20)
      .frame(height: 56)
    }
    .background(p.isDark ? Color(hex: 0x1C1C1F) : Color(hex: 0xF8F8FA))
  }
}

/// "Turning on in 4s · esc to cancel" with the blue hairline counting down.
struct CountdownStrip: View {
  var text: String
  var countdown: Countdown
  var now: Date
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(spacing: 8) {
      HStack(spacing: 8) {
        StatusDot(role: .working, size: 7).frame(width: 10, height: 10)
        Text("\(text) in \(countdown.secondsLeftLabel(at: now))").textStyle(Tokens.TypeScale.label)
          .monospacedDigit().foregroundStyle(p.ink1)
        Spacer()
        Text("Cancel").font(.system(size: 12)).foregroundStyle(p.ink2)
        Keycap(label: "esc")
      }
      ProgressHairline(fraction: countdown.fractionRemaining(at: now), role: .working)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(text) in \(countdown.secondsLeftLabel(at: now)). Press Escape to cancel.")
  }
}

// MARK: sheets

/// The confirmation: exactly what the first run does, who gets an email, and what is not ready yet.
struct ConfirmSheet: View {
  @ObservedObject var model: ReviewModel
  var frozenNow: Date? = nil
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let plan = model.flow.plan
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .top, spacing: 12) {
        ZStack {
          Circle().fill(p.status(.needsYou).opacity(0.16))
          Image(systemName: "lock.open").font(.system(size: 14, weight: .medium)).foregroundStyle(p.status(.needsYou))
        }
        .frame(width: 34, height: 34)
        VStack(alignment: .leading, spacing: 4) {
          Text("Turn on \(plan.workflowName)?").font(.system(size: 17, weight: .medium)).tracking(-0.3).foregroundStyle(p.ink1)
          Text(plan.firstRunAt == nil ? BrainError.sentence(plan.schedule)
               : "First run \(Format.runTime(plan.firstRunAt, now: frozenNow ?? Date(), past: false)). Then \(plan.schedule.lowercased()).")
            .font(.system(size: 13)).foregroundStyle(p.ink2)
        }
      }
      RingBox {
        HStack {
          Text(plan.headline).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
          Spacer()
          Text("from \(plan.sendFrom)").font(.system(size: 12)).foregroundStyle(p.ink3)
        }
        .padding(.horizontal, 14)
        .frame(height: 38)
        RowDivider(inset: 0)
        if let note = plan.pendingNote {
          Text(note).font(.system(size: 12.5)).foregroundStyle(p.ink2)
            .fixedSize(horizontal: false, vertical: true)
            .padding(14)
        }
        VStack(spacing: 0) {
          ForEach(Array(plan.recipients.enumerated()), id: \.element.id) { i, r in
            HStack(spacing: 8) {
              Text("\(i + 1)").font(.system(size: 11)).monospacedDigit().foregroundStyle(p.ink3).frame(width: 14, alignment: .trailing)
              Text(r.name).font(.system(size: 13)).foregroundStyle(p.ink1).lineLimit(1)
              Text(r.org).font(.system(size: 13)).foregroundStyle(p.ink2).lineLimit(1)
              Spacer(minLength: 8)
              Text(r.email).font(.system(size: 12)).foregroundStyle(p.ink3).lineLimit(1).truncationMode(.head)
            }
            .frame(height: 24)
          }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, plan.recipients.isEmpty ? 0 : 8)
      }
      .padding(.top, 18)

      VStack(alignment: .leading, spacing: 6) {
        ForEach(Array(plan.steps.enumerated()), id: \.offset) { i, s in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(i + 1).").font(.system(size: 12)).monospacedDigit().foregroundStyle(p.ink3).frame(width: 16, alignment: .trailing)
            Text(s).font(.system(size: 12.5)).foregroundStyle(p.ink2).fixedSize(horizontal: false, vertical: true)
          }
        }
        ForEach(plan.blockers, id: \.self) { b in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle().fill(p.status(.needsYou)).frame(width: 6, height: 6).frame(width: 16)
            Text(b).font(.system(size: 12.5)).foregroundStyle(p.ink1).fixedSize(horizontal: false, vertical: true)
          }
          .padding(.top, 4)
        }
      }
      .padding(.top, 16)

      Group {
        if let c = model.flow.countdown, case .armed = model.flow.phase {
          if let frozenNow {
            CountdownStrip(text: "Turning on", countdown: c, now: frozenNow)
          } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { ctx in
              CountdownStrip(text: "Turning on", countdown: c, now: ctx.date)
            }
          }
        } else {
          HStack(spacing: 8) {
            Text("Pause it any time from the dashboard.").font(.system(size: 12)).foregroundStyle(p.ink3)
            Spacer()
            SecondaryButton(title: "Cancel", key: "esc") { model.send(.escape) }
            PrimaryButton(title: "Turn on", key: "↩") { model.send(.confirm) }
          }
        }
      }
      .padding(.top, 20)
    }
    .padding(24)
    .frame(width: 520)
    .background(p.isDark ? Color(hex: 0x202023) : Color(hex: 0xFBFBFC))
  }
}

/// SKILL.md, read-only (S) or editable (E). Edits stay on this Mac until the brain has a write route.
struct SkillSheet: View {
  @ObservedObject var model: ReviewModel
  var editing: Bool
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Image(systemName: "doc.text").foregroundStyle(p.ink2)
        Text("SKILL.md").font(.system(size: 15, weight: .medium)).foregroundStyle(p.ink1)
        Text(editing ? "Editing the words; steps, tools and the gate stay as they are" : "Read only")
          .font(.system(size: 12)).foregroundStyle(p.ink3)
        Spacer()
        if editing && model.skillEdit != nil {
          SecondaryButton(title: "Cancel", key: "esc") { model.dismissSheet() }
          PrimaryButton(title: model.saving ? "Saving…" : "Save") { model.saveSkill() }
            .disabled(model.saving || !model.skillUnsaved)
        } else {
          SecondaryButton(title: "Done", key: "esc") { model.dismissSheet() }
        }
      }
      RingBox(padding: 0) {
        Group {
          if editing && !isSnapshot {
            SkillEditForm(model: model)
          } else if isSnapshot {
            // Offscreen rendering cannot draw a scroll view; same text, clipped to the same box.
            Text(model.skillDraft)
              .font(.system(size: 12, design: .monospaced)).lineSpacing(2)
              .foregroundStyle(p.ink1)
              .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
              .clipped()
          } else {
            ScrollView {
              Text(model.skillDraft)
                .font(.system(size: 12, design: .monospaced)).lineSpacing(2)
                .foregroundStyle(p.ink1)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
          }
        }
        .padding(12)
      }
      .frame(height: 420)
    }
    .padding(20)
    .frame(width: 640)
    .background(p.isDark ? Color(hex: 0x202023) : Color(hex: 0xFBFBFC))
  }
}

/// Edit mode of the SKILL.md sheet (s05c): the description and each step's title and detail, nothing else. Gate
/// steps are shown locked.
private struct SkillEditForm: View {
  @ObservedObject var model: ReviewModel
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    if model.skillEdit == nil {
      Text(model.skillDoc == nil ? "Loading SKILL.md…" : "")
        .font(.system(size: 13)).foregroundStyle(p.ink2)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    } else {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text("Description").font(.system(size: 12, weight: .medium)).foregroundStyle(p.ink2)
          TextField("What this workflow does", text: binding(\.description), axis: .vertical)
            .textFieldStyle(.roundedBorder).lineLimit(2...4)
          ForEach(Array((model.skillEdit?.steps ?? []).enumerated()), id: \.element.id) { i, step in
            VStack(alignment: .leading, spacing: 6) {
              HStack(spacing: 6) {
                Text("Step \(i + 1)").font(.system(size: 12, weight: .medium)).foregroundStyle(p.ink2)
                if step.isGate {
                  Image(systemName: "lock.fill").font(.system(size: 10)).foregroundStyle(p.status(.needsYou))
                  Text("Approval gate, not editable").font(.system(size: 11)).foregroundStyle(p.ink3)
                }
              }
              if step.isGate {
                Text(step.title).font(.system(size: 13)).foregroundStyle(p.ink1)
                Text(step.detail).font(.system(size: 12)).foregroundStyle(p.ink3)
              } else {
                TextField("Title", text: stepBinding(i, \.title)).textFieldStyle(.roundedBorder)
                TextField("Detail", text: stepBinding(i, \.detail), axis: .vertical)
                  .textFieldStyle(.roundedBorder).lineLimit(1...4)
              }
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  private func binding(_ kp: WritableKeyPath<SkillDoc, String>) -> Binding<String> {
    Binding(get: { model.skillEdit?[keyPath: kp] ?? "" }, set: { model.skillEdit?[keyPath: kp] = $0 })
  }

  private func stepBinding(_ i: Int, _ kp: WritableKeyPath<SkillStep, String>) -> Binding<String> {
    Binding(get: { model.skillEdit.flatMap { $0.steps.indices.contains(i) ? $0.steps[i][keyPath: kp] : nil } ?? "" },
            set: { v in if model.skillEdit?.steps.indices.contains(i) == true { model.skillEdit?.steps[i][keyPath: kp] = v } })
  }
}
