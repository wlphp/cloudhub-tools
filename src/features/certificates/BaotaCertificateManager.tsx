import { CertificateDomains } from "./CertificateDomains";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, RefreshCw, Server, Upload } from "lucide-react";
import { certificatesClient, type BaotaSiteCertificate } from "../../platform/clients/certificates";
import { platformErrorMessage } from "../../platform/api";
import type { Certificate, PanelConnection } from "../../shared/types";

export function BaotaCertificateManager({ certificates, onChanged, onConfirm, onStatus, alertTarget, onAlertTargetHandled }: { certificates: Certificate[]; onChanged: () => void; onConfirm: (message: string) => Promise<boolean>; onStatus: (message: string) => void; alertTarget?: {key:string;request:number}|null; onAlertTargetHandled?:()=>void }) {
  const [panels, setPanels] = useState<PanelConnection[]>([]);
  const [panel, setPanel] = useState("");
  const [sites, setSites] = useState<BaotaSiteCertificate[]>([]);
  const [filter, setFilter] = useState("");
  const [httpsFilter, setHttpsFilter] = useState("yes");
  const [expiryFilter, setExpiryFilter] = useState("all");
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [syncProgress, setSyncProgress] = useState("");
  const [deploy, setDeploy] = useState<{ site: BaotaSiteCertificate; certificateId: string } | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const appliedAlert=useRef(0);
  useEffect(()=>{ if(alertTarget?.key.startsWith("site:")) setPanel(""); },[alertTarget?.request]);
  useEffect(()=>{
    if(!alertTarget || !alertTarget.key.startsWith("site:") || appliedAlert.current===alertTarget.request) return;
    const target=sites.find(s=>s.id===Number(alertTarget.key.split(":")[1]));
    if(target) { setPanel(""); setFilter(target.siteName); setHttpsFilter("all");setExpiryFilter("all");appliedAlert.current=alertTarget.request;onAlertTargetHandled?.(); }
  },[alertTarget,sites,onAlertTargetHandled]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now() / 1000), 60000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { void certificatesClient.panels().then(setPanels).catch(reason => setError(platformErrorMessage(reason))); return () => { ++generation.current; }; }, []);
  useEffect(() => { const request = ++generation.current; void certificatesClient.baotaSites(panel ? Number(panel) : undefined).then(rows => { if (request === generation.current) setSites(rows); }).catch(reason => { if (request === generation.current) setError(platformErrorMessage(reason)); }); }, [panel]);
  async function work(run: () => Promise<string>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setMessage("");
    const request = generation.current;
    try { const result = await run(); const rows = await certificatesClient.baotaSites(panel ? Number(panel) : undefined); if (request !== generation.current) return; setSites(rows); setMessage(result); onStatus(result); onChanged(); }
    catch (reason) { if (request === generation.current) { setError(platformErrorMessage(reason)); try { setSites(await certificatesClient.baotaSites(panel ? Number(panel) : undefined)); } catch { /* Keep the last confirmed snapshot. */ } } }
    finally { inFlight.current = false; if (request === generation.current) setBusy(false); }
  }
  async function renew(site: BaotaSiteCertificate) {
    if (!await onConfirm(`续签 ${site.panelName} 的站点 ${site.siteName}（${site.siteDomains.join("、")}）？续签后将更新该站点证书。`)) return;
    await work(async () => (await certificatesClient.renewBaota(site.id)).message);
  }
  async function syncSites() {
    await work(async () => {
      const targets = panel ? panels.filter(item => String(item.id) === panel) : panels;
      let count = 0;
      let succeeded = 0;
      const failures: string[] = [];
      try {
        for (const [index, target] of targets.entries()) {
          setSyncProgress(`拉取 ${index + 1}/${targets.length}`);
          try { count += (await certificatesClient.syncBaota(target.id)).length; succeeded++; }
          catch (reason) { failures.push(`${target.name}：${platformErrorMessage(reason)}`); }
        }
        if (failures.length) setError(`部分面板拉取失败，已保留其本地记录：${failures.join("；")}`);
        return `已更新 ${count} 个宝塔站点证书（${succeeded}/${targets.length} 个面板成功）`;
      } finally { setSyncProgress(""); }
    });
  }
  const matchingSites = sites.filter(site => {
    const hasCertificate = Boolean(site.fingerprint || site.certificateDomains.length || site.notAfter);
    return (httpsFilter === "all" || hasCertificate === (httpsFilter === "yes"))
      && `${site.panelName} ${site.siteName} ${site.siteRemark || ""} ${site.siteDomains.join(" ")}`.toLowerCase().includes(filter.toLowerCase());
  });
  const remaining = (site: BaotaSiteCertificate) => site.notAfter && Number.isFinite(site.notAfter) ? site.notAfter - now : null;
  const expiresWithin = (site: BaotaSiteCertificate, days: number) => { const seconds = remaining(site); return seconds !== null && seconds > 0 && seconds <= days * 86400; };
  const expired = (site: BaotaSiteCertificate) => { const seconds = remaining(site); return seconds !== null && seconds <= 0; };
  const filtered = matchingSites.filter(site => expiryFilter === "all" || (expiryFilter === "expired" ? expired(site) : expiresWithin(site, expiryFilter === "urgent" ? 7 : 30)));
  const deployable = certificates.filter(cert => cert.status === "issued" && (cert.notBefore ?? 0) <= now && (cert.notAfter ?? 0) > now);
  return <section className="panel certificate-panel baota-certificate-manager">
    <div className="certificate-toolbar"><Server size={16} /><select aria-label="选择宝塔面板" value={panel} onChange={event => setPanel(event.target.value)} disabled={busy}><option value="">全部面板</option>{panels.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><label className="certificate-https-filter">HTTPS 证书<select aria-label="是否有 HTTPS 证书" value={httpsFilter} onChange={event => setHttpsFilter(event.target.value)}><option value="yes">有</option><option value="no">无</option><option value="all">全部</option></select></label><input aria-label="搜索宝塔站点" placeholder="搜索面板、站点或域名" value={filter} onChange={event => setFilter(event.target.value)} /><button className="secondary" disabled={!panels.length || busy} onClick={() => void syncSites()}><RefreshCw size={14} className={busy ? "spin" : undefined} />{busy ? syncProgress || "处理中…" : "获取站点证书"}</button></div>
    {!panels.length && <p className="certificate-source-note">请先在“宝塔面板”模块添加面板 API 连接。</p>}
    <div className="certificate-expiry-summary" aria-label="宝塔证书到期预警"><span><AlertTriangle size={14} />到期预警</span><button type="button" aria-pressed={expiryFilter === "all"} onClick={() => setExpiryFilter("all")}>全部</button><button type="button" className="expiry-warning" aria-pressed={expiryFilter === "soon"} onClick={() => setExpiryFilter("soon")}>30 天内到期（{matchingSites.filter(site => expiresWithin(site, 30)).length}）</button><button type="button" className="expiry-danger" aria-pressed={expiryFilter === "urgent"} onClick={() => setExpiryFilter("urgent")}>7 天内到期（{matchingSites.filter(site => expiresWithin(site, 7)).length}）</button><button type="button" className="expiry-danger" aria-pressed={expiryFilter === "expired"} onClick={() => setExpiryFilter("expired")}>已过期（{matchingSites.filter(expired).length}）</button><small>按当前面板和搜索条件统计</small></div>
    {error && <div className="form-error" role="alert">{error}</div>}{message && <div className="certificate-source-note" role="status">{message}</div>}
    <div className="table-wrap"><table><thead><tr><th>站点 / 域名</th><th>所属面板</th><th>证书状态</th><th>有效期</th><th>操作</th></tr></thead><tbody>{filtered.map(site => <tr key={site.id}><td><strong>{site.siteName}</strong>{site.siteRemark && <small className="asset-subline">{site.siteRemark}</small>}<CertificateDomains domains={site.siteDomains} title={site.siteName} /></td><td>{site.panelName}<small className="asset-subline">最近同步：{new Date(site.checkedAt).toLocaleString()}</small></td><td>{site.enabled ? "已部署 HTTPS" : "未部署 HTTPS"}<small className="asset-subline">{site.issuer || "签发者未获取"}</small><small className="asset-subline">{site.error || site.capabilityReason}</small></td><td>{site.notAfter ? new Date(site.notAfter * 1000).toLocaleDateString() : "未获取"}{site.notAfter && <small className={`asset-subline certificate-expiry-label${expired(site) || expiresWithin(site, 7) ? " expiry-danger" : expiresWithin(site, 30) ? " expiry-warning" : ""}`}>{(expired(site) || expiresWithin(site, 30)) && <AlertTriangle size={12} />}{expired(site) ? "已过期，请及时更换" : `${expiresWithin(site, 7) ? "紧急到期" : expiresWithin(site, 30) ? "即将到期" : "剩余"} ${Math.ceil((site.notAfter - now) / 86400)} 天`}</small>}</td><td><div className="certificate-actions">{site.pendingRenewal && <button className="secondary" disabled={busy} onClick={async () => { if (!await onConfirm(`确认已在宝塔面板核对 ${site.siteName} 的上次续签结果？解除保护后仍需重新获取站点证书，不会立即发起续签。`)) return; await work(async () => { await certificatesClient.confirmBaotaRetry(site.id); return "已解除重试保护，请重新获取站点证书"; }); }}>核对后允许重试</button>}<button className="secondary" disabled={busy || !site.canRenew} title={site.capabilityReason} aria-label={`续签站点 ${site.siteName}`} onClick={() => void renew(site)}><RefreshCw size={14} />续签</button><button className="secondary" disabled={busy || !site.canImport} title={site.capabilityReason} aria-label={`导入站点 ${site.siteName} 的证书`} onClick={() => void work(async () => { await certificatesClient.importBaota(site.id); return `${site.siteName} 证书已导入本地加密库`; })}><Download size={14} />导入本地</button><button className="secondary" disabled={busy || !site.panelId || !deployable.length} aria-label={`部署证书到站点 ${site.siteName}`} onClick={() => setDeploy({ site, certificateId: "" })}><Upload size={14} />部署证书</button></div></td></tr>)}</tbody></table>{!filtered.length && <p className="certificate-source-note">{sites.length ? "没有符合检索条件的站点，可调整到期预警、HTTPS 证书筛选或搜索内容。" : "暂无站点记录，请选择面板并获取站点证书。"}</p>}</div>
    {deploy && <div className="certificate-deploy-picker"><strong>部署到 {deploy.site.panelName} · {deploy.site.siteName}</strong><select aria-label="选择部署到宝塔的证书" value={deploy.certificateId} disabled={busy} onChange={event => setDeploy({ ...deploy, certificateId: event.target.value })}><option value="">请选择有效本地证书</option>{deployable.map(cert => <option key={cert.id} value={cert.id}>{cert.primaryDomain} · {cert.domains.join("、")}</option>)}</select><button className="secondary" disabled={busy} onClick={() => setDeploy(null)}>取消</button><button className="primary" disabled={busy || !deploy.certificateId} onClick={async () => { const target = deploy; if (!await onConfirm(`替换站点 ${target.site.siteName} 的 HTTPS 证书？请确认所选证书覆盖全部站点域名。`)) return; await work(async () => (await certificatesClient.deployBaota(target.site.id, Number(target.certificateId))).message); setDeploy(null); }}>确认部署</button></div>}
  </section>;
}
