import SwiftUI

/// The workflow review window: a normal titled window, no sidebar, one column centred and at most 720 pt wide at
/// any window width (s10a). Header (status, name, what it does, connectors and the saving in a wrapping row, the
/// schedule on its own line), steps, your voice (editable inline), the dry run ("Our draft" against "What you
/// sent"), and one action bar with a single white Approve. Every string comes from ReviewCopy / ConfirmCopy.
struct ReviewView: View {
  enum Part: CaseIterable { case header, steps, tone, dryRun }

  @ObservedObject var model: ReviewModel
  /// Snapshots: render only these parts, without a scroll view, at a fixed time.
  var parts: Set<Part> = Set(Part.allCases)
  var frozenNow: Date? = nil
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot

  /// The column, not the window: content never grows past this, and never past the window either.
  static let contentWidth: CGFloat = 720
  /// Smallest window the column is laid out for (the window's minSize).
  static let minWindowWidth: CGFloat = 640

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(spacing: 0) {
      if isSnapshot {
        content
      } else {
        ScrollViewReader { proxy in
          ScrollView(.vertical) { content }
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
    let copy = model.copy
    return VStack(alignment: .leading, spacing: Tokens.Space.s32) {
      if parts.contains(.header) { ReviewHeader(model: model, copy: copy) }
      if parts.contains(.steps) { StepsSection(copy: copy) }
      if parts.contains(.tone) { ToneSection(model: model) }
      if parts.contains(.dryRun) { DryRunSection(model: model, copy: copy).id(ReviewModel.dryRunSectionId) }
    }
    .frame(maxWidth: Self.contentWidth, alignment: .leading)
    .padding(.horizontal, Tokens.Space.s32)
    .padding(.top, Tokens.Space.s24)
    .padding(.bottom, Tokens.Space.s32)
    .frame(maxWidth: .infinity)
  }
}

// MARK: header

private struct ReviewHeader: View {
  @ObservedObject var model: ReviewModel
  var copy: ReviewCopy
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let w = model.workflow
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: Tokens.Space.s8) {
        StatusDot(role: StatusRole.forWorkflow(w.state), size: Tokens.Size.dotSmall)
          .frame(width: Tokens.Space.s12, height: Tokens.Space.s12)
        Text(copy.status).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink2)
      }
      Text(copy.title)
        .paragraphStyle(Tokens.TypeScale.largeTitle)
        .foregroundStyle(p.ink1)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, Tokens.Space.s8)
      Text(copy.summary)
        .paragraphStyle(Tokens.TypeScale.body)
        .foregroundStyle(p.ink2)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, Tokens.Space.s8)
      // Chips wrap: a long connector list or a narrow window adds a line, never pushes the column off screen.
      FlowLayout(spacing: Tokens.Space.s8) {
        ForEach(w.connectors) { c in ConnectorChip(connector: c) { model.onConnect?($0) } }
        if let saving = copy.savingChip { Chip(text: saving, style: .positive) }
      }
      .padding(.top, Tokens.Space.s16)
      // The schedule is a sentence, so it gets its own line and wraps.
      HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
        Image(systemName: "clock").symbolStyle(Tokens.TypeScale.Symbol.small)
        Text(copy.schedule).paragraphStyle(Tokens.TypeScale.callout).fixedSize(horizontal: false, vertical: true)
      }
      .foregroundStyle(p.ink2)
      .padding(.top, Tokens.Space.s12)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// MARK: steps

private struct StepsSection: View {
  var copy: ReviewCopy

  var body: some View {
    WindowSection(title: copy.stepsTitle, trailing: copy.stepsTrailing) {
      RingBox {
        ForEach(Array(copy.steps.enumerated()), id: \.element.id) { i, step in
          if i > 0 { RowDivider(inset: Tokens.Space.s40) }
          StepRow(step: step)
        }
      }
    }
  }
}

