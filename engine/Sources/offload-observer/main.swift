// offload-observer: records Events into $OFFLOAD_HOME per docs/store-contract.md. No network code.
import AppKit
import Foundation
import OffloadCore

let env = ProcessInfo.processInfo.environment
let parsed: ParsedArguments
do {
    parsed = try ObserverCLI.parse(Array(CommandLine.arguments.dropFirst()))
} catch {
    FileHandle.standardError.write(Data("offload-observer: \(error)\n\(ObserverCLI.usage)\n".utf8))
    exit(2)
}

guard parsed.command == .run else {
    let code = ObserverCLI.runOffline(parsed, environment: env, now: Date(),
                                      out: { print($0) },
                                      err: { FileHandle.standardError.write(Data(("offload-observer: " + $0 + "\n").utf8)) })
    exit(code)
}

let layout = StoreLayout(home: StoreLayout.resolveHome(flag: parsed.home, environment: env))
do { try layout.ensureDirectories() } catch {
    Log.error("run", "cannot create \(layout.home.path): \(error)")
    exit(1)
}
let plain = DayStore.plainFromEnvironment(env)
let policy = ExclusionPolicy.standard
let clock = SystemClock()
let input = LiveInputCounter()
let permissions = Permissions.state
let observer = Observer(clock: clock, workspace: LiveWorkspace(), idle: LiveIdle(), input: input,
                        screenText: LiveScreenText(policy: policy), pauseState: FilePauseControl(layout: layout),
                        sink: DayStore(layout: layout, plain: plain), retention: Retention(layout: layout),
                        policy: policy)
let startedAt = Date()
let pid = ProcessInfo.processInfo.processIdentifier

Log.info("run", "home=\(layout.home.path) plain=\(plain) screenRecording=\(permissions.screenRecording) "
    + "accessibility=\(permissions.accessibility) inputMonitoring=\(permissions.inputMonitoring)")
if !permissions.screenRecording { Log.info("run", "Screen Recording not granted: OCR is off") }
if !permissions.accessibility { Log.info("run", "Accessibility not granted: titles fall back to the window server, URLs are off") }
if !permissions.inputMonitoring { _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent) }

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
input.install()

let queue = DispatchQueue(label: "ai.offload.observer.tick", qos: .utility)
var ticks = 0
let timer = DispatchSource.makeTimerSource(queue: queue)
timer.schedule(deadline: .now(), repeating: .seconds(1), leeway: .milliseconds(100))
queue.sync { observer.start() }
timer.setEventHandler {
    observer.tick()
    ticks += 1
    if ticks % 5 == 1 {
        writeHeartbeat(observer.heartbeat(pid: pid, startedAt: startedAt, now: Date(), plain: plain,
                                          permissions: Permissions.state), layout: layout)
    }
}
timer.resume()

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
    source.setEventHandler {
        Log.info("run", "signal \(sig): stopping after \(observer.counters.totalWritten) events")
        if FileManager.default.fileExists(atPath: layout.statusFile.path) {
            do { try FileManager.default.removeItem(at: layout.statusFile) } catch {
                Log.error("run", "remove heartbeat: \(error.localizedDescription)")
            }
        }
        exit(0)
    }
    source.resume()
    signalSources.append(source)
}

app.run()
