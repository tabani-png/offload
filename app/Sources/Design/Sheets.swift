import SwiftUI

/// s10e (DESIGN-REVIEW-3 M5, P8): sheets are drawn in the window by SwiftUI, attached under the toolbar like a
/// classic Mac sheet: square top edge flush with the toolbar, radius 24 at the bottom, the window behind dimmed so it
/// reads at about a quarter. The sheet's content is a function of the model, so no frame ever shows an empty
/// container (the old auto-send sheet sized its window before its value existed). Inserted with the rise transition
/// (opacity + 7 pt, out-expo 200 ms). Snapshot chrome uses the very same view.
struct AttachedSheet<Sheet: View>: ViewModifier {
  var isPresented: Bool
  @ViewBuilder var sheet: () -> Sheet
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.isSnapshot) private var isSnapshot

  func body(content: Content) -> some View {
    let p = Palette(scheme: scheme)
    content.overlay(alignment: .top) {
      ZStack(alignment: .top) {
        if isPresented {
          SheetScrim()
            .transition(.opacity)
          let shape = UnevenRoundedRectangle(bottomLeadingRadius: Tokens.Window.sheetRadius,
                                             bottomTrailingRadius: Tokens.Window.sheetRadius, style: .continuous)
          sheet()
            .background(p.sheetFill)
            .clipShape(shape)
            .overlay(shape.strokeBorder(p.isDark ? .white.opacity(0.14) : .black.opacity(0.12), lineWidth: Tokens.Layout.hairline))
            .transition(.rise(reduceMotion: reduceMotion))
            .accessibilityAddTraits(.isModal)
        }
      }
      .animation(isSnapshot ? nil : Motion.outExpo(Tokens.Duration.base), value: isPresented)
    }
  }
}

/// The dimming behind an attached sheet; it also swallows clicks so the window behind cannot be used.
struct SheetScrim: View {
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    Rectangle()
      .fill(.black.opacity(scheme == .dark ? Tokens.Window.scrimDark : Tokens.Window.scrimLight))
      .contentShape(Rectangle())
      .onTapGesture {}
      .accessibilityHidden(true)
  }
}

extension View {
  func attachedSheet<S: View>(_ isPresented: Bool, @ViewBuilder _ sheet: @escaping () -> S) -> some View {
    modifier(AttachedSheet(isPresented: isPresented, sheet: sheet))
  }

  /// Dims a pane (the dashboard sidebar) while a sheet is up on its neighbour.
  func dimmed(_ on: Bool) -> some View {
    overlay { if on { SheetScrim() } }
  }
}
