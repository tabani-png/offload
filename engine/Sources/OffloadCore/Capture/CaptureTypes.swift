// Adapted from Workpaper engine WPCore/Capture/CaptureTypes.swift: only the pieces the Observer needs.
import Foundation

/// What the observer knows about the focused window at one poll. Raw values stay in memory: the observer masks the
/// title and strips the URL before anything is written.
public struct FocusSnapshot: Equatable, Sendable {
    public var bundleID: String
    public var appName: String
    public var windowTitle: String
    /// Full URL when the frontmost app is a browser and the URL could be read; nil otherwise.
    public var url: String?
    /// Secure Event Input is on (a password field has focus). OCR is skipped while it is on.
    public var secureInputActive: Bool
    /// The window is a private / incognito browser window, as far as the glue knows.
    public var isPrivateBrowsing: Bool

    public init(bundleID: String, appName: String, windowTitle: String, url: String? = nil,
                secureInputActive: Bool = false, isPrivateBrowsing: Bool = false) {
        self.bundleID = bundleID
        self.appName = appName
        self.windowTitle = windowTitle
        self.url = url
        self.secureInputActive = secureInputActive
        self.isPrivateBrowsing = isPrivateBrowsing
    }
}

public enum CaptureError: Error, Equatable {
    case ocrFailed(String)
    case permissionDenied(String)
    case noWindow
    case timeout
}
