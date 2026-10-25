// Live system sources for the Observer: NSWorkspace + Accessibility (app, title, URL), CGEventSource (idle),
// NSEvent global monitors (input COUNTS only), ScreenCaptureKit + Vision (OCR of the one allowed window).
// Adapted from Workpaper engine wp-capture/LiveSource.swift. Everything stays in memory and goes straight to the
// Observer, which masks before writing.
import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation
import IOKit.hid
import OffloadCore
import ScreenCaptureKit

/// A value filled in by a completion handler on another queue and read after a semaphore wait.
final class Slot<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

enum Permissions {
    static var accessibility: Bool { AXIsProcessTrusted() }
    static var screenRecording: Bool { CGPreflightScreenCaptureAccess() }
    static var inputMonitoring: Bool { IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted }

    static var state: PermissionState {
        PermissionState(screenRecording: screenRecording, accessibility: accessibility, inputMonitoring: inputMonitoring)
    }
}

final class LiveWorkspace: WorkspaceSource {
    static let browsers: Set<String> = [
        "com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "com.google.Chrome.canary",
        "company.thebrowser.Browser", "com.brave.Browser", "com.microsoft.edgemac", "org.mozilla.firefox",
        "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
    ]
    private var manualAXSet = Set<pid_t>()

    func frontmost() -> FocusSnapshot? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let pid = app.processIdentifier
        let bundle = app.bundleIdentifier ?? ""
        var title = ""
        var url: String?
        if Permissions.accessibility {
            let appElement = AXUIElementCreateApplication(pid)
            if Self.browsers.contains(bundle), bundle != "com.apple.Safari", manualAXSet.insert(pid).inserted {
                // Chromium builds its accessibility tree (and AXURL) only when asked.
                let status = AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
                if status != .success && status != .attributeUnsupported {
                    Log.error("workspace", "AXManualAccessibility on \(bundle) returned \(status.rawValue)")
                }
            }
            if let window = Self.element(appElement, kAXFocusedWindowAttribute) {
                title = Self.string(window, kAXTitleAttribute) ?? ""
                if Self.browsers.contains(bundle) { url = Self.browserURL(window) }
            }
        }
        if title.isEmpty { title = Self.windowServerTitle(pid: pid) ?? "" }
        return FocusSnapshot(bundleID: bundle, appName: app.localizedName ?? bundle, windowTitle: title, url: url,
                             secureInputActive: IsSecureEventInputEnabled())
    }

    /// kAXDocument on the window, else AXURL of the first AXWebArea (bounded breadth-first walk).
    private static func browserURL(_ window: AXUIElement) -> String? {
        if let doc = string(window, kAXDocumentAttribute), doc.hasPrefix("http") { return doc }
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var visited = 0
        while !queue.isEmpty && visited < 400 {
            let (node, depth) = queue.removeFirst()
            visited += 1
            if string(node, kAXRoleAttribute) == "AXWebArea" {
                if let value = attribute(node, kAXURLAttribute) {
                    if let u = value as? URL { return u.absoluteString }
                    if let s = value as? String { return s }
                }
            }
            guard depth < 10, let children = attribute(node, kAXChildrenAttribute) as? [AXUIElement] else { continue }
            queue.append(contentsOf: children.map { ($0, depth + 1) })
        }
        return nil
    }

    /// kCGWindowName of the app's front normal window (needs Screen Recording on recent macOS).
    private static func windowServerTitle(pid: pid_t) -> String? {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return nil }
        let front = windows.first {
            ($0[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid && ($0[kCGWindowLayer as String] as? Int) == 0
        }
        return front?[kCGWindowName as String] as? String
    }

    static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    static func element(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }

    static func string(_ element: AXUIElement, _ name: String) -> String? {
        attribute(element, name) as? String
    }
}

final class LiveIdle: IdleSource {
    private var warned = false

    func secondsSinceLastInput() -> TimeInterval {
        guard let any = CGEventType(rawValue: ~0) else {
            if !warned {
                warned = true
                Log.error("idle", "kCGAnyInputEventType unavailable; idle detection off")
            }
            return 0
        }
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
    }
}

/// Counts keyDown and leftMouseDown from global NSEvent monitors. The handler reads only the event TYPE; key codes
/// and characters are never touched.
final class LiveInputCounter: InputCountSource {
    private let lock = NSLock()
    private var keys = 0
    private var clicks = 0
    private var monitor: Any?
    let isAvailable: Bool

    init() {
        isAvailable = Permissions.inputMonitoring
    }

    /// Call on the main thread once the app exists.
    func install() {
        guard isAvailable else { return }
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .leftMouseDown]) { [weak self] event in
            self?.count(isKey: event.type == .keyDown)
        }
        if monitor == nil { Log.error("input", "NSEvent global monitor could not be installed") }
    }

    private func count(isKey: Bool) {
        lock.lock()
        if isKey { keys += 1 } else { clicks += 1 }
        lock.unlock()
    }

    func drainCounts() -> InputCounts {
        lock.lock()
        defer { lock.unlock() }
        let counts = InputCounts(keys: keys, clicks: clicks)
        keys = 0
        clicks = 0
        return counts
    }
}

/// OCR of the frontmost app's top normal window only (ExclusionPolicy.windowToRead). A perceptual hash of the
/// pixels skips Vision when the window looks the same as last time.
final class LiveScreenText: ScreenFrameSource {
    private let policy: ExclusionPolicy
    private let recognizer = VisionTextRecognizer()
    private var lastFrame: (window: UInt32, hash: PerceptualHash, lines: [OCRLine])?

