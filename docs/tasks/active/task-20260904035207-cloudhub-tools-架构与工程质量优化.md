# 任务：CloudHub Tools 架构与工程质量优化

**状态**: active
**创建时间**: 2026-09-04 03:52:07.416 UTC
**更新时间**: 2026-09-07 01:20:10.612 UTC
**Git 分支**: feature/architecture-optimization

---

## 范围

围绕前端/原生入口拆分、平台调用契约、数据库迁移、凭据与日志安全、同步可靠性、性能和自动化验证，分阶段完成可验证的工程优化。保持 React/Tauri/Rust/Node 三层边界，不修改无关云厂商实现，不记录任何凭据或敏感数据。

---

## 计划

- [x] 1. 现状基线与方案确认：记录当前构建、Rust 检查、平台契约、安全脚本结果，确认拆分边界和不改范围。
- [x] 2. 拆分 React 领域入口与平台客户端：按账号、资源、服务器、DNS、OSS、面板、SSH、日志和设置拆分 UI；所有平台调用统一经 client 层。
- [x] 3. 拆分 Rust 命令与统一错误契约：将 `lib.rs` 中的命令按领域迁入 `commands/`，保留唯一注册入口；统一错误码、用户消息、可重试属性和平台不支持语义。
- [x] 4. 完善数据库迁移与敏感日志治理：引入 schema 版本迁移、事务和备份；集中处理日志脱敏、大小限制、保留周期和查询筛选。
- [x] 5. 优化同步可靠性、SSH 安全与前端性能：增加有界并发、取消/重试、稳定资源主键、删除确认和文件操作限制；对终端及重型功能懒加载。
- [x] 6. 补齐自动化测试与 CI 验证：增加 client、DTO、迁移、日志脱敏、Web API、Rust repository 和关键 UI 流程测试，并接入发布前检查。
- [x] 7. 回归验收与交付说明：执行三执行层回归，确认浏览器预览不模拟原生能力，审阅差异范围并输出剩余风险。

## 方案

### 目标架构

```text
React 页面/组件
        ↓
领域 hooks + platform clients + DTO/错误类型
        ↓                         ↓
Tauri invoke                Web API preview
        ↓                         ↓
Rust commands               Node routes
        ↓                         ↓
core/database/crypto     providers/security
        ↓                         ↓
SQLite、本机能力          仅可安全降级的本地 HTTP 能力
```

### 实施原则

1. 每个用户行为只有一个主执行层：React 负责展示和编排，凭据/加密/SQLite/SSH/厂商签名归 Rust，浏览器只实现真实可用的降级能力。
2. 优先做可独立验证的小切片；每一步完成后运行对应层检查，再更新本任务记录。
3. 不新增无必要服务层，不复制 Controller/Service/DAO 分层；按领域聚合文件。
4. 不修改生成文件、锁文件和无关云厂商实现；只暂存当前步骤实际修改的文件。
5. 所有测试数据、日志和任务记录都不得包含账号密钥、SSH 凭据、私钥、面板 API Key 或解密后的本地数据。

### 方案审查结论

- 原步骤 2 覆盖面过大，不能以一次性重构方式实施；现拆为四个可回滚子阶段：基础 client（日志/偏好）→ DNS/OSS → 面板/SSH → 组件绕过检查。
- 原步骤 3 依赖步骤 2 的调用边界稳定后再做，避免同时移动 React 调用和 Rust 命令导致问题难以定位。
- “统一错误契约”先从 platform client 的错误包装和浏览器预览不支持语义开始，暂不强行一次改造全部厂商 provider。
- 数据库迁移、密钥环和 CSP 都属于独立风险面，应在有迁移测试和跨平台验证证据后推进，不与 UI 拆分混合提交。
- 步骤 6 的 CI 验收应在测试命令落地后再改发布工作流，避免把尚不存在的检查写成发布门禁。
- 步骤 3 需再拆为“无依赖命令迁移 → Rust 错误结构落地 → provider/命令逐批迁移 → 注册表和错误契约回归”四个子阶段；当前只完成前两项的基础部分。

#### 本轮审查补充

- P0：先完成 Rust 错误结构和敏感数据边界，再扩大命令迁移；否则前端虽有统一错误包装，provider 的 `String` 错误仍会造成错误码、重试属性和用户消息漂移。
- P1：同步重试必须按错误类型区分；当前固定退避只作为底层保护，认证、参数和权限错误后续应跳过重试，并补充取消信号。
- P1：资源稳定键应优先采用厂商 ID；无 ID 资源使用区域/连接身份或内容摘要，不能再使用数组下标。该原则已先落地到 fallback 路径。
- P1：日志保留、迁移、密钥环和 CSP 需要分别验收；“能编译”不能证明凭据迁移安全，也不能证明浏览器预览边界正确。
- P2：动态导入只解决首屏下载体积，不改变运行时能力；应以构建 chunk 和真实首屏指标共同验收。

### 分阶段交付

#### 阶段 A：降低维护成本

- 将 `src/App.tsx` 中的领域状态、事件处理和视图拆入 `src/features/*`。
- 为 DNS、OSS、面板、SSH、日志和设置补齐 `src/platform/clients/*`。
- 将 `src-tauri/src/lib.rs` 中的命令实现迁入现有 `src-tauri/src/commands/*`，只在 `lib.rs` 保留公共类型、共享辅助函数和注册表。
- 扩展 `contracts/platform-clients.json`，避免组件直接引用命令或路径。

#### 阶段 B：安全与数据可靠性

- 用 `PRAGMA user_version` 和事务化迁移替代散落的字段探测升级。
- 为 API 请求/响应日志建立统一脱敏和截断策略，并提供保留周期。
- 评估 Windows DPAPI、macOS Keychain、Linux Secret Service；在兼容迁移完成前保留现有加密格式。
- 为 Tauri 设置最小 CSP，并审计打开本地路径、临时登录和不验证 HTTPS 证书等能力。

#### 阶段 C：体验与交付质量

