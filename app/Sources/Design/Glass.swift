import AppKit
import SwiftUI

/// NSVisualEffectView behind-window blur, masked to a continuous rounded rect so the blur itself has the
/// right corners (SwiftUI clipping does not clip behind-window blending).
struct VisualEffect: NSViewRepresentable {
  var material: NSVisualEffectView.Material
  var cornerRadius: CGFloat

  func makeNSView(context: Context) -> NSVisualEffectView {
    let v = NSVisualEffectView()
    v.material = material
    v.blendingMode = .behindWindow
    v.state = .active
    v.isEmphasized = false
    v.maskImage = Self.mask(radius: cornerRadius)
    return v
  }

  func updateNSView(_ v: NSVisualEffectView, context: Context) {
    v.material = material
    v.maskImage = Self.mask(radius: cornerRadius)
  }

  static func mask(radius: CGFloat) -> NSImage {
    let edge = radius * 2 + 1
    let image = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { rect in
      NSColor.black.setFill()
      NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
      return true
    }
    image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
    image.resizingMode = .stretch
    return image
  }
}

enum GlassMaterial {
  case hud      // cards
  case popover  // rail capsules, hint pill

  var nsMaterial: NSVisualEffectView.Material {
    switch self {
    case .hud: return .hudWindow
    case .popover: return .popover
    }
  }
}

/// Glass in three layers: saturated blur (system material + veil), a 1-px edge ring, and a top specular
/// highlight. Plus a tight contact shadow, because it floats. Rule 4 in 13-design-getone.md.
struct GlassBackground: View {
  var cornerRadius: CGFloat
  var material: GlassMaterial = .hud
  var shadow = true
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot

  var body: some View {
    let p = Palette(scheme: scheme)
    let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    ZStack {
      if isSnapshot {
        shape.fill(p.glassSimulated)
      } else {
        VisualEffect(material: material.nsMaterial, cornerRadius: cornerRadius)
        shape.fill(p.glassVeil)
      }
      // Edge ring.
      shape.strokeBorder(p.ring, lineWidth: 1)
      // Top specular: bright at the top edge, gone by a third of the way down.
      shape.strokeBorder(
        LinearGradient(stops: [.init(color: p.specular, location: 0), .init(color: .clear, location: 0.35)],
                       startPoint: .top, endPoint: .bottom),
        lineWidth: 1)
    }
    .compositingGroup()
    .shadow(color: shadow ? p.contactShadow : .clear, radius: 14, x: 0, y: 10)
    .shadow(color: shadow ? p.contactShadow.opacity(0.5) : .clear, radius: 1.5, x: 0, y: 0.5)
  }
}

extension View {
  func glass(cornerRadius: CGFloat, material: GlassMaterial = .hud, shadow: Bool = true) -> some View {
    background(GlassBackground(cornerRadius: cornerRadius, material: material, shadow: shadow))
  }
}