/// One step: its number, title and detail, and where it runs on the right. Your approval step carries a lock and
/// a neutral "You approve" tag; colour is not used for it, because it is a design-time step, not a state.
private struct StepRow: View {
  var step: ReviewCopy.Step
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s12) {
      Text(step.number)
        .textStyle(Tokens.TypeScale.caption).monospacedDigit()
        .foregroundStyle(p.ink3)
        .frame(width: Tokens.Space.s16, alignment: .trailing)
      VStack(alignment: .leading, spacing: Tokens.Space.s4) {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
          if step.isGate {
            Image(systemName: "lock.fill").symbolStyle(Tokens.TypeScale.Symbol.small).foregroundStyle(p.ink2)
          }
          Text(step.title).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
            .fixedSize(horizontal: false, vertical: true)
        }
        Text(step.detail)
          .paragraphStyle(Tokens.TypeScale.callout)
          .foregroundStyle(p.ink2)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if !step.isGate {
        Text(step.place)
          .textStyle(Tokens.TypeScale.callout)
          .foregroundStyle(step.placeNeedsYou ? p.statusInk(.needsYou) : p.ink3)
          .multilineTextAlignment(.trailing)
          .frame(maxWidth: 200, alignment: .trailing)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.horizontal, Tokens.Space.s16)
    .padding(.vertical, Tokens.Space.s12)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Step \(step.number)\(step.isGate ? ", you approve" : ""). \(step.title). \(step.detail). \(step.isGate ? "" : step.place)")
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
        RingBox(padding: Tokens.Space.s16) {
          Text(model.toneLoaded ? "No notes on your voice yet." : "Loading your voice…")
            .textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
        }
      } else {
        RingBox(padding: 0) {
          Group {
            if isSnapshot {
              // TextEditor is an AppKit text view, which offscreen rendering cannot draw; same text, same metrics.
              Text(model.toneDraft)
                .paragraphStyle(Tokens.TypeScale.body)
                .foregroundStyle(p.ink1)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .padding(.horizontal, Tokens.Space.s4)
            } else {
              TextEditor(text: $model.toneDraft)
                .paragraphStyle(Tokens.TypeScale.body)
                .foregroundStyle(p.ink1)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 120, maxHeight: 180)
                .accessibilityLabel("How you write, editable")
            }
          }
          .padding(.horizontal, Tokens.Space.s12)
          .padding(.vertical, Tokens.Space.s12)
        }
        if model.tone?.text == nil && model.toneLoaded && !isSnapshot {
          Text("Write a few lines on how you sound. Drafts follow them.")
            .textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
        }
        if model.toneUnsaved {
          HStack {
            Spacer()
            SecondaryButton(title: model.saving ? "Saving…" : "Save your voice") { model.saveTone() }
              .disabled(model.saving)
          }
        }
      }
    }
  }

  private var toneTrailing: String? {
    if let t = model.tone {
      if model.toneUnsaved { return "Not saved yet" }
      return t.text == nil ? nil : (t.edited ? "Edited by you · type to change it" : "Built from your sent mail · type to change it")
    }
    if model.workflow.toneCard.isEmpty { return nil }
    return model.toneEdited ? "Edited · used on the next dry run" : "Built from your sent mail · type to change it"
  }
}

// MARK: dry run

private struct DryRunSection: View {
  @ObservedObject var model: ReviewModel
  var copy: ReviewCopy
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    WindowSection(title: copy.dryRunTitle, trailing: copy.dryRunTrailing) {
      if model.dryRun != nil {
        VStack(alignment: .leading, spacing: Tokens.Space.s12) {
          if let sample = copy.sampleChip {
            HStack(spacing: Tokens.Space.s8) {
              Chip(text: sample)
              Text("Written by the offline sample model to show the steps, not drafted from your voice.")
                .textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          ForEach(Array(copy.items.enumerated()), id: \.element.id) { i, item in
            if let d = model.dryRun, d.items.indices.contains(i) {
              DryRunCard(item: d.items[i], copy: item, oursTitle: copy.oursTitle)
            }
          }
          Text(copy.diffNote).textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
        }
      } else {
        RingBox(padding: Tokens.Space.s20) {
          Text(copy.emptyDryRun).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
        }
      }
    }
  }
}

private struct DryRunCard: View {
  var item: DryRunItem
  var copy: ReviewCopy.Item
  var oursTitle: String
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let diff = DiffLite.diff(ours: item.ourDraft, theirs: item.whatYouSent)
    RingBox {
      // Who first, then the subject cut at the tail, then the time per item and what it saves.
      HStack(spacing: Tokens.Space.s8) {
        Text(copy.who)
          .textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
          .lineLimit(1).layoutPriority(2)
        Text(copy.subject)
          .textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
          .help(copy.subject)
          .lineLimit(1).truncationMode(.tail).layoutPriority(1)
        Spacer(minLength: Tokens.Space.s12)
        Text(copy.time)
          .textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink3)
          .lineLimit(1)
          .fixedSize()
        Chip(text: copy.saved, style: .positive)
      }
      .padding(.horizontal, Tokens.Space.s16)
      .frame(minHeight: Tokens.Size.toolbar - Tokens.Space.s8)
      RowDivider(inset: 0)
      HStack(alignment: .top, spacing: 0) {
        column(oursTitle, segments: diff.ours, marked: true, p: p)
        Rectangle().fill(p.ring).frame(width: 1)
        column(copy.theirsTitle, segments: diff.theirs, marked: false, p: p)
      }
      .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(copy.who), \(copy.subject)")
  }

