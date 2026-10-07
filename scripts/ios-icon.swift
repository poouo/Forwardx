import CoreGraphics
import Darwin
import Foundation
import ImageIO
import UniformTypeIdentifiers

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("iOS icon: " + message + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count == 3 else {
    fail("Usage: swift scripts/ios-icon.swift <source.png> <output.png>")
}
let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let imageSource = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
      let source = CGImageSourceCreateImageAtIndex(imageSource, 0, nil),
      source.width > 0, source.height > 0 else {
    fail("Cannot decode source logo")
}

let dimension = 1024
guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(
        data: nil, width: dimension, height: dimension,
        bitsPerComponent: 8, bytesPerRow: dimension * 4,
        space: colorSpace,
        bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.noneSkipLast.rawValue
      ) else {
    fail("Cannot create opaque RGBX drawing context")
}

// macOS cannot draw into the old 24-bit AppKit bitmap reliably.
// Use supported 32-bit RGBX storage while exporting an opaque RGB PNG.
context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
context.fill(CGRect(x: 0, y: 0, width: dimension, height: dimension))
context.interpolationQuality = .high
let scale = min(896.0 / Double(source.width), 896.0 / Double(source.height))
let width = Double(source.width) * scale
let height = Double(source.height) * scale
context.draw(source, in: CGRect(x: (1024.0 - width) / 2, y: (1024.0 - height) / 2,
                               width: width, height: height))
guard let icon = context.makeImage() else {
    fail("Cannot render icon")
}
let encoded = NSMutableData()
guard let destination = CGImageDestinationCreateWithData(encoded, UTType.png.identifier as CFString, 1, nil) else {
    fail("Cannot create PNG encoder")
}
CGImageDestinationAddImage(destination, icon, nil)
guard CGImageDestinationFinalize(destination) else {
    fail("Cannot encode PNG")
}
do {
    try (encoded as Data).write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
} catch {
    fail("Cannot write icon: " + error.localizedDescription)
}
