import { ExportChecklist } from "../../shared/ExportSelection";
import { useEffect, useRef, useState } from "react";
import { SharedDialog } from "../../shared/SharedDialog";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { PaginationBar } from "../../shared/PaginationBar";
import { Download, Search } from "lucide-react";
import { certificatesClient } from "../../platform/clients/certificates";
import { platformErrorMessage } from "../../platform/api";

export function CertificateDomains({ domains, title, onRemove, onViewDomains }: { domains: string[]; title: string; onRemove?: (domain: string) => Promise<void>; onViewDomains?: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState("");
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const removingRef = useRef(false);
  const [domainPage, setDomainPage] = useState(1);
  const [domainPageSize, setDomainPageSize] = useState(120);
  const unique = [...new Set(domains)];
  const close = () => { setOpen(false); setSelected([]); setFilter(""); setStatus(""); };
  const matches = unique.filter(domain => domain.toLowerCase().includes(filter.trim().toLowerCase()));
  const safePage = Math.min(domainPage, Math.max(1, Math.ceil(matches.length / domainPageSize)));
  const pagedMatches = matches.slice((safePage - 1) * domainPageSize, safePage * domainPageSize);
  useEffect(() => { setDomainPage(1); }, [filter]);
  async function removeDomain(confirmed: boolean) {
    if (removingRef.current) return;
    if (!confirmed || !removeTarget || !onRemove) { setRemoveTarget(null); return; }
    const domain = removeTarget;
    removingRef.current = true; setRemoving(true); setStatus("");
    try {
      await onRemove(domain);
      setSelected(current => current.filter(value => value !== domain));
      setStatus(`已从宝塔站点移除 ${domain}`);
    } catch (reason) { setStatus(platformErrorMessage(reason, "移除域名失败，请刷新核对宝塔绑定后再操作")); }
    finally { removingRef.current = false; setRemoving(false); setRemoveTarget(null); }
  }
  async function exportDomains() {
    setExporting(true); setStatus("");
    try {
      const chosen = unique.filter(domain => selected.includes(domain));
      if (!chosen.length) return;
      const path = await certificatesClient.exportDomains(title, chosen);
      if (path) setStatus(`已导出 ${chosen.length} 个域名`);
    } catch (reason) { setStatus(platformErrorMessage(reason, "导出域名失败")); }
    finally { setExporting(false); }
  }
  return <>
    <small className="asset-subline certificate-domain-preview">{unique.slice(0, 3).join(" · ")}{unique.length > 3 ? ` · … 共 ${unique.length} 个` : ""}</small>
    {unique.length > 0 && <button type="button" className="certificate-domain-view" aria-label={`查看 ${title} 的全部域名（${unique.length} 个）`} onClick={() => onViewDomains ? onViewDomains() : setOpen(true)}>查看域名{unique.length > 3 ? `（${unique.length}）` : ""}</button>}
    {open && <SharedDialog title={`${title} · 全部域名`} subtitle={`全部域名 · ${unique.length} 个`} className="certificate-domains-dialog" closeLabel="关闭域名列表" onClose={close} closeDisabled={removing} headerActions={<button type="button" className="certificate-domain-export secondary" title="导出已勾选域名为 TXT，每行一个域名" disabled={exporting || removing || !unique.some(domain => selected.includes(domain))} onClick={() => void exportDomains()}><Download size={16} />{exporting ? "导出中…" : "导出"}</button>} footer={<>显示 {matches.length} / {unique.length} 个域名{status && <span role="status">{status}</span>}</>}>
      <label className="certificate-domain-search"><Search size={16} /><input autoFocus aria-label="搜索完整域名列表" placeholder="搜索域名" value={filter} onChange={event => setFilter(event.target.value)} /></label>
      <ExportChecklist items={pagedMatches.map(domain => ({ id: domain, label: domain }))} selected={selected} onChange={ids => setSelected(current => [...current.filter(domain => !pagedMatches.includes(domain)), ...ids])} disabled={exporting || removing} search={false} itemActions={onRemove ? item => <button type="button" className="certificate-domain-remove" aria-label={`移除域名 ${item.id}`} title={unique.length <= 1 ? "站点至少保留一个域名" : "从宝塔站点解除域名绑定"} disabled={exporting || removing || unique.length <= 1} onClick={() => setRemoveTarget(item.id)}>移除</button> : undefined} />
      {matches.length > 0 && <PaginationBar className="certificate-domains-pagination" page={safePage} pageSize={domainPageSize} total={matches.length} onPageChange={setDomainPage} onPageSizeChange={(size) => { setDomainPageSize(size); setDomainPage(1); }} pageSizeOptions={[60, 120, 240]} />}
      {!matches.length && <p>没有匹配的域名</p>}
    </SharedDialog>}
    {removeTarget && <ConfirmDialog title="移除站点域名" confirmLabel="确认移除" message={`确认从宝塔站点 ${title} 移除域名 ${removeTarget}？这会真实解除域名绑定，影响该域名对站点的访问。`} busy={removing} onResolve={confirmed => void removeDomain(confirmed)} />}
  </>;
}
