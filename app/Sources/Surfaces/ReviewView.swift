import AppKit
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
    // s10e: sheets are drawn in the window, attached under the toolbar (live and snapshot alike).
    .attachedSheet(!isSnapshot && model.sheet != nil) { ReviewSheetContent(model: model) }
  }

  private var content: some View {
    let copy = model.copy
    return VStack(alignment: .leading, spacing: Tokens.Space.s32) {
      if parts.contains(.header) { ReviewHeader(model: model, copy: copy).id("section.top") }
      // s14: a general workflow shows its typed plan; "Your voice" only when it writes text.
      let plan = model.planCopy
      if parts.contains(.steps) {
        if let plan { PlanSection(model: model, copy: plan, tools: copy.tools) } else { StepsSection(model: model, copy: copy) }
      }
      if parts.contains(.tone) && (plan?.writesText ?? true) { ToneSection(model: model) }
      if parts.contains(.dryRun) {
        if let g = model.generalCopy {
          GeneralDryRunSection(copy: copy, general: g).id(ReviewModel.dryRunSectionId)
        } else {
          DryRunSection(model: model, copy: copy).id(ReviewModel.dryRunSectionId)
        }
      }
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
        ForEach(w.connectors) { c in ConnectorChip(connector: c) { model.openConnect($0) } }
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
  @ObservedObject var model: ReviewModel
  var copy: ReviewCopy

  var body: some View {
    WindowSection(title: copy.stepsTitle, trailing: copy.stepsTrailing) {
      RingBox {
        ForEach(Array(copy.steps.enumerated()), id: \.element.id) { i, step in
          if i > 0 { RowDivider(inset: Tokens.Space.s40) }
          StepRow(step: step)
          // s14: the tool suggestion for this step, attached under it.
          if let t = copy.tools[step.id] { ToolSuggestionView(model: model, copy: t) }
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
      // s10d: the lock hangs left of the number, so every title starts at the same x.
      Text(step.number)
        .textStyle(Tokens.TypeScale.caption).monospacedDigit()
        .foregroundStyle(p.ink3)
        .frame(width: Tokens.Space.s16, alignment: .trailing)
        .overlay(alignment: .leading) {
          if step.isGate {
            Image(systemName: "lock.fill").symbolStyle(Tokens.TypeScale.Symbol.small).foregroundStyle(p.ink2)
              .offset(x: -Tokens.Space.s12)
              .accessibilityHidden(true)
          }
        }
      VStack(alignment: .leading, spacing: Tokens.Space.s4) {
        Text(step.title).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
          .fixedSize(horizontal: false, vertical: true)
        Text(step.detail)
          .paragraphStyle(Tokens.TypeScale.callout)
          .foregroundStyle(p.ink2)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      // One column width on every row, the approval step included, so every description wraps at one measure.
      Text(step.isGate ? "" : step.place)
        .textStyle(Tokens.TypeScale.callout)
        .foregroundStyle(step.placeNeedsYou ? p.statusInk(.needsYou) : p.ink3)
        .multilineTextAlignment(.trailing)
        .frame(width: Tokens.Layout.placeColumn, alignment: .trailing)
        .fixedSize(horizontal: false, vertical: true)
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
  @FocusState private var focused: Bool
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot

  /// s10e (M3): the measured style, from the brain (or the sample week's own numbers in snapshots).
  private var measured: ToneMeasured? { model.tone?.measured ?? (model.toneLoaded ? nil : MockBrainClient.sampleMeasured[model.workflow.id]) }

  var body: some View {
    let p = Palette(scheme: scheme)
    WindowSection(title: "Your voice", trailing: toneTrailing) {
      if !model.toneLoaded && !isSnapshot {
        RingBox(padding: Tokens.Space.s16) {
          HStack(spacing: Tokens.Space.s12) {
            Spinner()
            Text("Measuring your voice from your sent mail…").textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
          }
        }
      } else {
        RingBox(padding: 0) {
          if let m = measured {
            facts(VoiceFacts(m), p)
          } else {
            Text("Not measured yet. Offload measures your voice from your sent mail once Gmail is connected.")
              .paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
              .fixedSize(horizontal: false, vertical: true)
              .padding(Tokens.Space.s16)
          }
          RowDivider(inset: 0)
          notes(p)
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

  /// Four measured rows and one line quoted from a real email.
  private func facts(_ v: VoiceFacts, _ p: Palette) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(v.rows.enumerated()), id: \.element.id) { i, r in
        if i > 0 { RowDivider(inset: Tokens.Space.s16) }
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s12) {
          Text(r.label).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
            .frame(width: Tokens.Layout.receiptLabel, alignment: .leading)
          Text(r.value).paragraphStyle(Tokens.TypeScale.body).monospacedDigit().foregroundStyle(p.ink1)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
          // s10f (P1): "from 40 sent emails" is said once, in the section header, not on every row.
        }
        .padding(.horizontal, Tokens.Space.s16).padding(.vertical, Tokens.Space.s8 + Tokens.Space.nudge)
      }
      if let q = v.quote {
        RowDivider(inset: Tokens.Space.s16)
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s12) {
          Text("In your words").textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
            .frame(width: Tokens.Layout.receiptLabel, alignment: .leading)
          Text(q).paragraphStyle(Tokens.TypeScale.body).italic().foregroundStyle(p.ink1)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, Tokens.Space.s16).padding(.vertical, Tokens.Space.s8 + Tokens.Space.nudge)
      }
    }
  }

  /// The written notes drafts also follow: collapsed to a line with "Edit notes"; open, the text box.
  @ViewBuilder
  private func notes(_ p: Palette) -> some View {
    if model.editingVoice {
      Group {
        if isSnapshot {
          Text(model.toneDraft).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(.horizontal, Tokens.Space.s4)
        } else {
          TextEditor(text: $model.toneDraft)
            .paragraphStyle(Tokens.TypeScale.body)
            .foregroundStyle(p.ink1)
            .scrollContentBackground(.hidden)
            .focused($focused)
            .frame(height: Tokens.Layout.editorMax)
            .overlay(alignment: .topLeading) {
              if model.toneDraft.isEmpty {
                Text("Write a few lines on how you sound. Drafts follow them.")
                  .paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink3)
                  .padding(.leading, Tokens.Space.s4)
                  .allowsHitTesting(false)
              }
            }
            .onChange(of: focused) { _, f in model.textEditing = f }
            .onAppear { focused = true }
            .accessibilityLabel("Notes on how you write, editable")
        }
      }
      .padding(Tokens.Space.s12)
    } else {
      HStack(spacing: Tokens.Space.s12) {
        // s10f (P1): two lines, so a note is not cut mid-word.
        Text(Self.firstLine(model.toneDraft)).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
          .lineLimit(2).truncationMode(.tail).fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
        Button { model.editingVoice = true } label: {
          Text("Edit notes").textStyle(Tokens.TypeScale.calloutEmphasis).foregroundStyle(p.ink1)
            .padding(.horizontal, Tokens.Space.s8)
            .frame(height: Tokens.Size.chip)
            .overlay(Capsule().strokeBorder(p.ringStrong, lineWidth: Tokens.Layout.hairline))
        }
        .buttonStyle(PressStyle())
      }
      .padding(.horizontal, Tokens.Space.s16).padding(.vertical, Tokens.Space.s8)
    }
  }

  /// The first line of the notes that is not front matter or a heading, for the collapsed row.
  static func firstLine(_ text: String) -> String {
    let lines = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
    var inFront = lines.first == "---"
    for (i, l) in lines.enumerated() {
      if inFront { if i > 0 && l == "---" { inFront = false }; continue }
      if l.isEmpty || l.hasPrefix("#") { continue }
      let t = l.hasPrefix("- ") ? String(l.dropFirst(2)) : l
      return "Notes: \(t)"
    }
    return "No written notes yet."
  }

  private var toneTrailing: String? {
    if model.toneUnsaved { return "Not saved yet" }
    if let m = measured { return VoiceFacts(m).header }
    return nil
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
              DryRunCard(item: d.items[i], copy: item, oursTitle: copy.oursTitle, sampleHeader: copy.sampleCardHeader)
            }
          }
          Text(copy.diffNote).textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
            .fixedSize(horizontal: false, vertical: true)
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
  /// s10f (M3): "Sample, not your voice" on every card of a sample run, in amber.
  var sampleHeader: String? = nil
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let diff = DiffLite.diff(ours: item.ourDraft, theirs: item.whatYouSent)
    RingBox {
      if let sampleHeader {
        HStack(spacing: Tokens.Space.s8) {
          Circle().fill(p.status(.needsYou)).frame(width: Tokens.Size.dotSmall, height: Tokens.Size.dotSmall)
          Text(sampleHeader).textStyle(Tokens.TypeScale.calloutEmphasis).foregroundStyle(p.statusInk(.needsYou))
          Spacer(minLength: 0)
        }
        .padding(.horizontal, Tokens.Space.s16)
        .padding(.vertical, Tokens.Space.s8)
        .background(p.status(.needsYou).opacity(p.isDark ? 0.10 : 0.08))
        RowDivider(inset: 0)
      }
      // s10d: two lines, like a mail header. Who and what it saves; then the subject (it may truncate) and the
      // time, which never does.
      VStack(alignment: .leading, spacing: Tokens.Space.s4) {
        HStack(spacing: Tokens.Space.s8) {
          Text(copy.who)
            .textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
            .lineLimit(1).truncationMode(.tail)
          Spacer(minLength: Tokens.Space.s12)
          // s10f (P3): green means done; a per-draft saving is a neutral chip.
          Chip(text: copy.saved, style: .neutral)
        }
        HStack(spacing: Tokens.Space.s8) {
          Text(copy.subject)
            .textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
            .help(copy.subject)
            .lineLimit(1).truncationMode(.tail)
          Spacer(minLength: Tokens.Space.s12)
          Text(copy.time)
            .textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink3)
            .lineLimit(1)
            .fixedSize()
            .layoutPriority(3)
        }
      }
      .padding(.horizontal, Tokens.Space.s16)
      .padding(.vertical, Tokens.Space.s12)
      RowDivider(inset: 0)
      HStack(alignment: .top, spacing: 0) {
        column(oursTitle, segments: SentenceDiff.spans(ours: item.ourDraft, theirs: item.whatYouSent), marked: true,
               check: copy.check, other: nil, p: p)
        Rectangle().fill(p.ring).frame(width: Tokens.Layout.hairline)
        column(copy.theirsTitle, segments: diff.theirs, marked: false, check: nil, other: nil, p: p)
      }
      .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(copy.who), \(copy.subject)")
  }

  /// The column's title and, on our side, how far the draft is from what you sent (by sentence, plus the sign-off).
  @ViewBuilder
  private func columnHeader(_ title: String, marked: Bool, p: Palette) -> some View {
    Text(title).textStyle(Tokens.TypeScale.caption).foregroundStyle(p.ink3)
    if marked {
      Text(SentenceDiff.summary(ours: item.ourDraft, theirs: item.whatYouSent).label)
        .textStyle(Tokens.TypeScale.caption).foregroundStyle(p.ink2)
        .fixedSize()
        .padding(.horizontal, Tokens.Space.s8).frame(height: Tokens.Size.tag)
        .background(Capsule().fill(p.fill))
        .overlay(Capsule().strokeBorder(p.ring, lineWidth: Tokens.Layout.hairline))
    }
  }

  private func column(_ title: String, segments: [DiffLite.Segment], marked: Bool, check: String?, other: Set<String>?,
                      p: Palette) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s8) {
      // s10f: the tag wraps under the title when the column is narrow, never truncates.
      ViewThatFits(in: .horizontal) {
        HStack(spacing: Tokens.Space.s8) { columnHeader(title, marked: marked, p: p) }
        VStack(alignment: .leading, spacing: Tokens.Space.s4) { columnHeader(title, marked: marked, p: p) }
      }
      if segments.isEmpty {
        Text("No draft. This kind of task has no drafting dry run yet.")
          .textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
      } else {
        DiffText(segments: segments, marked: marked, other: other, spans: marked)
      }
      // s10d: a number or date the draft added that you never wrote and your facts do not hold.
      if let check {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
          Circle().fill(p.status(.needsYou)).frame(width: Tokens.Size.dotSmall, height: Tokens.Size.dotSmall)
          Text(check).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink1)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, Tokens.Space.s4)
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
    // s10f (M8): the bar knows its width, so below 720 pt the primary takes its short title and never truncates.
    GeometryReader { geo in bar(compact: Double(geo.size.width) < ReviewPrimary.compactBelow) }
      .frame(height: Tokens.Size.actionBar + Tokens.Layout.hairline)
  }

  private func bar(compact: Bool) -> some View {
    let p = Palette(scheme: scheme)
    let primary = ReviewPrimary.forWorkflow(model.workflow, sample: model.dryRun?.isSample == true)
    return VStack(spacing: 0) {
      Rectangle().fill(p.barHairline).frame(height: Tokens.Layout.hairline)
      HStack(spacing: Tokens.Space.s8) {
        if case .discarding(let c) = model.flow.phase {
          TimelineView(.animation(minimumInterval: 1.0 / 30)) { ctx in
            CountdownStrip(text: "Discarding", countdown: c, now: ctx.date)
          }
        } else {
          // s23 (PR #13 F4): after Turn on the footer is ReviewFooterButtons: no Discard, no Approve, Done is primary.
          if primary != .done { SecondaryButton(title: "Discard", key: "⌘⌫") { model.send(.discard) } }
          if let m = model.message ?? (model.textEditing ? "Typing in your voice: R, E and S type letters. Press esc to stop typing." : nil) {
            Text(m).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
              .lineLimit(2).fixedSize(horizontal: false, vertical: true)
              .padding(.leading, Tokens.Space.s8)
          }
          Spacer(minLength: Tokens.Space.s12)
          // s10f (M3): on a sample run the white primary reruns the dry run, so Run again is not shown twice.
          if primary != .runWithVoice {
            SecondaryButton(title: model.runningDryRun ? "Running…" : "Run again", key: model.textEditing ? nil : "R") { model.send(.rerun) }
              .disabled(model.runningDryRun)
          }
          SecondaryButton(title: "Edit", key: model.textEditing ? nil : "E") { model.send(.edit) }
          // Always in place, so the bar never reflows: disabled while a dry run is drafting or there is nothing to
          // approve. One white action per view: while the confirmation is up it holds the primary.
          // Disabled keeps its label (s10d), never a blank pill.
          // s10e (M8): while a step's tool is not connected, Connect is the white primary on ⌘↩ and Approve is
          // secondary, so the block is met here and not only in the next sheet.
          switch primary {
          case .done:
            PrimaryButton(title: primary.title, key: "⌘↩") { NSApp.keyWindow?.performClose(nil) }
              .fixedSize().layoutPriority(2)
          case .runWithVoice:
            SecondaryButton(title: "Approve") { model.approveNow() }
              .disabled(!model.flow.canApprove || model.runningDryRun || model.sheet != nil)
            PrimaryButton(title: model.runningDryRun ? "Running…" : primary.title(compact: compact), key: "⌘↩") { model.runWithVoice() }
              .disabled(model.runningDryRun || model.sheet != nil)
              .fixedSize().layoutPriority(2)
          case .connect(let c) where model.flow.canApprove:
            SecondaryButton(title: "Approve") { model.approveNow() }
              .disabled(model.runningDryRun || model.sheet != nil)
            PrimaryButton(title: primary.title(compact: compact), key: "⌘↩") { model.openConnect(c) }
              .disabled(model.sheet != nil)
              .fixedSize().layoutPriority(2)
          default:
            PrimaryButton(title: "Approve", key: "⌘↩") { model.send(.approve) }
              .disabled(!model.flow.canApprove || model.runningDryRun || model.sheet != nil)
              .fixedSize().layoutPriority(2)
          }
        }
      }
      .padding(.horizontal, Tokens.Space.s20)
      .frame(height: Tokens.Size.actionBar)
    }
    .background(p.actionBarFill)
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
/// connector a later step needs is missing, the reason is said once (the amber lines), Turn on is not shown (s10f),
/// and the primary is "Connect …" with ⌘↩ (s10d).
struct ConfirmSheet: View {
  @ObservedObject var model: ReviewModel
  var frozenNow: Date? = nil
  @Environment(\.colorScheme) private var scheme

  static let width: CGFloat = Tokens.Layout.confirmSheet

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

      if copy.people.isEmpty {
        // No list yet: two sentences, said plainly, not a card inside the sheet.
        VStack(alignment: .leading, spacing: Tokens.Space.s4) {
          Text(copy.headline).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
          if let note = copy.pendingNote {
            Text(note).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        .padding(.top, Tokens.Space.s20)
      } else {
        RingBox {
          Text(copy.headline).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
            .padding(.horizontal, Tokens.Space.s16)
            .frame(height: Tokens.Size.row + Tokens.Space.s4)
          RowDivider(inset: 0)
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
        .padding(.top, Tokens.Space.s20)
      }

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
          HStack(spacing: Tokens.Space.s8) {
            Spacer()
            SecondaryButton(title: "Cancel", key: "esc") { model.send(.escape) }
            // s10f (M5): no disabled Turn on beside the primary; it shows only when it can be pressed. Blocked: the way
            // forward is the primary, on the same chord Turn on would have had.
            PrimaryButton(title: copy.connectTitle ?? "Connect", key: "⌘↩") { model.connectFirstMissing() }
              .help(copy.blockedReason ?? "")
              .accessibilityHint(copy.blockedReason ?? "")
          }
        }
      }
      .padding(.top, Tokens.Space.s20)
    }
    .padding(Tokens.Space.s24)
    .frame(width: Self.width)
    .background(p.sheetFill)
  }
}

/// Edit the steps (E, S or the toolbar). The page already lists the steps, so this sheet is only the editor: the
/// description and each step's title and detail; your approval step is shown locked. s10d: no raw file on screen;
/// "Show in Finder" opens the workflow's folder for anyone who wants the file itself.
struct SkillSheet: View {
  @ObservedObject var model: ReviewModel
  var editing: Bool = true
  /// Snapshots: a problem line, as the editor shows it after a Save it refused.
  var problem: String? = nil
  var onReveal: ((String) -> Void)? = nil
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot

  static let width: CGFloat = Tokens.Layout.skillSheet

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Tokens.Space.s12) {
      HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
        Text("Edit the steps").textStyle(Tokens.TypeScale.sheetTitle).foregroundStyle(p.ink1)
        Spacer()
      }
      Text("Change the words. The tools, the order and your approval stay as they are.")
        .paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
        .fixedSize(horizontal: false, vertical: true)
      SkillEditForm(model: model, snapshot: isSnapshot)
      if let problem = problem ?? model.message.flatMap({ $0.hasPrefix("Not saved") ? $0 : nil }) {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
          Circle().fill(p.status(.needsYou)).frame(width: Tokens.Size.dotSmall, height: Tokens.Size.dotSmall)
          Text(problem).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink1)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      HStack(spacing: Tokens.Space.s8) {
        if !model.workflow.path.isEmpty, let onReveal {
          Button { onReveal(model.workflow.path) } label: {
            Text("Show in Finder").textStyle(Tokens.TypeScale.calloutEmphasis).foregroundStyle(p.ink2)
          }
          .buttonStyle(PressStyle())
        }
        Spacer()
        SecondaryButton(title: "Cancel", key: "esc") { model.dismissSheet() }
        PrimaryButton(title: model.saving ? "Saving…" : "Save", key: "⌘↩") { model.saveSkill() }
          .disabled(model.saving || (!isSnapshot && !model.skillUnsaved))
      }
    }
    .padding(Tokens.Space.s20)
    .frame(width: Self.width)
    .background(p.sheetFill)
  }
}

