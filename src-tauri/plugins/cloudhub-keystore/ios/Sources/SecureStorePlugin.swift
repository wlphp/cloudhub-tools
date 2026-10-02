import Foundation
import Security
import Tauri

private struct StoreKeyArgs: Decodable {
  let key: String
}

private struct BackupPathArgs: Decodable {
  let path: String
}

class SecureStorePlugin: Plugin {
  private let service = "com.cloudhub.tools.local-database-key"
  private let account = "database-key-v1"
  private let identityService = "com.cloudhub.tools.sync-identity"
  private let identityAccount = "signing-seed-v1"

  @objc public func excludeDataFromBackup(_ invoke: Invoke) throws {
    do {
      let args = try invoke.parseArgs(BackupPathArgs.self)
      let directory = URL(fileURLWithPath: args.path, isDirectory: true)
      try directory.setResourceValue(true, forKey: .isExcludedFromBackupKey)
      invoke.resolve([:])
    } catch {
      invoke.reject("无法设置本机数据备份边界")
    }
  }

  @objc public func loadKey(_ invoke: Invoke) throws {
    var query = baseQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      invoke.resolve(["key": NSNull()])
      return
    }
    guard status == errSecSuccess, let loadedData = result as? Data, loadedData.count == 32 else {
      invoke.reject("无法读取本机安全密钥；本地数据保持不变")
      return
    }
    var data = loadedData
    defer { data.resetBytes(in: 0..<data.count) }
    invoke.resolve(["key": data.base64EncodedString()])
  }

  @objc public func storeKey(_ invoke: Invoke) throws {
    do {
      let args = try invoke.parseArgs(StoreKeyArgs.self)
      guard var data = Data(base64Encoded: args.key), data.count == 32 else {
        invoke.reject("本机安全密钥格式无效")
        return
      }
      defer { data.resetBytes(in: 0..<data.count) }
      let query = baseQuery
      let update: [String: Any] = [kSecValueData as String: data]
      let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
      if status == errSecItemNotFound {
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(insert as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
      } else if status != errSecSuccess {
        throw KeychainError(status: status)
      }
      invoke.resolve([:])
    } catch {
      invoke.reject("无法保存本机安全密钥")
    }
  }

  @objc public func loadSyncIdentitySeed(_ invoke: Invoke) throws {
    var query = identityQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      invoke.resolve(["key": NSNull()])
      return
    }
    guard status == errSecSuccess, let loadedSeed = result as? Data, loadedSeed.count == 32 else {
      invoke.reject("无法读取本机同步身份密钥")
      return
    }
    var seed = loadedSeed
    defer { seed.resetBytes(in: 0..<seed.count) }
    invoke.resolve(["key": seed.base64EncodedString()])
  }

  @objc public func storeSyncIdentitySeed(_ invoke: Invoke) throws {
    do {
      let args = try invoke.parseArgs(StoreKeyArgs.self)
      guard var seed = Data(base64Encoded: args.key), seed.count == 32 else {
        invoke.reject("本机同步身份密钥格式无效")
        return
      }
      defer { seed.resetBytes(in: 0..<seed.count) }
      var insert = identityQuery
      insert[kSecValueData as String] = seed
      insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      let status = SecItemAdd(insert as CFDictionary, nil)
      guard status == errSecSuccess || status == errSecDuplicateItem else { throw KeychainError(status: status) }
      invoke.resolve([:])
    } catch {
      invoke.reject("无法保存本机同步身份密钥")
    }
  }

  private var baseQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: false,
    ]
  }

  private var identityQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: identityService,
      kSecAttrAccount as String: identityAccount,
      kSecAttrSynchronizable as String: false,
    ]
  }
}

private struct KeychainError: Error {
  let status: OSStatus
  init(status: OSStatus) { self.status = status }
}

@_cdecl("init_plugin_cloudhub_keystore")
func initPlugin() -> Plugin {
  SecureStorePlugin()
}
