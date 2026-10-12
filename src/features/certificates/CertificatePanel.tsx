import { SecretField } from "../../shared/SecretField";
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Download, Eye, Plus, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { certificatesClient } from "../../platform/clients";
import type { EsaCertificateTarget } from "../../platform/clients/certificates";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import type { Account, Certificate, LocalAsset } from "../../shared/types";
import "./certificates.css";
import { CertificateImportDialog } from "./CertificateImportDialog";
import { BaotaCertificateManager } from "./BaotaCertificateManager";
import { CertificateDomains } from "./CertificateDomains";

type Props = {
  accounts: Account[];
  localAssets: LocalAsset[];
  onStatus: (message: string) => void;
  onConfirm: (message: string) => Promise<boolean>;
  requestTarget?: EsaCertificateTarget;
  onIssued?: (certificate: Certificate) => void;
  onRequestClosed?: () => void;
};
type CertificateLog = {
  level: "info" | "success" | "error";
  message: string;
  timestamp: number;
};
type CertificateProgress = CertificateLog & { operationId: string; stage: string };
type CertificateChainItem = {
  level: number;
  name: string;
  issuer: string;
  notBefore?: number | null;
  notAfter?: number | null;
};
type CertificatePreview = {
  certificatePem: string;
  privateKeyAvailable: boolean;
  chain: CertificateChainItem[];
};
const providerLabels: Record<string, string> = {
  letsencrypt: "Let's Encrypt",
  litessl: "LiteSSL",
};
const domainPresets = [
  { label: "主域名 @", prefixes: [""] },
  { label: "www", prefixes: ["www."] },
  { label: "泛域名 *", prefixes: ["*."] },
  { label: "@ + www", prefixes: ["", "www."] },
  { label: "@ + *", prefixes: ["", "*."] },
];
const presetDomains = (zone: string, prefixes: string[]) => prefixes.map(prefix => `${prefix}${zone}`).join("\n");
const emptyForm = {
  accountId: "",
  provider: "letsencrypt" as "letsencrypt" | "litessl",
  primaryDomain: "",
  domains: "",
  dnsZone: "",
  eabKid: "",
  eabHmacKey: "",
};

