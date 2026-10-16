# 深层指纹内核实测记录

日期：2026-10-16。此记录是选型与接入证据。用户已明确选择“免费内核先做可选实验版，明确版本和能力限制”；Clearcote 公开版已作为非默认实验内核加入独立下载目录。

## 可复现探针

`scripts/verify-browser-fingerprint.mjs` 仅用于开发验收，复用已有 Playwright 开发依赖。要求显式指定绝对路径和经过审阅的 **exe SHA-256**；校验不符不执行浏览器。默认启用沙箱，仅在明确传入 `--test-no-sandbox` 时关闭测试沙箱。使用临时合成资料和本机 HTTP 页面，完成后关闭浏览器并删除本次资料，不访问用户环境。

```text
node scripts/verify-browser-fingerprint.mjs --executable <已验证的绝对路径> --sha256 <exe哈希>
```

依次采样：种子 A、同目录重启 A、新目录 A、新目录种子 B。每次采样页面、同源 iframe、Dedicated Worker 的 Canvas、WebGL、语言、时区、硬件字段、UA 与高熵 Client Hints；页面另测离线音频、字体宽度、矩形。输出 JSON。退出 0 只代表稳定性和采样范围内的跨上下文一致性通过，**不代表全部指纹表面已修改**；`distinct` 单独记录两个种子的差异。

参数缺失、未知参数、哈希不符的拒绝分支，以及真实浏览器路径均已执行。脚本未覆盖跨站 iframe、Service Worker、网络请求 Client Hints/TLS 一致性、指纹网站检测结果或网络包层泄漏，不能据此推广结论。

## Clearcote 公开版

来源：[官方项目](https://github.com/clearcotelabs/clearcote-browser)、[版本源码与补丁](https://github.com/clearcotelabs/clearcote-browser/tree/main/patches)、[官方固定下载目录](https://github.com/clearcotelabs/clearcote-browser/blob/main/sdk/node/src/release.ts)。许可证为 BSD-3-Clause；公开版与较新授权版是不同交付路径，不能把公开源码许可推及未审查的授权版。

- 发布标签：`v0.1.0-pre.23`，Windows x64，Chromium `150.0.7871.114`。
- ZIP 大小：`245936073` 字节。
- ZIP SHA-256：`93fc03c45b931d8d82f714814318892929f44dd671b0993788332071d53f3135`。
- exe SHA-256：`f49b0d6bc5a08857e34f951ddc456abc643283ae45ff330ee7c2c39cd75b4869`。
- 已实下载、校验 ZIP 和 exe，检查解压路径/大小后，仅在本机合成资料中执行。未安装该项目的 SDK，未使用账号或授权密钥。

探针结果（启用沙箱）：

| 检查 | 观察结果 |
| --- | --- |
| 同种子重启、新目录 | 采样结果稳定 |
| 页面 / 同源 iframe / Dedicated Worker | 本次采样一致 |
| 同一 Canvas 重复读取 | 稳定 |
| 不同种子 Canvas | 不同 |
| 不同种子音频、WebGL、字体宽度、矩形、CPU/内存 | 本次两个种子未观察到差异 |

源码审阅进一步发现，`020-audio.patch` 明确保留离线音频渲染样本，`050-shadow-dom` 移除了矩形噪声；`002-persona-profile.patch` 的默认 GPU 选择使用固定项。这与“每个表面都按种子变化”的实现不同。一次未观察到差异也不能证明所有种子都相同。

当前不作为默认内核：公开版落后于应用已验证的官方 Chromium 155，界面明确标识为实验版、仅用于测试，不能据现有证据开放参考图中的所有深层开关。禁止用页面注入补丁掩盖未实现能力。

用户确认后接入的能力：

- 环境保存非零 u32 种子，重开/重启保持；可明确生成新种子，不自动清空登录资料。
- Canvas 固定种子噪声 / 真实结果。关闭噪声后，本机样本像素哈希与官方 CfT 对照一致；两个种子不再造成差异。
- CPU 逻辑核数 1–64、设备内存 2/4/8/16/32 GB；实际验证 4 核 / 8 GB 在页面、同源 iframe 与 Worker 一致。其他值受原生类型与范围校验。
- 固定使用真实 GPU，原生参数为 `--disable-gpu-fingerprint`。音频、字体、矩形噪声与跨系统模拟不开放配置。
- `clearcote-150.0.7871.114` 使用独立内核目录和版本锁，不替换推荐 155 内核，也不迁移其已有环境。
- GitHub Release 下载仅允许 HTTPS 审核主机跳转；ZIP 固定哈希之外再校验 exe 哈希。支持匹配离线 ZIP。安装目录写入 Clearcote、Chromium 和 Fingerprint Chromium 上游许可说明，原包全部文件保留；检查 ZIP 未携带额外字体或 Widevine 文件。

补丁审阅补充核对了发布标签 `v0.1.0-pre.23` 的 LICENSE、开关和 persona 补丁，避免只依赖持续变化的主分支。真实原生测试使用产品的参数生成函数、启用沙箱，验证同种子稳定、不同种子 Canvas 差异、噪声关闭、硬件/语言/时区生效，并验证三份 ZIP 的解压与许可文件。

## 官方内核对照

Google Chrome for Testing `155.0.8059.84` 同一探针在启用沙箱时通过稳定性检查；两个不同的 `--fingerprint` 参数没有改变采样结果。该参数不属于此内核支持的指纹配置，测试再次确认普通官方内核不能提供深层种子能力。

对照 exe SHA-256：`a2ae305da79e701af793b667c1ca3d87383729040596264e52f51259d7966413`。ZIP 来源和哈希见 `docs/fingerprint-browser.md`。

## 后续验收与扩展

1. 持续核对可审阅补丁与安全更新；不得把落后的实验版本静默替换为默认内核。
2. 仅开放上述已验证的实验配置；扩展表面前，分别核对真实/种子/自定义语义与持久化规则。
3. 扩大种子样本，并验证跨站 iframe、Worker、UA/Client Hints 请求头及硬件组合一致性。
4. 验证正常桌面启动、资料持久化和代理下的 DNS / WebRTC / IPv6 包层出口。
5. 新版本继续执行审核目录、离线包校验、版本隔离与许可证检查，更新前先验证旧资料保护。
