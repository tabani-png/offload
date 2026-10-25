import AppKit
import SwiftUI

// s08 components for the two normal titled windows (workflow review, dashboard). Same tokens as the glass
// surfaces; the window canvas is opaque graphite (dark) or Apple's light grouped grey, and boxes are rings.

extension Palette {
  /// Window canvas. Dark is the hero.
  var canvas: Color { isDark ? Color(hex: 0x161618) : Color(hex: 0xF3F3F5) }
  /// A grouped box on the canvas: rows, sections.
  var group: Color { isDark ? .white.opacity(0.045) : .white }
  /// Diff-lite highlight behind a changed word. Neutral on purpose: colour means state, and a reworded phrase
  /// is not a state.
  var mark: Color { isDark ? .white.opacity(0.15) : .black.opacity(0.075) }
  /// Window toolbar band and the action bar under the review (s10d: named, not literals at each use).
  var toolbarFill: Color { isDark ? Color(hex: 0x232326) : Color(hex: 0xEDEDF0) }
  var actionBarFill: Color { isDark ? Color(hex: 0x1C1C1F) : Color(hex: 0xF8F8FA) }
  /// Sheet background.
  var sheetFill: Color { isDark ? Color(hex: 0x2A2A2D) : Color(hex: 0xFBFBFC) }
  /// Snapshot stand-in for the sidebar material (live: NSSplitViewItem's own sidebar material).
  var sidebarFill: Color { isDark ? Color(hex: 0x1F1F22) : Color(hex: 0xE8E8EB) }

  /// Timeline ink for a task rank (s10a): neutral steps of one ink, darkest = most time, never a hue (colour means
  /// state). Values and their >= 3:1 contrast live in Core (TimelineInk) so they are tested.
  func task(_ rank: Int) -> Color {
    (isDark ? Color.white : Color.black).opacity(TimelineInk.opacity(rank: rank, dark: isDark))
  }
}

// MARK: FlowLayout

/// Lays children left to right and wraps to a new line when the next one would not fit (chips, connector rows).
/// Never wider than the width it is offered, so a long label can never push a window's content off the side.
struct FlowLayout: Layout {
  var spacing: CGFloat = Tokens.Space.s8
  var lineSpacing: CGFloat = Tokens.Space.s8

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, widest: CGFloat = 0
    for v in subviews {
      let s = v.sizeThatFits(ProposedViewSize(width: width, height: nil))
      let w = min(s.width, width)
      if x > 0 && x + w > width { y += lineHeight + lineSpacing; x = 0; lineHeight = 0 }
      x += w + spacing
      widest = max(widest, x - spacing)
      lineHeight = max(lineHeight, s.height)
    }
    return CGSize(width: width.isFinite ? width : widest, height: y + lineHeight)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX, y = bounds.minY, lineHeight: CGFloat = 0
    // Items on one line share a centre line.
    var line: [(LayoutSubview, CGSize, CGFloat)] = []
    func flush() {
      for (v, s, px) in line {
        v.place(at: CGPoint(x: px, y: y + (lineHeight - s.height) / 2), proposal: ProposedViewSize(width: s.width, height: s.height))
      }
      line.removeAll()
    }
    for v in subviews {
      var s = v.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
      s.width = min(s.width, bounds.width)
      if x > bounds.minX && x + s.width > bounds.maxX {
        flush()
        y += lineHeight + lineSpacing
        x = bounds.minX
        lineHeight = 0
      }
      line.append((v, s, x))
      x += s.width + spacing
      lineHeight = max(lineHeight, s.height)
    }
    flush()
  }
}

// MARK: ConnectorChip

/// Connector state from GET /connectors: green dot connected, amber "Add key…", grey "Connect…".
/// The action half is its own button so the chip still reads as a label.
struct ConnectorChip: View {
  var connector: Connector
  var compact = false
  /// Pointer anchor id for the action half ("Connect…" / "Add key…"), so "show me" lands on what you press.
  var actionTarget: String? = nil
  var onAction: (Connector) -> Void = { _ in }
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let m = ConnectorChipModel(connector)
    let type = compact ? Tokens.TypeScale.caption : Tokens.TypeScale.calloutEmphasis
    HStack(spacing: 0) {
      HStack(spacing: Tokens.Space.s4) {
        Circle().fill(p.status(m.role)).frame(width: Tokens.Size.dotSmall, height: Tokens.Size.dotSmall)
        Text(m.name).textStyle(type)
          .foregroundStyle(m.action == nil ? p.ink1 : p.ink2)
      }
      .padding(.leading, Tokens.Space.s8)
      .padding(.trailing, m.action == nil ? Tokens.Space.s8 : Tokens.Space.s8)
      if let action = m.action {
        Rectangle().fill(p.ring).frame(width: 1, height: compact ? Tokens.Space.s12 : Tokens.Space.s16)
        Button { onAction(connector) } label: {
          Text(action)
            .textStyle(type)
            .foregroundStyle(m.role == .needsYou ? p.statusInk(.needsYou) : p.ink1)
            .padding(.leading, Tokens.Space.s8)
            .padding(.trailing, Tokens.Space.s8)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .help(m.role == .needsYou ? "Add the missing key for \(m.name)" : "Connect \(m.name)")
        .modifier(OptionalPointerTarget(id: actionTarget))
      }
    }
    .frame(height: compact ? Tokens.Size.chipSmall : Tokens.Size.chip)
    .background(Capsule().fill(p.fill))
    .overlay(Capsule().strokeBorder(p.ring, lineWidth: 1))
    .fixedSize()
    .accessibilityElement(children: .combine)
    .accessibilityLabel(m.accessibilityLabel)
  }
}

