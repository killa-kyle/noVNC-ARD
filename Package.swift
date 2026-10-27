// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "ARDWebAssets",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [.library(name: "ARDWebAssets", targets: ["ARDWebAssets"])],
  targets: [
    .target(name: "ARDWebAssets", resources: [.copy("Resources/Engine")]),
    .testTarget(name: "ARDWebAssetsTests", dependencies: ["ARDWebAssets"])
  ]
)
