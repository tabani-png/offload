// Copied from Workpaper engine (WPCore/Detectors), codename support removed for Offload.
/// Finds sensitive values (cards, national IDs, bank numbers, securities IDs, one-time codes, secrets)
/// in text, before anything is written to disk.
/// Rules: slices/s02-detectors/SPEC.md; the comma money guard and codename edges: slices/s13-engine-hardening/SPEC.md;
/// SSN, SIN and ABA windows and codename boundaries v2: slices/s15-engine-final/SPEC.md.
public struct SensitiveDetector: Sendable {
    public init() {}

    /// All sensitive values in `text`, sorted by position, with no two ranges overlapping.
    public func scan(_ text: String) -> [Detection] {
        let scanText = ScanText(text)
        return DetectorRun(scanText).run().map { found in
            Detection(category: found.category, range: scanText.range(found.span),
                      label: found.isExpiry ? MaskCategory.cardExpiryLabel : nil)
        }
    }

}

/// One candidate value before overlaps are resolved.
struct ScanCandidate {
    let category: MaskCategory
    let span: ScanSpan
    var isExpiry = false
}

/// One scan of one text: collects candidates per category, then keeps them greedily by priority.
struct DetectorRun {
    /// Overlap priority, highest first.
    static let priority: [MaskCategory] = [.secret, .iban, .isin, .cusip, .pan, .ssn, .sin, .aba, .cvv, .acct, .otp]

    static let accountWords = ScanPhrase.list("acct", "account", "a/c")
    static let ssnWords = ScanPhrase.list("ssn", "ss#", "social security")
    static let sinWords = ScanPhrase.list("sin", "nas", "social insurance")
    static let otpWords = ScanPhrase.list("code", "passcode", "verification", "verify", "2fa", "mfa", "one-time", "otp", "pin")
    static let cvvWords = ScanPhrase.list("cvv", "cvv2", "cvc", "cvc2", "cid", "csc", "security code")
    static let phoneWords = ScanPhrase.list("tel", "phone", "fax", "mobile", "cell", "call")
    static let invoiceWords = ScanPhrase.list("invoice", "inv", "order", "po", "ref", "ticket")
    static let quantityWords = ScanPhrase.list("shares", "sh", "units", "qty")
    static let cusipWords = ScanPhrase.list("cusip")

    let text: ScanText
    let groups: [ScanSpan]
    let numbers: [DigitNumber]
    let digits: ScanDigits
    let account, ssn, sin, otp, cvv, cusip: KeywordHits
    let phone, invoice, quantity: KeywordHits

    init(_ text: ScanText) {
        self.text = text
        digits = ScanDigits(text)
        groups = digits.groups
        account = KeywordHits(Self.accountWords, in: text)
        ssn = KeywordHits(Self.ssnWords, in: text)
        sin = KeywordHits(Self.sinWords, in: text)
        otp = KeywordHits(Self.otpWords, in: text)
        cvv = KeywordHits(Self.cvvWords, in: text)
        cusip = KeywordHits(Self.cusipWords, in: text)

        // Guards: money, phone, date, identifier/quantity (SPEC "Guards").
        phone = KeywordHits(Self.phoneWords, in: text)
        invoice = KeywordHits(Self.invoiceWords, in: text)
        quantity = KeywordHits(Self.quantityWords, in: text)
        var numbers = digits.numbers
        let chained = Self.thousandsChains(numbers, in: text)
        for k in numbers.indices {
            let span = numbers[k].span
            numbers[k].isMoney = chained[k] || Self.isMoney(span, in: text)
            numbers[k].isPhone = text[span.start - 1] == "+" || phone.before(span.start, within: 15)
            numbers[k].isDate = Self.isISODate(numbers[k], groups: digits.groups, in: text)
            numbers[k].isIdentifier = invoice.before(span.start, within: 15) || quantity.after(span.end, within: 3)
        }
        self.numbers = numbers
    }

