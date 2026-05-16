import AppKit
import Foundation
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow?
  private var backend: Process?

  func applicationDidFinishLaunching(_ notification: Notification) {
    startBackend()

    let configuration = WKWebViewConfiguration()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    let webView = WKWebView(frame: .zero, configuration: configuration)
    let url = URL(string: ProcessInfo.processInfo.environment["PROJECT_SPACE_APP_BASE_URL"] ?? "http://127.0.0.1:4173")!
    webView.load(URLRequest(url: url))

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Project Space"
    window.titlebarAppearsTransparent = true
    window.backgroundColor = NSColor(red: 0.027, green: 0.067, blue: 0.118, alpha: 1)
    window.center()
    window.contentView = webView
    window.makeKeyAndOrderFront(nil)
    self.window = window
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationWillTerminate(_ notification: Notification) {
    backend?.terminate()
  }

  private func startBackend() {
    let bundle = Bundle.main.bundleURL
    let candidate = bundle
      .appendingPathComponent("Contents")
      .appendingPathComponent("Resources")
      .appendingPathComponent("project-space")

    guard FileManager.default.isExecutableFile(atPath: candidate.path) else {
      return
    }

    let process = Process()
    process.executableURL = candidate
    process.arguments = ["serve"]
    process.currentDirectoryURL = bundle
      .appendingPathComponent("Contents")
      .appendingPathComponent("Resources")
    try? process.run()
    backend = process
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
