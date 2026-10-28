import XCTest
import CryptoKit
@testable import ARDWebAssets

final class ARDWebAssetsTests: XCTestCase {
  func testOfflineStaticImportGraphAndLicenseResources() throws {
    let root = ARDWebAssets.bundleURL
    XCTAssertEqual(ARDWebAssets.indexURL.lastPathComponent, "index.html")
    XCTAssertTrue(FileManager.default.fileExists(atPath: ARDWebAssets.indexURL.path))
    for path in ["LICENSE.noVNC-ARD", "noVNC/LICENSE.txt", "noVNC/vendor/pako/LICENSE"] {
      XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(path).path), path)
    }
    let pattern = #"(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]"#
    let regex = try NSRegularExpression(pattern: pattern)
    var queue = [root.appendingPathComponent("bootstrap.js")]
    var visited: Set<URL> = []
    while !queue.isEmpty {
      let file = queue.removeFirst().standardizedFileURL
      guard visited.insert(file).inserted else { continue }
      XCTAssertTrue(file.path.hasPrefix(root.path + "/"))
      let source = try String(contentsOf: file, encoding: .utf8)
      for match in regex.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
        let capture = match.range(at: 1).location == NSNotFound ? 2 : 1
        let range = Range(match.range(at: capture), in: source)!
        let relative = String(source[range])
        XCTAssertTrue(relative.hasPrefix("."), "Unexpected external module: \(relative)")
        let target = file.deletingLastPathComponent().appendingPathComponent(relative).standardizedFileURL
        XCTAssertTrue(FileManager.default.fileExists(atPath: target.path), "Missing import \(target.path)")
        queue.append(target)
      }
    }
    XCTAssertGreaterThan(visited.count, 50)
    let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!
    for case let file as URL in files {
      XCTAssertNotEqual(file.pathExtension, "wasm")
      XCTAssertFalse(file.path.contains("/relay/"))
      XCTAssertFalse(file.path.contains("/vendor/libav/"))
    }
  }

  func testNativeBridgeEntryPointsAndSafeAssetPolicyArePackaged() throws {
    let source = try String(contentsOf: ARDWebAssets.bundleURL.appendingPathComponent("bootstrap.js"), encoding: .utf8)
    for name in ["connect", "opened", "receive", "ack", "transportClosed", "disconnect", "credentials", "trust", "key", "pointer", "type", "clipboard", "curtain", "selectSession", "selectDisplay", "observe", "quality", "performance"] {
      XCTAssertTrue(source.contains("    \(name)("), name)
    }
    XCTAssertTrue(source.contains("_ardHpAllowed = false"))
    XCTAssertTrue(source.contains("_ardGetCachedRSAKey = () => null"))
    let html = try String(contentsOf: ARDWebAssets.indexURL, encoding: .utf8)
    XCTAssertTrue(html.contains("connect-src 'none'"))
    XCTAssertTrue(html.contains("<script src=\"bootstrap.bundle.js\"></script>"))
    XCTAssertFalse(html.contains("type=\"module\""))
    let bundle = try Data(contentsOf: ARDWebAssets.bundleURL.appendingPathComponent("bootstrap.bundle.js"))
    let digest = SHA256.hash(data: bundle).map { String(format: "%02x", $0) }.joined()
    let expected = try String(contentsOf: ARDWebAssets.bundleURL.appendingPathComponent("bootstrap.bundle.sha256"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    XCTAssertEqual(digest, expected)
    let compiled = String(decoding: bundle, as: UTF8.self)
    XCTAssertTrue(compiled.contains("window.KyleARD"))
    XCTAssertTrue(compiled.contains("Mozilla Public License") || compiled.contains("MPL-2.0"))
    XCTAssertTrue(compiled.contains("Copyright (C) 2014-2016 by Vitaly Puzrin"))
  }
}
