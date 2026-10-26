import SwiftUI

/// S2-13: "Share with my team". The brain's exact proposal (`POST /workflows/:id/share`) in plain words, what never
/// goes with it, and a "View source" disclosure with the JSON itself. The white action confirms with the preview's
/// hash, so only what was shown is queued; then the sheet says it is queued and the white action closes it.
struct CompanyShareSheet: View {
  @ObservedObject var model: CompanyModel
  var preview: SharePreview
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot

  static let width: CGFloat = Tokens.Layout.confirmSheet
  static let sourceHeight: CGFloat = 200

  var body: some View {
    let p = Palette(scheme: scheme)
    let queued = model.shareQueued
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: Tokens.Space.nudge) {
        Text(CompanyCopy.shareTitle).textStyle(Tokens.TypeScale.sheetTitle).foregroundStyle(p.ink1)
        Text(preview.name).textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
      }
      Text(CompanyCopy.shareNote).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, Tokens.Space.s12)

      RingBox {
        ForEach(Array(preview.lines.enumerated()), id: \.offset) { i, line in
          if i > 0 { RowDivider() }
          HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s12) {
            Text(line.label).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
              .frame(width: Tokens.Layout.labelColumn, alignment: .leading)
            Text(line.value).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink1)
              .fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .padding(.horizontal, Tokens.Space.s16)
          .padding(.vertical, Tokens.Space.s8)
        }
      }
      .padding(.top, Tokens.Space.s16)

      HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
        Image(systemName: "lock").symbolStyle(Tokens.TypeScale.Symbol.small).foregroundStyle(p.ink3)
        Text(SharePreview.neverIncluded).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.top, Tokens.Space.s12)

      Button(action: model.toggleSource) {
        HStack(spacing: Tokens.Space.s4) {
          Image(systemName: "chevron.right").symbolStyle(Tokens.TypeScale.Symbol.small, weight: .semibold)
            .rotationEffect(.degrees(model.showSource ? 90 : 0))
          Text(model.showSource ? CompanyCopy.hideSource : CompanyCopy.viewSource).textStyle(Tokens.TypeScale.calloutEmphasis)
        }
        .foregroundStyle(p.ink2)
        .contentShape(Rectangle())
      }
      .buttonStyle(PressStyle())
      .padding(.top, Tokens.Space.s12)
      .accessibilityHint("Shows the exact text that is sent")

      if model.showSource {
        Well {
          CompanyScroll(axes: [.vertical, .horizontal]) {
            Text(preview.source).textStyle(Tokens.TypeScale.code).foregroundStyle(p.ink2)
              .textSelection(.enabled)
              .fixedSize()
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .frame(height: Self.sourceHeight)
        }
        .padding(.top, Tokens.Space.s8)
        .transition(.rise(reduceMotion: false))
      }

      if queued {
        RingBox {
          HStack(spacing: Tokens.Space.s12) {
            StatusDot(role: .done, size: Tokens.Size.dot).frame(width: Tokens.Space.s16, height: Tokens.Space.s16)
            Text(CompanyCopy.shareQueued).paragraphStyle(Tokens.TypeScale.label).foregroundStyle(p.statusInk(.done))
            Spacer(minLength: 0)
          }
          .padding(.horizontal, Tokens.Space.s16)
          .padding(.vertical, Tokens.Space.s12)
        }
        .padding(.top, Tokens.Space.s16)
        .transition(.rise(reduceMotion: false))
      }

      HStack(spacing: Tokens.Space.s8) {
        Spacer()
        if !queued { SecondaryButton(title: "Cancel", key: "esc") { model.dismissSheet() } }
        PrimaryButton(title: queued ? "Done" : CompanyCopy.shareConfirm, key: "⌘↩") { model.confirmShare() }
          .disabled(model.busy)
      }
      .padding(.top, Tokens.Space.s20)
    }
    .padding(Tokens.Space.s24)
    .frame(width: Self.width, alignment: .leading)
    .background(p.sheetFill)
    .animation(isSnapshot ? nil : Motion.outExpo(Tokens.Duration.base), value: model.showSource)
    .animation(isSnapshot ? nil : Motion.outExpo(Tokens.Duration.base), value: queued)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(CompanyCopy.shareTitle)
  }
}
