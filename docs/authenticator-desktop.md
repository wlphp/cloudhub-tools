# PC 验证器使用与验证记录

日期：2026-10-10。开发分支：`feature/pc-authenticator-20261010`。

## 使用

在 PC 桌面客户端左侧打开“验证器”即可使用，无需创建或输入主密码。本机独立随机密钥自动生成，验证码仍加密存储。此前创建过主密码的密码库只需输入一次旧密码，迁移后直接打开，原验证码保持不变。支持 TOTP、HOTP 和 Steam；可手动填写密钥、粘贴 OTP 地址、选择二维码图片或粘贴图片。可以搜索、分组、置顶、排序，切换卡片与列表，批量选择和删除。

当前验证码点击复制，右上角浮动显示“服务商 · 账户：验证码复制成功”，3 秒后自动消失，不挤动页面内容。HOTP 只有点击“下一码”才推进计数，复制不会推进。TOTP/Steam 显示下一码与剩余秒数，使用原生系统时间计算。每页最多显示 100 项。

账号旁的图标可复制完整账号；“下一个”验证码也可点击复制，提示分别显示“账号复制成功”和“下一个验证码复制成功”。下一码在原生进程按点击时的系统时间计算，不推进 HOTP 计数；HOTP 不显示预览下一码。复制内容沿用 30 秒后仅在剪贴板仍保持原值时清理的规则。

顶部按服务商显示彩色分类统计，点击类别只显示该服务商，点击“全部”恢复所有服务商；可与搜索、分组和置顶筛选叠加。数量统计全部条目，不随搜索改变。切换类别保留已勾选条目。卡片服务商标识位于右上角，邮箱独立一行，过长自动换行。

从 Ente 迁入：在 Ente 导出明文或加密文件，然后在本页“导入”中填写文件密码（明文留空）、选择文件、检查预览并确认。重复密钥默认跳过，可选择更新；同名但不同密钥可并存。HOTP 更新禁止计数回退。无效条目显示行号和错误类别，不显示密钥。

迁回 Ente：勾选卡片左上角的复选框，点击选择栏的“导出所选”；顶部同时显示“导出所选（数量）”。跨页或搜索后仍保留已选条目，弹窗确认实际导出数量。未勾选时顶部显示“导出全部”。选择“Ente 兼容加密文件”或“Ente / OTP 明文文件”。加密导出需要设置文件密码；明文导出需确认敏感提示。保存时使用新文件名，已有文件不会被覆盖。

完整换机备份请选择默认的“CloudHub 完整加密备份”，它保留分组、备注、置顶和排序。Ente 兼容文件只保留 OTP 参数。目标电脑创建自己的密码库后导入，条目重新使用目标密码库密钥加密。

## 原生与数据边界

- 密钥和管理元数据使用独立随机密钥加密存入 SQLite；本机密钥单独存放在 `.authenticator.key`，与云账号 `.key` 分离，不进入整库迁移包。免密码模式的保护边界与项目现有本地凭据模式一致，不提供主密码访问屏障或系统密钥库保护。
- 前端列表和预览不接收 OTP 种子；手动输入密钥和密码提交后清空。密码库密钥只在 Rust 会话中保存。
- 页面离开、窗口失焦或会话超时会清除内存中的密钥；再次使用由原生进程读取本机密钥自动打开，无需用户解锁。原生文件选择窗口保持当前导入预览。
- 未接入系统锁屏/休眠专用通知；免密码模式没有用户身份认证。真实 Windows 文件对话框与剪贴板行为仍须人工验收。
- 整库导出移除验证器数据；整库导入保留本机验证器，忽略迁移包中的验证器数据。持续账号同步不包含 OTP；一次性电脑二维码迁移可单独勾选验证码。
- 浏览器版已接入本机验证器 API，见 [浏览器验证器说明](authenticator-browser.md)。移动原生客户端支持摄像头扫描与一次性电脑迁移，见 [移动验证器说明](authenticator-mobile.md)。本期不包含 OTP 持续云同步、Google 批量迁移二维码或 Ente HTML 导出。
- 单个导入/导出文件最多 10 MiB，最多 10000 项。超限需分批导出。Argon2id 参数限制为内存最多 512 MiB、最多 10 次操作，派生任务串行执行。
- 本机密钥缺失或损坏时不会生成新密钥覆盖旧验证码，需从独立备份恢复。旧密码库迁移仍须知道原密码。复制后 30 秒只在剪贴板仍包含原验证码时尝试清理；系统剪贴板历史不保证清除。

## Ente 格式依据与验证范围

参考源码基线 `29c8293ec4f6576cfd16368f3d53519fb8c094e3`。实际加密格式为 libsodium XChaCha20-Poly1305 **secretstream**，不是普通 XChaCha20-Poly1305 AEAD。接受 MESSAGE 和 FINAL 标签；Argon2id v19、并行度 1、输出 32 字节，`memLimit` 单位是字节，传入 Argon2 库前换算为 KiB。

依据：[Ente KDF 实现](https://github.com/ente/ente/blob/29c8293ec4f6576cfd16368f3d53519fb8c094e3/cli/internal/crypto/crypto.go)、[Ente Auth 解密实现](https://github.com/ente/ente/blob/29c8293ec4f6576cfd16368f3d53519fb8c094e3/cli/internal/crypto/crypto_native.go)、[官方导出文档](https://ente.com/help/auth/migration/export)。

夹具只使用 RFC 4226 公开示例种子和虚构账户。PyNaCl/libsodium 生成的 MESSAGE、FINAL 文件能够被 Rust 导入；Rust 生成的文件也由独立 PyNaCl/libsodium 解密并核对 URI 字段。格式层面的双向验证已通过；尚未完成真实 Ente 桌面客户端的导入/导出往返，不能将独立实现验证描述为 Ente GUI 验收。

## 自动验证

- `npm run build`：通过。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；保留现有 RDP 未使用代码警告。
- `cargo test --manifest-path src-tauri/Cargo.toml authenticator --lib`：覆盖 RFC 4226/6238、三种算法、Steam、非默认周期、Unicode URI、加密往返、错误密码、篡改、资源边界、原生二维码识别、会话过期、事务回滚、HOTP 大整数与计数回退、整库隔离，以及本机密钥重启恢复和旧密码库迁移。
- `npx playwright test tests/ui/authenticator.spec.ts`：6 项通过，覆盖浏览器拒绝、免密码直接打开/编辑/复制/计数/重新进入、旧密码库一次性迁移、导入预览/选定导出、服务商分类统计与搜索叠加/保留选择、布局切换及无横向溢出。该测试模拟 Tauri 调用，不代表操作系统文件选择器或剪贴板实测。
- `npm run verify:platform-contracts`、`npm run verify:rust-boundary`、`node --check scripts/verify-platform-contracts.mjs`：通过。

尚未制作发行安装包；真实 Ente 客户端、Windows 文件选择器/剪贴板/锁屏休眠以及 macOS/Linux 原生运行时验收未覆盖。

独立验证可复现：为 Rust 测试设置 `CLOUDHUB_AUTH_INTEROP_OUTPUT` 指向合成导出文件，然后运行 `python tests/fixtures/authenticator/verify-rust-export.py <该文件>`。验证脚本需 PyNaCl，仅属于测试工具，不是应用运行依赖。
