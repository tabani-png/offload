import AppKit
import SwiftUI

/// Colours for one appearance. Neutral graphite surfaces; the only saturated hues are the status roles.
/// Dark is the hero; light mirrors it with black ink instead of white.
struct Palette {
  let scheme: ColorScheme
  var isDark: Bool { scheme == .dark }

  // Ink ladder (opacity steps, not weight).
  var ink1: Color { isDark ? .white.opacity(0.96) : .black.opacity(0.86) }
  var ink2: Color { isDark ? .white.opacity(Tokens.Ink.secondary) : .black.opacity(0.56) }
  var ink3: Color { isDark ? .white.opacity(Tokens.Ink.tertiary) : .black.opacity(0.46) }

  // Rings and fills.
  var ring: Color { isDark ? .white.opacity(0.10) : .black.opacity(0.08) }
  var ringStrong: Color { isDark ? .white.opacity(0.20) : .black.opacity(0.13) }
  var fill: Color { isDark ? .white.opacity(0.06) : .white.opacity(0.55) }
  var fillStrong: Color { isDark ? .white.opacity(0.12) : .white.opacity(0.92) }
  var track: Color { isDark ? .white.opacity(0.10) : .black.opacity(0.07) }

  /// Top specular highlight on glass.
  var specular: Color { isDark ? .white.opacity(0.26) : .white.opacity(0.9) }
  /// Veil laid over the system material so it reads as graphite, not grey frost.
  var glassVeil: Color { isDark ? Color(red: 0.04, green: 0.045, blue: 0.06).opacity(0.58) : .white.opacity(0.50) }
  /// Snapshot stand-in for the live blur (cacheDisplay cannot capture behind-window blending).
  var glassSimulated: Color {
    isDark ? Color(red: 0.08, green: 0.085, blue: 0.10).opacity(0.74) : Color(red: 0.98, green: 0.98, blue: 0.985).opacity(0.70)
  }
  var contactShadow: Color { isDark ? .black.opacity(0.55) : .black.opacity(0.16) }

  /// The one primary per view: white on dark, near-black on light.
  var primaryFill: Color { isDark ? .white : Color(red: 0.11, green: 0.11, blue: 0.12) }
  var primaryInk: Color { isDark ? Color(red: 0.043, green: 0.043, blue: 0.047) : .white }

  func status(_ role: StatusRole) -> Color {
    switch role {
    case .working: return isDark ? Color(hex: 0x4C9DFF) : Color(hex: 0x0A7AFF)
    case .needsYou: return isDark ? Color(hex: 0xFFC75C) : Color(hex: 0xE29A00)
    case .done: return isDark ? Color(hex: 0x30D158) : Color(hex: 0x1FA84A)
    case .recording: return isDark ? Color(hex: 0xFF453A) : Color(hex: 0xFF3B30)
    case .neutral: return isDark ? .white.opacity(0.38) : .black.opacity(0.28)
    }
  }

  /// Text colour that sits on a status fill (badge digits).
  func onStatus(_ role: StatusRole) -> Color {
    role == .needsYou ? Color(red: 0.16, green: 0.11, blue: 0.0) : .white
  }
}

extension Color {
  init(hex: UInt32, opacity: Double = 1) {
    self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
              blue: Double(hex & 0xFF) / 255, opacity: opacity)
  }
}

// MARK: type

extension Tokens.TypeStyle {
  var swiftUIWeight: Font.Weight {
    switch weight {
    case 600: return .semibold
    case 500: return .medium
    default: return .regular
    }
  }

  var font: Font {
    name == "mono"
      ? .system(size: size, weight: swiftUIWeight, design: .monospaced)
      : .system(size: size, weight: swiftUIWeight)
  }
}

extension View {
  /// Applies a type token: system SF Pro (Display/Text picked by size), weight and tracking.
  func textStyle(_ style: Tokens.TypeStyle) -> some View {
    font(style.font).tracking(style.tracking)
  }
}

// MARK: environment

private struct SnapshotKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
  /// True while rendering PNGs offscreen: no arrival animations, frozen pulses, simulated glass.
  var isSnapshot: Bool {
    get { self[SnapshotKey.self] }
    set { self[SnapshotKey.self] = newValue }
  }
}

/// Reads the palette for the current appearance.
struct Themed<Content: View>: View {
  @Environment(\.colorScheme) private var scheme
  let content: (Palette) -> Content
  init(@ViewBuilder _ content: @escaping (Palette) -> Content) { self.content = content }
  var body: some View { content(Palette(scheme: scheme)) }
}
