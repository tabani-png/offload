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

  /// Task tints for the timeline. Desaturated pastels from the feature-title family, picked away from the four
  /// status hues so a bar never reads as "working" or "needs you". The last one is neutral ink.
  func task(_ tint: Int) -> Color {
    switch tint % 4 {
    case 0: return isDark ? Color(hex: 0xA99CF0) : Color(hex: 0x7A68D8)  // lavender
    case 1: return isDark ? Color(hex: 0x7FC9BE) : Color(hex: 0x3B9C8D)  // sea glass
    case 2: return isDark ? Color(hex: 0xE79AB4) : Color(hex: 0xCC6688)  // rose
    default: return isDark ? .white.opacity(0.26) : .black.opacity(0.18)
    }
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
    HStack(spacing: 0) {
      HStack(spacing: 5) {
        Circle().fill(p.status(m.role)).frame(width: 6, height: 6)
        Text(m.name).font(.system(size: compact ? 11 : 12, weight: .medium)).tracking(0.1)
          .foregroundStyle(m.action == nil ? p.ink1 : p.ink2)
      }
      .padding(.leading, compact ? 7 : 9)
      .padding(.trailing, m.action == nil ? (compact ? 8 : 9) : 6)
      if let action = m.action {
        Rectangle().fill(p.ring).frame(width: 1, height: compact ? 12 : 14)
        Button { onAction(connector) } label: {
          Text(action)
            .font(.system(size: compact ? 11 : 12, weight: .medium)).tracking(0.1)
            .foregroundStyle(m.role == .needsYou ? p.statusInk(.needsYou) : p.ink1)
            .padding(.leading, 6)
            .padding(.trailing, compact ? 8 : 9)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .help(m.role == .needsYou ? "Add the missing key for \(m.name)" : "Connect \(m.name)")
        .modifier(OptionalPointerTarget(id: actionTarget))
      }
    }
    .frame(height: compact ? 20 : 22)
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

/// Text with the diff-lite marks: unchanged words in secondary ink, changed words in primary ink on a soft mark.
struct DiffText: View {
  var segments: [DiffLite.Segment]
  var size: CGFloat = 12.5
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    var s = AttributedString()
    for seg in segments {
      var run = AttributedString(seg.text)
      run.foregroundColor = seg.changed ? p.ink1 : p.ink2
      if seg.changed { run.backgroundColor = p.mark }
      s += run
    }
    return Text(s)
      .font(.system(size: size))
      .lineSpacing(3)
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
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline) {
        Text(title).textStyle(Tokens.TypeScale.title).foregroundStyle(p.ink1)
          .accessibilityAddTraits(.isHeader)
        Spacer(minLength: 12)
        if let trailing {
          Text(trailing).font(.system(size: 12)).monospacedDigit().foregroundStyle(p.ink3).lineLimit(1)
        }
      }
      content
    }
  }
}

/// A hairline between rows inside a RingBox, inset from the leading edge like a native grouped list.
struct RowDivider: View {
  var inset: CGFloat = 16
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    Rectangle().fill(Palette(scheme: scheme).ring).frame(height: 1).padding(.leading, inset)
  }
}

// MARK: snapshot window chrome

/// Snapshot stand-in for the AppKit window frame: traffic lights, a unified toolbar with title and subtitle,
/// and the trailing toolbar items. Live windows get the real frame from NSWindow and NSToolbar.
struct WindowChrome<Content: View>: View {
  var title: String
  var subtitle: String?
  var toolbarItems: [ToolbarItemLook] = []
  var width: CGFloat
  @ViewBuilder var content: Content
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        ForEach([0xFF5F57, 0xFEBC2E, 0x28C840], id: \.self) { hex in
          Circle().fill(Color(hex: UInt32(hex))).frame(width: 12, height: 12)
            .overlay(Circle().strokeBorder(.black.opacity(0.12), lineWidth: 0.5))
        }
        VStack(alignment: .leading, spacing: 1) {
          Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(p.ink1)
          if let subtitle { Text(subtitle).font(.system(size: 11)).foregroundStyle(p.ink3) }
        }
        .padding(.leading, 14)
        Spacer()
        ForEach(toolbarItems) { item in
          HStack(spacing: 5) {
            Image(systemName: item.symbol).font(.system(size: 12, weight: .medium))
            if let t = item.title { Text(t).font(.system(size: 12)) }
          }
          .foregroundStyle(p.ink2)
          .padding(.horizontal, 9)
          .frame(height: 26)
          .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(p.fill))
        }
      }
      .padding(.horizontal, 18)
      .frame(height: 52)
      .background(p.isDark ? Color(hex: 0x232326) : Color(hex: 0xEDEDF0))
      .overlay(alignment: .bottom) { Rectangle().fill(p.isDark ? .black.opacity(0.5) : .black.opacity(0.1)).frame(height: 1) }
      content
    }
    .frame(width: width)
    .background(p.canvas)
    .clipShape(shape)
    .overlay(shape.strokeBorder(p.isDark ? .white.opacity(0.14) : .black.opacity(0.14), lineWidth: 1))
    .compositingGroup()
    .shadow(color: .black.opacity(p.isDark ? 0.5 : 0.18), radius: 24, x: 0, y: 14)
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
    HStack(spacing: 3) { ForEach(keys, id: \.self) { Keycap(label: $0) } }
  }
}
