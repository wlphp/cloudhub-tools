import { ExportChecklist } from "../../shared/ExportSelection";
import { useEffect, useState } from "react";
import { SharedDialog } from "../../shared/SharedDialog";
import { PaginationBar } from "../../shared/PaginationBar";
import { Download, Search } from "lucide-react";
import { certificatesClient } from "../../platform/clients/certificates";
import { platformErrorMessage } from "../../platform/api";

export function CertificateDomains({ domains, title }: { domains: string[]; title: string }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState("");
  const [domainPage, setDomainPage] = useState(1);
  const [domainPageSize, setDomainPageSize] = useState(120);
  const unique = [...new Set(domains)];
  const close = () => { setOpen(false); setSelected([]); setFilter(""); setStatus(""); };
  const matches = unique.filter(domain => domain.toLowerCase().includes(filter.trim().toLowerCase()));
  const pagedMatches = matches.slice((domainPage - 1) * domainPageSize, domainPage * domainPageSize);
  useEffect(() => { setDomainPage(1); }, [filter]);
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
    {unique.length > 0 && <button type="button" className="certificate-domain-view" aria-label={`查看 ${title} 的全部域名（${unique.length} 个）`} onClick={() => setOpen(true)}>查看域名{unique.length > 3 ? `（${unique.length}）` : ""}</button>}
    {open && <SharedDialog title={`${title} · 全部域名`} subtitle={`全部域名 · ${unique.length} 个`} className="certificate-domains-dialog" closeLabel="关闭域名列表" onClose={close} headerActions={<button type="button" className="certificate-domain-export secondary" title="导出已勾选域名为 TXT，每行一个域名" disabled={exporting || !unique.some(domain => selected.includes(domain))} onClick={() => void exportDomains()}><Download size={16} />{exporting ? "导出中…" : "导出"}</button>} footer={<>显示 {matches.length} / {unique.length} 个域名{status && <span role="status">{status}</span>}</>}>
      <label className="certificate-domain-search"><Search size={16} /><input autoFocus aria-label="搜索完整域名列表" placeholder="搜索域名" value={filter} onChange={event => setFilter(event.target.value)} /></label>
      <ExportChecklist items={pagedMatches.map(domain => ({ id: domain, label: domain }))} selected={selected} onChange={ids => setSelected(current => [...current.filter(domain => !pagedMatches.includes(domain)), ...ids])} disabled={exporting} search={false} />
      {matches.length > 0 && <PaginationBar className="certificate-domains-pagination" page={domainPage} pageSize={domainPageSize} total={matches.length} onPageChange={setDomainPage} onPageSizeChange={(size) => { setDomainPageSize(size); setDomainPage(1); }} pageSizeOptions={[60, 120, 240]} />}
      {!matches.length && <p>没有匹配的域名</p>}
    </SharedDialog>}
  </>;
}