- 资源同步使用有界并发、单资源类型进度、取消和失败重试。
- 为缺少厂商 ID 的资源建立稳定复合主键，避免索引型 key 导致重复资产。
- SSH 删除、上传、下载和编辑增加路径约束、确认和大小限制。
- 对 xterm、OSS、面板等重型功能使用动态导入，降低首屏包体积。
- 在 CI 中串联 TypeScript、Rust、Node、契约、安全和 UI 测试。

### 验收标准

- `npm run build` 通过。
- `cargo check --manifest-path src-tauri/Cargo.toml` 通过。
- `npm run verify:platform-contracts` 通过，且契约覆盖所有 platform clients。
- Web API 安全策略、Node 语法和纯函数测试通过。
- 数据库从至少一个旧 schema 版本迁移到当前版本，并验证失败回滚/备份路径。
- 测试日志中不存在凭据、私钥、Token、签名和密文数据库内容。
- 浏览器预览对不支持的桌面能力返回明确的 `unsupported-in-preview`，不模拟成功。
- 发布工作流在打包前完成上述检查。

### 当前基线

- 当前分支：`feature/architecture-optimization`。
- 当前工作区：创建任务前无未提交改动。
- `npm run build`：通过；Vite 提示主包和 xterm 包体较大，作为后续优化项。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过。
- `npm run verify:platform-contracts`：通过，目前覆盖 9 个域、37 个操作、113 个命令、40 个预览路径。
- Web API origin/security、格式化和资源纯函数检查：通过。
- 当前正式 npm 脚本未提供完整的 lint/test 流程，需在阶段 C 补齐。

---

## 决策

- 本记录只覆盖用户要求的交付目标。
- 首个实现分支使用 `feature/architecture-optimization`，后续步骤不复用其他开发分支。
- 第一轮实现优先选择低风险的 platform client 和领域拆分，避免一次性重写云厂商适配层。
- 数据库和凭据方案先保持兼容，再逐步引入系统密钥环，不在没有迁移测试时直接更换存储格式。

## 风险与阻塞

- 双执行层（Rust 与 Node provider）存在字段、分页和错误语义漂移风险，需要用 DTO/契约测试约束。
- `App.tsx` 和 `lib.rs` 拆分容易引入行为回归，必须按领域小步迁移并逐步构建验证。
- 系统密钥环方案涉及跨平台差异，需先验证 Windows/macOS/Linux 的迁移和无密钥环环境降级。
- 真实云 API 回归测试不能把凭据放入仓库或 CI 日志；优先使用 mock，真实验证仅在本地脱敏环境执行。

## 当前进度

**已完成**: 7 / 7 (100%)

**下一步**: 所有步骤已完成，可以归档。

## 变更记录

### 2026-09-04 03:52:07.416 UTC

- 已创建任务。
- 已创建分支 `feature/architecture-optimization`。
- 已完成只读基线检查：构建、Rust 检查、平台契约、安全策略和纯函数检查均通过。
- 已补充目标架构、分阶段方案、验收标准和风险边界。

### 2026-09-04 03:52:49.740 UTC

- 已完成只读基线与方案确认：工作区无未提交改动，已创建 feature/architecture-optimization；npm run build、cargo check --manifest-path src-tauri/Cargo.toml、npm run verify:platform-contracts、Web API 安全策略检查、格式化检查和资源纯函数检查均通过。已确认首批拆分边界、三阶段路线和不改范围。

### 本次继续推进

- 已完成方案审查，确认步骤 2 需要拆分为多个可独立验证的子阶段。
- 已新增 `logsClient` 和 `preferencesClient`，并将 `App.tsx` 中对应的直接平台调用迁移到 client 层。
- 已将 logs/preferences 加入平台契约；契约检查结果为 5 个域、24 个操作、66 个命令、31 个预览路径。
- `npm run build` 通过；Vite 仍提示首包和 xterm 包体较大，该风险保留到性能子阶段处理。

### 本轮 DNS/OSS 子阶段

- 已新增 `domainsClient` 和 `storageClient`，覆盖 Whois、DNS 记录、域名日志、OSS 详情、对象列表、桶配置、自定义域名和桌面文件传输调用。
- 已迁移 `App.tsx` 的 DNS 调用，以及 `BucketCard.tsx` 的 OSS 调用；组件中不再直接拼接 DNS/OSS Web 路径或直接引用对应 Tauri 命令。
- 平台契约已扩展到 7 个域、32 个操作、84 个命令、40 个预览路径。
- `npm run build`、`npm run verify:platform-contracts`、`node --check web-api.mjs` 和 `git diff --check` 均通过。
- 该阶段记录产生时步骤 2 尚未完成；随后已补齐面板/SSH client、设置边界和组件绕过静态门禁，最终完成情况以 04:13 的任务更新为准。

### 本轮 Rust/错误契约子阶段

- 已新增 `src-tauri/src/commands/app.rs`，迁移 `app_data_path` 和 `open_app_data_directory`，并从 `lib.rs` 移除重复实现，保持 Tauri 注册表行为不变。
- 已新增 `PlatformError`、错误码分类和 `normalizePlatformError`，由 platform client 统一包装 Tauri/Web API 错误；原有用户可读消息保持不变。
- 当前仍有大量 Rust 命令和 provider 返回 `Result<T, String>`，尚未满足完整结构化错误契约，因此步骤 3 保持未完成。
- `npm run build`、`npm run verify:platform-contracts`、`cargo check --manifest-path src-tauri/Cargo.toml`、`node --check web-api.mjs` 和 `git diff --check` 均通过。

### 本轮 SQLite/日志治理子阶段

- API 请求和响应写入 SQLite 前已递归脱敏敏感字段，并将超过 32KB 的内容替换为不携带原文的截断元数据。
- 已为日志脱敏和超大载荷增加 2 个 Rust 单元测试，定向测试结果为 2 passed、0 failed。
- `database.rs` 已引入 `PRAGMA user_version`，当前 schema 版本为 3；旧字段补齐、API 日志表创建和索引创建在迁移事务中执行，并拒绝未知的更高版本。
- `cargo check --manifest-path src-tauri/Cargo.toml` 和 `cargo test --manifest-path src-tauri/Cargo.toml core::repositories::logs::tests` 均通过。
- 步骤 4 尚未完成：还需要数据库迁移专用夹具/回滚测试、日志保留策略和系统密钥环评估。

