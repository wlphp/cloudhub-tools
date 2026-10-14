import { DialogHeaderActions } from "../../shared/DialogHeaderActions";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, Upload, X } from "lucide-react";
import { runningInTauri, platformErrorMessage } from "../../platform/api";
import { certificatesClient, type EsaCertificateContext, type EsaCertificateDeployment } from "../../platform/clients/certificates";
import type { Account, LocalAsset } from "../../shared/types";
import { CertificatePanel } from "./CertificatePanel";
import "./certificates.css";

type Props = { account: Account; siteId: number; accounts: Account[]; localAssets: LocalAsset[]; onClose: () => void; onStatus: (message: string) => void; onConfirm: (message: string) => Promise<boolean> };

export function EsaCertificateDialog({ account, siteId, accounts, localAssets, onClose, onStatus, onConfirm }: Props) {
  const [context, setContext] = useState<EsaCertificateContext | null>(null);
  const [selected, setSelected] = useState("");
  const [showAllLocal, setShowAllLocal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<EsaCertificateDeployment | null>(null);
  const [requesting, setRequesting] = useState(false);
  const alive = useRef(true);
  const operation = useRef(false);

  async function refresh() {
    if (operation.current || !runningInTauri) return;
    operation.current = true; setBusy(true); setError("");
    try {
      const next = await certificatesClient.esaContext(account.id, siteId);
      if (alive.current) {
        setContext(next);
        setSelected(current => {
          const isAvailable = (id: string) => next.candidates.find(cert =>
            String(cert.id) === id && cert.deployable && (showAllLocal || cert.matchesSite),
          );
          const stillAvailable = isAvailable(current);
          return String(stillAvailable?.id ?? next.candidates.find(cert =>
            cert.deployable && (showAllLocal || cert.matchesSite),
          )?.id ?? "");
        });
      }
    } catch (reason) { if (alive.current) setError(platformErrorMessage(reason, "读取 ESA 证书失败")); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }
  const visibleCandidates = context?.candidates.filter(cert => showAllLocal || (cert.matchesSite && cert.deployable)) ?? [];
  const deployableCandidates = visibleCandidates.filter(cert => cert.deployable);
  const selectedCandidate = context?.candidates.find(cert => String(cert.id) === selected);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, []);

  async function deploy(certificateId: number) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(""); setResult(null);
    try {
      const deployed = await certificatesClient.deployEsa(account.id, siteId, certificateId);
      if (!alive.current) return;
      setResult(deployed); onStatus(deployed.message);
      try { const next = await certificatesClient.esaContext(account.id, siteId); if (alive.current) setContext(next); }
      catch { if (alive.current) setError("上传结果已保留，刷新站点证书失败；请稍后点击刷新状态。"); }
    } catch (reason) { if (alive.current) setError(platformErrorMessage(reason, "部署失败；本地证书已保留，可重试部署")); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }
  const title = context ? `${context.site.siteName} · ESA 证书` : "ESA 站点证书";
  return createPortal(<>
    {!requesting && <div className="modal-backdrop esa-certificate-backdrop ide-theme">
      <section role="dialog" aria-modal="true" aria-label={title} className="detail-panel certificate-dialog esa-certificate-dialog">
        <div className="modal-head"><div><span className="eyebrow">ESA / HTTPS</span><h2>{title}</h2><p>{account.account_name} · 站点 ID {siteId}</p></div><DialogHeaderActions><button type="button" className="close" aria-label="关闭 ESA 证书" disabled={busy} onClick={onClose}><X size={18} /></button></DialogHeaderActions></div>
        {!runningInTauri && <p className="certificate-hint">证书部署仅支持桌面客户端。</p>}
        <div className="esa-certificate-body">
          <div className="esa-certificate-tools"><strong>ESA 当前证书</strong><button type="button" disabled={busy || !runningInTauri} onClick={() => void refresh()}><RefreshCw size={14} />刷新状态</button></div>
          {context?.remote.length ? <div className="esa-certificate-list">{context.remote.map(cert => <div key={cert.id}><strong>{cert.domains.join("、") || cert.name || cert.id}</strong><span>{cert.status === "OK" ? "正常" : cert.status || "状态未知"} · {cert.kind === "upload" ? "自定义证书" : cert.kind} · {cert.notAfter ? `到期 ${cert.notAfter} UTC` : "有效期待确认"}</span></div>)}</div> : <p className="certificate-hint">{busy ? "正在读取站点证书…" : context ? "该站点暂无证书" : "请读取站点信息后部署"}</p>}
          <div className="esa-local-certificate-tools">
            <label className="esa-local-certificate-select">选择本地证书<select aria-label="选择本地证书" value={selected} disabled={busy || !context} onChange={event => { setSelected(event.target.value); setResult(null); }}><option value="">{deployableCandidates.length ? "选择匹配站点的有效证书" : "没有可部署的匹配证书"}</option>{visibleCandidates.map(cert => <option key={cert.id} value={cert.id} disabled={!cert.deployable}>{cert.domains.join("、") || "未记录域名"} · {cert.notAfter ? new Date(cert.notAfter * 1000).toLocaleDateString("zh-CN") : "有效期未知"}{cert.reason ? ` · ${cert.reason}` : ""}</option>)}</select></label>
            <label className="esa-show-all-certificates"><input type="checkbox" checked={showAllLocal} disabled={busy || !context?.candidates.length} onChange={event => {
              const showAll = event.target.checked;
              setShowAllLocal(showAll);
              setSelected(current => {
                const currentCandidate = context?.candidates.find(cert => String(cert.id) === current);
                if (currentCandidate?.deployable && (showAll || currentCandidate.matchesSite)) return current;
                return String(context?.candidates.find(cert => cert.deployable && (showAll || cert.matchesSite))?.id ?? "");
              });
              setResult(null);
            }} />显示全部本地证书 <span>显示 {visibleCandidates.length} / 共 {context?.candidates.length ?? 0} 个 · {deployableCandidates.length} 个可部署</span></label>
          </div>
          {showAllLocal && context?.candidates.some(cert => !cert.deployable) && <p className="certificate-hint">灰显项目因证书状态或有效期问题无法部署。</p>}
          <p className="certificate-hint">部署会把选中的证书及私钥上传到此 ESA 站点。域名不匹配的证书也可尝试上传，但 ESA 可能拒绝，或无法为目标域名提供 HTTPS。自定义证书需自行续期；原有证书保留，站点需已开启 SSL/TLS。</p>
          {result && <p role="status" className="security-tip">{result.message}</p>}
          {error && <p role="alert" className="form-error">{error}</p>}
        </div>
        <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>关闭</button><button type="button" className="secondary" disabled={busy || !context || !runningInTauri} onClick={() => { setError(""); setRequesting(true); }}>申请并部署</button><button type="button" className="primary" disabled={busy || !selectedCandidate?.deployable || !context || !runningInTauri} onClick={() => void deploy(Number(selected))}><Upload size={14} />{busy ? "处理中…" : result ? "重新部署" : error ? "重试部署" : "部署已有证书"}</button></div>
      </section>
    </div>}
    {requesting && context && <CertificatePanel accounts={accounts} localAssets={localAssets} onStatus={onStatus} onConfirm={onConfirm}
      requestTarget={{ accountId: account.id, ...context.site }} onRequestClosed={() => setRequesting(false)}
      onIssued={certificate => { setContext(current => current ? { ...current, candidates: [{ id: certificate.id, domains: certificate.domains, status: "issued", deployable: true, matchesSite: true, reason: null, notBefore: null, notAfter: certificate.notAfter ?? null }, ...current.candidates.filter(item => item.id !== certificate.id)] } : current); setSelected(String(certificate.id)); setRequesting(false); void deploy(certificate.id); }} />}
  </>, document.body);
}
