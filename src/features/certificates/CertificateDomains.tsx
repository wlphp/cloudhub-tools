import { ExportChecklist } from "../../shared/ExportSelection";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Maximize2, Minimize2, Search, X } from "lucide-react";
import { certificatesClient } from "../../platform/clients/certificates";
import { platformErrorMessage } from "../../platform/api";

export function CertificateDomains({ domains, title }: { domains: string[]; title: string }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const unique = [...new Set(domains)];
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  const close = () => { setOpen(false); setSelected([]); setFilter(""); setFullscreen(false); setStatus(""); };
  const matches = unique.filter(domain => domain.toLowerCase().includes(filter.trim().toLowerCase()));
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
    {open && createPortal(<dialog ref={dialog} className={`certificate-domains-dialog modal-form-layout dialog-common-theme${fullscreen ? " is-fullscreen" : ""}`} aria-label={`${title} · 全部域名`} onCancel={event => { event.preventDefault(); close(); }}>
      <header><div><strong>{title}</strong><small>全部域名 · {unique.length} 个</small></div><nav className="certificate-domain-controls" aria-label="域名列表操作"><button type="button" aria-label={fullscreen ? "退出全屏" : "全屏查看域名"} title={fullscreen ? "退出全屏" : "全屏"} onClick={() => setFullscreen(value => !value)}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button><button type="button" className="certificate-domain-export" title="导出已勾选域名为 TXT，每行一个域名" disabled={exporting || !unique.some(domain => selected.includes(domain))} onClick={() => void exportDomains()}><Download size={16} />{exporting ? "导出中…" : "导出"}</button><button type="button" aria-label="关闭域名列表" title="关闭" onClick={close}><X size={18} /></button></nav></header>
      <label className="certificate-domain-search"><Search size={16} /><input autoFocus aria-label="搜索完整域名列表" placeholder="搜索域名" value={filter} onChange={event => setFilter(event.target.value)} /></label>
      <ExportChecklist items={matches.map(domain => ({ id: domain, label: domain }))} selected={selected} onChange={ids => setSelected(current => [...current.filter(domain => !matches.includes(domain)), ...ids])} disabled={exporting} search={false} />
      {!matches.length && <p>没有匹配的域名</p>}
      <footer>显示 {matches.length} / {unique.length} 个域名{status && <span role="status">{status}</span>}</footer>
    </dialog>, document.body)}
  </>;
}