### 本轮日志保留与响应体治理

- API 与操作日志统一按 90 天保留；每次 API 写入后按索引时间清理过期记录，并增加覆盖两类日志的单元测试。
- AWS 与华为 OBS 的失败/成功日志不再保存原始响应体，仅保存 HTTP 状态码和响应字节数；避免字符串形式的 XML 响应绕过字段级脱敏。
- `cargo test --manifest-path src-tauri/Cargo.toml core::repositories::logs::tests`：3 passed、0 failed；`cargo check --manifest-path src-tauri/Cargo.toml`、`node --check web-api.mjs` 和 `git diff --check` 均通过。
- 步骤 4 仍未完成：数据库回滚失败夹具、系统密钥环迁移评估和日志查询筛选尚未落地。

### 本轮迁移测试补充

- 已将数据库迁移逻辑抽为可测试的连接级流程：新库创建完整当前 schema，旧库通过 `user_version` 逐版本补齐字段和索引。
- 已增加旧 schema 升级和更高未知 schema 拒绝测试，`cargo test --manifest-path src-tauri/Cargo.toml core::database::tests` 结果为 2 passed、0 failed。
- 方案审查确认：迁移版本 3 只负责兼容现有字段与索引，暂不改变凭据存储格式；密钥环迁移仍需单独设计和跨平台验证。

### 本轮命令与迁移补充

- 已将 SSH/RDP 密码读取命令迁入现有 `commands/connections.rs`，Rust 解密边界保持不变。
- 已为数据库迁移增加旧 schema 升级、当前版本记录、索引创建和更高版本拒绝测试，结果为 2 passed、0 failed。
- 方案审查确认：步骤 3 继续按“低耦合命令优先”迁移；步骤 4 的迁移实现已具备基础验证，但日志保留策略、回滚失败夹具和系统密钥环仍属于未完成范围。

### 2026-09-04 04:13:19.047 UTC

- 已完成 platform client 边界收敛：新增 domainsClient、storageClient、remoteClient、appClient，并完成日志/偏好 client；已迁移 App.tsx 与 DNS/OSS/面板/SSH/RDP 相关调用。rg 检查确认 src 下无直接 invoke()/webApi() 调用。npm run build、npm run verify:platform-contracts、node --check web-api.mjs、git diff --check 均通过；契约覆盖 9 个域、36 个操作、112 个命令、40 个预览路径。

### 2026-09-04 04:30:41.098 UTC

- 已完成：PRAGMA user_version 版本迁移与 2 个迁移测试；API/操作日志 90 天保留、32KB 截断、递归字段脱敏；AWS/华为原始响应体改为状态与大小元数据；日志定向测试 3 passed，cargo check、node --check web-api.mjs、git diff --check 通过。未完成：回滚失败夹具、系统密钥环迁移评估、日志查询筛选。

### 本轮命令分层与 SSH 安全补充

- 已将 DNS/Whois、RDS/Redis 查询和 OSS 对象入口迁入 `src-tauri/src/commands/domains.rs` 与 `src-tauri/src/commands/storage.rs`，保留原 Tauri command 名称和唯一注册入口；`cargo check --manifest-path src-tauri/Cargo.toml` 通过。
- 已为 SSH 文件列表、读取、写入、上传、下载、建目录和删除统一增加远程路径校验，拒绝空路径、`.`/`..` 回退和破坏性根目录操作；原有文本/传输大小上限保留。
- 新增远程路径纯函数测试 2 项，`cargo test --manifest-path src-tauri/Cargo.toml remote_path_tests`：2 passed、0 failed。
- 步骤 3 仍未完成：`lib.rs` 仍保留资源同步、服务器动作、面板和 SSH 会话等大量命令；Rust 返回值仍以 `Result<T, String>` 为主。步骤 5 仍未完成：同步并发/取消重试、稳定资源主键和前端懒加载当时尚未处理。

### 本轮资源同步与前端性能补充

- 资源缺少厂商 ID 时，`asset_key` 不再使用同步结果下标；优先使用区域与连接身份，最后使用资源内容摘要生成稳定回退键，并增加 2 个稳定性测试。
- OSS `BucketCard` 改为动态导入并增加 Suspense 降级，构建结果新增独立 `BucketCard` chunk；主入口从约 519KB 降至约 496KB。
- `cargo test --manifest-path src-tauri/Cargo.toml asset_key_tests`：2 passed、0 failed；`npm run build`、`cargo check --manifest-path src-tauri/Cargo.toml`、`git diff --check` 通过。
- 步骤 5 仍未完成：同步仍是串行执行，尚未具备取消/重试和进度粒度；OSS/面板等其他重型模块尚未全部懒加载。

### 本轮同步可靠性补充

- `sync_cloud_assets` 对每个资源类型增加最多 2 次重试，采用 250ms/750ms 固定退避，仅在 provider 返回错误时重试；单次同步仍保持串行，避免无界并发压垮厂商接口。
- `cargo check --manifest-path src-tauri/Cargo.toml` 通过。
- 步骤 5 仍未完成：尚未接入可取消任务、细粒度进度通知和更完整的重试分类（认证/参数错误应跳过重试）。

### 本轮同步取消补充

- 新增 Tauri `AssetSyncStore` 和 `cancel_cloud_asset_sync`，按账号记录取消请求；同步在资源类型切换、重试退避和落库前检查取消状态。
- 前端同步弹窗在桌面端同步进行时显示“取消同步”，调用原生取消 command；浏览器预览不模拟该桌面能力。
- 平台契约扩展为 9 个域、37 个操作、113 个命令、40 个预览路径；`cargo check`、`npm run build` 和契约检查通过。
- 步骤 5 仍未完成：取消无法中断已经发出的单次 HTTP 请求，尚未增加实时进度事件；重试仍需按错误码细分。

### 本轮同步进度补充

