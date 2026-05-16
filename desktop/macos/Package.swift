// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "ProjectSpaceDesktop",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "project_spaceApp", targets: ["project_spaceApp"])
  ],
  targets: [
    .executableTarget(
      name: "project_spaceApp",
      resources: [.process("Resources")],
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("WebKit")
      ]
    )
  ]
)
