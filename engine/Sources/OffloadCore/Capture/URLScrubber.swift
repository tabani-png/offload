import Foundation

/// URL hygiene before a URL is written: query string and fragment removed, user info removed, host lowercased.
public enum URLScrubber {
    /// The URL without query, fragment or user info; nil when it does not parse or has no host.
    public static func scrub(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var c = URLComponents(string: trimmed), let host = c.host, !normalizedHost(host).isEmpty else { return nil }
        c.query = nil
        c.fragment = nil
        c.user = nil
        c.password = nil
        c.host = normalizedHost(host)
        return c.string
    }

    /// Host of a URL; a URL without a scheme is retried with `https://`. Lowercased, trailing dots dropped.
    public static func host(of url: String) -> String? {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        for candidate in [trimmed, "https://" + trimmed] {
            if let host = URLComponents(string: candidate)?.host, !normalizedHost(host).isEmpty {
                return normalizedHost(host)
            }
        }
        return nil
    }

    static func normalizedHost(_ s: String) -> String {
        var host = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while host.hasSuffix(".") { host.removeLast() }
        return host
    }
}
