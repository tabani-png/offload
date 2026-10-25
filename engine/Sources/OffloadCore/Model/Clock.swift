import Foundation

public protocol Clock: AnyObject {
    var now: Date { get }
}

public final class SystemClock: Clock {
    public init() {}
    public var now: Date { Date() }
}

/// A clock tests move by hand.
public final class ManualClock: Clock {
    public var now: Date

    public init(_ now: Date) {
        self.now = now
    }

    public func advance(by seconds: TimeInterval) {
        now = now.addingTimeInterval(seconds)
    }
}