    /// The kept detections, sorted by position.
    func run() -> [ScanCandidate] {
        var taken = [Bool](repeating: false, count: text.count)
        var kept: [ScanCandidate] = []
        // SSN, SIN and ABA windows come first: a card window that cuts an SSN or SIN window is never used (s15 AC-2).
        // CVV and expiry depend on where the kept PANs are, so they are resolved after every higher category.
        let ids = idWindows()
        let cuts = ids.filter { $0.candidate.category != .aba }.map { (lo: $0.lo, hi: $0.hi) }
        Self.keep(tokens() + pans(avoiding: cuts) + ids.map(\.candidate), into: &kept, taken: &taken)
        let keptPANs = kept.filter { $0.category == .pan }.map(\.span)
        Self.keep(cardExtras(near: keptPANs) + accountNumbers() + oneTimeCodes(),
                  into: &kept, taken: &taken)
        return kept.sorted { $0.span.start < $1.span.start }
    }

    /// Keeps candidates by category priority, longer span first, dropping any that overlap a kept one.
    private static func keep(_ candidates: [ScanCandidate], into kept: inout [ScanCandidate], taken: inout [Bool]) {
        let rank = Dictionary(uniqueKeysWithValues: priority.enumerated().map { ($1, $0) })
        let ordered = candidates.sorted { a, b in
            if rank[a.category]! != rank[b.category]! { return rank[a.category]! < rank[b.category]! }
            if a.span.length != b.span.length { return a.span.length > b.span.length }
            return a.span.start < b.span.start
        }
        for candidate in ordered {
            let span = candidate.span
            if (span.start..<span.end).contains(where: { taken[$0] }) { continue }
            for i in span.start..<span.end { taken[i] = true }
            kept.append(candidate)
        }
    }

    // MARK: guards

    /// After a currency symbol (optional space) or code, or touching `.` that has a digit on its other side.
    /// A comma makes money only inside a thousands chain (`thousandsChains`, s13 "Money guard").
    private static func isMoney(_ span: ScanSpan, in text: ScanText) -> Bool {
        afterCurrency(span.start, in: text) || touchesDecimal(span, in: text)
    }

    /// Right after a currency symbol (optional space) or a currency code and a space.
    private static func afterCurrency(_ s: Int, in text: ScanText) -> Bool {
        if let c = text[s - 1], ScanText.isCurrency(c) { return true }
        if text[s - 1] == " ", let c = text[s - 2], ScanText.isCurrency(c) { return true }
        for code in ["USD ", "CAD ", "EUR ", "GBP "] where text.has(Array(code), at: s - 4) && !text.isWord(s - 5) {
            return true
        }
        return false
    }

    /// Touching `.` that has a digit on its other side.
    private static func touchesDecimal(_ span: ScanSpan, in text: ScanText) -> Bool {
        (text[span.start - 1] == "." && text.isDigit(span.start - 2)) || (text[span.end] == "." && text.isDigit(span.end + 1))
    }

    /// For each number, true when it sits in a thousands chain (`1,250,000`): a maximal run of two or more numbers
    /// joined by single commas, each one bare digit group, the first 1 to 3 digits and every later one exactly 3.
    /// A run that breaks any of these (a card, a routing number, a grouped SSN, a 2- or 4-digit field) is not money.
    private static func thousandsChains(_ numbers: [DigitNumber], in text: ScanText) -> [Bool] {
        var chained = [Bool](repeating: false, count: numbers.count)
        var first = 0
        for k in numbers.indices {
            let end = numbers[k].span.end
            if k + 1 < numbers.count && text[end] == "," && numbers[k + 1].span.start == end + 1 { continue }
            let run = numbers[first...k]
            if run.count >= 2 && run.allSatisfy({ $0.groups.count == 1 }) && (1...3).contains(run.first!.digitCount)
                && run.dropFirst().allSatisfy({ $0.digitCount == 3 }) {
                for m in first...k { chained[m] = true }
            }
            first = k + 1
        }
        return chained
    }

