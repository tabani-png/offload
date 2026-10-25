import Foundation

/// One OCR request: the focused window when it was asked for, and the observer's generation (bumped on pause,
/// resume) so stale results can be thrown away.
public struct OCRJob: @unchecked Sendable {
    public var snapshot: FocusSnapshot
    public var generation: Int
    /// s11: also return the pixels (a keyframe could be kept now). Only honoured by a ScreenFrameSource.
    public var wantsFrame: Bool

    public init(snapshot: FocusSnapshot, generation: Int, wantsFrame: Bool = false) {
        self.snapshot = snapshot
        self.generation = generation
        self.wantsFrame = wantsFrame
    }
}

public struct OCRResult: @unchecked Sendable {
    public var job: OCRJob
    /// Text (nil = nothing to read) or the recognizer's error.
    public var outcome: Result<String?, Error>
    /// s11: the captured frame, when the job asked for one and the source could give it.
    public var frame: ScreenFrame?

    public init(job: OCRJob, outcome: Result<String?, Error>, frame: ScreenFrame? = nil) {
        self.job = job
        self.outcome = outcome
        self.frame = frame
    }

    /// Runs one job on `source`: pixels + text from a ScreenFrameSource when asked, else text only.
    static func run(_ job: OCRJob, source: ScreenTextSource) -> OCRResult {
        if job.wantsFrame, let frames = source as? ScreenFrameSource {
            do {
                let frame = try frames.captureFrame(of: job.snapshot)
                return OCRResult(job: job, outcome: .success(frame?.text), frame: frame)
            } catch {
                return OCRResult(job: job, outcome: .failure(error))
            }
        }
        return OCRResult(job: job, outcome: Result { try source.visibleText(of: job.snapshot) })
    }
}

/// Runs OCR jobs. The observer submits on its tick and drains finished results on later ticks, so a slow
/// recognizer never delays focus, idle, pause or input handling.
public protocol OCRExecutor: AnyObject {
    func submit(_ job: OCRJob)
    /// Finished results, oldest first; each is returned once.
    func drain() -> [OCRResult]
    /// Jobs thrown away because the queue was full.
    var dropped: Int { get }
}

/// Runs the job inside `submit` on the caller's thread. Deterministic; used by headless tests.
public final class InlineOCRExecutor: OCRExecutor {
    private let source: ScreenTextSource
    private var done: [OCRResult] = []
    public let dropped = 0

    public init(source: ScreenTextSource) {
        self.source = source
    }

    public func submit(_ job: OCRJob) {
        done.append(OCRResult.run(job, source: source))
    }

    public func drain() -> [OCRResult] {
        defer { done.removeAll() }
        return done
    }
}

/// One serial GCD queue for OCR (the live default). At most `capacity` jobs wait; a new job past that drops the
/// oldest waiting one. Finished results wait in a bounded outbox (oldest dropped) until the observer drains them.
public final class QueuedOCRExecutor: OCRExecutor, @unchecked Sendable {
    public let capacity: Int
    public let outboxCapacity: Int
    private let source: ScreenTextSource
    private let queue = DispatchQueue(label: "ai.offload.observer.ocr", qos: .utility)
    private let lock = NSLock()
    private var pending: [OCRJob] = []
    private var outbox: [OCRResult] = []
    private var running = false
    private var _dropped = 0

    public init(source: ScreenTextSource, capacity: Int = 2, outboxCapacity: Int = 8) {
        self.source = source
        self.capacity = max(1, capacity)
        self.outboxCapacity = max(1, outboxCapacity)
    }

    public var dropped: Int { lock.withLock { _dropped } }

    public func submit(_ job: OCRJob) {
        let start: Bool = lock.withLock {
            if pending.count >= capacity {
                pending.removeFirst()
                _dropped += 1
            }
            pending.append(job)
            guard !running else { return false }
            running = true
            return true
        }
        if start { queue.async { self.work() } }
    }

    public func drain() -> [OCRResult] {
        lock.withLock {
            defer { outbox.removeAll() }
            return outbox
        }
    }

    /// True when nothing is waiting or running (tests).
    public func waitUntilIdle(timeout: TimeInterval) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if lock.withLock({ !running && pending.isEmpty }) { return true }
            Thread.sleep(forTimeInterval: 0.005)
        }
        return lock.withLock { !running && pending.isEmpty }
    }

    private func work() {
        while true {
            let next: OCRJob? = lock.withLock {
                guard !pending.isEmpty else {
                    running = false
                    return nil
                }
                return pending.removeFirst()
            }
            guard let job = next else { return }
            let result = OCRResult.run(job, source: source)
            lock.withLock {
                if outbox.count >= outboxCapacity { outbox.removeFirst() }
                outbox.append(result)
            }
        }
    }
}
