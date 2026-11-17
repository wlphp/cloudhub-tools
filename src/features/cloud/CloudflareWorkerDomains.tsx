import { useEffect, useState, type FormEvent } from "react";
import type { LocalAsset } from "../../shared/types";
import { cloudflareClient } from "../../platform/clients/cloudflare";
import { SharedDialog } from "../../shared/SharedDialog";
import { ToastNotice } from "../../shared/ToastNotice";

type Row = Record<string, unknown>;
const text = (row: Row, key: string) => String(row[key] ?? "");

export function CloudflareWorkerDomains({ accountId, worker, zones, onClose, onConfirm }: {
  accountId: number; worker: string; zones: LocalAsset[]; onClose: () => void;
  onConfirm: (message: string) => Promise<boolean>;
}) {
  const activeZones = zones.filter(zone => String(zone.payload.Status ?? zone.payload.status ?? "").toLowerCase() === "active");
  const [zoneId, setZoneId] = useState(String(activeZones[0]?.payload.Id ?? activeZones[0]?.payload.id ?? ""));
  const selectedZone = activeZones.find(zone => String(zone.payload.Id ?? zone.payload.id ?? "") === zoneId);
  const [hostname, setHostname] = useState("");
  const [domains, setDomains] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function refresh() {
    setBusy(true); setError("");
    try {
      const result = await cloudflareClient.manage(accountId, "worker_domains_list", { name: worker });
      setDomains(result.items ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, [accountId, worker]);

  async function bind(event: FormEvent) {
    event.preventDefault();
    if (!selectedZone) { setError("请先同步并选择一个活动站点"); return; }
    if (!(await onConfirm(`将 ${hostname.trim()} 绑定到 Worker ${worker}？Cloudflare 会自动配置该主机名的 DNS 与证书；现有 DNS 配置可能发生变化。`))) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await cloudflareClient.manage(accountId, "worker_domain_bind", { name: worker, zoneId, hostname: hostname.trim() });
      setHostname(""); setMessage(result.domain?.hostname ? `已绑定 ${String(result.domain.hostname)}` : result.existing ? "该域名已绑定到此 Worker" : "绑定请求已成功");
      const latest = await cloudflareClient.manage(accountId, "worker_domains_list", { name: worker });
      setDomains(latest.items ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function unbind(domain: Row) {
    const domainId = text(domain, "id");
    if (!domainId || !(await onConfirm(`解除 ${text(domain, "hostname")} 与 Worker ${worker} 的绑定？该域名将不再由此 Worker 提供服务。`))) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await cloudflareClient.manage(accountId, "worker_domain_delete", { name: worker, domainId });
      setMessage(`已解除 ${text(domain, "hostname")} 的绑定`);
      const latest = await cloudflareClient.manage(accountId, "worker_domains_list", { name: worker });
      setDomains(latest.items ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return <SharedDialog title={`${worker} · 自定义域名`} sizeStorageKey="cloudflare-worker-domains" onClose={onClose} closeDisabled={busy} busy={busy} footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>关闭</button></>}>
    {error && <ToastNotice message={error} tone="error" />}{message && <ToastNotice message={message} />}
    <p>绑定后 Cloudflare 会自动管理 DNS 与 TLS 证书。域名必须属于当前账号下处于活动状态的站点。</p>
    <form className="cloudflare-worker-domain-form" onSubmit={event => void bind(event)}>
      <label>Cloudflare 活动站点<select aria-label="Cloudflare 活动站点" required value={zoneId} disabled={busy || !activeZones.length} onChange={event => setZoneId(event.target.value)}><option value="">请选择站点</option>{activeZones.map(zone => { const id = String(zone.payload.Id ?? zone.payload.id ?? ""); return <option key={id} value={id}>{String(zone.payload.Name ?? zone.payload.name ?? id)}</option>; })}</select></label>
      <label>完整域名<input aria-label="自定义域名" required maxLength={253} placeholder={selectedZone ? `例如 cdn.${String(selectedZone.payload.Name ?? selectedZone.payload.name)}` : "先选择活动站点"} value={hostname} disabled={busy || !selectedZone} onChange={event => setHostname(event.target.value)} autoComplete="off" spellCheck={false} /></label>
      <button type="submit" className="primary" disabled={busy || !selectedZone || !hostname.trim()}>{busy ? "处理中…" : "绑定域名"}</button>
    </form>
    {!zones.length && <p className="detail-empty">尚无已同步站点，请关闭此窗口后在“站点 / DNS”分类同步 Cloudflare 站点。</p>}
    {!!zones.length && !activeZones.length && <p className="detail-empty">没有已同步的活动站点；自定义域名要求站点状态为 active。</p>}
    <div className="resource-table-wrap"><table><thead><tr><th>域名</th><th>Worker</th><th>状态</th><th>操作</th></tr></thead><tbody>{domains.map(domain => <tr key={text(domain, "id")}><td>{text(domain, "hostname")}</td><td>{text(domain, "service")}</td><td>{domain.enabled === false ? "已停用" : "已绑定"}</td><td><button type="button" className="table-action danger" disabled={busy} onClick={() => void unbind(domain)}>解除绑定</button></td></tr>)}</tbody></table></div>
    {!domains.length && !busy && <p className="detail-empty">此 Worker 尚无自定义域名绑定。</p>}
  </SharedDialog>;
}
