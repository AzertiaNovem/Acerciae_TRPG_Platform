// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "AcerciaeCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "AcerciaeCore", targets: ["AcerciaeCore"])],
    targets: [
        .target(name: "AcerciaeCore"),
        .testTarget(name: "AcerciaeCoreTests", dependencies: ["AcerciaeCore"])
    ]
)
