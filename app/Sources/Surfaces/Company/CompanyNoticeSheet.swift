import SwiftUI

/// S2-13: the company's notice. The tenant's own Markdown first, then the two lists Offload itself guarantees (what
/// the company sees, what it never sees), the features on for me, and one white action that records the ack through
/// the brain (`POST /sync/notice/ack`). Until then nothing but that acknowledgement leaves this Mac.
struct CompanyNoticeSheet: View {
  @ObservedObject var model: CompanyModel
  @Environment(\.colorScheme) private var scheme

  static let width: CGFloat = Tokens.Layout.confirmSheet
  static let textHeight: CGFloat = 252

  var body: some View {
    let p = Palette(scheme: scheme)
    let s = model.status
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: Tokens.Space.nudge) {
        Text(s.notice?.title ?? "Notice").textStyle(Tokens.TypeScale.sheetTitle).foregroundStyle(p.ink1)
        Text("From \(s.tenantLabel)").textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
      }

      RingBox {
        CompanyScroll {
          NoticeText(markdown: s.notice?.markdown ?? "")
            .padding(Tokens.Space.s16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: Self.textHeight)
      }
      .padding(.top, Tokens.Space.s16)

      HStack(alignment: .top, spacing: Tokens.Space.s16) {
        VisibilityList(title: CompanyCopy.sees, symbol: "checkmark", items: CompanyVisibility.sees(features: s.features))
        VisibilityList(title: CompanyCopy.neverSees, symbol: "xmark", items: CompanyVisibility.neverSees)
      }
      .padding(.top, Tokens.Space.s16)

      VStack(alignment: .leading, spacing: Tokens.Space.s8) {
        SectionHeader(title: CompanyCopy.featuresOn)
        FeatureChips(status: s)
      }
      .padding(.top, Tokens.Space.s16)

      Text(CompanyCopy.noticeNote).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, Tokens.Space.s16)

      if let m = model.message {
        Text(m).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.statusInk(.needsYou))
          .fixedSize(horizontal: false, vertical: true)
          .padding(.top, Tokens.Space.s8)
      }

      HStack(spacing: Tokens.Space.s8) {
        Spacer()
        SecondaryButton(title: CompanyCopy.noticeLater, key: "esc") { model.dismissSheet() }
        PrimaryButton(title: CompanyCopy.acknowledge, key: "⌘↩") { model.acknowledge() }
          .disabled(model.busy)
      }
      .padding(.top, Tokens.Space.s20)
    }
    .padding(Tokens.Space.s24)
    .frame(width: Self.width, alignment: .leading)
    .background(p.sheetFill)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(s.notice?.title ?? "Notice")
  }
}

/// The notice's Markdown as native text: headings by size and ink, bullets and numbers with a hanging indent,
/// inline bold and links through AttributedString. Images and HTML stay plain text.
struct NoticeText: View {
  var markdown: String
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Tokens.Space.s8) {
      ForEach(Array(NoticeMarkdown.blocks(markdown).enumerated()), id: \.offset) { _, block in
        switch block {
        case .heading(let level, let text):
          Text(Self.inline(text)).textStyle(level <= 1 ? Tokens.TypeScale.title : Tokens.TypeScale.label)
            .foregroundStyle(p.ink1)
            .padding(.top, Tokens.Space.s4)
            .accessibilityAddTraits(.isHeader)
        case .bullet(let text):
          item("•", text, p)
        case .numbered(let n, let text):
          item("\(n).", text, p)
        case .paragraph(let text):
          Text(Self.inline(text)).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .textSelection(.enabled)
  }

  private func item(_ mark: String, _ text: String, _ p: Palette) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
      Text(mark).textStyle(Tokens.TypeScale.body).monospacedDigit().foregroundStyle(p.ink3)
        .frame(width: Tokens.Space.s16, alignment: .trailing)
      Text(Self.inline(text)).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  /// Bold and italics render; links stay plain ink text (colour means state, and a notice is read, not clicked).
  static func inline(_ s: String) -> AttributedString {
    guard var a = try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) else {
      return AttributedString(s)
    }
    for run in a.runs where run.link != nil { a[run.range].link = nil }
    return a
  }
}

/// One of the two lists. Neutral ink marks: a check or a cross is content here, not a state.
struct VisibilityList: View {
  var title: String
  var symbol: String
  var items: [String]
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Tokens.Space.s8) {
      SectionHeader(title: title)
      ForEach(items, id: \.self) { item in
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
          Image(systemName: symbol).symbolStyle(Tokens.TypeScale.Symbol.small, weight: .semibold).foregroundStyle(p.ink3)
            .frame(width: Tokens.Space.s12)
          Text(item).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .topLeading)
  }
}

/// The features that are on for me, or one sentence when none is.
struct FeatureChips: View {
  var status: CompanyStatus
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let on = status.featuresOn.filter { $0 != .workflowMetrics }
    if on.isEmpty {
      HStack(spacing: Tokens.Space.s8) {
        Chip(text: CompanyFeature.workflowMetrics.plain)
        Text(CompanyCopy.noFeatures).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
      }
    } else {
      FlowLayout(spacing: Tokens.Space.s8) {
        ForEach(status.featuresOn, id: \.self) { Chip(text: $0.plain) }
      }
    }
  }
}
