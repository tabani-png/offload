// Adapted from Workpaper engine WPCore/Capture/WindowPlan.swift: which on-screen window OCR may read.
import CoreGraphics
import Foundation

/// One on-screen window as the live glue lists it, front to back (`CGWindowListCopyWindowInfo` order).
public struct CaptureWindow: Equatable, Sendable {
    public var windowID: UInt32
    public var bundleID: String
    public var frame: CGRect
    /// `kCGWindowLayer`; 0 is a normal app window.
    public var layer: Int

    public init(windowID: UInt32, bundleID: String, frame: CGRect, layer: Int = 0) {
        self.windowID = windowID
        self.bundleID = bundleID
        self.frame = frame
        self.layer = layer
    }
}

extension ExclusionPolicy {
    /// The frontmost app's topmost normal window (layer 0, non-empty frame). A denied app, a blank bundle id or no
    /// such window gives nil: OCR reads nothing, never another app's window.
    public func windowToRead(_ windows: [CaptureWindow], frontmostBundleID: String) -> CaptureWindow? {
        if Self.matchBundle(frontmostBundleID, in: deniedBundleIDs) != nil { return nil }
        let front = frontmostBundleID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !front.isEmpty else { return nil }
        return windows.first { window in
            window.layer == 0 && window.frame.width > 0 && window.frame.height > 0
                && window.bundleID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == front
        }
    }
}
