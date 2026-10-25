/// One sensitive value found in a text. It never stores the value itself, only where it is.
public struct Detection: Hashable, Sendable {
    /// What kind of value this is.
    public let category: MaskCategory
    /// Where the value is in the scanned text: first to last character of the value, no surrounding space or punctuation.
    public let range: Range<String.Index>
    /// The token that replaces the value in masked text. `category.label`, except card expiry dates.
    public let label: String

    public init(category: MaskCategory, range: Range<String.Index>, label: String? = nil) {
        self.category = category
        self.range = range
        self.label = label ?? category.label
    }
}
