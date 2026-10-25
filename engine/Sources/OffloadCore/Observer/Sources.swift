import Foundation

/// The frontmost app and its focused window. The live glue reads NSWorkspace + Accessibility; tests script it.
public protocol WorkspaceSource: AnyObject {
    /// Nil when nothing is frontmost (or it cannot be read).
    func frontmost() -> FocusSnapshot?
}

/// Seconds since the last keyboard or mouse input (CGEventSource in the live glue).
public protocol IdleSource: AnyObject {
    func secondsSinceLastInput() -> TimeInterval
}

/// Keystroke and click COUNTS since the last drain. Never key values.
public struct InputCounts: Equatable, Sendable {
    public var keys: Int
    public var clicks: Int

    public init(keys: Int = 0, clicks: Int = 0) {
        self.keys = keys
        self.clicks = clicks
    }

    public var isEmpty: Bool { keys <= 0 && clicks <= 0 }
}

public protocol InputCountSource: AnyObject {
    /// False when Input Monitoring is not granted: the observer then writes no input events at all.
    var isAvailable: Bool { get }
    /// Returns the counts since the previous call and resets them to zero.
    func drainCounts() -> InputCounts
}

/// Visible text of the focused window (ScreenCaptureKit + Vision in the live glue). Called only for windows the
/// exclusion policy allows. Nil = nothing to read.
public protocol ScreenTextSource: AnyObject {
    func visibleText(of snapshot: FocusSnapshot) throws -> String?
}

public protocol PauseState: AnyObject {
    var isPaused: Bool { get }
}

/// Pause flag = presence of `$OFFLOAD_HOME/paused`. `offload-observer pause|resume` flips it; the running observer
/// checks it every tick.
public final class FilePauseControl: PauseState {
    public let layout: StoreLayout

    public init(layout: StoreLayout) {
        self.layout = layout
    }

    public var isPaused: Bool { FileManager.default.fileExists(atPath: layout.pauseFile.path) }

    public func pause(at date: Date) throws {
        try layout.ensureDirectories()
        let body = Data("{\"pausedAt\":\(epochMillis(date))}\n".utf8)
        do { try body.write(to: layout.pauseFile, options: .atomic) } catch {
            throw StoreError.io("write pause file: \(error.localizedDescription)")
        }
    }

    public func resume() throws {
        guard isPaused else { return }
        do { try FileManager.default.removeItem(at: layout.pauseFile) } catch {
            throw StoreError.io("remove pause file: \(error.localizedDescription)")
        }
    }
}
