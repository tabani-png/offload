import AppKit
import SwiftUI

/// NSVisualEffectView behind-window blur, masked to a continuous rounded rect so the blur itself has the
/// right corners (SwiftUI clipping does not clip behind-window blending).
struct VisualEffect: NSViewRepresentable {
  var material: NSVisualEffectView.Material
  var cornerRadius: CGFloat
  /// Pins the material to our appearance with the vibrant variant, so a dark card stays a dark HUD over a white
  /// page (and a light one stays light over a dark page) instead of following whatever is behind it.
  var dark: Bool = true

  func makeNSView(context: Context) -> NSVisualEffectView {
    let v = NSVisualEffectView()
    v.blendingMode = .behindWindow
    v.state = .active
    v.isEmphasized = false
    updateNSView(v, context: context)
    return v
  }

  func updateNSView(_ v: NSVisualEffectView, context: Context) {
    v.material = material
    v.appearance = NSAppearance(named: dark ? .vibrantDark : .vibrantLight)
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
  @Environment(\.colorSchemeContrast) private var contrast
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

  /// Veil opacity solved for the worst backdrop (GlassVeil): tertiary ink keeps 4.5:1 over a white page under the
  /// dark card and over a black page under the light one, 7:1 with Increase Contrast, opaque with Reduce
  /// Transparency. Over calm backdrops the same veil reads as clear glass; it only has to win the bright case.
  static func veilOpacity(dark: Bool, increaseContrast: Bool, reduceTransparency: Bool) -> Double {
    GlassVeil.opacity(dark ? .dark : .light, increaseContrast: increaseContrast, reduceTransparency: reduceTransparency)
  }

  var body: some View {
    let p = Palette(scheme: scheme)
    let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    let veil = Self.veilOpacity(dark: p.isDark, increaseContrast: contrast == .increased,
                                reduceTransparency: reduceTransparency)
    ZStack {
      if isSnapshot {
        shape.fill(p.glassSimulated)
      } else {
        VisualEffect(material: material.nsMaterial, cornerRadius: cornerRadius, dark: p.isDark)
        shape.fill(p.glassVeilBase.opacity(veil))
      }
      // Edge ring (stronger with Increase Contrast).
      shape.strokeBorder(contrast == .increased ? p.ringStrong : p.ring, lineWidth: 1)
      // Top specular: bright at the top edge, gone by a third of the way down.
      shape.strokeBorder(
        LinearGradient(stops: [.init(color: p.specular, location: 0), .init(color: .clear, location: 0.35)],
                       startPoint: .top, endPoint: .bottom),
        lineWidth: 1)
    }
    .compositingGroup()
    // Tight contact shadow (rule 3): short and close, plus a hairline at the edge. Not a wide CSS blur.
    .shadow(color: shadow ? p.contactShadow.opacity(0.75) : .clear, radius: 8, x: 0, y: 4)
    .shadow(color: shadow ? p.contactShadow.opacity(0.6) : .clear, radius: 1, x: 0, y: 0.5)
  }
}

extension View {
  func glass(cornerRadius: CGFloat, material: GlassMaterial = .hud, shadow: Bool = true) -> some View {
    background(GlassBackground(cornerRadius: cornerRadius, material: material, shadow: shadow))
  }
}