function date(value?: number | null) {
  if (!value) return "未解析";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).formatToParts(new Date(value * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function days(value?: number | null) {
  return value ? Math.ceil((value * 1000 - Date.now()) / 86400000) : null;
}

export function CertificatePanel({ accounts, localAssets, onStatus, onConfirm, requestTarget, onIssued, onRequestClosed }: Props) {
  const [sourceView, setSourceView] = useState<"local" | "baota">("local");
  const [importOpen, setImportOpen] = useState(false);
  const [rows, setRows] = useState<Certificate[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [openForm, setOpenForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [requestLogs, setRequestLogs] = useState<CertificateLog[]>([]);
  const [detail, setDetail] = useState<Certificate | null>(null);
  const [detailPreview, setDetailPreview] = useState<CertificatePreview | null>(null);
  const [detailPreviewLoading, setDetailPreviewLoading] = useState(false);
  const [certificateCopied, setCertificateCopied] = useState(false);
  const [filter, setFilter] = useState("");
  const domainAssets = useMemo(
    () => localAssets.filter((asset) => asset.resource_type === "domain"),
    [localAssets],
  );
  const aliyunAccounts = useMemo(
    () => accounts.filter((account) => account.cloud_type === "aliyun"),
    [accounts],
  );
  const esaDns = requestTarget?.accessType === "NS";
  const accountDomainAssets = useMemo(
    () =>
      domainAssets.filter(
        (asset) =>
          asset.account_id === Number(form.accountId) &&
          aliyunAccounts.some((account) => account.id === asset.account_id),
      ),
    [domainAssets, form.accountId, aliyunAccounts],
  );
  const zoneNames = esaDns && requestTarget ? [requestTarget.siteName] : accountDomainAssets.map(assetDomain);
  const filtered = useMemo(
    () =>
      rows.filter((row) =>
        `${row.primaryDomain} ${row.domains.join(" ")} ${row.issuer || ""}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
      ),
    [rows, filter],
  );

  function assetDomain(asset: LocalAsset) {
    return String(asset.payload?.DomainName || asset.asset_key || "")
      .trim()
      .toLowerCase();
  }
  function selectAccount(accountId: string) {
    const first = domainAssets.find(
      (asset) =>
        asset.account_id === Number(accountId) &&
        aliyunAccounts.some((account) => account.id === asset.account_id),
    );
    const domain = first ? assetDomain(first) : "";
    setForm((current) => ({
      ...current,
      accountId,
      primaryDomain: domain,
      domains: domain,
      dnsZone: domain,
    }));
    setError("");
  }
  function selectZone(zone: string) {
    setForm((current) => {
      const preset = domainPresets.find(item => presetDomains(current.dnsZone, item.prefixes) === current.domains.trim());
      const domains = zone ? presetDomains(zone, preset?.prefixes ?? [""]) : "";
      return { ...current, dnsZone: zone, domains, primaryDomain: domains.split("\n")[0] };
    });
  }

  async function load() {
    setLoading(true);
    setError("");
    try {
      setRows(await certificatesClient.list());
    } catch (reason) {
      setError(platformErrorMessage(reason, "读取证书列表失败"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (requestTarget) {
      const matches = domainAssets.filter(asset => requestTarget.siteName === assetDomain(asset) || requestTarget.siteName.endsWith(`.${assetDomain(asset)}`)).sort((a, b) => assetDomain(b).length - assetDomain(a).length);
      setForm({ ...emptyForm, accountId: String(esaDns ? requestTarget.accountId : matches[0]?.account_id ?? ""), dnsZone: esaDns ? requestTarget.siteName : matches[0] ? assetDomain(matches[0]) : "", domains: requestTarget.siteName, primaryDomain: requestTarget.siteName });
      setOpenForm(true);
    } else void load();
  }, []);
  useEffect(() => {
    if (!detail) {
      setDetailPreview(null);
      return;
    }
    let active = true;
    setDetailPreviewLoading(true);
    void certificatesClient.preview(detail.id)
      .then((preview) => {
        if (active) setDetailPreview(preview);
      })
      .catch((reason) => {
        if (active) onStatus(platformErrorMessage(reason, "读取证书详情失败"));
      })
      .finally(() => {
        if (active) setDetailPreviewLoading(false);
      });
    return () => { active = false; };
  }, [detail, onStatus]);

  function openRequest() {
    const first = domainAssets.find((asset) =>
      aliyunAccounts.some((account) => account.id === asset.account_id),
    );
    const accountId = first?.account_id || aliyunAccounts[0]?.id;
    const domain = first ? assetDomain(first) : "";
    setForm({
      ...emptyForm,
      accountId: accountId ? String(accountId) : "",
      primaryDomain: domain,
      domains: domain,
      dnsZone: domain,
    });
    setOpenForm(true);
    setError("");
    setRequestLogs([]);
    setActiveOperationId(null);
    setCancelling(false);
  }
  async function cancelRequest() {
    if (!activeOperationId) {
      setOpenForm(false);
      onRequestClosed?.();
      return;
    }
    setCancelling(true);
    setRequestLogs((current) => [...current.slice(-79), { level: "info", message: "已请求取消，正在停止申请并清理本次 TXT 记录…", timestamp: Date.now() }]);
    try {
      await certificatesClient.cancel(activeOperationId);
    } catch (reason) {
      setCancelling(false);
      setError(platformErrorMessage(reason, "取消证书申请失败"));
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const operationId = crypto.randomUUID();
    setActiveOperationId(operationId);
    setCancelling(false);
    setRequestLogs([{ level: "info", message: "正在准备证书申请…", timestamp: Date.now() }]);
    const domains = form.domains
      .split(/[\n,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      !form.accountId ||
      !zoneNames.includes(form.dnsZone.trim().toLowerCase())
    ) {
      setError("请选择当前 DNS 账号下已同步的域名资产");
      setLoading(false);
      return;
    }
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<CertificateProgress>("certificate-request-progress", (event) => {
        if (event.payload.operationId !== operationId) return;
        setRequestLogs((current) => [...current.slice(-79), {
          level: event.payload.level,
          message: event.payload.message,
          timestamp: Date.now(),
        }]);
      });
      const saved = await certificatesClient.request({
        accountId: Number(form.accountId),
        provider: form.provider,
        primaryDomain: domains[0] ?? form.primaryDomain.trim(),
        domains,
        dnsZone: form.dnsZone.trim(),
        eabKid: form.provider === "litessl" ? form.eabKid.trim() : undefined,
        eabHmacKey:
          form.provider === "litessl" ? form.eabHmacKey.trim() : undefined,
        operationId,
        esaSiteId: esaDns ? requestTarget?.siteId : undefined,
      });
      setRows((current) => [saved, ...current]);
      setOpenForm(false);
      onStatus(`${saved.primaryDomain} 证书申请成功`);
      onIssued?.(saved);
    } catch (reason) {
      const message = platformErrorMessage(reason, "证书申请失败");
      setError(message);
      setRequestLogs((current) => [...current.slice(-79), { level: "error", message, timestamp: Date.now() }]);
    } finally {
      unlisten?.();
      setLoading(false);
      setActiveOperationId(null);
      setCancelling(false);
    }
  }
  async function remove(row: Certificate) {
    if (!(await onConfirm(`确认删除本地证书记录“${row.primaryDomain}”吗？这不会撤销 CA 已签发的证书。`))) return;
    try {
      await certificatesClient.remove(row.id);
      setRows((current) => current.filter((item) => item.id !== row.id));
      onStatus("证书本地记录已删除");
    } catch (reason) {
      onStatus(platformErrorMessage(reason, "删除证书失败"));
    }
  }
  async function downloadArchive(row: Certificate) {
    try {
      const path = await certificatesClient.downloadArchive(row.id, row.primaryDomain);
      if (path) onStatus(`已保存证书压缩包：${path}`);
    } catch (reason) {
      onStatus(platformErrorMessage(reason, "下载证书压缩包失败"));
    }
  }
  async function copyCertificatePem() {
    const pem = detailPreview?.certificatePem;
    if (!pem) return;
    try {
      await navigator.clipboard.writeText(pem);
      setCertificateCopied(true);
      window.setTimeout(() => setCertificateCopied(false), 1800);
      onStatus("证书 PEM 已复制到剪贴板");
    } catch (reason) {
      onStatus(platformErrorMessage(reason, "复制证书 PEM 失败"));
    }
  }

  return (
    <section className={`certificate-page${requestTarget ? " ide-theme" : ""}`}>
      {!requestTarget && <>
      <header>
        <div>
          <span className="eyebrow">HTTPS CERTIFICATES</span>
          <h1>HTTPS 证书</h1>
          <p>
            申请、导入和管理本机及宝塔站点证书。私钥仅加密保存在本地数据库。
          </p>
        </div>
        <div className="certificate-header-actions"><button className="secondary" disabled={!runningInTauri} onClick={() => setImportOpen(true)}><Plus size={15} />导入证书</button><button
          className="primary-update-btn"
          onClick={openRequest}
          disabled={!runningInTauri}
        >
          <Plus size={15} />
          申请证书
        </button></div>
      </header>
      {!runningInTauri && (
        <div className="certificate-preview-warning">
          证书申请、密钥材料读取和删除仅支持桌面客户端，浏览器预览不会模拟成功。
        </div>
      )}
      {!requestTarget && <div className="certificate-source-tabs"><button className={sourceView === "local" ? "active" : ""} onClick={() => setSourceView("local")}>本地证书</button><button className={sourceView === "baota" ? "active" : ""} disabled={!runningInTauri} onClick={() => setSourceView("baota")}>宝塔站点证书</button></div>}
      {sourceView === "baota" ? <BaotaCertificateManager certificates={rows} onChanged={() => void load()} onConfirm={onConfirm} onStatus={onStatus} /> : <section className="panel certificate-panel">
        <div className="certificate-summary" aria-label="证书概览">
          <div><span>证书总数</span><strong>{rows.length}</strong><small>本地加密保存</small></div>
          <div><span>已签发</span><strong>{rows.filter((row) => row.status === "issued").length}</strong><small>可查看与下载</small></div>
          <div><span>即将到期</span><strong>{rows.filter((row) => { const remaining = days(row.notAfter); return remaining !== null && remaining >= 0 && remaining <= 30; }).length}</strong><small>30 天内到期</small></div>
        </div>
        <div className="certificate-toolbar">
          <input
            aria-label="搜索证书"
            placeholder="搜索域名或签发方"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <button
            className="secondary"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? "spin" : undefined} />
            刷新
          </button>
          <span className="certificate-count">共 {filtered.length} 张</span>
        </div>
        {error && <div className="form-error">{error}</div>}
        {filtered.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>域名</th>
                  <th>来源</th>
                  <th>签发者</th>
                  <th>有效期</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const remaining = days(row.notAfter);
                  return (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.primaryDomain}</strong>
                        <CertificateDomains domains={row.domains} title={row.primaryDomain} />
                        {row.sourceSites?.map(site => <div key={site.id}><small className="asset-subline">{site.panelName} · 站点 {site.siteName}</small><CertificateDomains domains={site.siteDomains} title={`${site.panelName} · ${site.siteName}`} /></div>)}
                      </td>
                      <td><span className={`certificate-source-label source-${row.sourceKind || "acme"}`}>{row.sourceKind === "manual" || row.provider === "manual" ? "手动导入" : row.sourceKind === "baota" || row.provider === "baota" ? "宝塔导入" : "申请签发"}</span>{providerLabels[row.provider] && <small className="asset-subline">{providerLabels[row.provider]}</small>}</td>
                      <td>{row.issuer || "—"}</td>
                      <td>
                        <div>
                          {date(row.notBefore)}
                          <br />至 {date(row.notAfter)}
                        </div>
                        {remaining !== null && (
                          <small
                            className={
                              remaining <= 30
                                ? "certificate-expiring"
                                : "asset-subline"
                            }
                          >
                            {remaining < 0
                              ? `已过期 ${Math.abs(remaining)} 天`
                              : `剩余 ${remaining} 天`}
                          </small>
                        )}
                      </td>
                      <td>
                        <span className={`certificate-status ${row.status}`}>
                          {row.status === "issued" ? "已签发" : row.status}
                        </span>
                      </td>
                      <td>
                        <div className="certificate-actions">
                          <button
                            className="secondary"
                            onClick={() => setDetail(row)}
                          >
                            <Eye size={14} />
                            详情
                          </button>
                          <button
                            className="secondary certificate-download"
                            onClick={() => void downloadArchive(row)}
                            disabled={row.status !== "issued"}
                            title="下载证书压缩包"
                          >
                            <Download size={14} />
                            下载
                          </button>
                          <button
                            className="danger-button"
                            onClick={() => void remove(row)}
                          >
                            <Trash2 size={14} />
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            <ShieldCheck size={42} />
            <h3>{loading ? "正在读取证书…" : "暂无证书"}</h3>
            <p>可申请新证书，或导入已有证书与私钥。</p>
          </div>
        )}
      </section>}
      </>}
      {importOpen && <CertificateImportDialog onClose={() => setImportOpen(false)} onImported={() => { setImportOpen(false); void load(); onStatus("证书已导入本地加密库"); }} />}
      {openForm && (
        <div className={`modal-backdrop${requestTarget ? " esa-certificate-request-backdrop" : ""}`}>
          <form className="detail-panel certificate-dialog" onSubmit={submit}>
            <div className="modal-head">
              <div>
                <span className="eyebrow">DNS-01</span>
                <h2>{requestTarget ? "申请证书并部署到 ESA" : "申请 HTTPS 证书"}</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => void cancelRequest()}
              >
                <X size={18} />
              </button>
            </div>
            <p className="certificate-hint">
              {requestTarget ? `目标 ESA 站点：${requestTarget.siteName}。签发后先加密保存，再上传；上传失败可直接重试部署。${esaDns ? "本次使用 ESA DNS 写入 TXT 验证记录。" : "请选择域名权威 DNS 所在的阿里云账号，ESA 账号与 DNS 账号可以不同。"}` : "域名和 DNS 区域只从当前账号已同步的域名资产中选择，避免把证书申请到其他账号的域名上。"}
            </p>
            <label>
              证书品牌
              <select
                value={form.provider}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    provider: event.target.value as "letsencrypt" | "litessl",
                  }))
                }
              >
                <option value="letsencrypt">Let's Encrypt（免费）</option>
                <option value="litessl">LiteSSL（需要 EAB）</option>
              </select>
            </label>
            {form.provider === "litessl" && (
              <>
                <label>
                  EAB KID
                  <input
                    required
                    value={form.eabKid}
                    onChange={(event) => setForm((current) => ({ ...current, eabKid: event.target.value }))}
                    placeholder="LiteSSL 控制台提供的 EAB KID"
                  />
                </label>
                <label>
                  EAB HMAC 密钥
                  <SecretField secretLabel="EAB HMAC 密钥"
                    required
                    value={form.eabHmacKey}
                    onChange={(event) => setForm((current) => ({ ...current, eabHmacKey: event.target.value }))}
                    placeholder="LiteSSL 控制台提供的 Base64URL 密钥"
                  />
                </label>
                <div className="certificate-hint">LiteSSL 的 EAB 凭据由其控制台生成，不会保存到本地数据库。</div>
              </>
            )}
            <label>
              DNS 账号
              <select
                required
                disabled={esaDns}
                value={form.accountId}
                onChange={(event) => selectAccount(event.target.value)}
              >
                <option value="">选择阿里云账号</option>
                {aliyunAccounts.filter(account => !esaDns || account.id === requestTarget?.accountId).map(account => (
                  <option key={account.id} value={account.id}>{account.account_name}（{esaDns ? "ESA DNS" : `${domainAssets.filter(asset => asset.account_id === account.id).length} 个域名`}）</option>
                ))}
              </select>
            </label>
            <label>
              DNS 区域
              <select
                required
                disabled={esaDns}
                value={form.dnsZone}
                onChange={(event) => selectZone(event.target.value)}
              >
                <option value="">选择当前账号下的域名</option>
                {zoneNames.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <div className="certificate-domain-presets" role="group" aria-label="证书域名快捷填充">
              <span>快捷填充</span>
              {domainPresets.map(preset => <button key={preset.label} type="button" disabled={!form.dnsZone || loading}
                aria-pressed={!!form.dnsZone && form.domains.trim() === presetDomains(form.dnsZone, preset.prefixes)}
                onClick={() => { const domains = presetDomains(form.dnsZone, preset.prefixes); setForm(current => ({ ...current, domains, primaryDomain: domains.split("\n")[0] })); }}
                title={form.dnsZone ? presetDomains(form.dnsZone, preset.prefixes).replace(/\n/g, "、") : "请先选择 DNS 区域"}>{preset.label}</button>)}
              <small>点击替换下方域名，可继续手动编辑。@ 表示主域名；泛域名 * 不包含主域名，需要两者请选择 @ + *。</small>
            </div>
            <label>
              证书域名（每行或逗号分隔）
              <textarea
                required
                rows={3}
                value={form.domains}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    domains: event.target.value,
                  }))
                }
                placeholder="主域名\nwww.example.com"
              />
            </label>
            {!form.accountId ? (
              <div className="certificate-hint">请先选择 DNS 账号。</div>
            ) : form.accountId && !zoneNames.length ? (
              <div className="form-error">
                当前账号没有已同步的域名资产，请先在资产管理中同步域名。
              </div>
            ) : null}
            <section className="certificate-request-log" aria-live="polite" aria-label="证书申请日志">
              <div className="certificate-request-log-head">
                <span>证书申请日志</span>
                <small>{loading ? "实时输出中" : requestLogs.length ? "已完成" : "等待开始"}</small>
              </div>
              <div className="certificate-request-log-body">
                {requestLogs.length ? requestLogs.map((entry, index) => (
                  <div key={`${entry.timestamp}-${index}`} className={`certificate-log-${entry.level}`}>
                    <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                    <span>{entry.message}</span>
                  </div>
                )) : <div className="certificate-log-info"><span>申请开始后会显示 DNS 验证与失败原因（敏感凭据不会显示）。</span></div>}
              </div>
            </section>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => void cancelRequest()}
                disabled={cancelling}
              >
                {cancelling ? "正在取消…" : "取消"}
              </button>
              <button
                type="submit"
                className="primary-update-btn"
                disabled={
                  loading || !form.accountId || !zoneNames.length
                }
              >
                {loading ? "申请中，等待 DNS 验证…" : "开始申请"}
              </button>
            </div>
          </form>
        </div>
      )}
      {detail && (
        <div className="modal-backdrop certificate-modal-backdrop">
          <div className="detail-panel certificate-dialog">
            <div className="modal-head">
              <div>
                <span className="eyebrow">CERTIFICATE DETAILS</span>
                <h2>{detail.primaryDomain}</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setDetail(null)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="certificate-detail-summary">
              <div>
                <span>证书分类</span>
                <strong>{providerLabels[detail.provider] || detail.provider}</strong>
              </div>
              <div>
                <span>证书品牌</span>
                <strong>{detail.issuer || providerLabels[detail.provider] || "未解析"}</strong>
              </div>
              <div>
                <span>认证域名</span>
                <strong>{detail.domains.join("、")}</strong>
              </div>
              <div>
                <span>到期时间</span>
                <strong>{date(detail.notAfter)}</strong>
              </div>
            </div>
            <section className="certificate-chain-section" aria-label="证书链信息">
              <h3>🔗 证书链信息</h3>
              <div className="certificate-chain-list">
                {(detailPreview?.chain || []).map((item) => {
                  const remaining = days(item.notAfter);
                  return (
                    <div className="certificate-chain-item" key={`${item.level}-${item.name}`}>
                      <div>
                        <span className="certificate-level">Level {item.level}</span>
                        <strong>{item.name}</strong>
                        <small>↑ 颁发者: {item.issuer}</small>
                      </div>
                      <div className="certificate-chain-validity">
                        <span>{date(item.notBefore)} 至 {date(item.notAfter)}</span>
                        {remaining !== null && (
                          <small className={remaining <= 30 ? "certificate-expiring" : "certificate-valid"}>
                            {remaining < 0 ? `已过期 ${Math.abs(remaining)} 天` : `剩余 ${remaining} 天`}
                          </small>
                        )}
                      </div>
                    </div>
                  );
                })}
                {!detailPreviewLoading && !detailPreview?.chain?.length && <span className="certificate-chain-empty">暂无证书链信息</span>}
                {detailPreviewLoading && <span className="certificate-chain-empty">正在读取证书链信息…</span>}
              </div>
            </section>
            <section className="certificate-san-section" aria-label="包含域名">
              <h3>🌐 包含域名（SAN） <small>共 {detail.domains.length} 个</small></h3>
              <div className="certificate-san-list">
                {detail.domains.map((domain, index) => <span key={domain}><b>{index === 0 ? "★" : ""}</b>{domain}</span>)}
              </div>
            </section>
            <section className="certificate-material-grid" aria-label="证书材料">
              <div className="certificate-code-panel">
                <div className="certificate-code-head">
                  <span>私钥（KEY）</span>
                  <small>{detailPreview?.privateKeyAvailable ? "已加密保存 · 请下载 ZIP" : "不可用"}</small>
                </div>
                <pre>{detailPreviewLoading ? "正在读取证书信息…" : "-----BEGIN PRIVATE KEY-----\n私钥仅保存在本地加密数据库\n请通过“下载 ZIP”导出使用\n-----END PRIVATE KEY-----"}</pre>
              </div>
              <div className="certificate-code-panel">
                <div className="certificate-code-head">
                  <span>证书（PEM 格式）</span>
                  <div className="certificate-code-actions">
                    <small>{detailPreview ? "已读取" : "等待读取"}</small>
                    <button
                      type="button"
                      className="certificate-copy-button"
                      onClick={() => void copyCertificatePem()}
                      disabled={!detailPreview?.certificatePem}
                      title="复制证书 PEM"
                    >
                      {certificateCopied ? <Check size={13} /> : <Copy size={13} />}
                      {certificateCopied ? "已复制" : "复制"}
                    </button>
                  </div>
                </div>
                <pre>{detailPreviewLoading ? "正在读取证书信息…" : detailPreview?.certificatePem || "暂无证书 PEM 内容"}</pre>
              </div>
            </section>
            <div className="certificate-export-box">
              <div>
                <strong>下载证书包</strong>
                <span>包含通用 PEM、Nginx、Apache、IIS、Tomcat 文件及使用说明。</span>
              </div>
              <div className="certificate-export-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void downloadArchive(detail)}
                >
                  <Download size={14} />
                  下载 ZIP
                </button>
              </div>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setDetail(null)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