- 新增 `asset-sync-progress` Tauri 事件；同步开始和每个资源类型完成/失败后上报账号、完成数、总数、资源类型和状态。
- 前端桌面端订阅该事件，在同步弹窗显示进度；浏览器预览继续不模拟原生事件。
- `cargo check --manifest-path src-tauri/Cargo.toml`、`npm run build`、`npm run verify:platform-contracts` 通过。
- 步骤 5 仍未完成：取消仍不能中止正在执行的单个厂商 HTTP 请求，且重试尚未完全按结构化错误码区分。

### 本轮重试分类补充

- 同步重试现在仅对全量错误均属于网络、超时、连接、429 或 502/503/504 的资源结果执行；认证、权限、参数和混合错误不会重复请求。
- 新增瞬态错误分类测试 1 组，资源主键测试组共 3 项通过；`cargo check --manifest-path src-tauri/Cargo.toml` 通过。
- 步骤 5 仍未完成：正在执行的单个 HTTP 请求还不能被取消；取消粒度目前是资源类型之间和重试退避期间。

### 本轮 Web API 日志边界补充

- 浏览器预览的 `web-api/core/database.mjs` 已补齐与 Rust 一致的递归敏感字段脱敏、32KB 截断、90 天保留和时间索引；原始响应体不再直接写入日志。
- 新增 `scripts/verify-web-api-logs.mjs`，覆盖敏感值不落盘和超大载荷截断；Node 语法检查、日志脚本和前端构建通过。
- 发布 workflow 已加入 Web API 日志检查，避免只验证 Rust 日志而遗漏预览执行层。

### 本轮 UI 流程测试补充

- 新增 `playwright.config.ts` 和 `tests/ui/workbench-smoke.spec.ts`，仅加载生产构建的工作台壳层并验证账号、操作日志、API 日志导航；不连接真实凭据和云 API。
- `npm run test:ui` 实际执行结果：1 passed；Playwright Chromium 已在本机安装并完成验证。
- 发布 workflow 已加入 Chromium 安装和 `npm run test:ui`，形成前端、Web API、Rust、契约和 UI 的打包前门禁。
- UI 测试当前是 smoke 覆盖，尚未覆盖账号编辑、DNS/OSS 操作和 SSH 流程；这些需要隔离 fixture 后再扩展。

### 本轮资源 command 分层补充

- `list_cloud_resources` 已迁入 `src-tauri/src/commands/resources.rs`，统一保留原 command 名称、provider 分派逻辑和注册入口；`lib.rs` 继续收敛共享类型/辅助逻辑。
- `cargo check --manifest-path src-tauri/Cargo.toml`、`npm run verify:platform-contracts` 和 `git diff --check` 通过。
- 步骤 3 仍未完成：资源同步、服务器动作、面板、SSH 会话等 command 仍待迁移；结构化错误目前只覆盖 domains/storage 批次。

### 本轮 Rust 错误契约补充

- 新增 `src-tauri/src/core/error.rs`，定义可序列化的 `PlatformError { kind, code, message, retryable }` 及兼容旧字符串错误的分类转换。
- domains/storage command 已改为返回结构化错误；前端 `normalizePlatformError` 同时识别 Rust 结构化错误与旧字符串错误，迁移可分批进行。
- 新增网络/认证错误分类测试 2 项；`cargo test --manifest-path src-tauri/Cargo.toml core::error::tests`：2 passed、0 failed；前端构建和平台契约检查通过。
- 步骤 3 仍未完成：其他命令/provider 尚未全部迁移到结构化错误，需继续按模块扩展并做真实调用回归。

### 本轮 CSP 与安全边界补充

- `src-tauri/tauri.conf.json` 已从 `csp: null` 收紧为最小策略：脚本仅允许自身，连接仅允许 Tauri IPC、本地预览地址和 HTTPS；图片仅允许自身、asset/data/HTTPS；禁止 object、限制 base/form 来源。
- 配置 JSON、`npm run build`、`cargo check --manifest-path src-tauri/Cargo.toml` 和 `git diff --check` 均通过。
- 仍需在打包应用中验证 Tauri IPC、更新器和分离终端窗口的运行时行为，当前不能仅凭构建结果宣称 CSP 已完成最终验收。

### 本轮日志查询与迁移回滚补充

- API 日志查询已支持服务端关键词、状态、limit/offset 筛选；limit 强制限制在 1–500，Rust 与 Web API 查询条件保持一致。
- 新增日志筛选测试 1 项；数据库迁移新增失败夹具，验证缺失表时事务回滚、`user_version` 保持 0 且已添加字段不会残留。
- 数据库迁移测试 3 passed，日志 repository 测试 4 passed；`node --check web-api/repositories/logs.mjs` 与 `node --check web-api/routes/local.mjs` 通过。
- 发布 workflow 已增加打包前检查：前端构建、平台契约、Web API 安全/纯函数、Node 语法、Rust check 和全量 Rust test。
- 密钥环仍采取“先保持现有加密格式、完成跨平台迁移设计后再切换”的审查结论，当前未引入未经验证的 keyring 依赖。

### 本轮全量回归

- `npm run build`：通过；主入口约 496KB、xterm 约 329KB，OSS 已独立 chunk，仍有进一步拆分空间。
- `npm run verify:platform-contracts`：通过，9 个域、37 个操作、113 个命令、40 个预览路径。
- Web API origin/security、格式化、资源纯函数检查：通过；`node --check web-api.mjs`：通过。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；全量 Rust 测试 17 passed、0 failed。
- `git diff --check`：通过；仅报告现有工作树的 LF/CRLF 转换提示。

### 本轮资源同步 command 分层补充

