import CryptoKit
import Foundation
import LocalAuthentication
import Security

enum SignerError: Error, CustomStringConvertible {
    case invalidArguments
    case invalidData
    case authentication(Error?)
    case checkpointConflict
    case invalidSignature

    var description: String {
        switch self {
        case .invalidArguments: return "invalid native signer arguments"
        case .invalidData: return "invalid native signer data"
        case .authentication(let error): return error?.localizedDescription ?? "authentication canceled"
        case .checkpointConflict: return "protected checkpoint changed"
        case .invalidSignature: return "checkpoint authorization signature is invalid"
        }
    }
}

private let checkpointService = "com.dotnaos.project.approval-checkpoint.v1"

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
    if !result { throw SignerError.authentication(failure) }
}

private func isCancellation(_ error: Error) -> Bool {
    if case SignerError.authentication(let underlying) = error, let underlying {
        return isCancellation(underlying)
    }
    let value = error as NSError
    if value.domain == LAError.errorDomain,
       [LAError.userCancel, .appCancel, .systemCancel].contains(LAError.Code(rawValue: value.code)) {
        return true
    }
    if let underlying = value.userInfo[NSUnderlyingErrorKey] as? Error {
        return isCancellation(underlying)
    }
    return false
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

private func checkpointQuery(account: String) -> [CFString: Any] {
    [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: checkpointService,
        kSecAttrAccount: account,
        kSecUseDataProtectionKeychain: true,
    ]
}

private func validatedCheckpointAccount(_ account: String) throws -> String {
    let prefix = "sha256:"
    let digest = account.dropFirst(prefix.count)
    guard account.hasPrefix(prefix), digest.count == 64,
          digest.allSatisfy({ $0.isNumber || ("a"..."f").contains(String($0)) }) else {
        throw SignerError.invalidData
    }
    return account
}

private func validateCheckpointBinding(payload: Data, account: String, next: Data) throws {
    guard let payloadObject = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
          let anchorObject = try JSONSerialization.jsonObject(with: next) as? [String: Any],
          let repository = payloadObject["repository"] as? String,
          let policy = payloadObject["policyId"] as? String,
          let scope = payloadObject["scopeId"] as? String else {
        throw SignerError.invalidData
    }
    let identity = repository + "\0" + policy + "\0" + scope
    let expectedAccount = "sha256:" + SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    let payloadDigest = "sha256:" + SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
    guard account == expectedAccount,
          anchorObject["payloadDigest"] as? String == payloadDigest,
          anchorObject["repository"] as? String == repository,
          anchorObject["policyId"] as? String == policy,
          anchorObject["scopeId"] as? String == scope,
          anchorObject["policyDigest"] as? String == payloadObject["policyDigest"] as? String,
          anchorObject["signerId"] as? String == payloadObject["signerId"] as? String,
          anchorObject["operation"] as? String == payloadObject["operation"] as? String,
          anchorObject["contentDigest"] as? String == payloadObject["contentDigest"] as? String,
          anchorObject["sequence"] as? NSNumber == payloadObject["sequence"] as? NSNumber,
          (anchorObject["previousEventDigest"] as? String ?? "") == (payloadObject["previousEventDigest"] as? String ?? "") else {
        throw SignerError.invalidData
    }
}

private func readCheckpoint(account: String) throws -> Data? {
    var query = checkpointQuery(account: account)
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }
    return data
}

private func writeCheckpoint(account: String, expected: Data?, next: Data) throws {
    let current = try readCheckpoint(account: account)
    guard current == expected else { throw SignerError.checkpointConflict }
    let query = checkpointQuery(account: account)
    if current == nil {
        var attributes = query
        attributes[kSecValueData] = next
        attributes[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    } else {
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData: next] as CFDictionary)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }
}

private func commitCheckpoint(payload: Data, signatureData: Data, account: String, expected: Data?, next: Data) throws {
    try validateCheckpointBinding(payload: payload, account: account, next: next)
    let key = try loadKey(reason: "Verify Project approval checkpoint authorization")
    let signature = try P256.Signing.ECDSASignature(derRepresentation: signatureData)
    guard key.publicKey.isValidSignature(signature, for: payload) else {
        throw SignerError.invalidSignature
    }
    try writeCheckpoint(account: account, expected: expected, next: next)
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
    case "checkpoint-read":
        guard arguments.count == 2 else { throw SignerError.invalidArguments }
        let account = try validatedCheckpointAccount(String(decoding: try decode(arguments[1]), as: UTF8.self))
        if let value = try readCheckpoint(account: account) {
            print(value.base64EncodedString())
        } else {
            print("MISSING")
        }
    case "checkpoint-commit":
        guard arguments.count == 6 else { throw SignerError.invalidArguments }
        let payload = try decode(arguments[1])
        let signature = try decode(arguments[2])
        let account = try validatedCheckpointAccount(String(decoding: try decode(arguments[3]), as: UTF8.self))
        let expected = arguments[4] == "-" ? nil : try decode(arguments[4])
        let next = try decode(arguments[5])
        try commitCheckpoint(payload: payload, signatureData: signature, account: account, expected: expected, next: next)
    default: throw SignerError.invalidArguments
    }
}

@main
struct ProjectApprovalSigner {
    static func main() {
        do { try run() } catch {
            if isCancellation(error) {
                FileHandle.standardError.write(Data("PROJECT_AUTHENTICATION_CANCELED\n".utf8))
                exit(2)
            }
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }
}
