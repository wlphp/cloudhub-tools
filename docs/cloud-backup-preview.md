# 网页云备份调试

网页调试可在桌面数据管理或手机布局的“系统设置 → 导入数据 → 云端备份”中测试 WebDAV / S3 连接、保存配置、上传和下载 `.chdb` 文件。

使用 `npm run dev:mobile` 启动手机布局与本地 API；桌面布局使用 `npm run web:api` 和 `npm run dev`。更新后端接口后须重启本地 API，刷新页面。

1. 展开云端备份，填写存储地址、凭据、目录及配置名，测试并保存。
2. 点击“上传到云端”，确认后自动生成本机当前数据的 `.chdb` 快照并上传，无需选择文件。网页上传的是本地 API 所使用的数据库。首次遇到已存在的远端备份，必须先下载检查；之后使用 ETag 条件写入，避免覆盖其他设备的新备份。
3. 下载并校验后直接弹出与桌面端相同的恢复确认框，选择模块和恢复方式后点击“确定导入”。取消不会写入业务数据；确认恢复前自动保存本机快照。密码保护的云备份需先填写“云备份解密密码”。

网页执行真实存储请求，使用与原生端相同的远端路径：`<远程根目录>/v1/<配置名>/database.chdb`。WebDAV / S3 请求通过已有的本地 Node API 转发，沿用来源校验；不跟随携带凭据的重定向。文件上限 256 MB，上传下载均检查包格式，未加密码的包还检查数据库与恢复 key 的摘要。带密码的文件保持原样传输，密码验证在原生恢复流程中完成。

网页连接配置通过已有的本地加密工具，单独保存到 `cloud.sync.preview.config`，不修改原生端的 `cloud.sync.config`。未加密码的 `.chdb` 包包含恢复 key，持有文件即可恢复，应按完整备份保管。

网页不自动上传。网页上传与恢复通过本机 Rust 私有管道复用桌面快照生成、备份解析、密码校验、模块选择和加密恢复逻辑，不在 Node 中另做数据库覆盖。快照排除云同步连接配置；生成的临时备份由本地 API 直接上传，完成或失败后清理，不向浏览器返回恢复 key 或解密凭据。先运行 `cargo build --manifest-path src-tauri/Cargo.toml --features browser-debug --bin cloudhub-browser-database` 编译独立的本机辅助程序；默认 App 构建不包含此程序。预览十分钟过期，取消或辅助进程退出后清理临时副本。

网页仍使用原有的 `CloudHubTools` 数据目录；辅助程序的数据目录由启动它的 Node 进程指定，普通桌面调试程序仍使用独立的 `CloudHubTools-Dev`。恢复只影响当前网页连接的本机数据，不会恢复到远程手机。

验证命令：

```powershell
node --test tests/node/cloud-sync-preview.test.mjs tests/node/cloud-sync-routes.test.mjs
npm run build
npm run build:mobile
npx playwright test --config playwright.mobile.config.ts tests/mobile-ui/mobile-cloud-sync-preview.spec.ts tests/mobile-ui/mobile-sync-flow.spec.ts
```
