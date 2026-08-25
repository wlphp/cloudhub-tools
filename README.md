# 云枢 Tools

本地优先的多云资源管理桌面应用。云枢 Tools 将分散在不同云厂商的账号、服务器、域名、数据库和存储资源集中到一个本机客户端中管理，并提供域名解析、对象存储浏览、服务器连接、面板查看和操作审计等能力。

当前基于 Tauri + React 构建，支持 Windows、macOS 和 Linux。本项目不依赖 PHP 或远程管理服务；账号凭证、同步资产和操作记录默认保存在当前设备。

## 核心功能

- **多云账号管理**：维护账号、分组、默认地域和启用状态，支持凭证加密保存与部分云账号连通性验证。
- **资源同步与汇总**：按账号选择资源类型同步到本地 SQLite；可按云厂商、地域、资源类型、状态和关键字筛选，并收藏常用资源。
- **云资源管理**：覆盖服务器、域名、对象存储、云数据库、Redis、轻量应用服务器及边缘安全加速等常用资产；部分资源支持改名、启动、停止、重启或强制重启。
- **域名与 DNS**：查看域名解析记录、操作日志和 WHOIS；在已支持写入的云厂商中可添加、编辑、启停和删除解析记录。
- **对象存储**：查看存储桶和部分桶的详情、文件列表、容量统计、CNAME 与 CORS 配置；支持的服务商可绑定或移除自定义域名。
- **服务器连接**：从云资源直接打开 SSH 或 Windows RDP；SSH 支持密码、私钥和私钥口令，并提供远程目录浏览、文件上传下载、编辑和删除等操作。
- **面板管理**：统一接入宝塔面板和 aaPanel，查看面板在线状态、版本、CPU、内存、磁盘与网络信息，并可快速打开面板或关联服务器的 SSH。
- **本地审计**：保留本机操作日志和云 API 请求日志，便于回溯账号与资源操作。

## 已接入云服务商

阿里云、腾讯云、火山引擎、天翼云、Oracle Cloud、华为云、百度智能云、京东云、UCloud、青云 QingCloud、金山云、七牛云、AWS、Microsoft Azure、Google Cloud 和 Vultr。

各云厂商的 API 能力和授权模型不同，因此同步资源类型、资源详情和可写操作并不完全一致。应用会在界面中标注仅支持读取的能力；例如部分云厂商当前仅支持资产或存储桶清单同步。

## 支持的资源类型

- 服务器与轻量应用服务器
- 域名与 DNS 解析
- 对象存储桶
- 云数据库与 Redis
- 边缘安全加速
- Vultr 的块存储、私有网络、防火墙、保留 IP、负载均衡、快照和 Kubernetes 等资源

## 本地数据与安全

- 账号密钥、面板 API Key 和已保存的 SSH 密码均使用本机生成的密钥加密后保存。
- AccessKey Secret 不会在账号列表中明文显示。
- Windows 数据库默认位于 `%LOCALAPPDATA%\CloudHubTools\cloudhub_tools.sqlite3`。
- macOS 数据库默认位于 `~/Library/Application Support/CloudHubTools/cloudhub_tools.sqlite3`。
- 操作日志和 API 日志仅保存在当前设备。

## 本地运行

### 环境要求

- Node.js
- Rust 工具链
- Windows：Visual Studio C++ Build Tools
- macOS：Xcode Command Line Tools

### Windows

双击 `run-windows-dev.cmd`，或在 PowerShell 中运行：

```powershell
./run-windows-dev.cmd
```

首次启动需要编译 Rust 依赖。前端开发服务默认运行在 `http://127.0.0.1:1420`；账号加密存储、SSH 和本机数据库等功能需要通过 Tauri 桌面客户端使用。

### 前端开发预览

```powershell
npm install
npm run dev
```

### 构建 Windows 安装包

```powershell
npm install
npm run tauri build
```

安装包将生成到 `src-tauri\target\release\bundle\`。

### GitHub Release

推送形如 `v0.1.1` 的版本标签会自动创建 GitHub Release，并上传以下原生安装包：

- Windows x64 和 Windows ARM64
- macOS Apple Silicon（M 系列芯片）和 macOS Intel
- Linux x64（AppImage、DEB、RPM，具体格式由 Tauri 生成）

macOS 发布包按芯片类型拆分，避免通用包的额外下载体积。Apple Silicon 对应 M1、M2、M3、M4 及后续芯片；Intel Mac 请选择 Intel 包。

### 构建 macOS 安装包

必须在 macOS 系统中执行：

```bash
npm install

# 通用包，同时支持 Apple Silicon 和 Intel Mac
npm run bundle:mac

# 仅 Apple Silicon
npm run bundle:mac:arm64

# 仅 Intel Mac
npm run bundle:mac:x64
```

生成的 `.app` 和 `.dmg` 位于 `src-tauri/target/<target>/release/bundle/`。未使用 Apple Developer 证书签名的包仅适合内部测试；对外发布前请完成签名和公证。

## 技术栈

- 前端：React、TypeScript、Vite
- 桌面端：Tauri 2、Rust
- 终端：xterm.js
- 本地存储：SQLite