  private func column(_ title: String, segments: [DiffLite.Segment], marked: Bool, p: Palette) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s8) {
      Text(title).textStyle(Tokens.TypeScale.caption).foregroundStyle(p.ink3)
      if segments.isEmpty {
        Text("No draft. This kind of task has no drafting dry run yet.")
          .textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
      } else {
        DiffText(segments: segments, marked: marked)
      }
    }
    .padding(Tokens.Space.s16)
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
      HStack(spacing: Tokens.Space.s8) {
        if case .discarding(let c) = model.flow.phase {
          TimelineView(.animation(minimumInterval: 1.0 / 30)) { ctx in
            CountdownStrip(text: "Discarding", countdown: c, now: ctx.date)
          }
        } else {
          SecondaryButton(title: "Discard", key: "⌘⌫") { model.send(.discard) }
          if let m = model.message {
            Text(m).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
              .lineLimit(2).fixedSize(horizontal: false, vertical: true)
              .padding(.leading, Tokens.Space.s8)
          }
          Spacer(minLength: Tokens.Space.s12)
          SecondaryButton(title: model.runningDryRun ? "Running…" : "Run again", key: "R") { model.send(.rerun) }
            .disabled(model.runningDryRun)
          SecondaryButton(title: "Edit", key: "E") { model.send(.edit) }
          // Always in place, so the bar never reflows: disabled while a dry run is drafting or there is nothing to
          // approve. One white action per view: while the confirmation is up it holds the primary.
          PrimaryButton(title: "Approve", key: "⌘↩") { model.send(.approve) }
            .disabled(!model.flow.canApprove || model.runningDryRun || model.sheet != nil)
            .opacity(model.sheet != nil ? 0.3 : 1)
        }
      }
      .padding(.horizontal, Tokens.Space.s20)
      .frame(height: Tokens.Size.actionBar)
    }
    .background(p.isDark ? Color(hex: 0x1C1C1F) : Color(hex: 0xF8F8FA))
  }
}

/// "Turning on in 4s · esc to cancel" with the blue hairline at exactly the seconds shown.
struct CountdownStrip: View {
  var text: String
  var countdown: Countdown
  var now: Date
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let seconds = countdown.secondsShown(at: now)
    VStack(spacing: Tokens.Space.s8) {
      HStack(spacing: Tokens.Space.s8) {
        StatusDot(role: .working, size: Tokens.Size.dotSmall).frame(width: Tokens.Space.s12, height: Tokens.Space.s12)
        Text("\(text) in \(countdown.secondsLeftLabel(at: now))").textStyle(Tokens.TypeScale.label)
          .monospacedDigit().foregroundStyle(p.ink1)
        Spacer()
        Text("Cancel").textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
        Keycap(label: "esc")
      }
      ProgressHairline(fraction: countdown.hairline(at: now), role: .working)
        .animation(Motion.outExpo(Tokens.Duration.base), value: seconds)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(text) in \(countdown.secondsLeftLabel(at: now)). Press Escape to cancel.")
  }
}

// MARK: sheets

/// The confirmation: exactly what the first run does, who gets an email, and what is not ready yet. While a
/// connector a later step needs is missing, Turn on is disabled with the reason beside it, and the primary
/// connects that connector instead (s10a).
struct ConfirmSheet: View {
  @ObservedObject var model: ReviewModel
  var frozenNow: Date? = nil
  @Environment(\.colorScheme) private var scheme

  static let width: CGFloat = 560

