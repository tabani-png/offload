/// Check-digit algorithms the detectors use to cut false positives (slices/s02-detectors/SPEC.md).
enum DetectorChecksum {
    /// Luhn (mod 10): the rightmost digit is the check digit. Cards and SINs.
    static func luhn(_ digits: [Int]) -> Bool {
        var sum = 0
        for (position, digit) in digits.reversed().enumerated() {
            if position % 2 == 1 {
                let doubled = digit * 2
                sum += doubled > 9 ? doubled - 9 : doubled
            } else {
                sum += digit
            }
        }
        return sum % 10 == 0
    }

    /// ABA routing number: weights 3-7-1 repeated, total divisible by 10.
    static func aba(_ digits: [Int]) -> Bool {
        guard digits.count == 9 else { return false }
        let weights = [3, 7, 1, 3, 7, 1, 3, 7, 1]
        return zip(digits, weights).reduce(0) { $0 + $1.0 * $1.1 } % 10 == 0
    }

    /// IBAN: move the first four characters to the end, letters become 10-35, the number mod 97 must be 1.
    static func iban(_ compact: [Character]) -> Bool {
        guard compact.count > 4 else { return false }
        var remainder = 0
        for c in compact[4...] + compact[..<4] {
            guard let value = alnumValue(c) else { return false }
            remainder = (value < 10 ? remainder * 10 + value : remainder * 100 + value) % 97
        }
        return remainder == 1
    }

    /// CUSIP: 8 characters (digits, letters 10-35), every second one doubled, digit sum, then (10 - sum mod 10) mod 10.
    static func cusip(_ token: [Character]) -> Bool {
        guard token.count == 9, let check = alnumValue(token[8]), check < 10 else { return false }
        var sum = 0
        for i in 0..<8 {
            guard var value = alnumValue(token[i]) else { return false }
            if i % 2 == 1 { value *= 2 }
            sum += value / 10 + value % 10
        }
        return (10 - sum % 10) % 10 == check
    }

    /// ISIN: letters become 10-35, written out as digits, and the whole digit string must pass Luhn.
    static func isin(_ token: [Character]) -> Bool {
        var digits: [Int] = []
        for c in token {
            guard let value = alnumValue(c) else { return false }
            if value >= 10 { digits.append(value / 10) }
            digits.append(value % 10)
        }
        return luhn(digits)
    }

    /// 0-9 for ASCII digits, 10-35 for A-Z, nil otherwise.
    static func alnumValue(_ c: Character) -> Int? {
        guard let a = c.asciiValue else { return nil }
        switch a {
        case 48...57: return Int(a) - 48
        case 65...90: return Int(a) - 55
        default: return nil
        }
    }
}
