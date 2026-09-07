# CloudHub Tools 桌面运行时验收清单

## 目的

这份清单用于步骤 7 的打包后验收。源码构建、静态门禁和无凭据 UI fixture 通过，并不等价于安装包、Tauri IPC、更新器或跨平台凭据存储已经通过。

## 执行前提

- 从待发布 tag 构建，确认 `package.json` 与 `src-tauri/tauri.conf.json` 版本一致。
- 执行 `npm ci`、`npx playwright install chromium` 和 `npm run verify:release-config`。
- 不把云密钥、SSH 密码、私钥、更新器签名私钥或真实厂商响应写入仓库、测试输出或截图。
- Windows 验收机安装 WiX/NSIS；macOS 使用 Intel 与 Apple Silicon 各一台；Linux 使用目标发行版。
- 发布 workflow 必须在编译前确认 `TAURI_SIGNING_PRIVATE_KEY` 已注入；检查只判断是否为空，不得输出 Secret 内容。

## 自动化前置证据

- `npm run build`
- `npm run verify:platform-contracts`
- `npm run verify:rust-boundary`
- `node scripts/verify-web-api-security.mjs`
- `node scripts/verify-web-api-logs.mjs`
- `npm run test:ui`
- `node --check web-api.mjs`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml`

每项记录命令、提交 SHA、平台、运行时间和结果；失败时保留脱敏错误摘要。

## 安装包矩阵

| 平台 | 包型 | 必须验证 |
| --- | --- | --- |
| Windows x64 | NSIS、MSI | 安装、升级覆盖安装、卸载、启动、数据目录保留、快捷方式；两种安装包都必须产出并使用 CI 签名 |
| macOS Intel | app、dmg | 打开、权限提示、升级、卸载/移除、数据目录保留 |
| macOS Apple Silicon | app、dmg | 同上，并确认架构与签名匹配 |
| Linux x64 | Tauri 目标包 | 安装、启动、数据目录权限、升级路径 |

## 功能验收

1. 启动后通过 Tauri IPC 加载账号、日志、偏好和本地资产；浏览器预览不得被误当作桌面运行结果。
2. 新建测试账号并确认 Secret 只在本机加密存储，日志和错误提示不显示 Secret、密文或完整厂商响应。
3. 导入/迁移一个旧版本测试数据库，验证成功迁移、失败回滚和备份恢复。
4. 使用脱敏测试账号验证 DNS、OSS、资源同步、取消、瞬态重试和重复同步冲突。
5. 使用专用测试主机验证 SSH 主机指纹、路径约束、上传/下载/删除确认、终端分离窗口和断开清理。
6. 在没有 Tauri 的浏览器预览中验证桌面专属操作返回 `unsupported-in-preview`，不得显示成功提示。
7. 使用签名更新包验证更新器检查、下载、安装、重启和失败回滚；更新包签名私钥只从 CI Secret 注入。

## 密钥环迁移验收

- Windows、macOS、Linux 分别验证首次写入、读取、用户拒绝授权、密钥环锁定、无桌面会话和应用重启。
- 旧 `.key` + AES-256-GCM 数据必须可读；迁移中断后可重试，不得删除旧数据或产生明文备份。
- 密钥环不可用时，按产品决策验证安全降级提示；不得静默把凭据写入日志、普通配置或临时文件。
- 验收完成前不引入“迁移后删除旧 `.key`”行为。

## 结果记录

每个平台单独记录：构建版本、包路径、安装/升级结果、关键功能结果、失败原因和后续责任人。任何未执行项标记为 `blocked-by-environment` 或 `not-run`，不能标记为 `passed`。

Windows 发布 workflow 在 Tauri action 完成构建/上传后执行 `npm run verify:bundle-artifacts -- --platform windows`，审计当前工作区至少有 1 个 NSIS 安装包和 2 个 MSI 语言包，且文件大小大于 0。由于 Tauri action 在同一步上传，该检查属于上传后审计，不替代签名验证和安装运行验证。
