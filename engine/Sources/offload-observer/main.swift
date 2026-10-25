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

let keysMode = KeyMode.fromEnvironment(env)
let secrets: SecretStore? = keysMode == .keychain ? KeychainSecretStore() : nil
let executablePath = Bundle.main.executablePath ?? CommandLine.arguments[0]

guard parsed.command == .run else {
    let code = ObserverCLI.runOffline(parsed, environment: env, now: Date(), secrets: secrets,
                                      permissions: parsed.command == .status ? Permissions.state : nil,
                                      executable: executablePath,
                                      input: {
                                          // wrap-key only: a piped key is refused without --import; a terminal means "none".
                                          switch parsed.command {
                                          case .wrapKey, .importKey: break
                                          default: return Data()
                                          }
                                          guard isatty(STDIN_FILENO) == 0 else { return Data() }
                                          return FileHandle.standardInput.readDataToEndOfFile()
                                      },
                                      out: { print($0) },
                                      err: { FileHandle.standardError.write(Data(("offload-observer: " + $0 + "\n").utf8)) })
    exit(code)
}

let layout = StoreLayout(home: StoreLayout.resolveHome(flag: parsed.home, environment: env))
do { try layout.ensureDirectories() } catch {
    Log.error("run", "cannot create \(layout.home.path): \(Log.describe(error))")
    exit(1)
}
let plain = DayStore.plainFromEnvironment(env)
let vault = DayKeyVault(layout: layout, mode: keysMode, secrets: secrets)
if keysMode == .keychain {
    do {
        _ = try vault.masterKey(create: true)
        let migrated = try vault.migrateRawKeys()
        if !migrated.isEmpty { Log.info("keys", "wrapped \(migrated.count) raw day key file(s) with the Keychain master key") }
    } catch {
        Log.error("keys", "Keychain master key unavailable (\(Log.describe(error))); not recording. OFFLOAD_KEYS=file uses raw key files")
        exit(1)
    }
}
let exclusions = ExclusionReloader(file: ExclusionFile(layout: layout))
let clock = SystemClock()
let input = LiveInputCounter()
let permissions = Permissions.state
// OCR runs on its own serial queue (QueuedOCRExecutor): the first Vision load no longer stalls focus/pause polling.
let ocr = QueuedOCRExecutor(source: LiveScreenText(policy: .standard))
let observer = Observer(clock: clock, workspace: LiveWorkspace(), idle: LiveIdle(), input: input,
                        screenText: nil, pauseState: FilePauseControl(layout: layout),
                        sink: DayStore(layout: layout, plain: plain, keys: vault), retention: Retention(layout: layout),
                        exclusions: exclusions, ocr: ocr, days: DayCalendar(),
                        logRotation: LogRotation(layout: layout),  // 5 MB, 2 old files, checked every minute
                        // s11: masked keyframes, encrypted with the day key; OFFLOAD_KEYFRAMES=0 turns them off.
                        frames: env["OFFLOAD_KEYFRAMES"] == "0" ? nil : FrameStore(layout: layout, keys: vault))
let startedAt = Date()
let pid = ProcessInfo.processInfo.processIdentifier

Log.info("run", "home=\(layout.home.path) plain=\(plain) keys=\(keysMode.rawValue) screenRecording=\(permissions.screenRecording) "
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
                                          permissions: Permissions.state, keysMode: keysMode), layout: layout)
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
