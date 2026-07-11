import CryptoKit
import Foundation
import LocalAuthentication
import Security

enum SignerError: Error, CustomStringConvertible {
    case invalidArguments
    case invalidData
    case authentication(String)

    var description: String {
        switch self {
        case .invalidArguments: return "invalid native signer arguments"
        case .invalidData: return "invalid native signer data"
        case .authentication(let message): return message
        }
    }
}

private let keyURL: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("Project/Approval/secure-enclave-p256-v1.key")
}()

private func decode(_ value: String) throws -> Data {
    guard let data = Data(base64Encoded: value) else { throw SignerError.invalidData }
    return data
}

private func context(reason: String) -> LAContext {
    let context = LAContext()
    context.localizedReason = reason
    context.touchIDAuthenticationAllowableReuseDuration = 0
    return context
}

private func authenticate(reason: String, context: LAContext) throws {
    let semaphore = DispatchSemaphore(value: 0)
    var result = false
    var failure: Error?
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
        result = success
        failure = error
        semaphore.signal()
    }
    semaphore.wait()
    if !result { throw SignerError.authentication(failure?.localizedDescription ?? "authentication canceled") }
}

private func loadKey(reason: String) throws -> SecureEnclave.P256.Signing.PrivateKey {
    let data = try Data(contentsOf: keyURL)
    return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data, authenticationContext: context(reason: reason))
}

private func enroll(reason: String) throws {
    let auth = context(reason: reason)
    try authenticate(reason: reason, context: auth)
    if FileManager.default.fileExists(atPath: keyURL.path) { return }
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &accessError) else {
        throw accessError!.takeRetainedValue()
    }
    let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: auth)
    try FileManager.default.createDirectory(at: keyURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try key.dataRepresentation.write(to: keyURL, options: [.atomic, .completeFileProtection])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: keyURL.path)
}

private func run() throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else { throw SignerError.invalidArguments }
    switch command {
    case "enroll":
        guard arguments.count == 2 else { throw SignerError.invalidArguments }
        try enroll(reason: String(decoding: try decode(arguments[1]), as: UTF8.self))
    case "public-key":
        guard arguments.count == 1 else { throw SignerError.invalidArguments }
        let key = try loadKey(reason: "Read Project approval public key")
        print(key.publicKey.x963Representation.base64EncodedString())
    case "sign":
        guard arguments.count == 3 else { throw SignerError.invalidArguments }
		let payload = try decode(arguments[1])
        let reason = String(decoding: try decode(arguments[2]), as: UTF8.self)
        let key = try loadKey(reason: reason)
		let signature = try key.signature(for: payload)
        print(signature.derRepresentation.base64EncodedString())
    default: throw SignerError.invalidArguments
    }
}

@main
struct ProjectApprovalSigner {
    static func main() {
        do { try run() } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }
}
