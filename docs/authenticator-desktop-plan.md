# CloudHub PC 验证器集成方案

日期：2026-10-10。状态：已实现 PC 首版；使用说明和实际验证范围见 [PC 验证器使用与验证记录](authenticator-desktop.md)。下文保留原始设计与验收目标。

用户体验调整：按用户要求取消主密码设置与日常解锁，改为独立本机密钥自动打开。旧密码库只需一次原密码迁移；加密迁移文件仍使用文件密码。下文主密码方案为历史设计，当前行为以使用说明为准。

## 目标与推荐路线

在 CloudHub 左侧主导航增加“验证器”，提供本地离线 OTP 管理，参考截图的服务商、账户、当前码、下一码和倒计时卡片。采用现有 React/Tauri/Rust/SQLite 架构，独立实现格式适配与 OTP 领域逻辑。首版覆盖 Ente 明文与加密文件的双向迁移，并提供 CloudHub 完整加密备份。

第一期仅 PC 原生客户端。手机端、浏览器真实 OTP 能力、Ente 登录和云同步不在本期范围；未来手机端可复用 Rust 领域模块。OTP 不自动进入现有账户扫码同步或整库导出。

后续用户已要求并实现移动端与一次性二维码迁移，以及浏览器验证器。现行能力分别见 `authenticator-mobile.md` 与 `authenticator-browser.md`；下文保留第一期设计记录。

## 调研依据

Ente 源码基线：`29c8293ec4f6576cfd16368f3d53519fb8c094e3`，实施时固定此基线作为兼容测试目标。

