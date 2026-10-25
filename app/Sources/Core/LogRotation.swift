import Foundation

/// s10a (REVIEW-2 privacy): the brain's stderr log (~/Library/Logs/Offload/brain.err.log) is rotated at 5 MB and
/// two old copies are kept (.1, .2), each 0600. The app checks at launch and every minute. The supervisor opens the
/// file per write, so a rename never loses a line: the next write creates a fresh file.
enum LogRotation {
  static let maxBytes: UInt64 = 5 * 1024 * 1024
  static let keep = 2
  static let interval: TimeInterval = 60

  /// Rotates when `url` is at least `maxBytes`. Returns true when it rotated.
  @discardableResult
  static func rotateIfNeeded(_ url: URL, maxBytes: UInt64 = maxBytes, keep: Int = keep,
                             fileManager fm: FileManager = .default) -> Bool {
    guard let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? UInt64, size >= maxBytes, keep > 0 else {
      return false
    }
    func old(_ n: Int) -> URL { URL(fileURLWithPath: url.path + ".\(n)") }
    try? fm.removeItem(at: old(keep))
    if keep > 1 {
      for n in stride(from: keep - 1, through: 1, by: -1) where fm.fileExists(atPath: old(n).path) {
        try? fm.moveItem(at: old(n), to: old(n + 1))
      }
    }
    guard (try? fm.moveItem(at: url, to: old(1))) != nil else { return false }
    for n in 1...keep where fm.fileExists(atPath: old(n).path) {
      try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: old(n).path)
    }
    fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
    return true
  }
}
