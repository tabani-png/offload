import CryptoKit
import Foundation

public struct ObserverConfig: Equatable, Sendable {
    /// Focus poll interval (app, title, URL), seconds.
    public var focusPoll: TimeInterval = 2
    /// No input for this long = idle.
    public var idleThreshold: TimeInterval = 120
    /// One input-count event per this many seconds.
    public var inputInterval: TimeInterval = 60
    /// OCR at most this often while the focus stays the same.
    public var ocrInterval: TimeInterval = 30
    /// Retention runs at start and then this often.
    public var purgeInterval: TimeInterval = 3600
    /// OCR text longer than this is cut (characters), to keep day files small.
    public var maxOCRCharacters: Int = 8000

    public init() {}
}

/// Running totals for `status`.
public struct ObserverCounters: Equatable, Sendable {
    public var written: [EventKind: Int] = [:]
    public var writeErrors = 0
    public var ocrErrors = 0
    public var ocrSkippedUnchanged = 0
    public var ocrSkippedExcluded = 0
    /// OCR jobs thrown away because the OCR queue was full (oldest first).
    public var ocrDropped = 0
    /// OCR results thrown away: asked before a pause/resume, or the window was excluded meanwhile.
    public var ocrDiscarded = 0
    public var purgedDays = 0

    public var totalWritten: Int { written.values.reduce(0, +) }
}

/// The Observer state machine. The live glue calls `start()` once, then `tick()` about once a second; tests drive it
/// with a ManualClock and scripted sources. It never touches the network and never stores key values.
public final class Observer {
    public let config: ObserverConfig
    private let clock: Clock
    private let workspace: WorkspaceSource
    private let idle: IdleSource
    private let input: InputCountSource
    private let ocr: OCRExecutor?
    private let exclusions: ExclusionReloader?
    private let pauseState: PauseState
    private let sink: EventSink
    private let retention: Retention?
    /// The exclusion policy in force (reloaded from `exclusions.json` when an ExclusionReloader is given).
    public private(set) var policy: ExclusionPolicy
    private let masker: Masker
    private let ids: ULIDGenerator

    public private(set) var counters = ObserverCounters()
    public private(set) var isPaused = false
    public private(set) var isIdle = false
    public private(set) var lastPurge: Date?

    private struct FocusKey: Equatable {
        var app: String
        var title: String
        var url: String?
    }

    private var lastFocus: FocusKey?
    private var lastSnapshot: FocusSnapshot?
    private var lastFocusPoll: Date?
    private var lastOCRAttempt: Date?
    private var lastTextHash: String?
    private var inputWindowStart: Date?
    private var loggedErrors = Set<String>()
    private var warnedInputUnavailable = false
    private var generation = 0

    public init(config: ObserverConfig = ObserverConfig(), clock: Clock, workspace: WorkspaceSource, idle: IdleSource,
                input: InputCountSource, screenText: ScreenTextSource?, pauseState: PauseState, sink: EventSink,
                retention: Retention?, policy: ExclusionPolicy = .standard, masker: Masker = Masker(),
                ids: ULIDGenerator = ULIDGenerator(), exclusions: ExclusionReloader? = nil, ocr: OCRExecutor? = nil) {
        self.config = config
        self.clock = clock
        self.workspace = workspace
        self.idle = idle
        self.input = input
        self.ocr = ocr ?? screenText.map { InlineOCRExecutor(source: $0) }
        self.exclusions = exclusions
        self.pauseState = pauseState
        self.sink = sink
        self.retention = retention
        self.policy = exclusions?.policy(now: clock.now) ?? policy
        self.masker = masker
        self.ids = ids
    }

    /// Runs retention once and opens the first input window.
    public func start() {
        runRetention()
        inputWindowStart = clock.now
        if !input.isAvailable && !warnedInputUnavailable {
            warnedInputUnavailable = true
            Log.info("input", "Input Monitoring not granted: input counts are omitted, not estimated")
        }
    }

    public func tick() {
        let now = clock.now
        if let last = lastPurge, now.timeIntervalSince(last) >= config.purgeInterval { runRetention() }
        if inputWindowStart == nil { inputWindowStart = now }
        if let exclusions { policy = exclusions.policy(now: now) }

        let paused = pauseState.isPaused
        if paused != isPaused {
            isPaused = paused
            write(Event(id: "", ts: 0, kind: paused ? .pause : .resume))
            resetObservation(now: now)
        }
        if paused {
            if input.isAvailable { _ = input.drainCounts() }  // counts made while paused are thrown away
            return
        }

        checkIdle()
        var focusChanged = false
        if lastFocusPoll.map({ now.timeIntervalSince($0) >= config.focusPoll }) ?? true {
            lastFocusPoll = now
            focusChanged = pollFocus()
        }
        maybeOCR(now: now, focusChanged: focusChanged)
        maybeInput(now: now)
    }

    // MARK: retention

    private func runRetention() {
        lastPurge = clock.now
        guard let retention else { return }
        let purged = retention.purge(now: clock.now)
        counters.purgedDays += purged.count
        if !purged.isEmpty, let store = sink as? DayStore { store.forgetKeys() }
    }

