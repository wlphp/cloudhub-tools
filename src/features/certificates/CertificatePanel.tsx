import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Download, Eye, Plus, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { certificatesClient } from "../../platform/clients";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import type { Account, Certificate, LocalAsset } from "../../shared/types";
import "./certificates.css";

type Props = {
  accounts: Account[];
  localAssets: LocalAsset[];
  onStatus: (message: string) => void;
  onConfirm: (message: string) => Promise<boolean>;
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

export function CertificatePanel({ accounts, localAssets, onStatus, onConfirm }: Props) {
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
  const accountDomainAssets = useMemo(
    () =>
      domainAssets.filter(
        (asset) =>
          asset.account_id === Number(form.accountId) &&
          aliyunAccounts.some((account) => account.id === asset.account_id),
      ),
    [domainAssets, form.accountId, aliyunAccounts],
  );
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
    setForm((current) => ({
      ...current,
      dnsZone: zone,
      primaryDomain:
        current.primaryDomain === current.dnsZone ||
        current.primaryDomain === `*.${current.dnsZone}`
          ? current.primaryDomain
          : zone,
      domains:
        current.domains === current.dnsZone ||
        current.domains === `*.${current.dnsZone}`
          ? zone
          : current.domains,
    }));
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
    void load();
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
      !accountDomainAssets.length ||
      !accountDomainAssets.some(
        (asset) => assetDomain(asset) === form.dnsZone.trim().toLowerCase(),
      )
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
      });
      setRows((current) => [saved, ...current]);
      setOpenForm(false);
      onStatus(`${saved.primaryDomain} 证书申请成功`);
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
    <section className="certificate-page">
      <header>
        <div>
          <span className="eyebrow">HTTPS CERTIFICATES</span>
          <h1>HTTPS 证书</h1>
          <p>
            通过 DNS-01 验证申请和管理本机证书。私钥仅加密保存在本地数据库。
          </p>
        </div>
        <button
          className="primary-update-btn"
          onClick={openRequest}
          disabled={!runningInTauri}
        >
          <Plus size={15} />
          申请证书
        </button>
      </header>
      {!runningInTauri && (
        <div className="certificate-preview-warning">
          证书申请、密钥材料读取和删除仅支持桌面客户端，浏览器预览不会模拟成功。
        </div>
      )}
      <section className="panel certificate-panel">
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
                  <th>品牌</th>
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
                        <small className="asset-subline">
                          {row.domains.join(" · ")}
                        </small>
                      </td>
                      <td>{providerLabels[row.provider] || row.provider}</td>
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
            <p>点击“申请证书”，选择证书品牌并完成 DNS-01 验证。</p>
          </div>
        )}
      </section>
      {openForm && (
        <div className="modal-backdrop">
          <form className="detail-panel certificate-dialog" onSubmit={submit}>
            <div className="modal-head">
              <div>
                <span className="eyebrow">DNS-01</span>
                <h2>申请 HTTPS 证书</h2>
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
              域名和 DNS
              区域只从当前账号已同步的域名资产中选择，避免把证书申请到其他账号的域名上。
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
                  <input
                    required
                    type="password"
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
                value={form.accountId}
                onChange={(event) => selectAccount(event.target.value)}
              >
                <option value="">选择阿里云账号</option>
                {aliyunAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.account_name}（
                    {
                      domainAssets.filter(
                        (asset) => asset.account_id === account.id,
                      ).length
                    }{" "}
                    个域名）
                  </option>
                ))}
              </select>
            </label>
            <label>
              DNS 区域
              <select
                required
                value={form.dnsZone}
                onChange={(event) => selectZone(event.target.value)}
              >
                <option value="">选择当前账号下的域名</option>
                {accountDomainAssets.map((asset) => (
                  <option
                    key={`${asset.account_id}:${asset.asset_key}`}
                    value={assetDomain(asset)}
                  >
                    {assetDomain(asset)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              证书主域名（快捷填充）
              <select
                required
                value={form.primaryDomain}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    primaryDomain: event.target.value,
                    domains: event.target.value,
                  }))
                }
              >
                <option value="">选择证书主域名</option>
                {form.dnsZone && (
                  <>
                    <option value={form.dnsZone}>{form.dnsZone}</option>
                    <option value={`*.${form.dnsZone}`}>
                      *.{form.dnsZone}（通配符）
                    </option>
                  </>
                )}
              </select>
            </label>
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
            ) : form.accountId && !accountDomainAssets.length ? (
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
                  loading || !form.accountId || !accountDomainAssets.length
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
