// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "Probe", targets: [.target(name: "Vendor"), .executableTarget(name: "App", dependencies: ["Vendor"])])