    /// When the next scheduled retention run is due.
    public var nextPurge: Date? { lastPurge?.addingTimeInterval(config.purgeInterval) }

    private func resetObservation(now: Date) {
        lastFocus = nil
        lastSnapshot = nil
        lastFocusPoll = nil
        lastOCRAttempt = nil
        lastTextHash = nil
        isIdle = false
        inputWindowStart = now
        generation += 1  // OCR results asked for before this point are dropped
    }

    // MARK: idle

    private func checkIdle() {
        let seconds = idle.secondsSinceLastInput()
        if !isIdle && seconds >= config.idleThreshold {
            isIdle = true
            write(Event(id: "", ts: 0, kind: .idleStart))
        } else if isIdle && seconds < config.idleThreshold {
            isIdle = false
            write(Event(id: "", ts: 0, kind: .idleEnd))
        }
    }

    // MARK: focus

    /// What a focus event records for a snapshot, after the exclusion policy, masking and URL scrubbing.
    public func observedFields(_ s: FocusSnapshot) -> (title: String, url: String?, host: String?, excluded: Bool) {
        if policy.evaluate(s) != nil {
            // Excluded: title replaced by the app name; URL dropped. Host kept only for a denied domain (not private).
            let decision = policy.evaluate(s)
            let host = decision?.reason == .denyURL ? s.url.flatMap(URLScrubber.host(of:)) : nil
            return (s.appName, nil, host, true)
        }
        let title = masker.mask(s.windowTitle).text
        guard let raw = s.url, let scrubbed = URLScrubber.scrub(raw) else { return (title, nil, nil, false) }
        return (title, masker.mask(scrubbed).text, URLScrubber.host(of: scrubbed), false)
    }

    /// Returns true when a focus event was written.
    private func pollFocus() -> Bool {
        guard let snap = workspace.frontmost() else { return false }
        let fields = observedFields(snap)
        let key = FocusKey(app: snap.bundleID, title: fields.title, url: fields.url ?? fields.host)
        lastSnapshot = snap
        guard key != lastFocus else { return false }
        lastFocus = key
        write(Event(id: "", ts: 0, kind: .focus, app: snap.bundleID, appName: snap.appName, title: fields.title,
                    url: fields.url, host: fields.host))
        return true
    }

    // MARK: OCR

    private func maybeOCR(now: Date, focusChanged: Bool) {
        guard let ocr else { return }
        if let snap = lastSnapshot, !isIdle {
            let due = focusChanged || lastOCRAttempt.map { now.timeIntervalSince($0) >= config.ocrInterval } ?? true
            if due {
                lastOCRAttempt = now
                if policy.evaluate(snap) != nil || snap.secureInputActive {
                    counters.ocrSkippedExcluded += 1
                } else {
                    ocr.submit(OCRJob(snapshot: snap, generation: generation))
                }
            }
        }
        for result in ocr.drain() { apply(result) }
        counters.ocrDropped = ocr.dropped
    }

    /// Masks, dedupes and writes one finished OCR result (on the tick thread).
    private func apply(_ result: OCRResult) {
        let snap = result.job.snapshot
        guard result.job.generation == generation, policy.evaluate(snap) == nil else {
            counters.ocrDiscarded += 1
            return
        }
        let raw: String?
        switch result.outcome {
        case .success(let text): raw = text
        case .failure(let error):
            counters.ocrErrors += 1
            logOnce("ocr", "screen text failed: \(error)")
            return
        }
        guard let raw, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        var text = masker.mask(raw).text
        if text.count > config.maxOCRCharacters { text = String(text.prefix(config.maxOCRCharacters)) }
        let hash = Self.textHash(text)
        guard hash != lastTextHash else {
            counters.ocrSkippedUnchanged += 1
            return
        }
        lastTextHash = hash
        write(Event(id: "", ts: 0, kind: .ocr, app: snap.bundleID, appName: snap.appName, text: text, textHash: hash))
    }

    /// SHA-256 of the masked text, first 16 bytes as hex.
    public static func textHash(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: input

    private func maybeInput(now: Date) {
        guard let start = inputWindowStart, now.timeIntervalSince(start) >= config.inputInterval else { return }
        inputWindowStart = now
        guard input.isAvailable else { return }
        let counts = input.drainCounts()
        guard !counts.isEmpty else { return }
        write(Event(id: "", ts: 0, kind: .input, keys: max(0, counts.keys), clicks: max(0, counts.clicks)))
    }

    // MARK: write

    private func write(_ template: Event) {
        var event = template
        event.ts = epochMillis(clock.now)
        event.id = ids.next(millis: event.ts)
        do {
            try sink.append(event)
            counters.written[event.kind, default: 0] += 1
        } catch {
            counters.writeErrors += 1
            Log.error("store", "append \(event.kind.rawValue) event failed: \(error)")
        }
    }

    private func logOnce(_ context: String, _ message: String) {
        guard loggedErrors.insert(context + message).inserted else { return }
        Log.error(context, message + " (further identical errors are counted, not logged)")
    }
}