  var body: some View {
    let p = Palette(scheme: scheme)
    let plan = model.flow.plan
    let copy = ConfirmCopy(plan: plan, now: frozenNow ?? Date())
    VStack(alignment: .leading, spacing: 0) {
      Text(copy.title).paragraphStyle(Tokens.TypeScale.sheetTitle).foregroundStyle(p.ink1)
        .fixedSize(horizontal: false, vertical: true)
      Text(copy.subtitle).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, Tokens.Space.s4)

      RingBox {
        Text(copy.headline).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
          .padding(.horizontal, Tokens.Space.s16)
          .frame(height: Tokens.Size.row + Tokens.Space.s4)
        RowDivider(inset: 0)
        if let note = copy.pendingNote {
          Text(note).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
            .fixedSize(horizontal: false, vertical: true)
            .padding(Tokens.Space.s16)
        }
        if !copy.people.isEmpty {
          // Plain rows: numbers are keys elsewhere, so a list that is not pressable is not numbered.
          VStack(spacing: 0) {
            ForEach(copy.people) { r in
              HStack(spacing: Tokens.Space.s8) {
                Text(r.name).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1).lineLimit(1)
                Text(r.org).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2).lineLimit(1)
                Spacer(minLength: Tokens.Space.s8)
                Text(r.email).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3).lineLimit(1).truncationMode(.head)
              }
              .frame(height: Tokens.Space.s24)
            }
          }
          .padding(.horizontal, Tokens.Space.s16)
          .padding(.vertical, Tokens.Space.s8)
        }
      }
      .padding(.top, Tokens.Space.s20)

      VStack(alignment: .leading, spacing: Tokens.Space.s8) {
        ForEach(Array(copy.lines.enumerated()), id: \.offset) { _, line in
          HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
            Image(systemName: line.symbol).symbolStyle(Tokens.TypeScale.Symbol.small).foregroundStyle(p.ink3)
              .frame(width: Tokens.Space.s16)
            Text(line.text).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        ForEach(copy.blockers, id: \.self) { b in
          HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
            Circle().fill(p.status(.needsYou)).frame(width: Tokens.Size.dotSmall, height: Tokens.Size.dotSmall)
              .frame(width: Tokens.Space.s16)
            Text(b).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink1)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      .padding(.top, Tokens.Space.s16)

      Group {
        if let c = model.flow.countdown, case .armed = model.flow.phase {
          if let frozenNow {
            CountdownStrip(text: "Turning on", countdown: c, now: frozenNow)
          } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { ctx in
              CountdownStrip(text: "Turning on", countdown: c, now: ctx.date)
            }
          }
        } else if copy.canTurnOn {
          HStack(spacing: Tokens.Space.s8) {
            Text(copy.footnote).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
            Spacer()
            SecondaryButton(title: "Cancel", key: "esc") { model.send(.escape) }
            // ⌘↩ here too: Approve and Turn on are the same weight of action, so they share a chord.
            PrimaryButton(title: copy.turnOnTitle, key: "⌘↩") { model.send(.confirm) }
          }
        } else {
          VStack(alignment: .trailing, spacing: Tokens.Space.s12) {
            if let reason = copy.blockedReason {
              Text(reason).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: Tokens.Space.s8) {
              Spacer()
              SecondaryButton(title: "Cancel", key: "esc") { model.send(.escape) }
              SecondaryButton(title: copy.turnOnTitle) {}
                .disabled(true)
                .help(copy.blockedReason ?? "")
              PrimaryButton(title: copy.connectTitle ?? "Connect", key: nil) { model.connectFirstMissing() }
            }
          }
        }
      }
      .padding(.top, Tokens.Space.s20)
    }
    .padding(Tokens.Space.s24)
    .frame(width: Self.width)
    .background(p.isDark ? Color(hex: 0x202023) : Color(hex: 0xFBFBFC))
  }
}

/// The steps, as a person reads them (S, or the toolbar's Steps button). SKILL.md itself is behind a View source
/// disclosure. E opens the same sheet with the words editable (s05c); tools, connectors and your approval step
/// stay as they are.
struct SkillSheet: View {
  @ObservedObject var model: ReviewModel
  var editing: Bool
  /// Snapshots: render with the source open.
  var sourceOpen = false
  @State private var showSource = false
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot

  static let width: CGFloat = 640