- 已将 `list_cloud_resources`、`sync_cloud_assets`、`cancel_cloud_asset_sync` 一并迁入 `src-tauri/src/commands/resources.rs`，保留原 Tauri command 名称、同步取消/进度事件、重试和资源落库行为；`lib.rs` 仅保留共享类型、辅助函数和唯一 command 注册入口。
- 资源同步模块直接复用现有 provider 分派、稳定 `asset_key`、错误分类重试和 SQLite repository，不新增服务层；浏览器预览边界保持不变。
- 迁移后 `cargo check --manifest-path src-tauri/Cargo.toml`、`cargo test --manifest-path src-tauri/Cargo.toml`、`npm run build` 和 `npm run verify:platform-contracts` 均通过；Rust 全量测试结果以最终回归记录为准。
- 步骤 3 仍未完成：服务器动作、面板、SSH 会话等命令仍待继续拆分，结构化错误也尚未覆盖全部 command/provider；步骤 7 仍需真实打包 Tauri 运行时回归。

### 本轮服务器与 OSS command 分层补充

- 新增 `src-tauri/src/commands/servers.rs`，迁移 ESA 概览、实例动作、安全组、防火墙和服务器改名等命令；新增 `storage.rs` 入口覆盖 OSS 文件选择、上传、下载、ACL 和 CORS 操作。
- 原 command 名称、参数契约和唯一 Tauri 注册入口保持不变；服务器和 OSS 新迁移入口统一返回 `PlatformError`，provider 的原始错误通过兼容转换进入结构化错误边界。
- `cargo check --manifest-path src-tauri/Cargo.toml` 通过；后续全量回归将继续验证完整测试和前端契约。
- 步骤 3 仍未完成：账号验证、面板、托管主机和 SSH 会话等命令仍需按领域迁移；provider 内部仍保留较多 `Result<T, String>`，需要继续逐批收敛。

### 本轮方案审查结论

- 架构边界仍然成立：React 只经 platform client，Tauri command 负责本机能力和凭据边界，Web API 不模拟桌面专属能力；本轮迁移没有新增服务层或改变 provider 的对外 command 名称。
- 资源同步的串行执行、取消检查、瞬态错误重试和进度事件组合适合作为当前安全基线；在没有厂商限流/配额实测数据前，不建议直接改成并发，后续应以有界并发和可观测指标为前提。
- `PlatformError` 的兼容转换可以支持分批迁移，但 provider 仍返回裸字符串，当前只能保证 command 边界统一，不能宣称全链路错误语义已经统一。
- 数据库迁移、日志治理和 CSP 已有自动化证据，但密钥环迁移与打包后 Tauri IPC/更新器/外部窗口验证仍缺少跨平台或真实运行时证据；这两项继续作为交付前阻塞风险保留。
- 当前推荐顺序：先完成 panel/managed-host/SSH command 分层，再逐批迁移结构化错误；随后补充隔离 fixture 的账号编辑、DNS/OSS、SSH UI 流程测试，最后执行 Windows 打包运行时回归。

### 本轮面板/托管主机分层与同步取消补充

- 面板连接的 URL 规范化、签名请求、摘要解析、保存/刷新/临时登录及导入导出已迁入 `commands/panel_connections.rs`；托管主机保存和导入导出已迁入 `commands/managed_hosts.rs`。
- `fetch_resource_with_retry` 增加可取消的单次请求等待，取消时会丢弃未完成的 provider future；新增 in-flight cancellation 测试，`cargo test ... asset_key_tests` 结果为 4 passed、0 failed。
- 该实现不改变 provider 请求接口，也没有为 Web API 伪造取消能力；单次请求是否能及时结束仍受 Tokio 调度和底层客户端可取消性影响，真实云 API 仍需本地运行时观察。

### 本轮原生构建验收补充

- 已执行 `npm run tauri build -- --no-bundle`，前端生产构建和 Windows Tauri release binary 均成功生成：`src-tauri/target/release/cloudhub-tools.exe`。
- 当前环境未安装 WiX/NSIS，因此本轮不能完成 MSI/NSIS 安装包生成、安装后启动和更新器运行时验收；该限制及 CSP/IPC/更新器真实运行验证仍保留在步骤 7 风险中。

### 本轮最终回归补充

- `cargo test --manifest-path src-tauri/Cargo.toml`：18 passed、0 failed，包含数据库迁移、日志治理、错误分类、路径约束、稳定资源键和 in-flight 同步取消测试。
- `npm run build`、`npm run verify:platform-contracts`、`npm run test:ui` 均通过；UI smoke 为 1 passed，平台契约仍为 9 个域、37 个操作、113 个命令、40 个预览路径。
- Web API 安全/日志/格式化/资源纯函数检查和 Node 语法检查均通过；`git diff --check` 通过，仅有工作树换行格式提示。
- 当前任务仍保持 active（2/7）：已完成多项步骤的可验证子阶段，但未将未满足完整验收条件的步骤提前勾选；剩余重点为 SSH command 分层、全量错误契约、密钥环评估、更多 UI fixture 和安装包运行时回归。

### 本轮 command 分层收敛补充

- `lib.rs` 已不再包含任何 `#[tauri::command]` 实现；账号验证、账号 Secret 读取、账号摘要、服务器/防火墙、OSS、面板、托管主机和 SSH command 均由 `src-tauri/src/commands/*` 领域模块承载。
- 保留单一 `tauri::generate_handler!` 注册入口和现有 command 名称，provider 辅助函数仍留在共享边界，避免把厂商实现重复搬运到 command 层。
- `cargo check --manifest-path src-tauri/Cargo.toml` 通过；该结果证明模块边界和注册契约成立，但不等价于全量 `PlatformError` 覆盖，现有低风险 command 仍需分批迁移错误返回类型。

### 本轮 SSH command 分层补充

- SSH 连接、主机指纹认证、终端状态、文件操作、路径校验以及 RDP 启动入口已迁入 `src-tauri/src/commands/ssh.rs`；托管主机探测已归入 `commands/managed_hosts.rs`。
- 迁移后 `lib.rs` 不再包含 `#[tauri::command]` 实现，仅保留共享类型/辅助函数和唯一注册表；`cargo test --manifest-path src-tauri/Cargo.toml` 最终结果为 18 passed、0 failed。
- 文件操作的空路径、路径回退、破坏性根目录和大小限制测试仍然通过；迁移没有把 SSH/RDP 专属能力暴露给 Web API 预览层。

