# 局域网设备

入口：软件商店 → 局域网设备。支持商店的页面 / 弹层呈现和可选侧栏入口。

## 首版能力

- 选择本机私有 IPv4 网卡，以单 IP、CIDR 或两个完整 IP 的起止范围扫描；每次最多 1024 个地址。
- ICMP 与 TCP 响应发现设备，默认探测 SSH、HTTP、HTTPS、SMB、RDP、IPP、打印和 RTSP；允许自定义 1–32 个 TCP 端口。
- 展示进度、停止扫描、查看已发现设备；关闭功能页面后任务继续，重新打开可以恢复查看。退出客户端会终止任务。
- 展示 IP、可获取的 MAC / 主机名、探测耗时、开放端口、设备类型、系统、厂商与识别依据。系统支持手动修正；厂商使用小型离线 OUI 子集，不承诺完整覆盖。
- SQLite 本地设备台账：别名、备注、标签、收藏；每个网络最多 4096 条设备和最近 20 次扫描。
- 搜索和筛选，CSV / JSON 导出，复制 IP，打开常用 Web 管理端口；SSH / RDP 复用现有主机连接或连接编辑器，扫描器不收集密码。

## 扫描和数据边界

### 系统与型号识别

- 本机直接依据运行平台标注 Windows / macOS / Linux，显示“已识别（本机）”；Linux 是可识别的目标系统，扫描客户端仍只支持 Windows / macOS。
- 仅对本次有响应的远端设备做有界探测：开放的 22 端口读取 SSH banner；开放的 80 / 8080 端口发送 HEAD 并读取 Server；UDP 5353 查询 Bonjour `_device-info._tcp.local` 型号；UDP 1900 查询 SSDP Server。所有 socket 绑定所选源地址，无代理、无登录、无跳转或 LOCATION 下载。
- HTTP / SSH 单次限时 750 ms，UDP 限时 650 ms；单份 TCP 数据最多 4096 字节、UDP 最多 8192 字节。识别沿用最多 16 个地址并发和扫描取消机制。Bonjour / SSDP 使用定向单播，设备不支持或防火墙阻挡时可能无结果。
- 远端声明始终标“推测”，可识别明确的 Windows、macOS、Linux / Ubuntu / Debian、Android、FreeBSD 标识，以及 Apple 型号推测的 iOS / iPadOS / tvOS。普通 OpenSSH、SMB、RDP、nginx 或 Apple 网卡本身都不作为系统证据。远端标识可能来自容器或代理，不能保证与宿主系统相同；冲突标识保留未识别。
- 本地管理 MAC 显示“可能为随机地址”，也可能来自虚拟网卡；不据其前缀猜厂商。全局 MAC 命中的厂商仅代表网卡注册组织，不能保证是整机品牌。
- 详情按条展示依据和型号；手动系统标记与自动结果分开保存，重新扫描保留手动值，清空后恢复自动结果。CSV / JSON 导出包括系统、识别状态、型号、MAC 类型及依据；旧台账和扫描历史通过缺省字段兼容，重新扫描后补充识别信息。

Windows 使用系统网卡、邻居表、ping 和系统 DNS 解析；macOS 使用 ifconfig、route、arp、ping。TCP 使用绑定所选源 IP 的原生 socket，探测不经过 HTTP 代理。

仅响应设备计入本次发现，邻居缓存只补充 MAC 等属性。未响应不代表离线，Wi-Fi 客户端隔离、防火墙或休眠均可能导致漏检。MAC / 主机名不可获取时留空，Windows 反向解析有总时间和并发限制，不保证每台设备都有名称。

扫描过程中定期检查网络，保存前再次检查；检测到变化时停止且不写入台账。用户主动停止时保存已完成的部分结果。取消需要等待有界的系统命令及收尾检查完成。

网络档案标识由网卡、网关、子网及系统可获取的网络名称组成，属于尽力识别；同一网卡连接到配置完全相同的不同网络时可能共用台账，尤其是 macOS。它不是账户级或租户级隔离边界。MAC 已知的设备按 MAC 标识；MAC 未知时按 IP，IP 被重用可能沿用旧备注。不同的已知 MAC 不继承彼此备注。

台账独立于账户同步；完整数据库备份仍包含这些表。导出仅包含设备台账，CSV 对公式前缀做转义。此功能不写入浏览器预览 API，浏览器和手机端明确不执行扫描，Linux 首版不支持。

## 验证

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml lan:: --lib
cargo test --manifest-path src-tauri/Cargo.toml native_interface_and_self_ping_smoke --lib -- --ignored
npm run verify:platform-contracts
npm run verify:rust-boundary
npx playwright test tests/ui/lan-devices.spec.ts tests/ui/application-navigation.spec.ts --workers=2
```

原生 smoke 仅读取网络配置、邻居表并探测本机地址，不扫描整个真实子网。界面回归使用模拟 Tauri 命令，不能代替 macOS 真机和不同路由器环境的验收。

## 后续可扩展

手动网络档案、完整离线厂商库、完整 mDNS / SSDP 服务目录和组播浏览、Windows 广播识别、扫描差异、定时巡检与新设备提醒、Wake-on-LAN、IPv6 和移动端发现均可后续实现；本版未包含这些功能。
