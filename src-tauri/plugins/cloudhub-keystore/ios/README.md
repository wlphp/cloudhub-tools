# CloudHub Keychain 集成

Keychain item 使用设备专属的 `AfterFirstUnlockThisDeviceOnly` 保护级别，不启用 iCloud Keychain 同步。接口只由 Rust 插件通过 Tauri 的 Swift bridge 调用，不注册 WebView 命令。