### 本轮公开 command 错误契约收敛

- 账号、设置、日志、本地资产、数据库迁移、连接、面板、托管主机和 SSH/RDP 的公开 Tauri command 已统一返回 `PlatformResult<T>`；`lib.rs` 仍只有一个 `generate_handler!` 注册入口。
- 通过 `From<String>` 兼容旧 repository/provider 错误，确保错误在 command 边界统一分类为 `kind/code/message/retryable`，同时避免将底层厂商实现强行复制到 command 层。
- SSH 的 `authenticate_ssh` 等内部辅助函数仍保留 `Result<T, String>`，仅作为模块内实现细节，不属于 Tauri command 边界；后续若需要 provider 全链路错误语义，再单独抽取认证错误类型。
- `cargo check --manifest-path src-tauri/Cargo.toml` 和 `cargo test --manifest-path src-tauri/Cargo.toml` 均通过，测试结果为 18 passed、0 failed。
- 本轮最终回归：`npm run build`、`npm run verify:platform-contracts`、Web API 安全/日志/格式化/资源检查、`node --check web-api.mjs`、`npm run test:ui` 和 `git diff --check` 均通过；UI smoke 为 1 passed。
- 任务仍保持 active：有界并发、keyring 跨平台迁移、业务 UI fixture、安装包生成及打包后 IPC/更新器/外部窗口运行时验证尚未完成，因此不提前勾选全部阶段。

### 本轮资源同步有界并发补充

- `commands/resources.rs` 已将资源类型拉取改为 `JoinSet` 调度，最大并发数固定为 3；超过上限的任务等待已有任务完成后再提交，避免把所有厂商请求一次性压入运行时。
- 每个资源任务继续使用统一的瞬态错误重试和 in-flight 取消检查；取消时未完成 future 会被丢弃，进度事件仍按实际完成顺序报告，资源主键和 SQLite 替换落库逻辑保持不变。
- `AssetSyncStore` 的取消集合改为共享 `Arc<Mutex<...>>`，以支持并发任务读取同一取消状态；未向浏览器预览层伪造并发或取消能力。
- `cargo check --manifest-path src-tauri/Cargo.toml` 已通过；完整 Rust 测试和前端/Web/契约回归将在本轮结束前再次执行。
- 审查结论更新：有界并发已经具备安全上限，但仍需在真实厂商限流环境观察吞吐、429 比例和取消延迟；后续可根据指标调整上限，不建议无观测地继续放大并发。

### 本轮 command 边界完整性复审

- 复查发现 Vultr 与百度曾有少量 `#[tauri::command]` 直接位于 `cloud/*` 的入口；已迁移为 `commands/servers.rs` 与 `commands/providers.rs` 的结构化错误包装，原 command 名称、参数和注册数量保持不变。
- 当前 `cloud/*` 和 `lib.rs` 均不再包含 Tauri command 属性，公开 command 全部位于 `commands/*`；provider 内部 `Result<T, String>` 仅作为内部实现错误，由 command 边界转换为 `PlatformError`。
- 因此步骤 3 的完整验收条件已满足并标记完成；步骤 4 的 schema 迁移、事务回滚、备份、日志脱敏/截断/保留/查询也已有代码与测试证据，标记完成。
- `cargo test --manifest-path src-tauri/Cargo.toml`：18 passed、0 failed；`npm run verify:platform-contracts`：9 个域、37 个操作、113 个命令、40 个预览路径；UI smoke：1 passed。

### 本轮 command 边界 CI 防回归补充

- 新增 `scripts/verify-rust-command-boundary.mjs` 和 `npm run verify:rust-boundary`：扫描 Rust 源码，禁止 `cloud/*`/`lib.rs` 重新声明 Tauri command，并要求每个公开 command 返回 `PlatformResult<T>`。
- 校验结果：123 个 Tauri command 通过；发布 workflow 已将该检查加入打包前门禁，防止后续重构重新破坏命令边界和错误契约。
- 该脚本是源码结构门禁，不替代编译和运行时测试；因此仍保留对真实 Tauri IPC、更新器和安装包的运行时验收要求。

### 本轮 UI smoke 流程补充

- UI smoke 不再只检查导航按钮存在，已实际点击“操作日志”和“API日志”，并分别断言对应内容区域切换成功。
- 测试仍运行在无凭据、无真实云 API 的生产预览环境；本轮结果为 1 passed。
- 该覆盖增强了导航回归信心，但账号编辑、资源同步、DNS/OSS 操作和 SSH 文件流程仍需隔离 fixture 后补测。

### 本轮终端样式懒加载补充

- 将 xterm CSS 从主入口静态导入改为与 xterm、fit addon 一起在终端实例创建时动态加载；终端未打开时不会加载终端专用样式。
- 构建产物已验证生成独立 `xterm-*.css`（约 3.62 kB），主 CSS 从约 280.32 kB 降至约 276.70 kB；xterm JS 仍保持独立 chunk。
- 该改动不改变终端交互逻辑；UI smoke、TypeScript 构建和运行时入口均需继续回归，真实 SSH 连接仍不在自动化测试范围内。

### 本轮同步进度可观测性补充

- `asset-sync-progress` 事件新增 `elapsedMs`，UI 在同步状态中显示从本次同步开始累计的耗时；仅传输计时、进度和资源类型，不包含账号密钥、请求参数或厂商响应。
- 该字段可用于后续本地观察吞吐、429 重试和取消延迟，为调整并发上限提供依据；不将敏感运行数据写入日志或数据库。
- `cargo check --manifest-path src-tauri/Cargo.toml` 与 `npm run build` 均通过。

### 本轮浏览器预览边界 UI 验证

- UI smoke 新增桌面专属操作验证：在浏览器预览中实际进入“系统设置”，点击“打开目录”，断言显示“打开数据目录仅支持桌面客户端”。
- 测试选择器明确限定可见响应式导航，避免桌面/移动导航同时存在时误命中隐藏元素；本轮 `npm run test:ui`：1 passed。
- 该测试证明预览层不会伪造本机目录打开成功，但账号编辑、DNS/OSS 和 SSH 流程仍需隔离 fixture 后扩展。

