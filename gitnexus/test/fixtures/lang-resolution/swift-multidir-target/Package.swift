// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "MultiDirTarget",
    targets: [
        .target(name: "Alpha"),
        .target(name: "Beta"),
    ]
)
