// Token rules: SECRET, IBAN, ISIN and CUSIP (slices/s02-detectors/SPEC.md). Every token starts where a word starts.
extension DetectorRun {
    /// API key prefixes and the minimum body length after them. Body characters are `[A-Za-z0-9_-]`.
    static let keyPrefixes: [(prefix: [Character], minBody: Int)] = [
        ("sk_live_", 16), ("sk_test_", 16), ("rk_live_", 16), ("rk_test_", 16),
        ("ghp_", 30), ("gho_", 30), ("ghu_", 30), ("ghs_", 30), ("ghr_", 30), ("github_pat_", 22),
        ("xoxa-", 10), ("xoxb-", 10), ("xoxp-", 10), ("xoxr-", 10), ("xoxs-", 10),
        ("AIza", 35), ("sk-ant-", 20), ("sk-proj-", 20), ("sk-", 20), ("glpat-", 20),
    ].map { (prefix: Array($0.0), minBody: $0.1) }

    static let awsPrefixes = [Array("AKIA"), Array("ASIA")]
    static let jwtHead = Array("eyJ")
    static let pemBegin = Array("-----BEGIN ")
    static let pemEnd = Array("-----END ")
    static let pemDashes = Array("-----")

    /// SECRET, IBAN, ISIN and CUSIP candidates.
    func tokens() -> [ScanCandidate] {
        var found = pemBlocks().map { ScanCandidate(category: .secret, span: $0) }
        var i = 0
        while i < text.count {
            guard text.isWord(i) else { i += 1; continue }
            var end = i + 1
            while end < text.count && text.isWord(end) { end += 1 }
            if let span = secret(at: i, wordEnd: end) { found.append(ScanCandidate(category: .secret, span: span)) }
            if let span = iban(at: i) { found.append(ScanCandidate(category: .iban, span: span)) }
            let word = Array(text.chars[i..<end])
            if word.count == 12 && Self.isISIN(word) {
                found.append(ScanCandidate(category: .isin, span: ScanSpan(start: i, end: end)))
            }
            if word.count == 9 && isCUSIP(word, at: i) {
                found.append(ScanCandidate(category: .cusip, span: ScanSpan(start: i, end: end)))
            }
            i = end
        }
        return found
    }

    // MARK: secrets

    /// An AWS access key id, a JWT or a prefixed API key starting at `i`, as the whole token.
    private func secret(at i: Int, wordEnd: Int) -> ScanSpan? {
        if wordEnd - i == 20, Self.awsPrefixes.contains(where: { text.has($0, at: i) }),
           text.chars[i..<wordEnd].allSatisfy(ScanText.isUpperAlnum) {
            return ScanSpan(start: i, end: wordEnd)
        }
        if let span = jwt(at: i) { return span }
        var best: ScanSpan?
        for (prefix, minBody) in Self.keyPrefixes where text.has(prefix, at: i) {
            let end = keyBodyEnd(from: i + prefix.count)
            if end - (i + prefix.count) >= minBody && end - i > (best?.length ?? 0) {
                best = ScanSpan(start: i, end: end)
            }
        }
        return best
    }

    /// `eyJ…` `.` `eyJ…` `.` signature, each part base64url.
    private func jwt(at i: Int) -> ScanSpan? {
        guard text.has(Self.jwtHead, at: i) else { return nil }
        let header = keyBodyEnd(from: i)
        guard text[header] == ".", text.has(Self.jwtHead, at: header + 1) else { return nil }
        let payload = keyBodyEnd(from: header + 1)
        guard text[payload] == "." else { return nil }
        let signature = keyBodyEnd(from: payload + 1)
        return signature > payload + 1 ? ScanSpan(start: i, end: signature) : nil
    }

    private func keyBodyEnd(from start: Int) -> Int {
        var end = start
        while end < text.count && ScanText.isKeyBody(text.chars[end]) { end += 1 }
        return end
    }