/// The editor's fields. Live: real text fields in our own field chrome; snapshots draw the same chrome with the
/// text in it (AppKit text fields do not render offscreen), so both look the same.
private struct SkillEditForm: View {
  @ObservedObject var model: ReviewModel
  var snapshot: Bool
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let doc = model.skillEdit ?? (snapshot ? model.previewSkillDoc : nil)
    if let doc {
      let rows = VStack(alignment: .leading, spacing: Tokens.Space.s16) {
        field("What it does", text: doc.description, binding: binding(\.description), lines: 2, p: p)
        ForEach(Array(doc.steps.enumerated()), id: \.element.id) { i, step in
          if step.isGate {
            VStack(alignment: .leading, spacing: Tokens.Space.s4) {
              HStack(spacing: Tokens.Space.s8) {
                Image(systemName: "lock.fill").symbolStyle(Tokens.TypeScale.Symbol.small).foregroundStyle(p.ink2)
                Text("Step \(i + 1) · \(PlainWords.clean(step.title))").textStyle(Tokens.TypeScale.calloutEmphasis).foregroundStyle(p.ink1)
              }
              Text("You approve each batch here. This step cannot be changed.")
                .textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
            }
          } else {
            VStack(alignment: .leading, spacing: Tokens.Space.s8) {
              field("Step \(i + 1)", text: PlainWords.clean(step.title), binding: stepBinding(i, \.title), lines: 1, p: p)
              fieldBox(text: PlainWords.clean(step.detail), binding: stepBinding(i, \.detail), lines: 2, p: p)
            }
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if snapshot {
        rows.frame(maxHeight: Tokens.Layout.editorSheet, alignment: .top).clipped()
      } else {
        // s10e (P7): an 8-pt fade at the bottom, so a field cut by the scroll edge reads as "more below".
        ScrollView { rows.padding(.bottom, Tokens.Space.s8) }.frame(height: Tokens.Layout.editorSheet)
          .mask(VStack(spacing: 0) {
            Rectangle()
            LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: Tokens.Space.s8)
          })
      }
    } else {
      Text("Loading the steps…")
        .textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
        .frame(maxWidth: .infinity, minHeight: Tokens.Layout.editorMax, alignment: .topLeading)
    }
  }

  private func field(_ label: String, text: String, binding: Binding<String>, lines: Int, p: Palette) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s4) {
      Text(label).textStyle(Tokens.TypeScale.calloutEmphasis).foregroundStyle(p.ink2)
      fieldBox(text: text, binding: binding, lines: lines, p: p)
    }
  }

  private func fieldBox(text: String, binding: Binding<String>, lines: Int, p: Palette) -> some View {
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.control, style: .continuous)
    return Group {
      if snapshot {
        Text(text).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
          .lineLimit(lines).frame(maxWidth: .infinity, alignment: .leading)
      } else {
        TextField("", text: binding, axis: .vertical)
          .textFieldStyle(.plain)
          .paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
          .lineLimit(1...max(1, lines + 2))
      }
    }
    .padding(.horizontal, Tokens.Space.s8)
    .padding(.vertical, Tokens.Space.s4 + Tokens.Space.nudge)
    .background(shape.fill(p.fill))
    .overlay(shape.strokeBorder(p.ring, lineWidth: Tokens.Layout.hairline))
  }

  private func binding(_ kp: WritableKeyPath<SkillDoc, String>) -> Binding<String> {
    Binding(get: { model.skillEdit?[keyPath: kp] ?? "" }, set: { model.skillEdit?[keyPath: kp] = $0 })
  }

  private func stepBinding(_ i: Int, _ kp: WritableKeyPath<SkillStep, String>) -> Binding<String> {
    Binding(get: { model.skillEdit.flatMap { $0.steps.indices.contains(i) ? $0.steps[i][keyPath: kp] : nil } ?? "" },
            set: { v in if model.skillEdit?.steps.indices.contains(i) == true { model.skillEdit?.steps[i][keyPath: kp] = v } })
  }
}

/// s10e: which sheet the review shows, in the window.
struct ReviewSheetContent: View {
  @ObservedObject var model: ReviewModel
  var frozenNow: Date? = nil

  var body: some View {
    switch model.sheet {
    case .confirm?: ConfirmSheet(model: model, frozenNow: frozenNow)
    case .skill(let editing)?:
      SkillSheet(model: model, editing: editing, onReveal: { path in
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
      })
    case .connect?:
      if let s = model.connect { ConnectSheet(session: s) }
    case nil: EmptyView()
    }
  }
}
