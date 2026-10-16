# 软件商店指纹浏览器

本功能按三个阶段推进：独立浏览器环境、基础环境参数、经过审核的深层指纹内核。推荐使用 Google Chrome for Testing；用户确认后，另提供 Clearcote 150 可选实验内核及经过验证的种子/硬件参数。**不宣称具有完整的硬件指纹修改能力**。

## 当前实现

- 软件商店中进入“指纹浏览器”；管理界面懒加载。
- Windows x64 原生端支持环境创建、编辑、批量打开和关闭、搜索、分组移动、标签和备注。
- 每个环境使用 UUID 对应的独立 Chromium 资料目录；重复启动、运行时编辑和删除受保护。
- 回收站保留资料，可恢复。永久删除必须输入完整环境名称，并限定在应用浏览器目录内。
- HTTP、HTTPS/TLS、SOCKS5 上游代理及认证通过本机临时通道处理。HTTPS 上游校验证书；凭据使用既有本地加密存储，不放进启动参数。
- 通过明确点击访问 ipify 检查所选连接的出口 IP；结果仅在当前界面保留。检测不会自动直连兜底。
- 语言、时区、窗口尺寸、自定义地理位置。默认禁用地理位置权限；自定义位置仍由网站询问授权。
- 正式浏览器保持沙箱启用。QUIC 关闭，WebRTC 限制非代理 UDP；尚不能据此宣称所有网络指纹无泄漏。
- 打开的环境可以通过原生文件选择器导入 JSON / Netscape Cookie、导出 JSON Cookie。Cookie 内容不进入 React、日志或报错；导出文件是敏感登录资料。
- 应用正常退出时请求浏览器保存并关闭；Windows Job 管理子进程，持有者消失时清理。遗留进程按 PID、创建时间和准确程序路径联合识别，再允许关闭恢复。环境锁和内核读写锁避免多个 CloudHub 进程同时修改资料或卸载正在使用的内核。
- 浏览器预览及手机端不执行本机下载、进程和资料操作。当前 macOS、Linux 桌面也明确显示暂不支持。

## 下载及包体

仓库及 CloudHub 安装资源不包含 Chrome、Chromium ZIP、Node.js 或自动化运行时。浏览器首次使用前由用户主动下载；各环境共享内核。

受信目录当前包含两个独立安装的 Google Chrome for Testing Windows x64 版本。推荐版本 `155.0.8059.84`：

- 官方地址：`https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.84/win64/chrome-win64.zip`
- 压缩包大小：`206114888` 字节，约 196.6 MiB。
- SHA-256：`507f2a031441d10c62b5e3d4e863f09ac1198a571c1419976cbd8387f639afde`
- 该哈希来自 2026-10-16 经 HTTPS 实际下载的官方 ZIP，已通过解压专项测试。

兼容测试版本 `155.0.8059.79`：官方同目录下的对应版本 ZIP，`207516446` 字节；SHA-256 为 `4966d9df2c8ed9be606ff0fc8877b2e800def164fbad63fed6a1d93222ad9dbf`。两份实际下载文件均已校验并通过解压测试。可为新环境选择版本，分别安装和卸载，不覆盖其他版本。

可选实验版 `clearcote-150.0.7871.114`：来自 Clearcote 官方 GitHub Release `v0.1.0-pre.23`；ZIP `245936073` 字节（约 234.5 MiB），解压约 658.7 MiB；SHA-256 为 `93fc03c45b931d8d82f714814318892929f44dd671b0993788332071d53f3135`，exe 另有固定哈希校验。该版本落后于推荐内核，明确用于实验测试。支持固定种子、Canvas 噪声开关、CPU 核数及内存；GPU 保留真实值，其他深层开关未开放。许可证与实测见 [实验内核记录](browser-fingerprint-evaluation.md)。

目录结构（相对于应用数据目录，开发环境与正式环境分离）：

```text
browser/
  locks/                         环境和内核的跨进程锁
  kernels/<版本>-win64/          共用内核、原始许可证及校验记录
  environments/<环境 UUID>/     独立 Chromium 用户资料
```

安装先写独立临时目录，限制压缩包及解压大小，拒绝目录穿越和符号链接，通过校验后再重命名到最终版本目录。用户可以取消、重试、导入同版本官方离线包，以及卸载内核并保留全部环境资料。

当前使用**随应用审核发布的固定目录及哈希**，不接受远程可任意修改的下载地址、哈希或启动参数。后续若引入独立在线版本清单，需要先实现签名验证、签名密钥轮换和回退约束，不能仅靠同一远程来源提供的哈希。

已使用环境固定内核版本，不允许直接切换旧内核打开已迁移资料。即使启动失败而没有写入成功时间，只要已有 Chromium 初始化资料或进程记录，也禁止换版本。新增版本必须保留原版本及其资料隔离，并通过兼容性验证后开放选择。

## 执行层与安全边界

