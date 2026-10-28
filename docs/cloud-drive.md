# 云盘挂载（Windows x64）

入口：软件商店 → 云盘挂载。第一版面向阿里云 OSS 和通用 S3；其他厂商为兼容配置模板，不能据此认定已完成厂商实测。浏览器、手机和 macOS 当前不提供系统挂载。

## 使用

1. 点击“下载挂载引擎”。主安装包不携带 rclone；按需下载官方固定版本并校验 SHA-256。本机 PATH 中已有的 rclone 也可复用，但需兼容所用接口。
2. 如未检测到 WinFsp，通过“官方安装页面”安装驱动，再刷新。驱动可能需要管理员权限或重启。
3. 新增连接，填写 HTTPS Endpoint、区域、桶名、访问凭据，选择空闲盘符或尚不存在的本机挂载目录。目录的父目录须已存在。Access Key ID 直接显示并可编辑；Secret Access Key 默认隐藏，点击小眼睛可查看输入值或已保存密钥。仅查看已保存密钥不会改变表单内容，隐藏或关闭弹窗后结束显示；凭据仍在本机加密保存。
4. 默认只读。保存后先测试连接，再挂载。“查看存储桶/子目录”可选择条目，随后需要明确保存配置才生效；无列举全部桶权限时可直接填写已授权桶名。
5. 读写挂载中，保存先进入缓存，随后上传。关闭使用磁盘的程序，等待队列、上传和失败数归零后，选择“安全卸载”。

正常退出应用会检查挂载和恢复记录；使用应用已有的托盘模式时，关闭窗口可以保持后台运行。自动挂载指 CloudHub 启动时挂载，不修改 Windows 登录启动设置。

编辑连接时，密钥留空保留原值。修改服务商或 Endpoint 后，保存会展示新目标，请确认后沿用已保存凭据，无需再次输入或查看密钥；取消确认保留表单。若修改 Access Key ID，必须填写配套的新密钥，旧 Session Token 不会自动配给新 ID。勾选清除令牌可移除旧 Session Token。

## 缓存和恢复

连接编辑器中的存储桶位于 AK 凭据之后。点击“读取存储桶”使用当前表单凭据，无需先填写桶名、连接名称或保存配置；读取后从列表选择，再明确保存才生效。无列桶权限或返回空列表时可手动填写桶名。切换凭据、服务商、Endpoint、区域或寻址方式会清空旧列表并保留填写的桶名。已有密钥无需先显示即可读取；修改服务地址后复用旧密钥读取须再次确认。桶所在地域仍须与 Endpoint 一致，不会因选桶而自动更换服务地址。

- 每个连接有独立缓存。空间配置是清理目标，不能保证硬性上限；未上传或正在使用的文件不会被随意清理。
- 缓存含明文文件内容。敏感资料应放在受系统磁盘加密保护的可信本机目录。
- 异常退出后保留原连接和缓存，点击“恢复挂载”。进程身份或状态无法确认时禁止重复启动挂载。
- 临时凭据过期导致无法上传时，先关闭使用磁盘的全部程序并保存文件，再选择“保留缓存停止”。此时待上传文件尚未备份到云端。停止完成后用“更新凭据”填写相同存储空间的有效凭据，再恢复挂载，等待上传完成。
- 更新凭据不会改变桶、目录、挂载点或缓存。普通配置编辑和删除在挂载/恢复期间禁用。
- “清理已停止记录”只接受进程已退出且没有未上传修改的记录；不删除本地缓存或云端对象。

对象存储通过文件系统呈现，仍有网络延迟、对象覆盖、文件锁及空目录等语义差异。不建议存放数据库、虚拟机或直接安装软件。读写挂载中的删除和覆盖会作用于云端，建议桶开启版本控制。公网读取、请求和归档恢复等费用由存储服务计费。

## 实现与验证边界

- React 复用软件商店容器、SharedDialog 与 ConfirmDialog。
- 原生调用位于 `src-tauri/src/commands/cloud_drive/`，凭据和恢复日志使用项目既有加密 SQLite。通用设置读写与便携导出排除该保留命名空间。
- “已挂载”同时要求认证进程匹配、目标出现在引擎挂载列表中，以及缓存状态可读取；只有文件缓存存活不会被视为磁盘仍挂载。无法读取或解析缓存元数据时阻止普通卸载。
- 子进程使用独立环境配置和本地认证控制接口，访问凭据不进入命令参数或日志。不提供浏览器 API 挂载替代。
- 错误边界仅允许固定、由程序撰写的诊断，其他底层错误仍通过项目通用脱敏处理。
- 测试连接使用独立只读进程，不排队等待挂载操作；限制低层重试和检查时间。盘符占用检查读取 Windows 盘符表，不访问可能失联的虚拟盘目录；目录挂载点检查在后台执行，5 秒超时保留原记录。挂载请求超时只表示结果未确认，不会删除缓存或强杀引擎。

验证命令：

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib cloud_drive -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib encrypted_drive_configuration_never_enters_generic_preferences
npx playwright test tests/ui/cloud-drive.spec.ts --workers=2
npm run verify:platform-contracts
npm run verify:rust-boundary
```

显式运行联网引擎集成测试（下载官方引擎到开发数据目录，不安装驱动、不连接真实账户）：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib cloud_drive_download_and_real_engine_cache_roundtrip -- --ignored --nocapture
```

该测试使用本地临时目录和 WebDAV 文件接口，覆盖真实引擎的认证控制、中文文件读写、延迟上传，以及有待上传缓存时正常停止后重启继续上传。它不能替代 WinFsp 系统盘符和实际 OSS/S3 验收。

已安装 WinFsp 时，可运行生产 rcd 启动参数与 RC 挂载请求的原生回归（仅使用临时本地目录，不连接真实账户）：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib real_rcd_and_native_mount_roundtrip -- --include-ignored --nocapture
```

该测试覆盖 WinFsp 目录挂载、中文文件读取、full 缓存延迟回写、只读拒写及卸载。VFS 参数通过 `mount/mount` 的 `vfsOpt` 传递，不能作为 `rcd` 的命令行参数。

无响应网络的连接测试回归（假凭据，仅访问本机临时 TLS 端口）：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib real_probe_returns_when_tls_peer_stalls -- --include-ignored --nocapture
```

仍需逐项实机验收：盘符挂载、实际 OSS/S3 读写、多连接独立挂载、打开文件时卸载行为、上传中卸载阻止、断网恢复、凭据过期修复、应用退出保护与启动自动挂载。真实云端操作应使用专用测试桶和最小权限凭据，在本机界面填写；不得将凭据写入任务记录或测试代码。