    /// Starts with `yyyy-mm-dd`: groups of 4, 2 and 2 digits joined by single `-`.
    private static func isISODate(_ number: DigitNumber, groups: [ScanSpan], in text: ScanText) -> Bool {
        guard number.groups.count >= 3 else { return false }
        let g = number.groups.lowerBound
        let (y, m, d) = (groups[g], groups[g + 1], groups[g + 2])
        return y.length == 4 && m.length == 2 && d.length == 2
            && m.start == y.end + 1 && text[y.end] == "-" && d.start == m.end + 1 && text[m.end] == "-"
    }

    // MARK: numbers

    /// PAN: the longest (then earliest) Luhn-valid window of 13-19 digits starting with 2-6; leftover groups can hold more.
    /// A window that cuts one of `cuts` (the SSN and SIN windows as group ranges, sorted by `lo`) is dropped before the
    /// choice: it shares a group with it without holding all of its groups (s15 "Card windows never cut an SSN or SIN").
    private func pans(avoiding cuts: [(lo: Int, hi: Int)]) -> [ScanCandidate] {
        let cutStarts = cuts.map(\.lo)
        var found: [ScanCandidate] = []
        for number in numbers where !number.isMoney && !number.isPhone && number.digitCount >= 13 {
            let first = sortedLowerBound(cutStarts, number.groups.lowerBound)
            let mine = cuts[first...].prefix(while: { $0.lo < number.groups.upperBound })
            var windows: [(lo: Int, hi: Int, digits: Int)] = []
            for lo in number.groups {
                guard let lead = text.digits(groups[lo]).first, (2...6).contains(lead) else { continue }
                var windowDigits: [Int] = []
                for hi in lo..<number.groups.upperBound {
                    windowDigits += text.digits(groups[hi])
                    if windowDigits.count > 19 { break }
                    if windowDigits.count >= 13 && DetectorChecksum.luhn(windowDigits)
                        && !mine.contains(where: { lo <= $0.hi && $0.lo <= hi && !(lo <= $0.lo && $0.hi <= hi) }) {
                        windows.append((lo, hi, windowDigits.count))
                    }
                }
            }
            windows.sort { $0.digits != $1.digits ? $0.digits > $1.digits : $0.lo < $1.lo }
            var used: [(lo: Int, hi: Int)] = []
            for w in windows where !used.contains(where: { w.lo <= $0.hi && $0.lo <= w.hi }) {
                used.append((w.lo, w.hi))
                found.append(ScanCandidate(category: .pan, span: ScanSpan(start: groups[w.lo].start, end: groups[w.hi].end)))
            }
        }
        return found
    }

    /// An SSN, SIN or ABA candidate with the digit groups `lo...hi` it covers (indexes into `groups`).
    struct IDWindow {
        let candidate: ScanCandidate
        let lo: Int
        let hi: Int
    }

    /// SSN, SIN and ABA on every window of 1 to 3 whole groups of each number (s15 "SSN, SIN and ABA windows"). The
    /// window that is the whole number keeps the s02 rule and the number's own guards. A strict window (part of a longer
    /// number) needs uniform separators, is guarded on its own span, and is never taken from a number an account keyword
    /// claims (that number is masked whole as ACCT). Sorted by `lo`.
    private func idWindows() -> [IDWindow] {
        let claimed = Set(accountNumberIndices())
        var found: [IDWindow] = []
        for (n, number) in numbers.enumerated() {
            let last = number.groups.upperBound - 1
            for lo in number.groups {
                for hi in lo...min(lo + 2, last) {
                    let bare = hi == lo && groups[lo].length == 9
                    let ssnShape = hi == lo + 2 && groups[lo].length == 3 && groups[lo + 1].length == 2
                        && groups[hi].length == 4
                    let sinShape = hi == lo + 2 && groups[lo].length == 3 && groups[lo + 1].length == 3
                        && groups[hi].length == 3
                    guard bare || ssnShape || sinShape else { continue }
                    let span = ScanSpan(start: groups[lo].start, end: groups[hi].end)
                    if lo == number.groups.lowerBound && hi == last {
                        if number.isMoney || number.isPhone || number.isDate || number.isIdentifier { continue }
                    } else if claimed.contains(n) || !uniformSeparators(lo, hi) || isGuarded(window: span, of: number) {
                        continue
                    }
                    let d = text.digits(span)
                    var categories: [MaskCategory] = []
                    if (ssnShape || (bare && ssn.before(span.start, within: 20))) && Self.validSSN(d) {
                        categories.append(.ssn)
                    }
                    if (sinShape || (bare && sin.before(span.start, within: 20))) && DetectorChecksum.luhn(d) {
                        categories.append(.sin)
                    }
                    if bare && Self.validABA(d) { categories.append(.aba) }
                    for category in categories {
                        found.append(IDWindow(candidate: ScanCandidate(category: category, span: span), lo: lo, hi: hi))
                    }
                }
            }
        }
        return found
    }

