/// A category of finance-sensitive value. Raw values are the names used in plan/CONTEXT.md, the event log and the API.
public enum MaskCategory: String, CaseIterable, Codable, Sendable {
    case pan = "PAN"
    case cvv = "CVV"
    case ssn = "SSN"
    case sin = "SIN"
    case aba = "ABA"
    case acct = "ACCT"
    case iban = "IBAN"
    case cusip = "CUSIP"
    case isin = "ISIN"
    case otp = "OTP"
    case secret = "SECRET"

    /// The token that replaces a value of this category in masked text, for example `[ACCT NO.]`.
    /// The full table is in slices/s02-detectors/SPEC.md.
    public var label: String {
        switch self {
        case .pan: return "[CARD NO.]"
        case .cvv: return "[CVV]"
        case .ssn: return "[SSN]"
        case .sin: return "[SIN]"
        case .aba: return "[ROUTING NO.]"
        case .acct: return "[ACCT NO.]"
        case .iban: return "[IBAN]"
        case .cusip: return "[CUSIP]"
        case .isin: return "[ISIN]"
        case .otp: return "[OTP]"
        case .secret: return "[SECRET]"
        }
    }

    /// The label for a card expiry date found next to a PAN. Expiry dates use category `.cvv`.
    public static let cardExpiryLabel = "[CARD EXP.]"
}