    init(policy: ExclusionPolicy) {
        self.policy = policy
    }

    func visibleText(of snapshot: FocusSnapshot) throws -> String? {
        try captureFrame(of: snapshot)?.text
    }

    /// s11: the window pixels, their OCR lines (Vision is skipped when the pixels did not change) and the secure text
    /// field rectangles of the focused window, all in image pixels with a top-left origin.
    func captureFrame(of snapshot: FocusSnapshot) throws -> ScreenFrame? {
        guard Permissions.screenRecording else { throw CaptureError.permissionDenied("Screen Recording not granted") }
        let shot = try captureWindow(frontmostBundleID: snapshot.bundleID)
        let hash = PerceptualHash(image: shot.image)
        let lines: [OCRLine]
        if let last = lastFrame, last.window == shot.windowID, last.hash.distance(to: hash) == 0 {
            lines = last.lines
        } else {
            lines = try recognizer.recognize(shot.image)
            lastFrame = (shot.windowID, hash, lines)
        }
        let secure = Self.secureFieldRects(bundleID: snapshot.bundleID, windowFrame: shot.frame, scale: shot.scale)
        return ScreenFrame(image: shot.image, lines: lines, secureFields: secure)
    }

    /// AXSecureTextField frames inside the frontmost app's focused window, converted from global points (top-left)
    /// to window image pixels. Empty without Accessibility (Secure Event Input still stops capture for a focused
    /// password field, see Observer).
    static func secureFieldRects(bundleID: String, windowFrame: CGRect, scale: CGFloat) -> [CGRect] {
        guard Permissions.accessibility, let app = NSWorkspace.shared.frontmostApplication,
              app.bundleIdentifier == bundleID else { return [] }
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        guard let window = LiveWorkspace.element(appElement, kAXFocusedWindowAttribute) else { return [] }
        var out: [CGRect] = []
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var visited = 0
        while !queue.isEmpty && visited < 1500 {
            let (node, depth) = queue.removeFirst()
            visited += 1
            let role = LiveWorkspace.string(node, kAXRoleAttribute)
            let subrole = LiveWorkspace.string(node, kAXSubroleAttribute)
            if subrole == "AXSecureTextField" || role == "AXSecureTextField", let r = frame(of: node) {
                out.append(CGRect(x: (r.minX - windowFrame.minX) * scale, y: (r.minY - windowFrame.minY) * scale,
                                  width: r.width * scale, height: r.height * scale))
            }
            guard depth < 25, let children = LiveWorkspace.attribute(node, kAXChildrenAttribute) as? [AXUIElement] else { continue }
            queue.append(contentsOf: children.map { ($0, depth + 1) })
        }
        return out
    }

    private static func frame(of element: AXUIElement) -> CGRect? {
        guard let p = LiveWorkspace.attribute(element, kAXPositionAttribute),
              let s = LiveWorkspace.attribute(element, kAXSizeAttribute),
              CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point),
              AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }

    struct Shot {
        var windowID: UInt32
        var image: CGImage
        /// Window frame in global points, top-left origin.
        var frame: CGRect
        /// Pixels per point of the capture.
        var scale: CGFloat
    }

    /// Blocks the calling (serial, non-main) queue until ScreenCaptureKit answers. Never call from a Swift Task.
    private func captureWindow(frontmostBundleID: String) throws -> Shot {
        let done = DispatchSemaphore(value: 0)
        let result = Slot<Result<Shot, Error>>(.failure(CaptureError.noWindow))
        let policy = self.policy
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
            let rank = Self.windowRank()
            let shareable = (content?.windows ?? []).filter { rank[$0.windowID] != nil }
                .sorted { (rank[$0.windowID] ?? Int.max) < (rank[$1.windowID] ?? Int.max) }
            let windows = shareable.map {
                CaptureWindow(windowID: $0.windowID, bundleID: $0.owningApplication?.bundleIdentifier ?? "",
                              frame: $0.frame, layer: $0.windowLayer)
            }
            guard let planned = policy.windowToRead(windows, frontmostBundleID: frontmostBundleID),
                  let window = shareable.first(where: { $0.windowID == planned.windowID }) else {
                result.value = .failure(error ?? CaptureError.noWindow)
                done.signal()
                return
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let scale = CGFloat(filter.pointPixelScale)
            let config = SCStreamConfiguration()
            config.width = max(1, Int((filter.contentRect.width * scale).rounded()))
            config.height = max(1, Int((filter.contentRect.height * scale).rounded()))
            config.showsCursor = false
            let frame = window.frame
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
                result.value = image.map { .success(Shot(windowID: planned.windowID, image: $0, frame: frame, scale: scale)) }
                    ?? .failure(error ?? CaptureError.noWindow)
                done.signal()
            }
        }
        guard done.wait(timeout: .now() + 10) == .success else { throw CaptureError.timeout }
        return try result.value.get()
    }

    private static func windowRank() -> [CGWindowID: Int] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
            return [:]
        }
        var rank: [CGWindowID: Int] = [:]
        for (i, info) in list.enumerated() {
            if let number = info[kCGWindowNumber as String] as? NSNumber { rank[number.uint32Value] = i }
        }
        return rank
    }
}
