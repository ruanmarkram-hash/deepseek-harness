import AppKit
import CoreImage
import Testing
@testable import RemoteHostApp

private let previewCode = "dsh3." + String(repeating: "a", count: 32) + "." + String(repeating: "b", count: 43)

@Test("pairing accessory fits the laid-out NSAlert and shows the complete selectable code")
@MainActor func pairingDialogFitsAlert() throws {
  _ = NSApplication.shared
  let alert = PairingCodeDialog.make(code: previewCode, expiresAt: Date(timeIntervalSince1970: 0))
  alert.layout()
  alert.window.contentView?.layoutSubtreeIfNeeded()
  let accessory = try #require(alert.accessoryView)
  let content = try #require(alert.window.contentView)
  #expect(content.bounds.contains(accessory.convert(accessory.bounds, to: content)))
  let manual = try #require(accessory.subviews.compactMap { $0 as? NSTextField }.first)
  #expect(manual.stringValue == previewCode)
  #expect(manual.isSelectable && !manual.isEditable)
  #expect(manual.lineBreakMode == .byCharWrapping)
  #expect(manual.frame.height > 24)
  for child in accessory.subviews {
    #expect(accessory.bounds.contains(child.frame))
  }
  let qr = try #require(accessory.subviews.compactMap { $0 as? NSImageView }.first)
  #expect(qr.frame.minY >= manual.frame.maxY + 16)
  #expect(qr.frame.size == qr.image?.size)
  #expect(qr.frame.width <= 280)
}

@Test("pairing QR decodes to the complete manual code with an opaque white quiet zone")
@MainActor func pairingQRRoundTrips() throws {
  let image = try #require(PairingCodeDialog.qrImage(code: previewCode))
  let bitmap = try #require(image.cgImage(forProposedRect: nil, context: nil, hints: nil))
  let detector = try #require(CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(), options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]))
  let features = detector.features(in: CIImage(cgImage: bitmap))
  #expect((features.first as? CIQRCodeFeature)?.messageString == previewCode)
  let pixels = NSBitmapImageRep(cgImage: bitmap)
  for x in [0, bitmap.width - 1] {
    for y in 0..<bitmap.height {
      let color = try #require(pixels.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB))
      #expect(color.redComponent == 1 && color.greenComponent == 1 && color.blueComponent == 1 && color.alphaComponent == 1)
    }
  }
}

@Test("pairing manual code remains visible without a QR renderer")
@MainActor func pairingManualFallback() throws {
  let accessory = PairingCodeDialog.accessory(code: previewCode, qrImage: nil)
  let manual = try #require(accessory.subviews.first as? NSTextField)
  #expect(manual.stringValue == previewCode)
  #expect(accessory.bounds.contains(manual.frame))
  #expect(accessory.frame.height == manual.frame.height)
}
