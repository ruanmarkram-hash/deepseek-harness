import AppKit
import CoreImage

/** AppKit pairing presentation only; constructing the dialog creates no pairing or approval. */
@MainActor enum PairingCodeDialog {
  static func make(code: String, expiresAt: Date) -> NSAlert {
    let alert = NSAlert()
    alert.messageText = "Pair iPhone from anywhere"
    alert.informativeText = "Scan this QR code in DSH Mobile or enter the code below manually. It expires at \(expiresAt.formatted(date: .omitted, time: .shortened)). Approval is still required here."
    alert.accessoryView = accessory(code: code, qrImage: qrImage(code: code))
    alert.addButton(withTitle: "I’ve scanned it")
    return alert
  }

  /** The manual code remains available even when Core Image cannot render a QR code. */
  static func accessory(code: String, qrImage: NSImage?) -> NSView {
    let width: CGFloat = 360
    let manualCode = NSTextField(wrappingLabelWithString: code)
    manualCode.identifier = NSUserInterfaceItemIdentifier("pairing-manual-code")
    manualCode.isSelectable = true
    manualCode.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    manualCode.lineBreakMode = .byCharWrapping
    manualCode.maximumNumberOfLines = 0
    manualCode.cell?.usesSingleLineMode = false
    manualCode.setAccessibilityLabel("Manual pairing code")
    let textHeight = ceil(manualCode.cell!.cellSize(forBounds: NSRect(x: 0, y: 0, width: width, height: .greatestFiniteMagnitude)).height)
    manualCode.frame = NSRect(x: 0, y: 0, width: width, height: textHeight)

    let qrHeight = qrImage.map { $0.size.height + 16 } ?? 0
    let accessory = NSView(frame: NSRect(x: 0, y: 0, width: width, height: textHeight + qrHeight))
    accessory.addSubview(manualCode)
    if let qrImage {
      let qrView = NSImageView(image: qrImage)
      qrView.identifier = NSUserInterfaceItemIdentifier("pairing-qr-code")
      qrView.imageScaling = .scaleNone
      qrView.frame = NSRect(x: (width - qrImage.size.width) / 2, y: textHeight + 16, width: qrImage.size.width, height: qrImage.size.height)
      qrView.setAccessibilityLabel("Pairing QR code")
      accessory.addSubview(qrView)
    }
    // NSAlert sizes its accessory from the frame, not a stack's unconstrained fitting size.
    accessory.widthAnchor.constraint(equalToConstant: width).isActive = true
    accessory.heightAnchor.constraint(equalToConstant: accessory.frame.height).isActive = true
    return accessory
  }

  /** Integer-sized modules and an opaque four-module quiet zone remain sharp at 1x and 2x. */
  static func qrImage(code: String) -> NSImage? {
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    filter.setValue(Data(code.utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let output = filter.outputImage else { return nil }
    let paddedExtent = output.extent.insetBy(dx: -4, dy: -4)
    let scale = floor(280 / paddedExtent.width)
    guard scale >= 1 else { return nil }
    let white = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: paddedExtent)
    let padded = output.composited(over: white).cropped(to: paddedExtent)
      .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    guard let bitmap = CIContext().createCGImage(padded, from: padded.extent) else { return nil }
    return NSImage(cgImage: bitmap, size: NSSize(width: bitmap.width, height: bitmap.height))
  }
}