| 层 | 职责 |
| --- | --- |
| `src/features/plugins/BrowserEnvironments.tsx` | 环境、配置、内核管理及明确操作反馈，复用公共弹层 |
| `src/platform/clients/browser.ts` | 类型与 nativeOnly 调用 |
| `src-tauri/src/commands/browser.rs` | 原生操作入口、文件选择、操作串行化 |
| `src-tauri/src/core/browser/` | 模型、校验、内核、代理、CDP 与进程管理 |
| SQLite schema 37 | 环境元数据及加密代理密码，不加入账号同步 |
| `web-api.mjs` | 无浏览器执行接口，预览显示不支持 |

浏览器控制通道使用 `127.0.0.1` 随机端口和浏览器生成的私有路径，校验 WebSocket 握手；不开放到局域网，也不将端口、路径及任意 CDP 接口交给 React。当前尚未使用调试管道，需要继续评估 Windows 管道继承方案。

## 深层指纹内核评估（2026-10-16）

1. [fingerprint-chromium 官方说明](https://github.com/adryfish/fingerprint-chromium)：项目声明 BSD-3-Clause，提供种子及 Canvas、音频、字体等能力，但采用延迟公开对应版本补丁的方式。当前主文档列出的版本与 Google 稳定内核存在差距，GPU 参数也发生过删除和平台限制；不能直接照搬旧参数或把作者展示的检测结果作为本项目验收。
2. [Camoufox 官方项目](https://github.com/daijro/camoufox)及[许可证](https://github.com/daijro/camoufox/blob/main/LICENSE)：基于 Firefox，涉及多种组成部分的许可与工具链。接入需要独立的 Firefox 启动及控制适配，不能套用 Chromium 的 CDP 配置。
3. [BotBrowser 官方许可证入口](https://github.com/botswin/BotBrowser/blob/main/LICENSE)：需进一步核对具体二进制版本的许可、使用限制、授权方式、来源校验和更新机制，尚未集成。

补充实测及可复现探针见 [深层指纹内核实测记录](browser-fingerprint-evaluation.md)。Clearcote 公开版已在合成资料中验证种子稳定及部分跨上下文一致性；用户选择免费可选实验版后，已加入独立目录并开放经过验证的有限配置，不能覆盖参考图全部表面。

当前决策：保留官方推荐内核，同时提供用户确认的可选实验内核；未验证的深层开关不显示为可用。下一阶段应选取能够审阅源码补丁及安全更新来源的内核，在隔离测试环境验证：相同种子重启稳定、不同环境种子区分、iframe / worker 一致性、Canvas / WebGL / Audio / 字体覆盖、UA 与 Client Hints 一致性、DNS / WebRTC / IPv6 出口，以及 Chromium 安全补丁跟进。尚未完成这些验证，不应宣称能避免平台关联识别。

## 验证与剩余工作

常规检查：

```text
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
node scripts/verify-platform-contracts.mjs
node scripts/verify-rust-command-boundary.mjs
npx playwright test --config playwright.browser.config.ts
cargo test --manifest-path src-tauri/Cargo.toml core::browser --lib
cargo test --manifest-path src-tauri/Cargo.toml core::database::tests --lib
```

真实内核测试需显式设置 `CLOUDHUB_BROWSER_TEST_EXE`、`CLOUDHUB_BROWSER_TEST_ARCHIVE`、`CLOUDHUB_BROWSER_TEST_COMPAT_ARCHIVE` 到上述经过验证的本机文件；实验内核另设置 `CLOUDHUB_BROWSER_FINGERPRINT_TEST_EXE` 和 `CLOUDHUB_BROWSER_FINGERPRINT_TEST_ARCHIVE`，再为浏览器测试追加 `-- --include-ignored`。这些测试只使用临时资料及本机/测试域名。测试文件建议放在工作区外的持久测试缓存，临时目录可能被系统清理。

沙箱调查：早期原生启动在本机退出 3，曾临时以无沙箱测试取得证据；后续对照发现 Playwright 启用沙箱可启动。逐项缩小参数后，原生方式仅增加 `--disable-field-trial-config` 即可启动，因此共用参数禁用 CfT 强制实验配置，保留浏览器沙箱。真实专项测试已移除硬编码 `--no-sandbox`。正常 Tauri 桌面交互仍需端到端验收。

已获得的验证证据：前端构建、Rust 检查、平台契约和原生边界检查通过；6 项 Playwright 流程测试通过；18 项浏览器专项测试（包含真实官方/实验内核及三份 ZIP）通过；21 项数据库测试通过。TLS 代理测试覆盖受信测试证书下的原始 CONNECT 通道，以及拒绝不受信证书。界面已检查 375、768、1024、1440 宽度、遮罩点击及 Escape 行为。

未完成事项：基于出口 IP 的时区/定位模板、正常 Tauri 桌面完整流程验收、完整浏览器网络泄漏验收、User-Agent / Client Hints 一致模板。可选实验内核已按用户确认接入；其余深层能力不在当前已验证范围。阶段一至三的任务保持跟踪，不以当前部分功能代替完整验收。
