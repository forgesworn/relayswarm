// swift-tools-version: 5.9
// The RelaySwarm core for Swift. Run `npm run build:ffi:apple` from the
// repository root first: it builds relayswarm_ffiFFI.xcframework here and
// writes the generated bindings into Sources/RelaySwarmCore.
import PackageDescription

let package = Package(
    name: "RelaySwarmCore",
    platforms: [.macOS(.v14), .iOS(.v16)],
    products: [.library(name: "RelaySwarmCore", targets: ["RelaySwarmCore"])],
    targets: [
        .binaryTarget(name: "relayswarm_ffiFFI", path: "relayswarm_ffiFFI.xcframework"),
        .target(name: "RelaySwarmCore", dependencies: ["relayswarm_ffiFFI"]),
    ]
)