    /// Every separator between the groups `lo...hi` is the same string, character for character.
    private func uniformSeparators(_ lo: Int, _ hi: Int) -> Bool {
        guard hi > lo else { return true }
        let first = text.chars[groups[lo].end..<groups[lo + 1].start]
        return (lo + 1..<hi).allSatisfy { text.chars[groups[$0].end..<groups[$0 + 1].start].elementsEqual(first) }
    }

    /// The guards of a strict window, judged on the window: money (the number right after a currency sign or code, or
    /// the window touching a decimal point), phone (`+` right before, or a phone keyword before (15)) and identifier
    /// (an invoice keyword before (15), or a quantity word after (3)). No date guard.
    private func isGuarded(window span: ScanSpan, of number: DigitNumber) -> Bool {
        Self.afterCurrency(number.span.start, in: text) || Self.touchesDecimal(span, in: text)
            || text[span.start - 1] == "+" || phone.before(span.start, within: 15)
            || invoice.before(span.start, within: 15) || quantity.after(span.end, within: 3)
    }

    /// Area 000, 666 and 900-999, group 00 and serial 0000 are never issued.
    private static func validSSN(_ d: [Int]) -> Bool {
        let area = d[0] * 100 + d[1] * 10 + d[2]
        let group = d[3] * 10 + d[4]
        let serial = d[5] * 1000 + d[6] * 100 + d[7] * 10 + d[8]
        return area != 0 && area != 666 && area < 900 && group != 0 && serial != 0
    }

    /// ABA: 9 digits with a Federal Reserve prefix and a valid 3-7-1 checksum.
    private static func validABA(_ d: [Int]) -> Bool {
        let prefix = d[0] * 10 + d[1]
        let prefixOK = (1...12).contains(prefix) || (21...32).contains(prefix) || (61...72).contains(prefix) || prefix == 80
        return prefixOK && DetectorChecksum.aba(d)
    }