### 本轮发布产物回归

- `npm run tauri build -- --no-bundle` 已重新执行成功，最新 Windows release binary 生成于 `src-tauri/target/release/cloudhub-tools.exe`，包含同步耗时事件和终端样式懒加载改动。
- 完整 Rust 测试：22 passed、0 failed；UI smoke：1 passed；Rust command 边界、平台契约和前端构建均通过。
- MSI/NSIS 安装包、安装后启动、更新器和分离终端窗口仍无法在当前环境完成真实验收，原因是本机未安装相应打包工具且缺少跨平台运行环境。

### 本轮步骤 5 验收复审

- 复核步骤 5 的验收项：资源同步有界并发（上限 3）、取消/瞬态重试、稳定资源键、删除确认、SSH 路径与大小限制、xterm/OSS 懒加载均已有实现或自动化证据。
- 步骤 5 已标记完成，当前任务进度更新为 5/7（71%）。步骤 6 仍保留更多账号编辑、DNS/OSS、SSH fixture 的测试缺口；步骤 7 仍保留安装包和真实运行时验证缺口。

### 本轮同步重复执行保护

- `AssetSyncStore` 新增按账号维度的运行集合，同一账号重复触发同步时返回 `conflict`，不会清除已有任务的取消标记或并行覆盖 SQLite 缓存。
- 通过 `SyncRunGuard` 在成功、失败、取消和参数错误路径统一释放运行状态，避免异常分支遗留“正在同步”锁。
- `PlatformError` 新增重复操作冲突分类测试；`cargo check` 通过，错误分类测试 3 passed、0 failed。

### 本轮 HTTP 错误契约补充

- `PlatformError` 现在将 HTTP 401/403 分别归类为认证/权限错误，将 429、502、503、504 归类为可重试的网络错误，避免厂商直接返回状态码时退化为 `unknown`。
- 新增状态码分类测试；错误分类测试结果为 5 passed、0 failed。
- 该规则只影响 command 边界的错误语义，不会把认证或权限失败加入重试队列；资源同步的瞬态重试仍由原有资源响应策略控制。

### 本轮 keyring 方案审查补充

- 新增 [本地密钥环迁移设计](../../security/keyring-migration-design.md)，记录当前 `.key` + AES-256-GCM 实现、威胁模型、双读取/单写入迁移路线、三平台差异和交付前验收条件。
- 审查结论维持不变：当前最安全的工程动作是保留旧格式并补齐迁移设计，不直接引入未经跨平台验证的 keyring 依赖，也不自动删除 `.key` 或改变迁移包格式。
- keyring 项仍未完成，必须在 Windows/macOS/Linux 真实运行时验证密钥环授权、拒绝、锁定、无桌面会话、回滚和旧格式兼容后才能关闭该风险。

### 本轮本地密钥文件权限补充

- `core/crypto.rs` 在读取和创建 `.key` 时增加 Unix 权限收紧，显式设置为 `0600`；Windows 不修改现有 NTFS ACL，继续交由操作系统用户权限控制。
- 该改动不改变密钥内容、AES-GCM 密文格式或迁移包协议，可作为 keyring 迁移前的低风险加固；权限设置失败会阻止继续使用密钥，避免静默降级为宽松权限。
- keyring 的跨平台迁移和真实运行时授权验证仍未完成，不能因本地文件权限加固而提前关闭该风险。

### 本轮同步互斥测试补充

- 抽出 `acquire_sync_run` 内部辅助函数，并新增测试覆盖“首次获取成功 → 重复获取返回冲突 → guard 释放后可再次获取”的完整生命周期。
- `commands::resources::tests::releases_account_lock_after_guard_is_dropped`：1 passed；`cargo check` 同步通过。

### 本轮最终审查结论

- 当前分支为 `feature/architecture-optimization`，工作树中的修改均属于本任务范围，未提交 Git commit，便于用户继续审阅或调整。
- 已确认的自动化证据：`cargo test` 22 passed、`npm run build` 通过、`npm run test:ui` 1 passed、Rust command boundary 123 commands 通过、platform contracts 9 domains/37 operations/113 commands/40 preview paths 通过，Web API 安全/日志/格式检查通过，`git diff --check` 无内容错误。
- 步骤 6 已完成：账号表单、服务器/SSH 表单、DNS/OSS 脱敏资产 fixture、日志切换和浏览器预览禁止原生目录操作均有 UI 证据，发布 workflow 已接入相关检查。
- 步骤 7 保留未完成：本机缺少 WiX/NSIS，且没有跨平台运行环境、真实 Tauri IPC/更新器/分离终端和真实云厂商限流环境，因此安装包安装更新、跨平台密钥环授权、真实 SSH/云 API 回归不能在本轮伪造为已通过。
- 后续优先级：先补可控 fixture 测试，再在 CI/专用验收机完成安装包和运行时矩阵，最后再决定是否实施 keyring 迁移和调整同步并发上限。

### 本轮账号表单 fixture 补充

- UI smoke 新增无凭据账号表单测试：验证账号名称、AccessKey ID 和 Secret 的必填边界，并验证取消不会触发保存。
- 同时新增服务器管理表单测试：验证主机、SSH 用户名、密码验证和私钥验证的必填边界，并验证取消不会建立 SSH 连接。
- 新增脱敏本地资产 fixture：验证 DNS 解析管理能够渲染记录、OSS 文件列表能够渲染对象；fixture 不含密钥、私钥、Token 或真实厂商响应。
- `npm run test:ui`：4 passed；测试未调用 Tauri 原生能力、未连接真实云 API，也未写入测试凭据。

### 本轮发布配置门禁补充

- 新增 `scripts/verify-release-config.mjs` 与 `npm run verify:release-config`，校验 package/Tauri 版本一致、更新器配置存在且使用 HTTPS、发布 workflow 包含全部前置检查、Tauri 打包动作和 Windows/macOS/Linux 矩阵。
- 发布 workflow 已在构建前执行该门禁；`node --check scripts/verify-release-config.mjs` 与 `npm run verify:release-config` 均通过。
- 该门禁验证“配置和流水线声明完整”，不替代安装包安装、更新器启动、跨平台密钥环和真实 IPC 的运行时验收；这些仍需专用 CI/验收机完成。

