// Adapted from Workpaper engine WPCore/Capture/ExclusionPolicy.swift. Finance preset (messaging, data rooms, payroll)
// dropped; password managers, Keychain Access, authenticators and banking are kept.
import Foundation

/// Why a window is treated as excluded: no OCR, title replaced by the app name.
public enum ExclusionReason: String, CaseIterable, Codable, Sendable {
    case denyApp = "deny_app"
    case denyURL = "deny_url"
    case privateWindow = "private_window"
}

public struct ExclusionDecision: Equatable, Sendable {
    public var reason: ExclusionReason
    /// The list entry that matched, exactly as written. Nil for the private-browsing flag.
    public var rule: String?

    public init(_ reason: ExclusionReason, rule: String? = nil) {
        self.reason = reason
        self.rule = rule
    }
}

public struct ExclusionPolicy: Equatable, Codable, Sendable {
    /// Apps that never get OCR and whose titles are replaced by the app name.
    public var deniedBundleIDs: [String]
    /// URL domains (and their subdomains) treated the same way: banking.
    public var deniedURLDomains: [String]
    /// Case-insensitive substrings of a window title that mark a private / incognito window.
    public var privateTitleMarkers: [String]

    public init(deniedBundleIDs: [String], deniedURLDomains: [String], privateTitleMarkers: [String]) {
        self.deniedBundleIDs = deniedBundleIDs
        self.deniedURLDomains = deniedURLDomains
        self.privateTitleMarkers = privateTitleMarkers
    }

    /// Banking apps known on macOS (native and iOS-on-Apple-silicon). Bundle ids are best effort; extend as found.
    public static let bankingBundleIDs = [
        "com.moneymoney-app.retail", "com.iggsoftware.banktivity7", "com.iggsoftware.banktivity8",
        "com.quicken.Quicken", "com.chase.sig.Chase", "com.bankofamerica.BofA", "com.wellsfargo.net.mobilebanking",
        "com.capitalone.enterprisemobilebanking", "com.americanexpress.amexservice", "com.rbc.mobile.app",
        "com.td.tdcanada", "com.scotiabank.mobile", "com.bmo.mobile", "com.cibc.mobile", "com.revolut.revolut",
        "com.monzo.monzo", "com.n26.n26",
    ]

    public static let standard = ExclusionPolicy(
        deniedBundleIDs: [
            // password managers and Keychain Access
            "com.1password.1password", "com.agilebits.onepassword7", "com.agilebits.onepassword-osx",
            "com.bitwarden.desktop", "org.keepassxc.keepassxc", "com.lastpass.LastPass", "com.dashlane.dashlanephonefinal",
            "com.apple.Passwords", "com.apple.keychainaccess",
            // authenticators
            "com.authy.authy-mac", "com.microsoft.azureauthenticator", "com.yubico.yubioath",
        ] + bankingBundleIDs,
        deniedURLDomains: [
            "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "capitalone.com", "usbank.com", "pnc.com",
            "ally.com", "americanexpress.com", "rbcroyalbank.com", "td.com", "scotiabank.com", "bmo.com", "cibc.com",
            "tangerine.ca", "revolut.com", "monzo.com", "n26.com", "wise.com", "mercury.com", "1password.com",
            "bitwarden.com", "lastpass.com",
        ],
        privateTitleMarkers: ["Private Browsing", "Incognito", "InPrivate", "Private Window"])

    /// The first matching rule, or nil when the window may be observed in full.
    public func evaluate(_ snapshot: FocusSnapshot) -> ExclusionDecision? {
        if let rule = Self.matchBundle(snapshot.bundleID, in: deniedBundleIDs) {
            return ExclusionDecision(.denyApp, rule: rule)
        }
        if snapshot.isPrivateBrowsing { return ExclusionDecision(.privateWindow) }
        if let marker = privateTitleMarkers.first(where: { !Self.isBlank($0) &&
            snapshot.windowTitle.range(of: $0, options: .caseInsensitive) != nil }) {
            return ExclusionDecision(.privateWindow, rule: marker)
        }
        guard let url = snapshot.url, let host = URLScrubber.host(of: url) else { return nil }
        if let rule = Self.matchDomain(host, in: deniedURLDomains) { return ExclusionDecision(.denyURL, rule: rule) }
        return nil
    }

    private static func isBlank(_ s: String) -> Bool { s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// Trimmed, case-insensitive equality. Returns the list entry as written.
    static func matchBundle(_ bundleID: String, in list: [String]) -> String? {
        let id = bundleID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !id.isEmpty else { return nil }
        return list.first { !isBlank($0) && $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == id }
    }

    /// The host is the domain or a subdomain of it. Returns the list entry as written.
    static func matchDomain(_ host: String, in list: [String]) -> String? {
        list.first { entry in
            let domain = URLScrubber.normalizedHost(entry)
            return !domain.isEmpty && (host == domain || host.hasSuffix("." + domain))
        }
    }
}
