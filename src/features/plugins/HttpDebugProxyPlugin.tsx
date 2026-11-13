import { ToastNotice } from "../../shared/ToastNotice";
import { useDialogDocument } from "../../shared/DialogDocument";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Braces, CircleStop, Copy, Download, ExternalLink, Eye, EyeOff, FileLock2, Info, Play, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { runningInTauri, runningOnPhone } from "../../platform/api";
import { httpDebugProxyClient, type HttpDebugCertificate, type HttpDebugCertificateOverview, type HttpDebugSession, type HttpDebugSnapshot } from "../../platform/clients/http-debug-proxy";
import { SharedDialog } from "../../shared/SharedDialog";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { PaginationBar } from "../../shared/PaginationBar";
import "./http-debug-proxy.css";

const empty: HttpDebugSnapshot = { running: false, address: "", systemProxy: false, systemProxyEnabled: false, systemProxyServer: null, systemProxyRecoveryAvailable: false, systemProxyRecoverySafe: false, upstreamProxy: false, rootCertificateInstalled: false, httpsDecryption: false, sessions: [] };
const PAGE_SIZE = 10;
const time = (value: number) => new Date(value).toLocaleTimeString();
const dateTime = (value: number) => new Date(value).toLocaleString();
const prettyJson = (value: string) => { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return null; } };
type ResponseTypeFilter = "all" | "json" | "image" | "binary" | "text" | "other";
function responseTypeOf(contentType: string): Exclude<ResponseTypeFilter, "all"> {
  const type = contentType.toLowerCase().split(";")[0].trim();
  if (/\bjson\b/.test(type) || type.endsWith("+json")) return "json";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/") || /(?:xml|javascript|x-www-form-urlencoded|graphql)$/.test(type)) return "text";
  if (type.startsWith("application/") || type.startsWith("audio/") || type.startsWith("video/") || type.startsWith("font/")) return "binary";
  return "other";
}