struct OptionalPointerTarget: ViewModifier {
  var id: String?
  func body(content: Content) -> some View {
    if let id { content.pointerTarget(id) } else { content }
  }
}

// MARK: DiffText

/// Text with the diff-lite marks (s10a): only the draft side is marked. Changed words are primary ink with an
/// underline (no box: a box needs padding Text cannot give it, and clipped glyphs read as a bug); everything else,
/// and the whole "what you sent" side, is plain secondary ink. A caption under the run says what the mark means.
struct DiffText: View {
  var segments: [DiffLite.Segment]
  var marked = true
  /// s10d: the other side's words; a word it also uses is not marked.
  var other: Set<String>? = nil
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    var s = AttributedString()
    for seg in segments {
      // s10d: inside a changed run only the words that carry a claim are marked; "the", "our", "of" are not.
      for token in seg.changed && marked ? DiffLite.tokens(seg.text) : [seg.text] {
        var run = AttributedString(token)
        let mark = seg.changed && marked && DiffEmphasis.marks(token, other: other)
        run.foregroundColor = mark ? p.ink1 : p.ink2
        // s10e (M2): a tint behind the changed claim words, never an underline (an underline reads as a link).
        if mark { run.backgroundColor = p.isDark ? Color.white.opacity(DiffTint.dark) : Color.black.opacity(DiffTint.light) }
        s += run
      }
    }
    return Text(s)
      .paragraphStyle(Tokens.TypeScale.body)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .topLeading)
      .textSelection(.enabled)
  }
}

// MARK: Hatch

/// Diagonal stripes: "Offload ran this" on the timeline. Drawn as a shape so it renders offscreen too.
struct HatchShape: Shape {
  var spacing: CGFloat = 4
  func path(in r: CGRect) -> Path {
    var p = Path()
    var x = r.minX - r.height
    while x < r.maxX {
      p.move(to: CGPoint(x: x, y: r.maxY))
      p.addLine(to: CGPoint(x: x + r.height, y: r.minY))
      x += spacing
    }
    return p
  }
}

// MARK: GroupBox

/// A ringed box on the window canvas, radius 12 (rows inside it use 8). Rings, not shadows.
struct RingBox<Content: View>: View {
  var padding: CGFloat = 0
  @ViewBuilder var content: Content
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.row, style: .continuous)
    VStack(alignment: .leading, spacing: 0) { content }
      .padding(padding)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(shape.fill(p.group))
      .overlay(shape.strokeBorder(p.ring, lineWidth: 1))
  }
}

/// Section title on the canvas: title-weight label plus a quiet trailing note.
struct WindowSection<Content: View>: View {
  var title: String
  var trailing: String? = nil
  @ViewBuilder var content: Content
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Tokens.Space.s12) {
      HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
        Text(title).textStyle(Tokens.TypeScale.title).foregroundStyle(p.ink1)
          .accessibilityAddTraits(.isHeader)
          .layoutPriority(1)
        Spacer(minLength: Tokens.Space.s12)
        if let trailing {
          Text(trailing).textStyle(Tokens.TypeScale.callout).monospacedDigit().foregroundStyle(p.ink3)
            .lineLimit(1).truncationMode(.tail)
        }
      }
      content
    }
  }
}

/// A hairline between rows inside a RingBox, inset from the leading edge like a native grouped list.
struct RowDivider: View {
  var inset: CGFloat = Tokens.Space.s16
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    Rectangle().fill(Palette(scheme: scheme).ring).frame(height: 1).padding(.leading, inset)
  }
}

// MARK: snapshot window chrome