    /// Card expiry dates and CVVs, only near a kept PAN.
    private func cardExtras(near keptPANs: [ScanSpan]) -> [ScanCandidate] {
        guard !keptPANs.isEmpty else { return [] }
        // Kept PANs never overlap, so sorted by start they are sorted by end too: the nearest ones sit either side
        // of the insertion point.
        let pans = keptPANs.sorted { $0.start < $1.start }
        let panStarts = pans.map(\.start)
        let isNearPAN = { (span: ScanSpan) -> Bool in
            let k = sortedLowerBound(panStarts, span.start)
            return (k < pans.count && pans[k].gap(to: span) <= 40) || (k > 0 && pans[k - 1].gap(to: span) <= 40)
        }

        // Expiry: MM/YY or MM/YYYY that is not part of a longer slash date. `skip` collects the first character of
        // every group inside an expiry or a PAN; rule (a) passes over those groups.
        var expiries: [ScanSpan] = []
        var skip = Set<Int>()
        for g in groups.indices.dropLast() {
            let (mm, yy) = (groups[g], groups[g + 1])
            guard mm.length == 2, text[mm.end] == "/", yy.start == mm.end + 1, yy.length == 2 || yy.length == 4 else { continue }
            let month = text.digits(mm)
            guard (1...12).contains(month[0] * 10 + month[1]) else { continue }
            if text[mm.start - 1] == "/" && text.isDigit(mm.start - 2) { continue }
            if text[yy.end] == "/" && text.isDigit(yy.end + 1) { continue }
            let span = ScanSpan(start: mm.start, end: yy.end)
            if text.onBoundaries(span) && isNearPAN(span) {
                expiries.append(span)
                skip.formUnion([mm.start, yy.start])
            }
        }
        var found = expiries.map { ScanCandidate(category: .cvv, span: $0, isExpiry: true) }

        // (a) the first CVV-shaped group starting within 40 characters after a PAN, skipping expiry and PAN groups.
        let groupStarts = groups.map(\.start)
        for pan in pans {
            var g = sortedLowerBound(groupStarts, pan.start)
            while g < groups.count && groups[g].start < pan.end {
                skip.insert(groups[g].start)
                g += 1
            }
        }
        for pan in pans {
            var g = sortedLowerBound(groupStarts, pan.end)
            while g < groups.count && groups[g].start - pan.end <= 40 {
                let group = groups[g]
                g += 1
                if !skip.contains(group.start) && isCVVShaped(group) {
                    found.append(ScanCandidate(category: .cvv, span: group))
                    break
                }
            }
        }
        // (b) a CVV-shaped group right after a CVV keyword, near a PAN on either side.
        for group in groups where isCVVShaped(group) && cvv.before(group.start, within: 3) && isNearPAN(group) {
            found.append(ScanCandidate(category: .cvv, span: group))
        }
        return found
    }

    /// 3-4 digits; neighbours are not letters, digits or currency, nor `/ . , : -` touching another digit; not money.
    private func isCVVShaped(_ group: ScanSpan) -> Bool {
        guard group.length == 3 || group.length == 4 else { return false }
        return cvvNeighbourOK(group.start - 1, beyond: group.start - 2) && cvvNeighbourOK(group.end, beyond: group.end + 1)
            && !Self.isMoney(group, in: text)
    }

    private func cvvNeighbourOK(_ i: Int, beyond j: Int) -> Bool {
        guard let c = text[i] else { return true }
        if c.isLetter || c.isNumber || ScanText.isCurrency(c) { return false }
        if "/.,:-".contains(c) && text.isDigit(j) { return false }
        return true
    }

    /// ACCT: the first number after an account keyword, starting within 25 characters, with 6-17 digits.
    private func accountNumbers() -> [ScanCandidate] {
        accountNumberIndices().map { ScanCandidate(category: .acct, span: numbers[$0].span) }
    }

    /// Indexes into `numbers` of the ACCT candidates: for each account keyword, the first number starting within 25
    /// characters after it, with 6-17 digits, not money, date or identifier.
    private func accountNumberIndices() -> [Int] {
        let numberStarts = numbers.map(\.span.start)
        var found: [Int] = []
        for keyword in account.spans {
            let k = sortedLowerBound(numberStarts, keyword.end)
            guard k < numbers.count else { continue }
            let number = numbers[k]
            guard number.span.start - keyword.end <= 25, (6...17).contains(number.digitCount),
                  !number.isMoney, !number.isDate, !number.isIdentifier else { continue }
            found.append(k)
        }
        return found
    }

    /// OTP: 1 or 2 groups, 4-8 digits, with a code keyword within 30 characters before or after.
    private func oneTimeCodes() -> [ScanCandidate] {
        var found: [ScanCandidate] = []
        for number in numbers where number.groups.count <= 2 && (4...8).contains(number.digitCount)
            && !number.isMoney && !number.isPhone && !number.isDate {
            if otp.before(number.span.start, within: 30) || otp.after(number.span.end, within: 30) {
                found.append(ScanCandidate(category: .otp, span: number.span))
            }
        }
        return found
    }

}