- [官方导出格式](https://ente.com/help/auth/migration/export)：v1 使用 Argon2id 派生密钥、XChaCha20-Poly1305 加密，解密内容为逐行 OTP 地址。
- [导出实现](https://github.com/ente/ente/blob/29c8293ec4f6576cfd16368f3d53519fb8c094e3/mobile/apps/auth/lib/ui/settings/data/export_widget.dart)：明文来自 `code.rawData`，每条一行；加密导出封装为 JSON；普通导出未调用带 `codeDisplay` 的完整序列化方法。
- [文件模型](https://github.com/ente/ente/blob/29c8293ec4f6576cfd16368f3d53519fb8c094e3/mobile/apps/auth/lib/models/export/ente.dart)：外层字段是 `version`、`kdfParams { memLimit, opsLimit, salt }`、`encryptedData`、`encryptionNonce`。
- [明文解析](https://github.com/ente/ente/blob/29c8293ec4f6576cfd16368f3d53519fb8c094e3/mobile/apps/auth/lib/ui/settings/data/import/plain_text_import_parser.dart)：识别 OTP 地址列表，也接受包含 `items` 的 JSON；支持换行与部分旧逗号分隔格式。
- [Code 模型](https://github.com/ente/ente/blob/29c8293ec4f6576cfd16368f3d53519fb8c094e3/mobile/apps/auth/lib/models/code.dart)：存在 TOTP、HOTP、Steam 类型以及 SHA1/SHA256/SHA512。不能把所有导出项都当作默认 6 位、30 秒 TOTP。
- [CLI 解密入口](https://github.com/ente/ente/blob/main/cli/pkg/authenticator/decrypt.go)也按上述 envelope 派生密钥再解密，可用于互操作验收。

实施中已确认 KDF 参数及 secretstream 消息布局，并完成独立 libsodium 双向验证。真实 Ente 桌面客户端往返尚未验收，详见使用说明的证据边界。

## 方案对比

| 路线 | 成本与复杂度 | 安全与数据归属 | 可逆性与验证 |
| --- | --- | --- | --- |
| 独立原生实现、兼容格式（推荐） | 中等；增加 OTP 引擎和格式适配器 | 数据只在本机；沿用项目边界 | 可以独立停用；使用标准向量和 Ente 双向往返测试 |
| 嵌入/移植 Ente 客户端 | 高；需适配其 Flutter 客户端及存储/依赖 | 新增第二套运行时和秘密处理路径 | 耦合较深；需测试两个客户端体系及许可要求 |
| 接入 Ente 云服务 | 高；增加登录、端到端加密同步和冲突 | 增加账户、网络和远端数据生命周期 | 撤销与迁移较复杂；超出本期本地需求 |

不复制上游业务代码、图标资源或品牌素材；依照标准和已核对格式实现适配。上游仓库标注 AGPL-3.0，若实施中决定复用代码，先核对具体文件和依赖许可并处理相应义务。

## 首版功能与界面

- 主导航“验证器”；顶部搜索、新增、导入、导出、锁定；分组栏支持全部、置顶、用户分组。
- 响应式紧凑卡片与列表切换，保持现有主题/CSS/Lucide。卡片显示服务商、账户、当前码、剩余秒数；TOTP/Steam 可选显示下一码，HOTP 显示计数和显式“生成下一码”操作。
- 当前码点击复制，并显示反馈；等宽数字且每三位分隔。接近失效时提示剩余时间，不自动复制下一码。
- 手工新增、粘贴 `otpauth://`、二维码图片文件/粘贴图片识别。摄像头扫描和 Google 批量迁移二维码放后续。
- 编辑账户/服务商/参数、置顶、分组、排序、批量删除；导入支持预览、逐项选择、重复与冲突处理。
- 统一时钟驱动可见卡片，不为每个卡片启动计时器；按时间窗口批量请求 Rust 生成验证码。窗口恢复、系统时间变化时立即重新取码，不靠递减计数作为时间来源。
- 无网络时正常使用；服务商图标采用本地资源或通用图标，不按账户/服务商远程请求图标。

## 导入导出契约

| 格式 | 导入 | 导出 | 保留范围 |
| --- | --- | --- | --- |
| Ente 明文 TXT / OTP 地址列表 | 首版 | 首版，可选兼容迁移 | 服务商、账户、种子、类型、算法、位数、周期、HOTP 计数 |
| Ente 加密 v1 JSON | 首版，输入文件密码 | 首版，设置导出密码 | 与上行相同；按 Ente 格式封装 |
| CloudHub 加密备份 v1 | 首版 | 默认备份选项 | 全部 OTP 字段及分组、置顶、排序、备注、稳定标识 |
| Ente HTML 二维码导出、其他厂商专用格式 | 后续 | 后续 | 必须分别核对格式后提供适配 |

按文件内容识别而非只看扩展名，可接受历史 `.txt` 中的加密 JSON。遇到未知格式版本或 OTP 类型，显示不支持原因和数量，不静默丢弃或改成默认参数。

Ente 普通导出不能被承诺保留其所有分组、备注和置顶等元数据。若文件实际携带已知扩展字段，按经验证的契约映射；未知扩展需要明确处理策略，不任意执行。CloudHub 兼容导出明确提示自身管理元数据的损失，完整恢复使用 CloudHub 备份。

加密兼容必须逐项确认 Argon2id 版本、并行度、输出长度、`memLimit` 单位及换算、Base64 编码、nonce 长度、认证标签布局和 AAD。不能直接把 Ente 字段喂给 Rust 库默认值。使用成熟库；KDF 放后台任务，限制文件大小、条数、内存/计算参数，避免恶意文件耗尽资源。初步限制文件 10 MiB、条数 10000，KDF 上限按实际 Ente 导出样本确定，超限明确报错。

导入流程：选文件 → Rust 识别/解密/校验 → 返回无秘密的预览 → 处理冲突 → SQLite 事务写入 → 数量回执。预览临时状态由 Rust 持有，使用随机、绑定窗口的短期 ID；取消、超时、锁定时销毁。

重复判断在 Rust 内比较规范化种子和 OTP 参数，不单凭账户名；同账户不同种子默认并存并提示。HOTP 同种子不同计数不得自动回退或无声合并。无效条目仅报告行号和错误类别；导出仅包含用户选定记录并报告实际数量。

导出由 Rust 直接写用户选择的文件路径；前端不接收种子、完整 OTP 地址或解密文本。明文导出在明确敏感提示及再次解锁后执行；默认加密导出。通过临时密文文件和原子替换保证失败不留下半成品，避免明文临时文件。

## 原生架构与安全

当前可复用：`src/platform/clients/base.ts` 的 `nativeOnly`、Rust commands/repositories 分层、`core/database.rs` 版本迁移和 `core/crypto.rs` 的成熟加密基础。Cargo 已有 HMAC/SHA1/SHA2/AES-GCM/zeroize；Ente 兼容预计新增 Argon2id/XChaCha20-Poly1305 支持及 Base32/OTP/二维码相关依赖，实施时核对维护状态、许可和锁文件变更必要性。

建议文件：

- `src/features/authenticator/`：面板、卡片、导入预览、导出与解锁弹窗及独立 CSS。
- `src/platform/clients/authenticator.ts`：类型化原生调用；`src/App.tsx` 只挂导航与模块入口。
- `src-tauri/src/commands/authenticator.rs`：命令/权限和安全错误；`commands/mod.rs` 与 `lib.rs` 注册。
- `src-tauri/src/core/authenticator/`：OTP、URI、Ente adapter、完整备份、vault 会话。
- `src-tauri/src/core/repositories/authenticator.rs`：新增表与事务；`core/database.rs` 按实施时版本增加迁移。
- `contracts/platform-clients.json`：原生限定契约；`web-api.mjs` 不新增 OTP 秘密接口，浏览器入口显示原生限定状态。

数据库将 OTP 记录与云账户分开，不强制绑定云账户。字段包括 UUID、issuer、account、type、algorithm、digits、period、counter、secret_ciphertext、分组/置顶/排序/备注和时间戳；不保存当前/下一验证码。HOTP 计数推进在事务中进行，不因渲染、复制或重新打开页面自动推进。

现有桌面密钥存放 `.key`，Windows 权限限制分支是空实现；不能把它描述为已经使用系统密钥库。现有 `docs/security/keyring-migration-design.md` 是设计而非完成证据。

推荐验证器采用独立 vault 数据密钥：随机生成，使用主密码经 Argon2id 派生的密钥进行认证加密包装，解锁后只在 Rust 内存保留；种子复用 AES-GCM 原语但使用独立密钥。不直接改动或迁移云账户的全局 `.key`。系统密钥库可作为以后“记住解锁”的可选扩展，不能在主密码锁定模式下把能绕过密码的解密材料存入普通文件。

锁定由 Rust 校验每条验证码/复制/新增/编辑/导入/导出命令：启动默认锁定，手动锁定、空闲超时、系统锁屏/休眠时清除会话；无法可靠接收事件的平台在窗口恢复时要求重新解锁。React 仅接收元数据与短时验证码。手动输入种子和解锁密码不可避免经过输入控件，提交后立即清空，不写入 localStorage、持久状态或日志。

备份密码与本机主密码分离；换机导入后使用目标 vault 密钥重新加密。忘记主密码且没有可解密备份时不能承诺恢复。删除是逻辑删除，不能承诺 SSD/SQLite 页的取证级擦除。

验证码复制尽量经 Rust 原生剪贴板；延迟清理只在剪贴板仍是本次写入内容时执行，不覆盖用户随后复制的其他内容。说明系统剪贴板历史不保证可清除。完整数据库导出必须显式处理 vault 及恢复材料，不能无意泄露独立 vault 密钥。

## 实施步骤与验收

以下为后续开发任务，不表示当前已完成。开始开发时创建唯一 `feature/pc-authenticator-<日期或唯一后缀>` 分支，尊重已有改动。

| 步骤 | 执行层/依赖 | 验收标准与主要风险 |
| --- | --- | --- |
| 1. 固定兼容契约和 OTP 引擎 | Rust，先于持久化 | RFC 4226/6238 向量；SHA1/256/512、6/8 位、非 30 秒周期、时间边界；Steam 用独立参考向量核对 |
| 2. 独立 vault 和数据库 | Rust/SQLite，依赖 1 | 错误密码不泄露内容；锁定后所有敏感命令拒绝；重启可恢复；事务回滚；不影响旧账户数据 |
| 3. Ente 双向格式与完整备份 | Rust，依赖 1/2 | Ente → CloudHub → Ente 实际往返；Unicode/冒号/百分号标签；HOTP 计数保真；密码错误、篡改、资源超限拒绝 |
| 4. 桌面模块与新增/二维码/导入预览 | React/client，依赖 2/3 | 卡片倒计时/复制、搜索分组、键盘焦点、明暗主题；睡眠恢复和过期码刷新；无秘密持久化 |
| 5. 整体回归与 PC 验收 | 契约与桌面运行时，依赖前四步 | npm run build；cargo check --manifest-path src-tauri/Cargo.toml；Rust 领域测试；原生能力契约检查；Windows 运行时验收，支持其他 PC 系统时分别验收 |

互操作测试使用专门生成的临时演示数据，不使用用户真实 OTP、账号邮箱或截图数据作为夹具。必须保存测试目标版本和通过结果后才能标记兼容；源码阅读不能代替实际 Ente 导入验收。

实施交付已经包含原生引擎、密码库、格式适配、桌面界面和自动测试。实际实现使用独占创建目标文件并在写入失败时清理，不覆盖已有备份；整库迁移保留本机验证器。完整 Windows 运行时和真实 Ente 客户端验收仍作为后续发布前检查。
