import Foundation
public enum ARDWebAssets {
  public static let upstreamRevision = "d699293635083c9e0c30c8f9480993865653772a"
  public static let noVNCRevision = "8e1ebdffba02e651c399dacef841f8941f6ad6e4"
  public static var directoryURL: URL {
    Bundle.module.url(forResource: "Engine", withExtension: nil)!
  }
  public static var bundleURL: URL { directoryURL }
  public static var indexURL: URL { directoryURL.appendingPathComponent("index.html") }
}
