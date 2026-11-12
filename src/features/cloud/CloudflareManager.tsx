import { useEffect, useRef, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import type { Account, LocalAsset } from "../../shared/types";
import { resourcesClient } from "../../platform/clients/resources";
import { cloudflareClient, type CloudflareAction } from "../../platform/clients/cloudflare";
import { SharedDialog } from "../../shared/SharedDialog";
import { CloudflareAssetDetail } from "./CloudflareAssetDetail";

const kinds = [["domain", "站点 / DNS"], ["workers", "Workers"], ["oss", "R2 存储桶"], ["pages", "Pages"], ["tunnel", "Tunnel"]] as const;
type Row = Record<string, unknown>;
const value = (row: Row, key: string) => String(row[key] ?? "");
const editableTypes = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"];
type DnsDraft = { recordId: string; type: string; name: string; content: string; ttl: number; priority: number; proxied: boolean };
const emptyDns: DnsDraft = { recordId: "", type: "A", name: "", content: "", ttl: 1, priority: 10, proxied: false };

export function CloudflareManager({ account, initialKind = "domain", onClose, onChanged, onConfirm }: {
  account: Account; initialKind?: string; onClose: () => void; onChanged: () => Promise<void>;
  onConfirm: (message: string) => Promise<boolean>;
}) {
  const [kind, setKind] = useState(initialKind);
  const [assets, setAssets] = useState<LocalAsset[]>([]);
  const [keyword, setKeyword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const revision = useRef(0);
  const [zone, setZone] = useState<Row | null>(null);
  const [records, setRecords] = useState<Row[]>([]);
  const [editor, setEditor] = useState<DnsDraft | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);
  const [bucketName, setBucketName] = useState<string | null>(null);
  const [ssl, setSsl] = useState<Row | null>(null);
  const [sslMode, setSslMode] = useState("strict");
  useEffect(() => {
    let alive = true;
    const version = revision.current;
    resourcesClient.listLocal({ accountId: account.id }).then(rows => { if (alive && version === revision.current) setAssets(rows); }).catch(() => { if (alive && version === revision.current) setError("读取本地 Cloudflare 资产失败"); });
    return () => { alive = false; };
  }, [account.id]);

  async function run(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try { await work(); } catch (e) { setError(String(e)); } finally { lock.current = false; setBusy(false); }
  }
  async function sync(types: string[]) {
    ++revision.current;
    const result = await resourcesClient.sync(account.id, types);
    setAssets(await resourcesClient.listLocal({ accountId: account.id }));
    await onChanged();
    setMessage(`已更新 ${result.fetched} 项资产`);
    if (result.errors.length) setError(result.errors.join("；"));
  }
  async function mutate(action: CloudflareAction, input: Row, confirmation?: string) {
    if (confirmation && !(await onConfirm(confirmation))) return false;
    await cloudflareClient.manage(account.id, action, input);
    setMessage("操作成功");
    return true;
  }
  async function dnsList(item: Row) {
    const result = await cloudflareClient.manage(account.id, "dns_list", { zoneId: value(item, "Id") });
    setRecords(result.items || []);
    setZone(item);
  }
  const filtered = assets.filter(a => a.resource_type === kind && `${a.payload.Name} ${a.asset_key}`.toLowerCase().includes(keyword.toLowerCase()));
  const notice = <>{error && <p role="alert" className="error-text">{error}</p>}{message && <p role="status">{message}</p>}</>;
  const consoleLink = <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">Cloudflare 控制台 ↗</a>;
  return <>
    <SharedDialog sizeStorageKey="features/cloud/cloudflare-manager/cloudflare-manager" title={`${account.account_name} · Cloudflare 资产管理`} eyebrow="CLOUDFLARE" onClose={onClose} closeDisabled={busy} busy={busy} footer={<><span>Account ID：{account.access_key_id}</span><button type="button" className="secondary" disabled={busy} onClick={onClose}>关闭</button></>}>
      <p className="security-tip">同步保存在本机；写操作直接影响 Cloudflare 上的资源。{consoleLink}</p>
      <details><summary>权限与支持范围</summary><p>验证账号需 Account Settings Read；站点需 Zone Read；DNS 管理需 DNS Edit；清缓存需 Cache Purge；SSL 需 Zone Settings Read / Edit。Workers、R2、Pages、Tunnel 分别授予对应 Read 权限，删除或创建时需要 Edit / Write。只开启需要管理的资源权限；权限不足的分类会显示错误并保留原有缓存。</p><p>Workers：元数据和删除；R2：桶创建和删除空桶；Pages：项目元数据和删除；Tunnel：状态和删除离线隧道。代码部署、R2 文件操作和 Tunnel 路由配置请通过控制台完成。R2 当前同步默认 jurisdiction 的桶。</p></details>
      <div className="favorite-type-tabs" role="group" aria-label="Cloudflare 资源类型">{kinds.map(([id, label]) => <button type="button" key={id} disabled={busy} aria-pressed={kind === id} className={kind === id ? "active" : ""} onClick={() => { setKind(id); setKeyword(""); }}>{label} ({assets.filter(a => a.resource_type === id).length})</button>)}</div>
      <div className="asset-list-toolbar">
        <label className="cloudflare-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索 Cloudflare 资产" placeholder="搜索名称 / ID" value={keyword} onChange={e => setKeyword(e.target.value)} /></label>
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => { await cloudflareClient.manage(account.id, "verify"); setMessage("Account ID 与账号读取权限验证通过；各类资源权限请通过对应分类同步验证"); })}>验证账号</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => sync([kind]))}><RefreshCw size={14} />同步当前分类</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void run(() => sync(kinds.map(([id]) => id)))}>{busy ? "处理中…" : "同步全部资产"}</button>
        {kind === "oss" && <button type="button" className="secondary" disabled={busy} onClick={() => setBucketName("")}>创建 R2 桶</button>}
      </div>
      {!zone && !editor && !ssl && bucketName === null && notice}
      <div className="resource-table-wrap"><table><thead><tr><th>名称</th><th>ID</th><th>状态 / 位置</th><th>最近同步</th><th>操作</th></tr></thead><tbody>{filtered.map(asset => {
        const item = asset.payload;
        return <tr key={asset.asset_key}><td>{value(item, "Name")}</td><td><code>{value(item, "Id")}</code></td><td>{value(item, "Status") || value(item, "location") || "—"}</td><td>{new Date(asset.fetched_at).toLocaleString()}</td><td><div className="asset-action-buttons">
          <button type="button" className="table-action" disabled={busy} onClick={() => setDetail(item)}>详情</button>
          {kind === "domain" ? <>
            <button type="button" className="table-action" disabled={busy} onClick={() => void run(() => dnsList(item))}>DNS 管理</button>
            <button type="button" className="table-action" disabled={busy} onClick={() => void run(async () => { await mutate("purge_cache", { zoneId: item.Id }, `清空 ${item.Name} 的全部边缘缓存？回源请求可能增加。`); })}>清缓存</button>
            <button type="button" className="table-action" disabled={busy} onClick={() => void run(async () => { const result = await cloudflareClient.manage(account.id, "ssl_get", { zoneId: item.Id }); setSslMode(result.mode || "strict"); setSsl({ ...item, currentMode: result.mode }); })}>设置 SSL</button>
          </> : <button type="button" className="table-action danger" disabled={busy} onClick={() => void run(async () => {
            const resourceId = kind === "pages" || kind === "oss" ? value(item, "Name") : value(item, "Id");
            if (await mutate("delete_resource", { kind, resourceId }, `从 Cloudflare 永久删除 ${item.Name}？这会影响使用它的服务。R2 必须先清空桶，Tunnel 必须无活动连接。此操作无法通过本地回收站恢复。`)) await sync([kind]);
          })}>删除云端资源</button>}
        </div></td></tr>;
      })}</tbody></table></div>
      {!filtered.length && <p className="detail-empty">暂无匹配资产，请同步当前分类。仅显示 Token 有权访问的资源。</p>}
    </SharedDialog>
    {detail && <CloudflareAssetDetail asset={detail} kindLabel={kinds.find(([id]) => id === kind)?.[1] ?? "资产"} onClose={() => setDetail(null)} />}
    {zone && <SharedDialog sizeStorageKey="features/cloud/cloudflare-manager/cloudflare-manager/3" title={`${zone.Name} · DNS 管理`} onClose={() => { if (!busy) { setZone(null); setRecords([]); } }} closeDisabled={busy} footer={<><span>代理开关仅改变 Cloudflare 代理状态，不会停用 DNS 记录。</span><button type="button" className="primary" disabled={busy} onClick={() => setEditor({ ...emptyDns, name: value(zone, "Name") })}>添加记录</button><button type="button" className="secondary" disabled={busy} onClick={() => void run(() => dnsList(zone))}>刷新</button></>}>
      {!editor && notice}
      <div className="resource-table-wrap"><table><thead><tr><th>类型</th><th>完整名称</th><th>内容</th><th>TTL</th><th>代理</th><th>操作</th></tr></thead><tbody>{records.map(row => <tr key={value(row, "id")}><td>{value(row, "type")}</td><td>{value(row, "name")}</td><td className="cloudflare-dns-content">{value(row, "content")}</td><td>{row.ttl === 1 ? "自动" : value(row, "ttl")}</td><td>{row.proxied ? "已代理" : "仅 DNS"}</td><td><div className="asset-action-buttons">
        <button type="button" className="table-action" disabled={busy || !editableTypes.includes(value(row, "type"))} onClick={() => setEditor({ recordId: value(row, "id"), type: value(row, "type"), name: value(row, "name"), content: value(row, "content"), ttl: Number(row.ttl) || 1, priority: Number(row.priority) || 0, proxied: Boolean(row.proxied) })}>编辑</button>
        {row.proxiable === true && <button type="button" className="table-action" disabled={busy} onClick={() => void run(async () => { if (await mutate("dns_proxy", { zoneId: zone.Id, recordId: row.id, proxied: !row.proxied }, `将 ${row.name} 切换为${row.proxied ? "仅 DNS" : "Cloudflare 代理"}？这会改变流量路由。`)) await dnsList(zone); })}>{row.proxied ? "关闭代理" : "开启代理"}</button>}
        <button type="button" className="table-action danger" disabled={busy} onClick={() => void run(async () => { if (await mutate("dns_delete", { zoneId: zone.Id, recordId: row.id }, `永久删除 ${row.type} ${row.name} 记录？可能导致对应服务不可达。`)) await dnsList(zone); })}>删除</button>
      </div></td></tr>)}</tbody></table></div>{!records.length && <p>暂无 DNS 记录</p>}
    </SharedDialog>}
    {editor && zone && <SharedDialog sizeStorageKey="features/cloud/cloudflare-manager/cloudflare-manager/4" title={editor.recordId ? "编辑 DNS 记录" : "添加 DNS 记录"} onClose={() => setEditor(null)} closeDisabled={busy} onSubmit={e => { e.preventDefault(); void run(async () => { if (await mutate("dns_save", { zoneId: zone.Id, ...editor }, `保存 ${editor.type} ${editor.name} 到 Cloudflare？现有解析可能立即变化。`)) { setEditor(null); await dnsList(zone); } }); }} footer={<><button type="button" className="secondary" disabled={busy} onClick={() => setEditor(null)}>取消</button><button type="submit" className="primary" disabled={busy}>保存到 Cloudflare</button></>}>
      {notice}<div className="form-grid"><label>类型<select value={editor.type} onChange={e => setEditor({ ...editor, type: e.target.value, proxied: false })}>{editableTypes.map(type => <option key={type}>{type}</option>)}</select></label><label>完整域名<input required value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} /></label><label>内容<input required value={editor.content} onChange={e => setEditor({ ...editor, content: e.target.value })} /></label><label>TTL（1 为自动）<input required type="number" min={1} max={86400} value={editor.ttl} onChange={e => setEditor({ ...editor, ttl: Number(e.target.value) })} /></label>{editor.type === "MX" && <label>优先级<input required type="number" min={0} max={65535} value={editor.priority} onChange={e => setEditor({ ...editor, priority: Number(e.target.value) })} /></label>}{["A", "AAAA", "CNAME"].includes(editor.type) && <label>Cloudflare 代理<select value={String(editor.proxied)} onChange={e => setEditor({ ...editor, proxied: e.target.value === "true" })}><option value="false">仅 DNS</option><option value="true">已代理（TTL 自动）</option></select></label>}</div>
    </SharedDialog>}
    {bucketName !== null && <SharedDialog sizeStorageKey="features/cloud/cloudflare-manager/cloudflare-manager/5" title="创建 R2 存储桶" onClose={() => setBucketName(null)} closeDisabled={busy} onSubmit={e => { e.preventDefault(); void run(async () => { if (await mutate("r2_create", { name: bucketName }, `创建 R2 存储桶 ${bucketName}？后续使用可能产生费用。`)) { setBucketName(null); await sync(["oss"]); } }); }} footer={<button type="submit" className="primary" disabled={busy}>创建</button>}>
      {notice}<label>桶名称<input required minLength={3} maxLength={63} pattern="[a-z0-9][a-z0-9-]{1,61}[a-z0-9]" value={bucketName} onChange={e => setBucketName(e.target.value)} placeholder="小写字母、数字、连字符" /></label>
    </SharedDialog>}
    {ssl && <SharedDialog sizeStorageKey="features/cloud/cloudflare-manager/cloudflare-manager/6" title={`${ssl.Name} · 设置 SSL 模式`} onClose={() => setSsl(null)} closeDisabled={busy} footer={<button type="button" className="primary" disabled={busy} onClick={() => void run(async () => { if (await mutate("ssl_set", { zoneId: ssl.Id, mode: sslMode }, `将 ${ssl.Name} 的 SSL 模式设置为 ${sslMode}？错误设置可能导致 HTTPS 无法访问。`)) setSsl(null); })}>应用设置</button>}>
      {notice}<p>当前模式：{value(ssl, "currentMode")}。Strict 要求源站证书有效；Flexible 不加密回源；Off 会关闭加密。</p><label>待应用 SSL 模式<select value={sslMode} onChange={e => setSslMode(e.target.value)}><option value="strict">Full (strict)</option><option value="full">Full</option><option value="flexible">Flexible</option><option value="off">Off</option></select></label>
    </SharedDialog>}
  </>;
}
