# CloudHub Android 更新

插件仅在 Android 注册。检查固定 GitHub 仓库的最新稳定 Release，下载 ARM64 APK 到应用私有缓存，并通过系统安装器完成升级。

- 仅接受当前仓库、对应版本的固定 APK 名称及 HTTPS 下载地址。
- 下载支持取消，校验 Release 资产大小及 SHA-256；失败移除未完成文件。
- 安装前检查包名、版本名称、递增版本号和与当前应用一致的签名证书。
- 使用独立 FileProvider，只共享更新缓存目录；安装权限由用户在系统设置中授予。
- 不支持静默安装。iOS 使用已有版本检查界面及签名渠道，不调用此插件。

发布的 APK 必须使用与已安装应用相同的签名，并保留名称 `CloudHub.Tools_<version>_android_arm64.apk`。GitHub 必须返回该资产的 `sha256:` 摘要，否则更新只展示发布页。