/// Snapshot stand-in for the AppKit window frame: traffic lights, a unified toolbar with title and subtitle,
/// and the trailing toolbar items. Live windows get the real frame from NSWindow and NSToolbar.
/// s10d: `sidebar` draws a source-list column under the traffic lights (the dashboard), and `sheet` draws a sheet
/// the way macOS 26 presents `beginSheet`: centred on the window, with the window dimmed behind it.
struct WindowChrome<Content: View>: View {
  var title: String
  var subtitle: String?
  var toolbarItems: [ToolbarItemLook] = []
  var width: CGFloat
  var sidebar: AnyView? = nil
  var sheet: AnyView? = nil
  @ViewBuilder var content: Content
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.window, style: .continuous)
    Group {
      if let sidebar {
        HStack(spacing: 0) {
          VStack(alignment: .leading, spacing: 0) {
            lights.padding(.horizontal, Tokens.Space.s20).frame(height: Tokens.Size.toolbar)
            sidebar
            Spacer(minLength: 0)
          }
          .frame(width: Tokens.Layout.sidebar)
          .frame(maxHeight: .infinity, alignment: .top)
          .background(p.sidebarFill)
          .dimmed(sheet != nil)
          .overlay(alignment: .trailing) { Rectangle().fill(p.barHairline).frame(width: Tokens.Layout.hairline) }
          VStack(spacing: 0) {
            toolbar(p, lights: false)
            content.attachedSheet(sheet != nil) { sheet }
          }
        }
      } else {
        VStack(spacing: 0) {
          toolbar(p, lights: true)
          // s10e: the same attached sheet the live window draws, under the toolbar.
          content.attachedSheet(sheet != nil) { sheet }
        }
      }
    }
    .frame(width: width)
    .background(p.canvas)
    .clipShape(shape)
    .overlay(shape.strokeBorder(p.isDark ? .white.opacity(Tokens.Window.ringDark) : .black.opacity(Tokens.Window.ringLight), lineWidth: Tokens.Layout.hairline))
    .compositingGroup()
    .shadow(color: .black.opacity(p.isDark ? 0.5 : 0.18), radius: Tokens.Window.shadowRadius, x: 0, y: Tokens.Window.shadowY)
  }

  private var lights: some View {
    HStack(spacing: Tokens.Space.s8) {
      ForEach([0xFF5F57, 0xFEBC2E, 0x28C840], id: \.self) { hex in
        Circle().fill(Color(hex: UInt32(hex))).frame(width: Tokens.Space.s12, height: Tokens.Space.s12)
          .overlay(Circle().strokeBorder(.black.opacity(0.12), lineWidth: 0.5))
      }
    }
  }

  private func toolbar(_ p: Palette, lights showLights: Bool) -> some View {
    HStack(spacing: Tokens.Space.s8) {
      if showLights { lights }
      VStack(alignment: .leading, spacing: 0) {
        Text(title).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
        if let subtitle { Text(subtitle).textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3) }
      }
      .padding(.leading, showLights ? Tokens.Space.s12 : 0)
      Spacer()
      ForEach(toolbarItems) { item in
        HStack(spacing: Tokens.Space.s4) {
          Image(systemName: item.symbol).symbolStyle(Tokens.TypeScale.Symbol.regular)
          if let t = item.title { Text(t).textStyle(Tokens.TypeScale.callout) }
        }
        .foregroundStyle(p.ink2)
        .padding(.horizontal, Tokens.Space.s8)
        .frame(height: Tokens.Size.chip + Tokens.Space.s4)
        .background(RoundedRectangle(cornerRadius: Tokens.Radius.control, style: .continuous).fill(p.fill))
      }
    }
    .padding(.horizontal, Tokens.Space.s20)
    .frame(height: Tokens.Size.toolbar)
    .background(p.toolbarFill)
    .overlay(alignment: .bottom) { Rectangle().fill(p.barHairline).frame(height: Tokens.Layout.hairline) }
  }
}

struct ToolbarItemLook: Identifiable {
  var symbol: String
  var title: String?
  var id: String { symbol + (title ?? "") }
}

// MARK: key hint

/// "⌘↩"-style hint inside a button or next to a label.
struct KeyHint: View {
  var keys: [String]
  var body: some View {
    HStack(spacing: Tokens.Space.s4) { ForEach(keys, id: \.self) { Keycap(label: $0) } }
  }
}

/// "J K select": keys then what they do, in callout ink. One component for every hint row (s10a).
struct KeyLegend: View {
  var items: [(keys: [String], text: String)]
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    let p = Palette(scheme: scheme)
    FlowLayout(spacing: Tokens.Space.s16, lineSpacing: Tokens.Space.s8) {
      ForEach(Array(items.enumerated()), id: \.offset) { _, item in
        HStack(spacing: Tokens.Space.s8) {
          KeyHint(keys: item.keys)
          Text(item.text).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
        }
      }
    }
  }
}