    /// `-----BEGIN … PRIVATE KEY-----` through the matching footer, or to the end of the text when it is cut off.
    private func pemBlocks() -> [ScanSpan] {
        var found: [ScanSpan] = []
        var i = 0
        while i < text.count {
            guard text.chars[i] == "-", text.has(Self.pemBegin, at: i) else { i += 1; continue }
            let labelStart = i + Self.pemBegin.count
            var labelEnd = labelStart
            while labelEnd < text.count && !text.has(Self.pemDashes, at: labelEnd) && !text.chars[labelEnd].isNewline {
                labelEnd += 1
            }
            let label = Array(text.chars[labelStart..<labelEnd])
            guard text.has(Self.pemDashes, at: labelEnd), String(label).hasSuffix("PRIVATE KEY") else {
                i = labelStart
                continue
            }
            let footer = Self.pemEnd + label + Self.pemDashes
            var f = labelEnd + Self.pemDashes.count
            while f + footer.count <= text.count && !text.has(footer, at: f) { f += 1 }
            var end = text.count
            if f + footer.count <= text.count {
                end = f + footer.count
            } else {
                while end > labelEnd && text.chars[end - 1].isWhitespace { end -= 1 }
            }
            found.append(ScanSpan(start: i, end: end))
            i = end
        }
        return found
    }

    // MARK: bank and securities identifiers

    /// IBAN: 2 upper-case letters + 2 digits, then compact or blocks of up to 4 split by single spaces, 15-34
    /// characters, mod-97 == 1. The longest valid prefix that ends at a word boundary wins.
    private func iban(at i: Int) -> ScanSpan? {
        guard let a = text[i], let b = text[i + 1], let c = text[i + 2], let d = text[i + 3],
              ScanText.isUpper(a), ScanText.isUpper(b), ScanText.isDigit(c), ScanText.isDigit(d) else { return nil }
        var blocks: [ScanSpan] = []
        var p = i
        while true {
            var q = p
            while q < text.count && ScanText.isUpperAlnum(text.chars[q]) { q += 1 }
            let block = ScanSpan(start: p, end: q)
            if !blocks.isEmpty && block.length > 4 { break }
            blocks.append(block)
            if blocks.count == 1 && block.length != 4 { break } // compact form: one run
            guard text[q] == " ", let next = text[q + 1], ScanText.isUpperAlnum(next) else { break }
            p = q + 1
        }
        for k in stride(from: blocks.count, through: 1, by: -1) {
            let last = blocks[k - 1]
            if text.isWord(last.end) { continue }
            let compact = blocks[..<k].flatMap { text.chars[$0.start..<$0.end] }
            if (15...34).contains(compact.count) && DetectorChecksum.iban(compact) {
                return ScanSpan(start: i, end: last.end)
            }
        }
        return nil
    }

    /// ISIN: `[A-Z]{2}[A-Z0-9]{9}[0-9]` with a digit somewhere in characters 3-11 and a valid check digit.
    private static func isISIN(_ w: [Character]) -> Bool {
        let middle = w[2...10]
        return ScanText.isUpper(w[0]) && ScanText.isUpper(w[1]) && middle.allSatisfy(ScanText.isUpperAlnum)
            && ScanText.isDigit(w[11]) && middle.contains(where: ScanText.isDigit) && DetectorChecksum.isin(w)
    }

    /// CUSIP: `[A-Z0-9]{8}[0-9]` with a digit in the first 8, a valid check digit, and a letter in the first 8
    /// or a CUSIP keyword before (20).
    private func isCUSIP(_ w: [Character], at i: Int) -> Bool {
        let body = w[0..<8]
        guard body.allSatisfy(ScanText.isUpperAlnum), ScanText.isDigit(w[8]), body.contains(where: ScanText.isDigit),
              DetectorChecksum.cusip(w) else { return false }
        return body.contains(where: ScanText.isUpper) || cusip.before(i, within: 20)
    }
}
