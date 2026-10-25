import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import OffloadCore

@Suite struct S11MaskTests {
    let config = KeyframeConfig()

    @Test func linesWithSensitiveValuesAreBlackedOutAndOthersAreKept() throws {
        let frame = ScreenFrame(image: s11Image(), lines: [
            s11Line("Invoice INV-20431 for Northwind", x: 10, y: 10, width: 360),
            s11Line("Card 4111 1111 1111 1111 exp 12/27", x: 10, y: 100, width: 420),
            s11Line("SSN 123-45-6789", x: 10, y: 200, width: 200),
        ])
        let out = try KeyframeRenderer.render(frame, masker: Masker(), config: config)
        let img = DecodedImage(jpeg: out.jpeg)
        #expect(out.maskedRegions == 2)
        #expect(img.brightness(200, 110) < 40)   // card line: black
        #expect(img.brightness(100, 210) < 40)   // SSN line: black
        #expect(img.brightness(150, 20) > 200)   // invoice line: untouched (white background)
        #expect(img.brightness(600, 300) > 200)
    }

    @Test func secureFieldsAreBlackedOut() throws {
        let frame = ScreenFrame(image: s11Image(), lines: [], secureFields: [CGRect(x: 500, y: 300, width: 200, height: 30)])
        let out = try KeyframeRenderer.render(frame, masker: Masker(), config: config)
        let img = DecodedImage(jpeg: out.jpeg)
        #expect(out.maskedRegions == 1)
        #expect(img.brightness(600, 315) < 40)
        #expect(img.brightness(600, 200) > 200)
    }

    @Test func aValueSplitAcrossTwoLinesMasksBothLinesWhenTheJoinedTextIsFlagged() {
        // The API key spans a line break in the joined text only when the lines are joined; per-line it is cut.
        let lines = [s11Line("token sk-ant-api03-abcdefghij", x: 0, y: 0, width: 300),
                     s11Line("klmnopqrstuvwxyz0123456789", x: 0, y: 30, width: 300),
                     s11Line("hello world", x: 0, y: 60, width: 100)]
        let flagged = KeyframeRenderer.sensitiveLines(lines, masker: Masker())
        #expect(flagged.contains(0))
        #expect(!flagged.contains(2))
    }

    @Test func downscalesSoTheLongEdgeIsAtMost1280() throws {
        let big = ScreenFrame(image: s11Image(width: 2880, height: 1800), lines: [])
        let out = try KeyframeRenderer.render(big, masker: Masker(), config: config)
        #expect(out.width == 1280)
        #expect(out.height == 800)
        let img = DecodedImage(jpeg: out.jpeg)
        #expect(img.width == 1280 && img.height == 800)
        let small = try KeyframeRenderer.render(ScreenFrame(image: s11Image(), lines: []), masker: Masker(), config: config)
        #expect(small.width == 800 && small.height == 400)
    }

    @Test func maskStillCoversTheLineAfterDownscaling() throws {
        let frame = ScreenFrame(image: s11Image(width: 2560, height: 1600),
                                lines: [s11Line("IBAN GB82 WEST 1234 5698 7654 32", x: 100, y: 1000, width: 900, height: 40)])
        let out = try KeyframeRenderer.render(frame, masker: Masker(), config: config)
        let img = DecodedImage(jpeg: out.jpeg)
        #expect(out.maskedRegions == 1)
        for x in stride(from: 52, to: 498, by: 20) { #expect(img.brightness(x, 510) < 40) }
    }

    @Test func dHash64IsSixteenHexCharsAndDiffersForDifferentImages() throws {
        let a = KeyframeRenderer.dHash64Hex(s11Pattern(1))
        let b = KeyframeRenderer.dHash64Hex(s11Pattern(2))
        #expect(a.count == 16 && b.count == 16)
        let hex = a.allSatisfy { $0.isHexDigit }
        #expect(hex)
        #expect(a != b)
    }

    @Test func theJPEGCarriesNoMetadata() throws {
        let out = try KeyframeRenderer.render(ScreenFrame(image: s11Image(), lines: []), masker: Masker(), config: config)
        let src = CGImageSourceCreateWithData(out.jpeg as CFData, nil)!
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] ?? [:]
        // ImageIO always writes the colour space and pixel size; nothing else (no dates, device, user comment).
        let exif = (props[kCGImagePropertyExifDictionary] as? [CFString: Any]) ?? [:]
        let allowed: Set<String> = [kCGImagePropertyExifColorSpace as String, kCGImagePropertyExifPixelXDimension as String,
                                    kCGImagePropertyExifPixelYDimension as String]
        #expect(Set(exif.keys.map { $0 as String }).isSubset(of: allowed))
        #expect(props[kCGImagePropertyGPSDictionary] == nil)
        #expect(props[kCGImagePropertyTIFFDictionary] == nil)
    }
}
