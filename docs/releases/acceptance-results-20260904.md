# CloudHub Tools 验收结果（2026-09-04）

## 已通过

| 范围 | 证据 |
| --- | --- |
| 前端 | `npm run build` 通过 |
| Rust | `cargo test --manifest-path src-tauri/Cargo.toml`：22 passed；`cargo check` 通过 |
| 平台契约 | 9 domains、37 operations、113 commands、40 preview paths |
| Rust command 边界 | 123 commands 通过 |
| UI fixture | `npm run test:ui`：4 passed |
| Web API | 安全、日志、格式和资源检查通过；`node --check web-api.mjs` 通过 |
| 发布配置 | `npm run verify:release-config` 通过 |
| Windows bundle 产物 | `npm run verify:bundle-artifacts -- --platform windows`：1 NSIS、2 MSI，均非空 |
| MSI 解析 | `msiexec /a` 限定目录提取返回码 0 |
| 最新 Windows release binary | `npm run tauri build -- --no-bundle` 在 Rust 错误脱敏改动后重新执行并成功 |
| NSIS 隔离安装 | 静默安装到仓库 target 下临时目录返回码 0，应用文件与卸载器均生成 |
| 安装后启动/退出 | 安装目录中的应用启动 5 秒并取得窗口句柄，随后同一 PID 优雅退出 |
| NSIS 隔离卸载 | 临时安装目录卸载器返回码 0，目录已移除 |

## 部分通过

- `npm run tauri build -- --bundles nsis,msi` 已完成 release 编译并生成 NSIS、MSI `en-US` 和 MSI `zh-CN`。
- 构建在更新器签名阶段停止，因为当前环境没有 `TAURI_SIGNING_PRIVATE_KEY`；没有生成或伪造签名。

## 尚未验收

- 签名更新器生成、更新下载、安装、重启和失败回滚。
- NSIS/MSI 实际安装、覆盖升级、卸载、启动后 Tauri IPC 和数据目录保留。
- macOS Intel/Apple Silicon 与 Linux 安装包运行时。
- Windows/macOS/Linux 系统密钥环授权、锁定、拒绝、无桌面会话和旧 `.key` 迁移。
- 真实 SSH 主机指纹、文件操作和真实云 API 限流/取消回归。

## 执行边界

未验收项统一标记为 `blocked-by-environment` 或 `not-run`，不以源码构建、浏览器预览或脱敏 fixture 的结果替代真实桌面运行时证据。
