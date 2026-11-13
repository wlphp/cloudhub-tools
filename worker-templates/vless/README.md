# CloudHub VLESS 部署模板包

来源：用户提供的 `worker.fixed.js` 和 `deploy-cloudflare-vless.mjs`。这是面向 CloudHub 的适配包，未复制任何 Cookie、账号、固定 UUID 或密码。分发前需自行确认原始源码的使用许可。

应用内：Cloudflare → Workers → 新建 Worker → 选择 VLESS 模板 → 选择已激活域名 → 填写未使用的子域名和 Worker 名称 → 创建并部署。

部署使用账号已保存的 API Token；需要 Workers Scripts Read / Write、Zone Read、DNS Read。Cloudflare Custom Domains 自动处理域名绑定与证书，DNS/证书生效可能需要时间。只支持当前账号已接入并激活的域名，不修改域名注册商 NS，不覆盖已有 Worker、DNS 记录或域名绑定。部署成功不等于已验证代理连通性。

每次部署由后端生成随机 UUID 和订阅路径，作为 Worker Secret 注入，不写入模板源码、本地数据库或日志。首页返回 404，只有结果中的随机订阅地址返回 Clash / Mihomo YAML；请立即复制保存订阅地址，它包含访问凭据。关闭结果后可在 Cloudflare 控制台重新设置 SUB_TOKEN 获得新的订阅路径。

与原脚本的区别：仅启用 VLESS TCP + WebSocket + TLS；关闭固定密码 Trojan 和无认证协议，不允许在 URL 中指定上游代理。第三方优选入口与回退地址默认关闭，只有部署时明确勾选才启用；这些外部地址不由 CloudHub 管理，可用性无法保证。未自动安装、启动或测试 Mihomo。

## 独立部署

Node.js 22 或以上。使用环境变量 `CLOUDFLARE_API_TOKEN` 提供 Token，不将其写进参数、脚本或仓库。

```text
node deploy.mjs --account-id <Account ID> --zone-id <Zone ID> --hostname node.example.com --worker-name my-vless
```

可加 `--third-party` 明确开启原脚本的第三方入口。`node deploy.mjs --help` 不会访问网络。CLI 最后输出的订阅地址是用户主动请求的交付结果，包含访问凭据，请勿将其写入公共日志。

域名绑定失败时保留已部署 Worker，返回警告和订阅路径，避免重复创建或自动删除资源。请根据所选域名在控制台完成绑定。