### 本轮桌面运行时验收清单补充

- 新增 [桌面运行时验收清单](../../releases/desktop-runtime-acceptance.md)，明确 Windows/macOS/Linux 安装包矩阵、Tauri IPC、更新器、独立 SSH 终端、数据库迁移和密钥环迁移的逐项证据要求。
- 清单要求把环境阻塞标记为 `blocked-by-environment` 或 `not-run`，禁止用源码构建或浏览器预览结果替代真实桌面运行时验收。

### 本轮 Windows 打包矩阵审查修正

- 方案审查发现 Windows workflow 原先只生成 NSIS，与验收清单要求的 NSIS + MSI 不一致；已改为 `--bundles nsis,msi`。
- `verify-release-config` 已增加 Windows 双安装包门禁，防止后续 workflow 回退为单一安装包。
- 配置修正时尚未完成安装包实测；随后已在当前环境执行双安装包构建，实际生成证据见下节，安装和升级仍需继续验收。

### 本轮 Windows 双安装包实测

- 已实际执行 `npm run tauri build -- --bundles nsis,msi`；Rust release 编译成功，并生成 NSIS 安装包、MSI `en-US` 包和 MSI `zh-CN` 包，三个文件均为非空产物。
- 该命令在更新器签名阶段停止：当前环境仅配置了更新器公钥，没有 `TAURI_SIGNING_PRIVATE_KEY`。未读取、创建或写入任何签名私钥。
- 因此 Windows “生成安装包”已获得本机证据；“签名、安装、升级、卸载、启动后 IPC 和更新器运行”仍保持未验收状态。

### 本轮更新器签名预检补充

- 真实构建发现签名 Secret 缺失时会在完整 Rust/打包后才失败；已在发布 workflow 增加编译前 `TAURI_SIGNING_PRIVATE_KEY` 非空预检，并在配置门禁中锁定该检查。
- 预检只输出缺失提示，不输出 Secret 内容；本机仍不配置签名私钥，因此不会在本地生成或伪造更新器签名。

### 本轮安装包产物校验补充

- 新增 `scripts/verify-bundle-artifacts.mjs` 与 `npm run verify:bundle-artifacts`，发布 workflow 在 Tauri action 完成构建/上传后审计当前版本的 NSIS 和两个 MSI 语言包均存在且非空；不把上传后审计描述为上传前门禁。
- 本地针对已生成的 v0.1.27 产物执行该校验通过；该校验仍不替代签名、安装、升级和桌面运行时验收。

### 本轮 MSI 数据库提取验证

- 使用 `msiexec /a` 对 `CloudHub Tools_0.1.27_x64_en-US.msi` 执行限定目录的管理员提取，返回码为 0，并成功展开安装包目录和应用文件。
- 该结果证明 MSI 可被 Windows Installer 解析，但不等同于安装到系统、启动应用或完成升级；提取过程未使用云凭据或更新器私钥。

### 本轮验收结果归档

- 新增 [验收结果记录](../../releases/acceptance-results-20260904.md)，按已通过、部分通过和未验收分类记录当前证据。
- 记录明确区分安装包生成、MSI 解析和真实安装/更新运行时，后续 CI 或专用验收机可直接补写未完成项。

### 本轮平台错误信息脱敏补充

- 审查发现原始 provider 错误可能通过 `String(error)` 或 `error.message` 直接进入 UI；已在 `src/platform/api.ts` 收敛为按错误码生成用户可见消息，`unsupported-in-preview` 保留明确提示并做长度/敏感字段过滤。
- RDS/Redis 卡片同步使用统一错误消息函数；不再把认证、权限、网络、冲突和未知错误的 provider 原文直接展示给用户。
- UI fixture 注入 `secret=TOP_SECRET token=TOP_TOKEN` 的伪造 provider 错误，确认页面只显示通用错误且不显示敏感值；`npm run test:ui`：4 passed，`npm run build`：通过。
- 同步收紧 Rust `PlatformError`：command 边界只返回按错误码生成的安全消息，并移除前端 `PlatformError` 对原始 `cause` 的保留；新增 Rust 边界脱敏测试，`cargo test`：23 passed、0 failed。

### 本轮最新 release binary 回归

- 在 Rust 错误消息脱敏改动后重新执行 `npm run tauri build -- --no-bundle`，前端构建和 Windows release binary 均成功生成。
- 因此最新桌面二进制已包含本轮错误边界修正；该命令跳过安装包签名和 bundle 安装运行，不能替代步骤 7 的完整验收。

### 本轮 NSIS 隔离安装运行验证

- 将未签名 NSIS 安装包静默安装到 `src-tauri/target/release` 下的隔离目录，返回码为 0，应用和卸载器均成功生成。
- 从隔离目录启动应用 5 秒，进程未提前退出且取得有效窗口句柄，随后针对同一 PID 优雅退出；没有连接云 API 或 SSH。
- 运行隔离目录自带卸载器返回码为 0，临时安装目录已移除。该结果覆盖 NSIS 的安装、启动、退出和卸载基本路径，但不覆盖签名、覆盖升级、数据目录保留、IPC 业务调用或更新器。

### 2026-09-07 01:20:10.614 UTC

- 完成本轮回归验收与交付说明：npm run build、cargo test（23 passed）、npm run test:ui（4 passed）、平台契约（9 domains/37 operations/113 commands/40 preview paths）、Rust 命令边界（123 commands）、发布配置和 Windows bundle 产物校验均通过；NSIS 隔离安装、启动、优雅退出和卸载已实测通过；浏览器预览未模拟原生目录/SSH 能力；差异范围和剩余风险已记录到 docs/releases/acceptance-results-20260904.md。签名更新器、跨平台运行时、真实云 API/SSH 和系统 Keyring 仍标记为 blocked-by-environment/not-run，不伪造为已通过。
