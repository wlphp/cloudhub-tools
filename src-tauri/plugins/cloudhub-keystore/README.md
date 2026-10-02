# CloudHub 移动端密钥库插件

插件只供 Rust 内部调用，不注册可由 WebView 调用的 Tauri 命令。

- Android 以 Android Keystore 生成的 AES-256-GCM 非导出密钥包装 32 字节数据库密钥；包装后的密文通过 `AtomicFile` 保存在 `noBackupFilesDir`，不随 Android Auto Backup 或设备迁移复制。
- iOS 将 32 字节数据库密钥保存在 Keychain，使用 `AfterFirstUnlockThisDeviceOnly`，并禁用 Keychain 同步。
- Rust 启动时先读取系统安全存储；首次升级时从旧 `.key` 迁移，成功写入并回读校验后才删除旧文件。
- 系统密钥丢失、数据库存在但密钥缺失、旧密钥与系统密钥冲突时均停止访问数据库，不生成替代密钥覆盖数据。
- Android 最低版本为 API 24（与移动 App 配置一致）。Android Keystore 是否由硬件安全模块保护取决于设备厂商和机型；本插件不要求生物识别。

换机通过 CloudHub 的显式口令加密迁移包完成，系统密钥不跨设备复制。
