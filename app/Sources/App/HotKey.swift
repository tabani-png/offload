import Carbon
import Foundation

/// System-wide hotkey through Carbon's RegisterEventHotKey. Needs no Accessibility or Input Monitoring
/// permission, and it only ever sees its own chord, never other keystrokes.
///
/// Default: ⌥Space opens and closes the insight card.
final class HotKey {
  static let defaultKeyCode = UInt32(kVK_Space)
  static let defaultModifiers = UInt32(optionKey)
  static let displayName = "⌥Space"

  private var ref: EventHotKeyRef?
  private var handler: EventHandlerRef?
  private let action: () -> Void

  init?(keyCode: UInt32 = HotKey.defaultKeyCode, modifiers: UInt32 = HotKey.defaultModifiers,
        action: @escaping () -> Void) {
    self.action = action
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let me = Unmanaged.passUnretained(self).toOpaque()
    let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
      guard let userData else { return OSStatus(eventNotHandledErr) }
      let hotKey = Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue()
      DispatchQueue.main.async { hotKey.action() }
      return noErr
    }, 1, &spec, me, &handler)
    guard installed == noErr else { return nil }
    let id = EventHotKeyID(signature: OSType(0x4F46_4C44), id: 1)  // "OFLD"
    let registered = RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &ref)
    guard registered == noErr else {
      if let handler { RemoveEventHandler(handler) }
      return nil
    }
  }

  deinit {
    if let ref { UnregisterEventHotKey(ref) }
    if let handler { RemoveEventHandler(handler) }
  }
}
