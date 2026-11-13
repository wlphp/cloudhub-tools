import { useRef, useState } from "react";
import { cloudflareClient } from "../../platform/clients/cloudflare";
import { SharedDialog } from "../../shared/SharedDialog";
import vlessTemplate from "../../../worker-templates/vless/manifest.json";

const example = `export default {
  async fetch(request, env, ctx) {
    return new Response("Hello from CloudHub Tools!", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
`;

export function CloudflareWorkerCreate({ accountId, zones, onClose, onCreated }: {
  accountId: number; zones: { id: string; name: string }[]; onClose: () => void; onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState(example);
  const [busy, setBusy] = useState(false);
  const [template, setTemplate] = useState("custom");
  const [zoneId, setZoneId] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [thirdParty, setThirdParty] = useState(false);
  const selectedZone = zones.find(zone => zone.id === zoneId);
  const hostname = selectedZone ? `${subdomain}.${selectedZone.name}` : "";
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ url?: string; warning?: string; subscriptionUrl?: string; subscriptionPath?: string } | null>(null);
  const [syncWarning, setSyncWarning] = useState("");
  const lock = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  async function create() {
    if (lock.current || result) return;
    if (template === "custom" && (!code.trim() || new TextEncoder().encode(code).length > 1024 * 1024 || code.includes("\0"))) {
      setError("代码不能为空，且不能超过 1 MiB 或包含空字符。");
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    lock.current = true; setBusy(true); setError("");
    try {
      const created = template === "vless"
        ? await cloudflareClient.manage(accountId, "worker_template_deploy", { template, name, zoneId, hostname, thirdParty })
        : await cloudflareClient.manage(accountId, "worker_create", { name, code });
      setResult(created);
      setCode("");
      try { await onCreated(); }
      catch { setSyncWarning("Worker 已创建，但列表刷新失败，请关闭后同步当前分类。"); }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message.includes("不支持的 Cloudflare 操作")
        ? "当前运行的后端尚不支持新建 Worker。请重新编译并重启桌面开发程序；若使用浏览器预览，请重启本地 API 服务后重试。"
        : /超时|timeout|网络请求失败/i.test(message)
          ? `${message}。请先同步 Workers 确认云端状态，再决定是否重试。`
          : message);
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally { lock.current = false; setBusy(false); }
  }

  return <SharedDialog title="新建 Worker" className="cloudflare-worker-create" sizeStorageKey="cloudflare-worker-create"
    onClose={onClose} closeDisabled={busy} busy={busy} initialFocus="input[name=workerName]"
    onSubmit={event => { event.preventDefault(); void create(); }}
    footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>{result ? "关闭" : "取消"}</button>
      {!result && <button type="submit" className="primary" disabled={busy}>{busy ? "正在创建并部署…" : "创建并部署"}</button>}</>}>
    {error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-text">{error}</p>}
    {result ? <div className="cloudflare-worker-result">
      <p role="status">Worker {name} 代码已创建并部署。</p>
      {result.url && <label>访问地址<input aria-label="Worker 访问地址" readOnly value={result.url} onFocus={event => event.target.select()} /></label>}
      {result.subscriptionUrl && <label>Clash / Mihomo 订阅地址<input readOnly value={result.subscriptionUrl} onFocus={event => event.target.select()} /></label>}
      {result.subscriptionPath && <label>订阅路径（绑定域名后使用）<input readOnly value={result.subscriptionPath} onFocus={event => event.target.select()} /></label>}
      {template === "vless" && <p>请立即复制保存订阅地址或路径，其中包含访问凭据，关闭后本机不会保留。域名证书生效可能需要等待；尚未实测代理连通性。</p>}
      {result.url && template === "custom" && <p>地址已启用，首次访问可能需要等待生效。</p>}
      {result.warning && <p role="alert">{result.warning}</p>}
      {syncWarning && <p role="alert">{syncWarning}</p>}
      <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">前往 Cloudflare 控制台 ↗</a>
    </div> : <>
      <p className="security-tip">{template === "vless" ? "将部署 VLESS 节点并绑定所选子域名。Token 需具备 Workers Scripts Read / Write、Zone Read 和 DNS Read 权限；同名 Worker 或已有 DNS 记录会阻止部署。" : "将向当前账号部署代码并开启公开的 workers.dev 地址。Token 需具备 Workers Scripts Read / Write 权限；同名资源会阻止创建。"}</p>
      <div className="cloudflare-worker-fields">
        <label>部署模板<select value={template} disabled={busy} onChange={event => {
          setTemplate(event.target.value); setError("");
          if (event.target.value === "vless") { const suffix = crypto.randomUUID().slice(0, 8); if (!name) setName(`vless-${suffix}`); if (!subdomain) setSubdomain(`node-${suffix}`); }
        }}><option value="custom">自定义 JavaScript 模块</option><option value="vless">{vlessTemplate.name}</option></select></label>
        {template === "vless" && <>
          <label>选择域名<select required value={zoneId} disabled={busy} onChange={event => setZoneId(event.target.value)}><option value="">请选择当前账号的域名</option>{zones.map(zone => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
          {!zones.length && <p role="status">暂无本地域名，请取消后先同步“站点 / DNS”，或在控制台接入域名。</p>}
          <label>子域名前缀<input required maxLength={63} pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" value={subdomain} disabled={busy || !zoneId} onChange={event => setSubdomain(event.target.value)} placeholder="例如 node" /></label>
          {hostname && <p className="cloudflare-worker-host">绑定地址：https://{hostname}</p>}
        </>}
        <label>Worker 名称<input name="workerName" required maxLength={63} pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" title="1–63 位小写字母、数字或连字符，首尾不能为连字符" placeholder="例如 my-worker" value={name} disabled={busy} onChange={event => setName(event.target.value)} autoComplete="off" spellCheck={false} /></label>
        {template === "custom" && <label>JavaScript 模块代码<textarea required rows={14} value={code} disabled={busy} onChange={event => setCode(event.target.value)} spellCheck={false} autoComplete="off" /></label>}
        {template === "vless" && <label className="cloudflare-worker-checkbox"><input type="checkbox" checked={thirdParty} disabled={busy} onChange={event => setThirdParty(event.target.checked)} />启用原脚本的第三方优选入口与回退地址（流量可能经第三方转发）</label>}
      </div>
      <details><summary>代码格式与部署说明</summary>{template === "vless" ? <p>内置包版本 {vlessTemplate.version}，基于你提供的脚本适配。UUID 和订阅凭据由后端随机生成，通过 Worker Secret 注入。只启用 VLESS TCP，首页不公开订阅；不收集 Cookie、不修改 NS、不覆盖现有资源。使用 Cloudflare Custom Domains 自动配置域名及证书，要求域名已激活。第三方地址默认关闭，开启后使用原脚本提供的外部入口，其可用性不由 CloudHub 保证。</p> : <p>默认示例可直接部署，也可替换为你的单文件 JavaScript ES 模块，入口使用 export default。自定义代码模式暂不支持多文件、npm 依赖构建、传统 addEventListener 格式、资源绑定或自定义域名。粘贴的代码只用于本次部署，不写入本地缓存或日志；请勿在代码中硬编码密钥。首次使用 Workers 时，请先在控制台配置账号的 workers.dev 子域名。</p>}<p>使用受 Cloudflare 套餐配额和计费规则约束。</p></details>
    </>}
  </SharedDialog>;
}