  var body: some View {
    let p = Palette(scheme: scheme)
    let copy = model.copy
    VStack(alignment: .leading, spacing: Tokens.Space.s12) {
      HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
        Text(editing ? "Edit the steps" : "Steps").textStyle(Tokens.TypeScale.sheetTitle).foregroundStyle(p.ink1)
        Spacer()
        if editing && model.skillEdit != nil {
          SecondaryButton(title: "Cancel", key: "esc") { model.dismissSheet() }
          PrimaryButton(title: model.saving ? "Saving…" : "Save") { model.saveSkill() }
            .disabled(model.saving || !model.skillUnsaved)
        } else {
          SecondaryButton(title: "Done", key: "esc") { model.dismissSheet() }
        }
      }
      Text(editing ? "Change the words. The tools, the order and your approval stay as they are."
                   : PlainWords.clean(model.workflow.summary))
        .paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
        .fixedSize(horizontal: false, vertical: true)
      RingBox(padding: 0) {
        Group {
          if editing && !isSnapshot {
            SkillEditForm(model: model)
              .padding(Tokens.Space.s12)
          } else {
            VStack(alignment: .leading, spacing: 0) {
              ForEach(Array(copy.steps.enumerated()), id: \.element.id) { i, step in
                if i > 0 { RowDivider(inset: Tokens.Space.s40) }
                HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s12) {
                  Text(step.number).textStyle(Tokens.TypeScale.caption).monospacedDigit().foregroundStyle(p.ink3)
                    .frame(width: Tokens.Space.s16, alignment: .trailing)
                  VStack(alignment: .leading, spacing: Tokens.Space.s4) {
                    HStack(spacing: Tokens.Space.s8) {
                      if step.isGate { Image(systemName: "lock.fill").symbolStyle(Tokens.TypeScale.Symbol.small).foregroundStyle(p.ink2) }
                      Text(step.title).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
                    }
                    Text(step.detail).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
                      .fixedSize(horizontal: false, vertical: true)
                  }
                  Spacer(minLength: 0)
                }
                .padding(.horizontal, Tokens.Space.s16)
                .padding(.vertical, Tokens.Space.s8)
              }
            }
            .padding(.vertical, Tokens.Space.s4)
          }
        }
      }
      if !editing {
        Button {
          withAnimation(Motion.outExpo()) { showSource.toggle() }
        } label: {
          HStack(spacing: Tokens.Space.s4) {
            Image(systemName: "chevron.right").symbolStyle(Tokens.TypeScale.Symbol.small)
              .rotationEffect(.degrees(showSource || sourceOpen ? 90 : 0))
            Text("View source").textStyle(Tokens.TypeScale.calloutEmphasis)
          }
          .foregroundStyle(p.ink2)
          .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityHint("Shows the workflow file Offload runs from")
        if showSource || sourceOpen {
          RingBox(padding: Tokens.Space.s12) {
            if isSnapshot {
              Text(model.skillDraft).paragraphStyle(Tokens.TypeScale.code).foregroundStyle(p.ink2)
                .frame(maxWidth: .infinity, maxHeight: 220, alignment: .topLeading)
                .clipped()
            } else {
              ScrollView {
                Text(model.skillDraft).paragraphStyle(Tokens.TypeScale.code).foregroundStyle(p.ink2)
                  .textSelection(.enabled)
                  .frame(maxWidth: .infinity, alignment: .topLeading)
              }
              .frame(height: 220)
            }
          }
        }
      }
    }
    .padding(Tokens.Space.s20)
    .frame(width: Self.width)
    .background(p.isDark ? Color(hex: 0x202023) : Color(hex: 0xFBFBFC))
  }
}

/// Edit mode of the steps sheet (s05c): the description and each step's title and detail, nothing else. Your
/// approval step is shown locked.
private struct SkillEditForm: View {
  @ObservedObject var model: ReviewModel
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    if model.skillEdit == nil {
      Text(model.skillDoc == nil ? "Loading the steps…" : "")
        .textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
        .frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
    } else {
      ScrollView {
        VStack(alignment: .leading, spacing: Tokens.Space.s16) {
          Text("What it does").textStyle(Tokens.TypeScale.calloutEmphasis).foregroundStyle(p.ink2)
          TextField("What this workflow does", text: binding(\.description), axis: .vertical)
            .textFieldStyle(.roundedBorder).lineLimit(2...4)
          ForEach(Array((model.skillEdit?.steps ?? []).enumerated()), id: \.element.id) { i, step in
            VStack(alignment: .leading, spacing: Tokens.Space.s8) {
              HStack(spacing: Tokens.Space.s8) {
                Text("Step \(i + 1)").textStyle(Tokens.TypeScale.calloutEmphasis).foregroundStyle(p.ink2)
                if step.isGate {
                  Image(systemName: "lock.fill").symbolStyle(Tokens.TypeScale.Symbol.small).foregroundStyle(p.ink2)
                  Text("You approve each batch here. This step cannot be edited.")
                    .textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
                }
              }
              if step.isGate {
                Text(PlainWords.clean(step.title)).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
                Text(PlainWords.clean(step.detail)).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
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
      .frame(height: 420)
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