export function HttpDebugProxyPlugin() {
  const document = useDialogDocument();
  const [snapshot, setSnapshot] = useState(empty);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<HttpDebugSession | null>(null);
  const [showSensitive, setShowSensitive] = useState(false);
  const [query, setQuery] = useState("");
  const [methodFilter, setMethodFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("");
  const [responseTypeFilter, setResponseTypeFilter] = useState<ResponseTypeFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [busy, setBusy] = useState(false);
  const [certificateBusy, setCertificateBusy] = useState<"install" | "remove" | "delete" | null>(null);
  const [showCertificates, setShowCertificates] = useState(false);
  const [certificateOverview, setCertificateOverview] = useState<HttpDebugCertificateOverview | null>(null);
  const [certificateLoading, setCertificateLoading] = useState(false);
  const [certificateError, setCertificateError] = useState("");
  const [certificateFeedback, setCertificateFeedback] = useState("");
  const [certificateDetail, setCertificateDetail] = useState<string | null>(null);
  const [certificateToRemove, setCertificateToRemove] = useState<HttpDebugCertificate | null>(null);
  const [applySystemProxy, setApplySystemProxy] = useState(true);
  const [showProxyInfo, setShowProxyInfo] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [detailFeedback, setDetailFeedback] = useState("");
  const [formattedBodies, setFormattedBodies] = useState({ request: false, response: false });
  const unsupported = !runningInTauri || runningOnPhone || !/Windows/i.test(navigator.userAgent);

  const refresh = useCallback(async () => {
    if (unsupported) return;
    try { setSnapshot(await httpDebugProxyClient.state()); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取代理状态失败"); }
  }, [unsupported]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!snapshot.running) return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [snapshot.running, refresh]);
  useEffect(() => {
    if (!detailFeedback) return;
    const timer = window.setTimeout(() => setDetailFeedback(""), 3500);
    return () => window.clearTimeout(timer);
  }, [detailFeedback]);

  async function operate(action: () => Promise<HttpDebugSnapshot | void>, success?: string) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await action();
      if (next) setSnapshot(next);
      else await refresh();
      if (success) setNotice(success);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败，请重试"); }
    finally { setBusy(false); }
  }
  async function changeCertificate(install: boolean) {
    if (busy) return;
    setCertificateBusy(install ? "install" : "remove");
    try {
      await operate(
        () => httpDebugProxyClient.setCertificate(install),
        install ? "已将本机 HTTPS 调试根证书加入当前用户证书存储，HTTPS 会话现在可以解密。可随时在此移除。" : "已移除本机 HTTPS 调试根证书，之后的新 HTTPS 连接只做加密转发。",
      );
      if (showCertificates) await loadCertificates();
    } finally { setCertificateBusy(null); }
  }
  const loadCertificates = useCallback(async () => {
    setCertificateLoading(true); setCertificateError("");
    try { setCertificateOverview(await httpDebugProxyClient.certificates()); }
    catch (reason) { setCertificateError(reason instanceof Error ? reason.message : "读取根证书信息失败"); }
    finally { setCertificateLoading(false); }
  }, []);
  function openCertificateManager() {
    setShowCertificates(true); setCertificateDetail(null); setCertificateFeedback(""); setCertificateError("");
    void loadCertificates();
  }
  async function updateCertificate(action: "install" | "remove" | "delete", fingerprint?: string) {
    if (certificateBusy || busy) return;
    setCertificateBusy(action); setCertificateError(""); setCertificateFeedback("");
    try {
      if (action === "delete") {
        await httpDebugProxyClient.deleteApplicationCertificate();
        setCertificateOverview(null);
        setCertificateFeedback("已删除本机保存的根证书和私钥；下次使用 HTTPS 调试代理时会重新生成。");
        return;
      }
      const next = action === "install" ? await httpDebugProxyClient.setCertificate(true)
        : fingerprint ? await httpDebugProxyClient.removeCertificate(fingerprint)
        : await httpDebugProxyClient.setCertificate(false);
      setSnapshot(next);
      if (action === "remove") setCertificateDetail(null);
      setCertificateFeedback(action === "install" ? "已安装根证书，新建立的 HTTPS 连接会自动解密。" : "已从当前用户证书存储移除根证书，新建立的 HTTPS 连接改为加密转发。");
      await loadCertificates();
    } catch (reason) { setCertificateError(reason instanceof Error ? reason.message : "证书操作失败，请重试"); }
    finally { setCertificateBusy(null); }
  }
  async function copyCertificateText(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setCertificateFeedback(`已复制${label}`); }
    catch { setCertificateError(`复制${label}失败，请检查剪贴板权限。`); }
  }

  const httpsTunnelCount = useMemo(() => snapshot.sessions.filter(item => item.note).length, [snapshot.sessions]);
  const certificateRows = useMemo<HttpDebugCertificate[]>(() => certificateOverview
    ? [certificateOverview.application, ...certificateOverview.store.filter(item => item.fingerprint !== certificateOverview.application.fingerprint)]
    : [], [certificateOverview]);
  const sessions = useMemo(() => snapshot.sessions.filter(item => {
    const matchesQuery = `${item.method} ${item.url} ${item.status}`.toLowerCase().includes(query.trim().toLowerCase());
    const matchesStatus = !statusFilter || String(item.status).startsWith(statusFilter);
    const matchesType = responseTypeFilter === "all" || responseTypeOf(item.responseContentType) === responseTypeFilter;
    return matchesQuery && (methodFilter === "all" || item.method.toUpperCase() === methodFilter) && matchesStatus && matchesType;
  }), [snapshot.sessions, query, methodFilter, statusFilter, responseTypeFilter]);
  const pageCount = Math.max(1, Math.ceil(sessions.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const visibleSessions = useMemo(() => sessions.slice((safePage - 1) * pageSize, safePage * pageSize), [sessions, safePage, pageSize]);
  useEffect(() => { setPage(current => Math.min(current, pageCount)); }, [pageCount]);
  async function selectSession(id: string) {
    if (selectedId === id) { setSelectedId(null); setSelected(null); setShowSensitive(false); setDetailFeedback(""); return; }
    setSelectedId(id); setSelected(null); setShowSensitive(false); setDetailFeedback(""); setFormattedBodies({ request: false, response: false });
    try { setSelected(await httpDebugProxyClient.session(id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取会话详情失败"); }
  }
  async function toggleSensitive() {
    if (!selectedId || busy) return;
    const reveal = !showSensitive;
    setBusy(true); setError("");
    try { setSelected(await httpDebugProxyClient.session(selectedId, reveal)); setShowSensitive(reveal); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取会话详情失败"); }
    finally { setBusy(false); }
  }
  async function exportSelected() {
    if (!selectedId || busy) return;
    setBusy(true); setError(""); setNotice("");
    try { const path = await httpDebugProxyClient.exportSession(selectedId); if (path) setNotice("会话文件已导出。请妥善保管，其中可能包含敏感请求或响应正文。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "导出会话失败"); }
    finally { setBusy(false); }
  }
  async function copyDetailText(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setDetailFeedback(`已复制${label}`); }
    catch { setDetailFeedback(`复制${label}失败，请检查剪贴板权限。`); }
  }
  async function openSelectedUrl() {
    if (!selected || !selectedId) return;
    try {
      const fullSession = await httpDebugProxyClient.session(selectedId, true);
      const url = new URL(fullSession.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("仅允许打开 HTTP 或 HTTPS 链接");
      await openUrl(url.toString());
      setDetailFeedback("已在浏览器中打开 URL。");
    } catch (reason) { setDetailFeedback(reason instanceof Error ? reason.message : "打开 URL 失败。"); }
  }

  if (unsupported) return <section className="http-debug-proxy"><div className="http-debug-proxy-unavailable"><AlertTriangle size={20} /><div><strong>HTTP(S) 抓包仅支持 Windows 桌面端</strong><p>浏览器预览和手机 App 不提供本机代理、系统代理或根证书管理能力。</p></div></div></section>;

  return <section className="http-debug-proxy" aria-label="HTTP(S) 抓包">
    {detailFeedback && createPortal(<div className="toast-notice toast-top http-debug-proxy-feedback-toast" role="status" aria-live="polite" aria-atomic="true">{detailFeedback}</div>, document.body)}
    <header className="http-debug-proxy-heading"><div><h2>HTTP(S) 抓包</h2><p>通过本机代理捕获并检查 HTTP/HTTPS 请求。会话保留到手动清空或退出应用，不会因停止代理或数量增加而自动删除。</p></div>
      <div className="http-debug-proxy-actions"><button type="button" className="secondary" onClick={() => void refresh()} disabled={busy} aria-label="刷新代理状态"><RefreshCw size={14} aria-hidden="true" />刷新</button>
      <button type="button" className="secondary" onClick={() => setShowProxyInfo(true)} disabled={busy}>查看系统代理</button>
      {!snapshot.running ? <><label className="http-debug-proxy-system-toggle"><input type="checkbox" checked={applySystemProxy} onChange={event => setApplySystemProxy(event.target.checked)} disabled={busy} /><span><strong>让 Windows 应用流量经过抓包</strong><small>仅影响遵循 Windows 系统代理的应用</small></span></label><button type="button" className="primary" onClick={() => void operate(() => httpDebugProxyClient.start(applySystemProxy))} disabled={busy}><Play size={14} aria-hidden="true" />开始抓包</button></>
        : <button type="button" className="secondary http-debug-proxy-stop" onClick={() => void operate(async () => { await httpDebugProxyClient.stop(); setSelectedId(null); setSelected(null); return httpDebugProxyClient.state(); }, "抓包已停止，系统代理已恢复，会话记录仍保留。")} disabled={busy}><CircleStop size={14} aria-hidden="true" />停止抓包并恢复代理设置</button>}</div>
    </header>

    {!snapshot.rootCertificateInstalled && <div className="http-debug-proxy-warning" role="note"><AlertTriangle size={18} aria-hidden="true" /><div><strong>{snapshot.running ? httpsTunnelCount ? `已捕获 ${httpsTunnelCount} 个未解密的 HTTPS 连接：安装根证书后即可查看请求与响应内容` : "HTTPS 当前未解密：安装根证书后即可查看会话内容" : "未安装根证书也可以开始抓包，但 HTTPS 无法解密"}</strong><p>未安装 CloudHub 本机根证书时，HTTP 请求会正常记录；HTTPS 连接只做加密转发，只能看到域名，看不到请求头、正文和响应。安装根证书后，新建立的 HTTPS 连接会自动解密。</p><button type="button" className="secondary" onClick={() => changeCertificate(true)} disabled={busy}><ShieldCheck size={14} aria-hidden="true" />安装 HTTPS 解密证书</button></div></div>}

    <div className="http-debug-proxy-status"><span className={snapshot.running ? "is-running" : ""} aria-hidden="true" /><strong>{snapshot.running ? "抓包运行中" : "抓包已停止"}</strong>{snapshot.running && <><code>{snapshot.address}</code><span>{snapshot.systemProxy ? "Windows 应用流量正在经过抓包" : "系统代理未修改，可手动配置应用"}</span>{snapshot.upstreamProxy && <span>已串联原系统上游代理</span>}{!snapshot.httpsDecryption && <span className="http-debug-proxy-decryption-off">HTTPS 未解密</span>}</>}<button type="button" className="secondary http-debug-proxy-certificate-action http-debug-proxy-certificate-manage" onClick={openCertificateManager} disabled={busy || certificateBusy !== null}><FileLock2 size={14} aria-hidden="true" />根证书管理</button>{snapshot.systemProxyRecoveryAvailable && <button type="button" className="secondary http-debug-proxy-certificate-action" onClick={() => setConfirmRestore(true)} disabled={busy || snapshot.running || !snapshot.systemProxyRecoverySafe}>恢复启动前设置</button>}{snapshot.rootCertificateInstalled && <button type="button" className="secondary http-debug-proxy-certificate-action" onClick={() => changeCertificate(false)} disabled={busy}><ShieldCheck size={14} aria-hidden="true" />移除根证书</button>}</div>

    {snapshot.running && <div className="http-debug-proxy-capture-note" role="note"><AlertTriangle size={15} aria-hidden="true" />{snapshot.httpsDecryption ? "HTTP 与 HTTPS 均经过代理；HTTPS 会解密并显示会话内容。" : "HTTP 请求会记录到会话列表；HTTPS 未安装根证书，只做加密转发，安装证书后新连接会自动解密。"}密码、Cookie、Authorization 和 API Key 请求头会隐藏；正文在你选中会话后显示。停止代理会恢复启动前的系统代理设置。</div>}
    {error && <ToastNotice message={error} tone="error" />}
    {certificateBusy && <p className="http-debug-proxy-notice is-pending" role="status">正在等待 Windows「安全警告」确认，请在弹出窗口点击「是」以{certificateBusy === "install" ? "安装" : "移除"}根证书。</p>}
    {notice && <ToastNotice message={notice} />}
    {!snapshot.running && <p className="http-debug-proxy-idle">HTTP 始终可抓；HTTPS 需要安装根证书才能解密，未安装时只转发加密流量。默认启用 Windows 系统代理，并自动串联原有本机 HTTP 上游代理（如 127.0.0.1:10808）。部分应用可能忽略系统代理或使用证书固定。</p>}

    <div className="http-debug-proxy-toolbar"><strong>会话 <span>{sessions.length}{(query || methodFilter !== "all" || statusFilter || responseTypeFilter !== "all") ? ` / ${snapshot.sessions.length}` : "（应用运行期间保留）"}</span></strong><div className="http-debug-proxy-toolbar-actions">
      <label className="http-debug-proxy-search"><Search size={14} aria-hidden="true" /><input aria-label="筛选会话" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="搜索域名、路径" /></label>
      <select aria-label="按请求方法筛选" value={methodFilter} onChange={event => { setMethodFilter(event.target.value); setPage(1); }}><option value="all">全部方法</option>{["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT"].map(method => <option key={method} value={method}>{method}</option>)}</select>
      <input className="http-debug-proxy-status-filter" aria-label="按状态码筛选" inputMode="numeric" value={statusFilter} onChange={event => { setStatusFilter(event.target.value.replace(/\D/g, "").slice(0, 3)); setPage(1); }} placeholder="状态码" />
      <select aria-label="按响应类型筛选" value={responseTypeFilter} onChange={event => { setResponseTypeFilter(event.target.value as ResponseTypeFilter); setPage(1); }}><option value="all">全部类型</option><option value="json">JSON</option><option value="image">图片</option><option value="binary">二进制</option><option value="text">文本</option><option value="other">其他/未知</option></select>
      <button type="button" className="secondary http-debug-proxy-clear" disabled={!snapshot.sessions.length || busy} onClick={() => void operate(async () => { await httpDebugProxyClient.clear(); setSelectedId(null); setSelected(null); setPage(1); await refresh(); }, "会话已清空。")}><Trash2 size={14} aria-hidden="true" />清空会话</button></div></div>
    <div className="http-debug-proxy-table-wrap"><table className="http-debug-proxy-table"><caption className="store-table-caption">HTTP 与 HTTPS 请求会话</caption><thead><tr><th>时间</th><th>方法</th><th>主机与路径</th><th>状态</th><th>耗时</th><th>操作</th></tr></thead><tbody>
      {visibleSessions.map(item => <tr key={item.id} className={selectedId === item.id ? "is-selected" : ""}><td>{time(item.timestamp)}</td><td><code>{item.method}</code></td><td className="http-debug-proxy-url" title={item.url}>{item.url}{item.note && <small className="http-debug-proxy-session-note">{item.note}</small>}</td><td>{item.status || "失败"}</td><td>{item.durationMs} ms</td><td><button type="button" className="table-link http-debug-proxy-view" onClick={() => void selectSession(item.id)} aria-label={`查看 ${item.method} ${item.url} 的详情`}><Eye size={14} aria-hidden="true" />查看</button></td></tr>)}
      {!sessions.length && <tr><td colSpan={6} className="http-debug-proxy-empty">{snapshot.running ? "等待请求……" : "暂无会话"}</td></tr>}
    </tbody></table></div>
    {sessions.length > 0 && <PaginationBar className="http-debug-proxy-pagination" page={safePage} pageSize={pageSize} total={sessions.length} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} pageSizeOptions={[10, 20, 50, 100]} />}
    {showProxyInfo && <SharedDialog sizeStorageKey="features/plugins/http-debug-proxy-plugin/http-debug-proxy-plugin" title="Windows 系统代理" subtitle="当前 Windows 用户的代理设置" size="small" showResize={false} onClose={() => setShowProxyInfo(false)}><dl className="http-debug-proxy-system-info"><div><dt>状态</dt><dd>{snapshot.systemProxyEnabled ? "已启用" : "未启用"}</dd></div><div><dt>代理地址</dt><dd>{snapshot.systemProxyServer || "未设置"}</dd></div><div><dt>抓包代理</dt><dd>{snapshot.systemProxy ? "当前由 CloudHub 接管" : "未由 CloudHub 接管"}</dd></div><div><dt>启动前设置</dt><dd>{snapshot.systemProxyRecoveryAvailable ? snapshot.systemProxyRecoverySafe ? "可安全恢复" : "当前设置已变化，暂不覆盖" : "无待恢复记录"}</dd></div></dl></SharedDialog>}
    {showCertificates && <SharedDialog title="根证书管理" subtitle="查看 CloudHub 本机 HTTPS 调试根证书及其在 Windows 当前用户证书存储中的安装状态" size="large" resizable sizeStorageKey="http-debug-proxy-certificates" onClose={() => { setShowCertificates(false); setCertificateDetail(null); setCertificateFeedback(""); setCertificateError(""); }} headerActions={<button type="button" className="secondary" onClick={() => void loadCertificates()} disabled={certificateLoading || certificateBusy !== null}><RefreshCw size={14} aria-hidden="true" />{certificateLoading ? "读取中…" : "刷新"}</button>}>
      {certificateBusy && <p className="http-debug-proxy-notice is-pending" role="status">正在等待 Windows「安全警告」确认，请在弹出窗口点击「是」以{certificateBusy === "install" ? "安装" : "移除"}根证书。</p>}
      {certificateError && <p className="http-debug-proxy-error" role="alert">{certificateError}</p>}
      {certificateFeedback && <p className="http-debug-proxy-notice" role="status">{certificateFeedback}</p>}
      <p className="http-debug-proxy-certificates-note"><Info size={15} aria-hidden="true" />根证书仅用于解密本机代理转发的 HTTPS 流量，私钥保存在本机应用数据目录，不会上传。从 Windows 证书存储移除不会删除私钥，可随时重新安装；移除只影响之后新建的 HTTPS 连接。</p>
      {certificateLoading && !certificateOverview ? <p className="http-debug-proxy-certificates-empty" role="status">正在读取根证书信息…</p>
        : certificateRows.length ? <ul className="http-debug-proxy-certificates">{certificateRows.map(item => {
          const active = certificateDetail === item.fingerprint;
          const actionBusy = certificateBusy !== null || busy;
          return <li key={item.fingerprint} className={active ? "is-active" : ""}>
            <div className="http-debug-proxy-certificate-head">
              <div className="http-debug-proxy-certificate-title"><FileLock2 size={15} aria-hidden="true" /><strong>{item.commonName || "未命名证书"}</strong>{item.isApplication && <span className="http-debug-proxy-certificate-badge is-application">应用根证书</span>}<span className={`http-debug-proxy-certificate-badge ${item.installed ? "is-installed" : "is-missing"}`}>{item.installed ? "已安装" : "未安装"}</span>{item.expired && <span className="http-debug-proxy-certificate-badge is-expired">已过期</span>}{item.isCa && <span className="http-debug-proxy-certificate-badge">CA 证书</span>}</div>
              <div className="http-debug-proxy-certificate-actions">
                <button type="button" className="secondary" aria-expanded={active} onClick={() => setCertificateDetail(active ? null : item.fingerprint)}>{active ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}{active ? "收起详情" : "查看详情"}</button>
                <button type="button" className="secondary" onClick={() => void copyCertificateText(item.fingerprint, "证书指纹")}><Copy size={13} aria-hidden="true" />复制指纹</button>
                {item.isApplication && <button type="button" className="secondary" onClick={() => item.installed ? setCertificateFeedback("当前 HTTPS 调试代理正在使用此根证书。") : void updateCertificate("install")} disabled={actionBusy} aria-current={item.installed ? "true" : undefined}><ShieldCheck size={13} aria-hidden="true" />{item.installed ? "使用中" : "使用"}</button>}
                {!item.isApplication && <button type="button" className="secondary" disabled title={item.isCa ? "此证书的私钥不由 CloudHub 管理，目前不能用于 HTTPS 代理解密。" : "该证书不是 CA 根证书，不能用于 HTTPS 代理解密。"}><ShieldCheck size={13} aria-hidden="true" />暂不可用</button>}
                {(item.installed || item.isApplication) && <button type="button" className="secondary http-debug-proxy-certificate-remove" onClick={() => setCertificateToRemove(item)} disabled={actionBusy}><Trash2 size={13} aria-hidden="true" />{item.isApplication ? "删除" : "移除"}</button>}
              </div>
            </div>
            <dl className="http-debug-proxy-certificate-meta">
              <div><dt>主题</dt><dd>{item.subject || "—"}</dd></div>
              <div><dt>颁发者</dt><dd>{item.issuer || "—"}</dd></div>
              <div><dt>有效期</dt><dd>{dateTime(item.notBefore)} 至 {dateTime(item.notAfter)}</dd></div>
              <div><dt>SHA-1 指纹</dt><dd><code>{item.fingerprint}</code></dd></div>
            </dl>
            {active && <div className="http-debug-proxy-certificate-detail">
              <dl className="http-debug-proxy-system-info">
                <div><dt>常用名称</dt><dd>{item.commonName || "—"}</dd></div>
                <div><dt>序列号</dt><dd><code>{item.serial || "—"}</code></dd></div>
                <div><dt>生效时间</dt><dd>{dateTime(item.notBefore)}</dd></div>
                <div><dt>到期时间</dt><dd>{dateTime(item.notAfter)}{item.expired ? "（已过期）" : ""}</dd></div>
                <div><dt>证书类型</dt><dd>{item.isCa ? "CA 根证书" : "终端证书"}{item.isApplication ? " · CloudHub 应用根证书" : ""}</dd></div>
                <div><dt>安装状态</dt><dd>{item.installed ? "已加入当前用户根证书存储" : "未加入当前用户根证书存储"}</dd></div>
              </dl>
              {item.pem && <><div className="http-debug-proxy-detail-section-heading"><h4>PEM 内容</h4><button type="button" className="secondary" onClick={() => void copyCertificateText(item.pem ?? "", "PEM 内容")}><Copy size={13} aria-hidden="true" />复制 PEM</button></div><pre className="http-debug-proxy-certificate-pem">{item.pem}</pre></>}
            </div>}
          </li>;
        })}</ul> : <p className="http-debug-proxy-certificates-empty" role="status">没有可显示的根证书。</p>}
    </SharedDialog>}
    {certificateToRemove && <ConfirmDialog title={certificateToRemove.isApplication ? "删除 CloudHub 根证书" : "从 Windows 移除根证书"} confirmLabel={certificateToRemove.isApplication ? "删除证书" : "移除证书"} message={certificateToRemove.isApplication ? `确定删除“${certificateToRemove.commonName || "未命名证书"}”及本地保存的加密私钥？请先停止代理。下次使用 HTTPS 调试代理时会生成新的根证书。` : `确定从当前用户的 Windows 根证书存储中移除“${certificateToRemove.commonName || "未命名证书"}”？`} onResolve={confirmed => { const target = certificateToRemove; setCertificateToRemove(null); if (confirmed) void updateCertificate(target.isApplication ? "delete" : "remove", target.isApplication ? undefined : target.fingerprint); }} />}
    {confirmRestore && <ConfirmDialog title="恢复系统代理设置" confirmLabel="恢复设置" busy={busy} message="将恢复开始抓包前保存的 Windows 系统代理设置。若检测到代理已被其他程序修改，操作会被拒绝以免覆盖。" onResolve={confirmed => { setConfirmRestore(false); if (confirmed) void operate(async () => { await httpDebugProxyClient.restoreSystemProxy(); return httpDebugProxyClient.state(); }, "已恢复启动前的系统代理设置。"); }} />}
    {selectedId && <SharedDialog title="HTTP 会话详情" subtitle={selected ? `${selected.method} · HTTP ${selected.status || "失败"}` : "正在读取会话详情…"} size="large" resizable sizeStorageKey="http-debug-proxy-session" onClose={() => { setSelectedId(null); setSelected(null); setShowSensitive(false); setDetailFeedback(""); }} headerActions={selected ? <><button type="button" className="secondary" onClick={() => void exportSelected()} disabled={busy}><Download size={14} aria-hidden="true" />导出会话</button><button type="button" className="secondary" onClick={() => void toggleSensitive()} disabled={busy} aria-pressed={showSensitive}>{showSensitive ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}{showSensitive ? "隐藏敏感信息" : "显示敏感信息"}</button></> : undefined}>
      {!selected ? <p role="status">正在读取会话详情…</p> : <div className="http-debug-proxy-detail">
        <p className="http-debug-proxy-export-note">{showSensitive ? "敏感信息当前可见，仅在此会话详情中临时显示；关闭弹层后会恢复隐藏。" : "敏感请求头和 URL 参数默认隐藏；导出文件仍包含正文，请谨慎保存。"}</p>
        <dl className="http-debug-proxy-meta"><div><dt>时间</dt><dd>{new Date(selected.timestamp).toLocaleString()}</dd></div><div><dt>方法</dt><dd><code>{selected.method}</code></dd></div><div><dt>状态</dt><dd>{selected.status || "失败"}</dd></div><div><dt>耗时</dt><dd>{selected.durationMs} ms</dd></div></dl>
        <section className="http-debug-proxy-url-card"><div className="http-debug-proxy-detail-section-heading"><h3>URL</h3><div><button type="button" className="secondary" onClick={() => void copyDetailText(selected.url, "URL")}><Copy size={13} aria-hidden="true" />复制</button><button type="button" className="secondary" onClick={() => void openSelectedUrl()}><ExternalLink size={13} aria-hidden="true" />一键打开</button></div></div><pre>{selected.url}</pre></section>
        {selected.note && <div className="http-debug-proxy-detail-note" role="note"><AlertTriangle size={15} aria-hidden="true" /><div><strong>{selected.note}</strong><p>安装根证书后，新建立的 HTTPS 连接会自动解密并显示请求头、正文和响应；已建立的连接不受影响。</p></div></div>}
        {selected.error && <p className="http-debug-proxy-error" role="alert">连接失败：{selected.error}</p>}{error && <p className="http-debug-proxy-error" role="alert">{error}</p>}
        {(() => {
          const requestHeaders = selected.requestHeaders.map(([k,v]) => `${k}: ${v}`).join("\n") || "无";
          const responseHeaders = selected.responseHeaders.map(([k,v]) => `${k}: ${v}`).join("\n") || "无";
          const requestPretty = prettyJson(selected.requestBody);
          const responsePretty = prettyJson(selected.responseBody);
          const requestBody = formattedBodies.request && requestPretty ? requestPretty : selected.requestBody || "无";
          const responseBody = formattedBodies.response && responsePretty ? responsePretty : selected.responseBody || "无";
          return <div className="http-debug-proxy-detail-grid">
            <section><h3>请求</h3>
              <div className="http-debug-proxy-detail-section-heading"><h4>请求头</h4><button type="button" className="secondary" onClick={() => void copyDetailText(requestHeaders, "请求头")}><Copy size={13} aria-hidden="true" />复制</button></div><pre>{requestHeaders}</pre>
              <div className="http-debug-proxy-detail-section-heading"><h4>请求正文</h4><div>{requestPretty && <button type="button" className="secondary" aria-pressed={formattedBodies.request} onClick={() => setFormattedBodies(value => ({ ...value, request: !value.request }))}><Braces size={13} aria-hidden="true" />{formattedBodies.request ? "显示原文" : "格式化"}</button>}<button type="button" className="secondary" onClick={() => void copyDetailText(requestBody, "请求正文")}><Copy size={13} aria-hidden="true" />复制</button></div></div>{selected.requestImageData && <img className="http-debug-proxy-image-preview" src={selected.requestImageData} alt="HTTP 请求图片正文预览" />}<pre>{requestBody}</pre>
            </section>
            <section><h3>响应</h3>
              <div className="http-debug-proxy-detail-section-heading"><h4>响应头 · HTTP {selected.status}</h4><button type="button" className="secondary" onClick={() => void copyDetailText(responseHeaders, "响应头")}><Copy size={13} aria-hidden="true" />复制</button></div><pre>{responseHeaders}</pre>
              <div className="http-debug-proxy-detail-section-heading"><h4>响应正文</h4><div>{responsePretty && <button type="button" className="secondary" aria-pressed={formattedBodies.response} onClick={() => setFormattedBodies(value => ({ ...value, response: !value.response }))}><Braces size={13} aria-hidden="true" />{formattedBodies.response ? "显示原文" : "格式化"}</button>}<button type="button" className="secondary" onClick={() => void copyDetailText(responseBody, "响应正文")}><Copy size={13} aria-hidden="true" />复制</button></div></div>{selected.responseImageData && <img className="http-debug-proxy-image-preview" src={selected.responseImageData} alt={`HTTP ${selected.status} 图片响应预览`} />}<textarea className="http-debug-proxy-response-body" aria-label="响应正文" readOnly value={responseBody} spellCheck={false} />
            </section>
          </div>;
        })()}
      </div>}
    </SharedDialog>}
  </section>;
}
