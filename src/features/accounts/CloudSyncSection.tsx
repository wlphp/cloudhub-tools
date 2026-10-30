import { useEffect, useId, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Cloud, CloudDownload, CloudUpload, Link, Save, Plus, Pencil, Trash2, Search, History, ChevronLeft, ChevronRight } from "lucide-react";
import { cloudSyncClient, cloudSyncChannelClient, type CloudBackupVersion, type CloudSyncConfig, type CloudSyncView } from "../../platform/clients/cloudSync";
import type { DatabaseImportPreview } from "../../platform/clients/database";
import { databaseClient } from "../../platform/clients/database";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { SecretField } from "../../shared/SecretField";
import { SharedDialog } from "../../shared/SharedDialog";
import { runningInTauri } from "../../platform/api";
import { DataTransferScope, useTransferCatalog } from "./DataTransferScope";
import { appendCloudSyncHistory, backupHistoryKey, readBackupHistory, readCloudSyncHistory, type CloudSyncHistoryEntry } from "./cloud-backup-history";
import "./cloud-backup-versions.css";
import "./cloud-sync-editor.css";

const defaults: CloudSyncConfig = {
  method: "webdav", provider: "custom", endpoint: "", username: "", password: "",
  accessKeyId: "", secretKey: "", bucket: "", region: "us-east-1", pathStyle: true,
  remoteRoot: "cloudhub-sync", profile: "default", autoSync: false, allowInsecure: false,
  passwordProtected: false, backupPassword: "",
};
const editable = (view: CloudSyncView): CloudSyncConfig => {
  const { hasPassword: _p, hasSecretKey: _s, hasBackupPassword: _b, ...config } = view.config;
  return { ...config, password: "", secretKey: "", backupPassword: "" };
};
const timeText = (value: string | null) => value ? new Date(value).toLocaleString() : "尚无记录";
const phaseLabels = { connecting: "正在连接云存储…", preparing: "正在准备备份…", uploading: "正在上传备份", downloading: "正在下载备份", confirming: "已发送，等待服务器确认…", verifying: "正在校验备份…", finishing: "正在保存同步状态…" };
const byteText = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function CloudSyncSection({ onRestore, mobile = false }: { onRestore: (preview: DatabaseImportPreview) => void; mobile?: boolean }) {
  const [channels, setChannels] = useState<CloudSyncView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<CloudSyncView | null>(null);
  const [busyChannel, setBusyChannel] = useState("");
  async function refresh() {
    try { setChannels(await cloudSyncClient.channels()); setError(""); }
    catch { setError("读取同步渠道失败，请重试。"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  return <section className="data-settings-section cloud-sync-section" aria-label="云同步">
    <div className="cloud-sync-list-heading"><h2>云同步</h2><div className="cloud-sync-actions"><button type="button" className="secondary" disabled={loading || !!busyChannel || !!draft} onClick={() => setDraft({ configured: false, config: { ...defaults, id: crypto.randomUUID(), name: "", hasPassword: false, hasSecretKey: false, hasBackupPassword: false }, status: { busy: false, paused: false, lastUpload: null, lastDownload: null, error: null } })}><Plus size={16} aria-hidden="true" />添加同步渠道</button></div></div>
    <p className="cloud-sync-hint">{mobile ? "连接 WebDAV、S3 或阿里云 OSS，按设备与时间恢复历史备份。" : "每条渠道独立配置 WebDAV、S3 或阿里云 OSS 存储；上传保留历史版本，下载时选择机器和时间。"}</p>
    {loading && <p role="status">正在读取同步渠道…</p>}
    {error && <p role="alert" className="data-settings-error">{error}<button type="button" className="secondary" onClick={() => void refresh()}>重试</button></p>}
    {!loading && !error && channels.length === 0 && <div className="data-settings-panel"><p>尚未添加同步渠道，添加后即可上传备份、下载和查看云端备份列表。</p></div>}
    <div className="cloud-sync-channel-list">{channels.map(channel => <CloudSyncChannel key={channel.config.id ?? "default"} channel={channel} onRestore={onRestore} mobile={mobile} blocked={!!busyChannel && busyChannel !== channel.config.id} onBusy={busy => setBusyChannel(busy ? channel.config.id ?? "default" : "")} onChanged={() => void refresh()} />)}</div>
    {draft && <CloudSyncChannel channel={draft} onRestore={onRestore} mobile={mobile} blocked={!!busyChannel && busyChannel !== draft.config.id} onBusy={busy => setBusyChannel(busy ? draft.config.id ?? "default" : "")} onChanged={() => { setDraft(null); void refresh(); }} onCancel={() => setDraft(null)} />}
  </section>;
}

function CloudSyncChannel({ channel, onRestore, mobile, blocked, onBusy, onChanged, onCancel }: { channel: CloudSyncView; onRestore: (preview: DatabaseImportPreview) => void; mobile: boolean; blocked: boolean; onBusy: (busy: boolean) => void; onChanged: () => void; onCancel?: () => void }) {
  const channelId = channel.config.id ?? "default";
  const client = useMemo(() => cloudSyncChannelClient(channelId), [channelId]);
  const browserPreview = !runningInTauri;
  const id = useId();
  const [expanded, setExpanded] = useState(!channel.configured);
  const [config, setConfig] = useState<CloudSyncConfig>(() => editable(channel));
  const [saved, setSaved] = useState<CloudSyncView | null>(channel);
  const [busy, setBusy] = useState("");
  const loading = false;
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ title: string; message: string; failed: boolean; preview?: DatabaseImportPreview } | null>(null);
  const [confirmUpload, setConfirmUpload] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [versions, setVersions] = useState<CloudBackupVersion[] | null>(null);
  const [versionSearch, setVersionSearch] = useState("");
  const [versionSort, setVersionSort] = useState("desc");
  const [deleteVersion, setDeleteVersion] = useState<CloudBackupVersion | null>(null);
  const [versionError, setVersionError] = useState("");
  const [downloadVersion, setDownloadVersion] = useState<CloudBackupVersion | null>(null);
  const [downloadPassword, setDownloadPassword] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const historyKey = backupHistoryKey(channelId, channel.config);
  const [downloadHistory, setDownloadHistory] = useState(() => readBackupHistory(historyKey));
  const [historyError, setHistoryError] = useState("");
  const [historyDialog, setHistoryDialog] = useState<CloudSyncHistoryEntry["action"] | null>(null);
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(1);
  const [syncHistory, setSyncHistory] = useState(() => readCloudSyncHistory(historyKey));
  useEffect(() => { setDownloadHistory(readBackupHistory(historyKey)); }, [historyKey]);
  useEffect(() => { setSyncHistory(readCloudSyncHistory(historyKey)); }, [historyKey]);
  const filteredHistory = useMemo(() => syncHistory.filter(item => item.action === historyDialog &&
    [item.versionId ?? "", item.occurredAt, new Date(item.occurredAt).toLocaleString(), "本机"].some(value => value.toLocaleLowerCase().includes(historySearch.trim().toLocaleLowerCase()))), [syncHistory, historyDialog, historySearch]);
  const historyPageSize = 10;
  const pageHistory = filteredHistory.slice((historyPage - 1) * historyPageSize, historyPage * historyPageSize);
  const historyPageCount = Math.max(1, Math.ceil(filteredHistory.length / historyPageSize));
  const visibleVersions = useMemo(() => {
    const query = versionSearch.trim().toLocaleLowerCase();
    return (versions ?? []).filter(version => [version.machineName, version.id, version.uploadedAt ?? "", version.uploadedAt ? timeText(version.uploadedAt) : "时间未知"].some(value => value.toLocaleLowerCase().includes(query)))
      .sort((a, b) => {
        if (!a.uploadedAt || !b.uploadedAt) return a.uploadedAt ? -1 : b.uploadedAt ? 1 : a.id.localeCompare(b.id);
        const difference = Date.parse(a.uploadedAt) - Date.parse(b.uploadedAt);
        return (versionSort === "asc" ? difference : -difference) || a.id.localeCompare(b.id);
      });
  }, [versions, versionSearch, versionSort]);
  const newestVersion = useMemo(() => (versions ?? []).filter(v => v.uploadedAt).reduce<CloudBackupVersion | null>((latest, v) => !latest || Date.parse(v.uploadedAt!) > Date.parse(latest.uploadedAt!) ? v : latest, null)?.id, [versions]);
  const [secretRevision, setSecretRevision] = useState(0);
  const scope = useTransferCatalog(expanded);
  const dirty = !saved?.configured || JSON.stringify(browserPreview ? { ...config, backupPassword: "" } : config) !== JSON.stringify(editable(saved));
  const disabled = blocked || loading || !!busy || !!saved?.status.busy;
  const canTransfer = !disabled && !!saved?.configured;
  const transferring = busy === "upload" || busy === "download" || !!saved?.status.busy;
  const progress = transferring ? saved?.status.progress : null;
  const percent = progress && (progress.phase === "uploading" || progress.phase === "downloading") && progress.total && progress.total > 0
    ? Math.min(100, Math.floor(progress.transferred / progress.total * 100)) : undefined;
  const progressLabel = progress ? phaseLabels[progress.phase] : busy === "upload" ? "正在准备上传…" : "正在准备下载…";
  const statusLabel = loading ? "读取中" : !saved ? "读取失败" : saved.status.busy ? "同步中" : saved.status.paused ? "自动上传已暂停" : !saved.configured ? "未配置" : dirty ? "待保存" : "已配置";
  const sameIdentity = saved && config.method === saved.config.method && config.endpoint.replace(/\/$/, "") === saved.config.endpoint && config.username === saved.config.username && config.accessKeyId === saved.config.accessKeyId;
  useEffect(() => {
    let active = true;
    let timer: number;
    async function poll() {
      let backendBusy = false;
      try {
        const view = await client.state();
        if (active && view?.config) { setSaved(view); backendBusy = view.status.busy; }
      } catch { /* Keep the last known progress during a transient status failure. */ }
      if (active) timer = window.setTimeout(() => void poll(), busy || backendBusy ? 400 : 5000);
    }
    timer = window.setTimeout(() => void poll(), busy ? 150 : 5000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [busy, client]);
  function update<K extends keyof CloudSyncConfig>(key: K, value: CloudSyncConfig[K]) {
    setConfig(current => ({ ...current, [key]: value })); setMessage(""); setError("");
  }
  async function loadVersions() {
    onBusy(true);
    if (versions === null) { setVersionSearch(""); setVersionSort("desc"); }
    setVersions(current => current ?? []); setVersionError(""); setBusy("versions");
    try {
      const items = await client.versions();
      setVersions(current => current === null ? null : items);
    } catch (reason) {
      setVersionError(reason instanceof Error ? reason.message : "读取版本列表失败，请重试。");
    } finally { setBusy(""); onBusy(false); }
  }
  async function removeVersion(version: CloudBackupVersion) {
    setBusy("delete-version"); onBusy(true); setVersionError("");
    try {
      await client.deleteVersion(version.id);
      setVersions(current => current?.filter(item => item.id !== version.id) ?? null);
      setDeleteVersion(null);
    } catch (reason) {
      setVersionError(reason instanceof Error ? reason.message : "删除版本失败，请重试。");
      setDeleteVersion(null);
    } finally { setBusy(""); onBusy(false); }
  }
  async function run(action: "test" | "save" | "upload" | "download" | "delete", versionId?: string, password?: string) {
    onBusy(true);
    setBusy(action); setError(""); setMessage("");
    setSaved(current => current ? { ...current, status: { ...current.status, progress: null } } : current);
    const label = { test: "测试连接", save: "保存配置", upload: "上传云备份", download: "下载云备份", delete: "删除同步渠道" }[action];
    let successMessage = "";
    let preview: DatabaseImportPreview | undefined;
    try {
      if (action === "delete") { await client.remove(); onChanged(); return; }
      if (action === "test") { await client.test(config); successMessage = "连接成功。测试仅检查访问权限，上传仍需写入权限。"; }
      if (action === "save") {
        setSecretRevision(current => current + 1);
        if (scope.loading || scope.error || !scope.categories.length || config.tables?.length === 0) throw new Error("请先读取并选择至少一类数据范围。");
        const view = await client.save({ ...config, tables: config.tables ?? scope.categories.map(item => item.table) }); setSaved(view); setConfig(editable(view)); setExpanded(false); onChanged(); successMessage = "配置已保存，凭据已在本机加密存储。";
      }
      if (action === "upload") {
        setSaved(await client.upload());
        try { setSyncHistory(appendCloudSyncHistory(historyKey, "upload", null)); setHistoryError(""); }
        catch { setHistoryError("备份已上传，但本机存储不可用，操作记录未能保存。"); }
        successMessage = "本机当前数据已作为新版本上传到云端，历史版本已保留。";
      }
      if (action === "download" && browserPreview) {
        const blob = await client.downloadFile(versionId);
        preview = await databaseClient.prepareBrowserImport(new File([blob], "cloudhub-cloud-backup.chdb"), password ?? config.backupPassword);
        successMessage = "云备份已下载并校验，请选择需要恢复的数据。";
        await client.state().then(view => setSaved(view)).catch(() => {});
      }
      if (action === "download" && !browserPreview) {
        preview = await client.download(versionId, password);
        successMessage = "云备份已下载并校验，请选择需要恢复的数据。";
        // A status refresh failure must not discard a successfully downloaded preview.
        await client.state().then(view => { setSaved(view); setConfig(editable(view)); }).catch(() => {});
      }
      if (action === "download" && versionId && preview) {
        const history = readBackupHistory(historyKey);
        history[versionId] = { count: (history[versionId]?.count ?? 0) + 1, lastDownload: new Date().toISOString() };
        setDownloadHistory(history);
        try { localStorage.setItem(historyKey, JSON.stringify(history)); setHistoryError(""); }
        catch { setHistoryError("本机存储不可用，下载记录未能保存。"); }
        try { setSyncHistory(appendCloudSyncHistory(historyKey, "download", versionId)); }
        catch { setHistoryError("本机存储不可用，操作记录未能保存。"); }
      }
      setMessage(successMessage);
      if (preview) { setDownloadVersion(null); setDownloadPassword(""); setDownloadError(""); onRestore(preview); }
      else setResult({ title: `${label}成功`, message: successMessage, failed: false });
    } catch (reason) {
      // The backend supplies safe messages; never render remote response bodies or URLs.
      const text = reason instanceof Error ? reason.message : "";
      const failureMessage = text || "操作失败，请检查连接配置、权限或备份密码后重试。";
      if (action === "download") {
        setDownloadPassword("");
        setDownloadError(failureMessage);
        setDownloadVersion(current => current ?? versions?.find(item => item.id === versionId) ?? null);
      } else {
        setError(failureMessage);
        setResult({ title: `${label}失败`, message: failureMessage, failed: true });
      }
    } finally {
      setBusy("");
      onBusy(false);
      setSaved(current => current ? { ...current, status: { ...current.status, busy: false, progress: null } } : current);
    }
  }
  function field(key: "name" | "endpoint" | "username" | "password" | "accessKeyId" | "secretKey" | "bucket" | "region" | "remoteRoot" | "profile" | "backupPassword", label: string, placeholder = "", secret = false) {
    const props = { id: `${id}-${key}`, autoComplete: secret ? "new-password" : "off", spellCheck: false, value: config[key], placeholder, disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => update(key, event.target.value) };
    const secretKey = key === "password" || key === "secretKey" || key === "backupPassword" ? key : null;
    const hasSaved = secretKey === "backupPassword" ? saved?.config.hasBackupPassword : sameIdentity && (secretKey === "password" ? saved?.config.hasPassword : saved?.config.hasSecretKey);
    return <label className="cloud-sync-field" htmlFor={props.id}><span>{label}</span>{secretKey ? <SecretField {...props} key={JSON.stringify([key, config.method, config.endpoint, config.username, config.accessKeyId, secretRevision])} secretLabel={label} reveal={hasSaved ? () => client.revealSecret(config, secretKey) : undefined} /> : <input {...props} type="text" />}</label>;
  }
  function closeEditor() { setConfig(editable(saved ?? channel)); setExpanded(false); setError(""); onCancel?.(); }
  const manageActions = <>
    <button type="button" className="secondary" title="编辑渠道" aria-label="编辑" disabled={disabled} onClick={() => { setConfig(editable(saved ?? channel)); setExpanded(true); }}><Pencil size={16} aria-hidden="true" />{!mobile && "编辑"}</button>
    <button type="button" className="secondary" title="删除渠道" aria-label="删除" disabled={disabled} onClick={() => setConfirmDelete(true)}><Trash2 size={16} aria-hidden="true" />{!mobile && "删除"}</button>
  </>;
  return <>
    {channel.configured && <article className="data-settings-panel cloud-sync-panel" aria-label={saved?.config.name ?? "默认渠道"} aria-busy={!!busy || !!saved?.status.busy}>
      <div className="data-settings-heading cloud-sync-heading"><Cloud size={17} aria-hidden="true" /><h3>{saved?.config.name ?? "默认渠道"}</h3>{mobile && <div className="cloud-sync-manage">{manageActions}</div>}{!mobile && <><span className="data-settings-badge">{saved?.config.method === "oss" ? "阿里云 OSS" : saved?.config.method === "s3" ? "S3" : "WebDAV"}</span><span className="data-settings-badge">{statusLabel === "待保存" ? "已配置" : statusLabel}</span></>}</div>
      {mobile && <div className="cloud-sync-channel-meta"><span className="data-settings-badge">{saved?.config.method === "oss" ? "阿里云 OSS" : saved?.config.method === "s3" ? "S3" : "WebDAV"}</span><span>{statusLabel === "待保存" ? "已配置" : statusLabel}</span></div>}
      <p className="cloud-sync-channel-target">{saved?.config.endpoint} · {saved?.config.remoteRoot}/v1/{saved?.config.profile}</p>
      <div className="cloud-sync-actions cloud-sync-row-actions">
        <button type="button" className="primary-update-btn" disabled={!canTransfer} onClick={() => setConfirmUpload(true)}><CloudUpload size={16} aria-hidden="true" />{busy === "upload" ? "正在上传…" : "上传备份"}</button>
        <button type="button" className="secondary" disabled={!canTransfer} onClick={() => void loadVersions()}><CloudDownload size={16} aria-hidden="true" />下载备份</button>
        {!mobile && manageActions}
      </div>
      <div className="cloud-sync-history">
        <div className="cloud-sync-history-item">
          <span className="cloud-sync-history-label">上次上传</span>
          <span className={saved?.status.lastUpload ? "cloud-sync-history-value" : "cloud-sync-history-value is-empty"}>{timeText(saved?.status.lastUpload ?? null)}</span>
          <button type="button" className="cloud-sync-history-open" onClick={() => { setHistoryDialog("upload"); setHistorySearch(""); setHistoryPage(1); }}><History size={13} aria-hidden="true" />上传记录</button>
        </div>
        <div className="cloud-sync-history-item">
          <span className="cloud-sync-history-label">上次下载</span>
          <span className={saved?.status.lastDownload ? "cloud-sync-history-value" : "cloud-sync-history-value is-empty"}>{timeText(saved?.status.lastDownload ?? null)}</span>
          <button type="button" className="cloud-sync-history-open" onClick={() => { setHistoryDialog("download"); setHistorySearch(""); setHistoryPage(1); }}><History size={13} aria-hidden="true" />下载记录</button>
        </div>
      </div>
      {transferring && <div className="cloud-sync-progress"><div className="cloud-sync-progress-heading"><span role="status">{progressLabel}</span><span>{percent !== undefined ? `${percent}% · ` : ""}{progress && progress.transferred > 0 ? `${byteText(progress.transferred)}${progress.total ? ` / ${byteText(progress.total)}` : ""}` : ""}</span></div><progress aria-label={progressLabel} max={100} value={percent} /></div>}
      {(error || saved?.status.error) && <p role="alert" className="data-settings-error">{error || saved?.status.error}</p>}
      {message && <p role="status" className="cloud-sync-success"><CheckCircle2 size={15} aria-hidden="true" /><span>{message}</span></p>}
    </article>}
    {expanded && <SharedDialog title={channel.configured ? "编辑同步渠道" : "添加同步渠道"} subtitle="独立配置存储连接，凭据在本机加密保存。" className="cloud-sync-editor" closeDisabled={!!busy} onClose={closeEditor} initialFocus="input" footer={<><button type="button" className="secondary" disabled={disabled} onClick={() => void run("test")}><Link size={15} aria-hidden="true" />{busy === "test" ? "正在测试…" : "测试连接"}</button><button type="button" className="secondary" disabled={!!busy} onClick={closeEditor}>取消</button><button type="button" className="primary" disabled={disabled || scope.loading || !!scope.error || !scope.categories.length || config.tables?.length === 0} onClick={() => void run("save")}><Save size={15} aria-hidden="true" />{busy === "save" ? "正在保存…" : "保存配置"}</button></>}>
      <div className="cloud-sync-form">
        {field("name", "渠道名称", "例如：家庭 NAS、备用 S3")}
        <details className="data-settings-scope">
          <summary>数据范围<span>{scope.loading ? "读取中…" : scope.error ? "读取失败" : `已选 ${config.tables?.length ?? scope.categories.length} / ${scope.categories.length} 类`}</span></summary>
          {scope.loading ? <p role="status">正在读取数据范围…</p> : scope.error ? <div className="cloud-sync-scope-error"><p role="alert">{scope.error}</p><button type="button" className="secondary" disabled={disabled} onClick={scope.retry}>重新读取</button></div> : <DataTransferScope categories={scope.categories} tables={config.tables ?? scope.categories.map(item => item.table)} onChange={tables => setConfig(current => ({ ...current, tables }))} disabled={disabled} />}
        </details>
        <p>按所选范围保存历史备份（含回收站），下载后手动选择恢复。</p>
        <label className="cloud-sync-field" htmlFor={`${id}-method`}><span>同步方式</span><select id={`${id}-method`} disabled={disabled} value={config.method} onChange={event => { const method = event.target.value as CloudSyncConfig["method"]; setConfig(current => ({ ...current, method, region: method === "oss" && current.region === "us-east-1" ? "cn-beijing" : current.region, password: "", secretKey: "" })); }}><option value="webdav">WebDAV</option><option value="s3">S3 兼容存储</option><option value="oss">阿里云 OSS</option></select></label>
        {config.method === "webdav" ? <>
          <label className="cloud-sync-field" htmlFor={`${id}-provider`}><span>服务商</span><select id={`${id}-provider`} disabled={disabled} value={config.provider} onChange={event => { const provider = event.target.value; setConfig(current => ({ ...current, provider, endpoint: provider === "jianguoyun" ? "https://dav.jianguoyun.com/dav" : current.endpoint })); }}><option value="custom">自定义</option><option value="jianguoyun">坚果云</option><option value="nextcloud">Nextcloud</option><option value="alist">Alist / OpenList</option></select></label>
          {field("endpoint", "WebDAV 服务器地址", "https://dav.example.com/dav/")}
          <div className="cloud-sync-grid">{field("username", "WebDAV 账号", "邮箱或账号")}{field("password", "WebDAV 密码", sameIdentity && saved?.config.hasPassword ? "已保存，留空保留原应用密码" : "第三方应用密码", true)}</div>
        </> : <>
          {field("endpoint", config.method === "oss" ? "OSS Endpoint" : "S3 服务地址", config.method === "oss" ? "https://oss-cn-beijing.aliyuncs.com" : "https://s3.example.com")}
          {config.method === "oss" && <p className="cloud-sync-hint">填写存储桶所在区域的 Endpoint，也支持已包含存储桶名称的地址；自动使用存储桶子域名访问。</p>}
          <div className="cloud-sync-grid">{field("bucket", "存储桶", "bucket-name")}{field("region", "区域", config.method === "oss" ? "cn-beijing" : "us-east-1")}{field("accessKeyId", config.method === "oss" ? "AccessKey ID" : "Access Key ID")}{field("secretKey", config.method === "oss" ? "AccessKey Secret" : "Secret Access Key", sameIdentity && saved?.config.hasSecretKey ? "已保存，留空保留原密钥" : "存储访问密钥", true)}</div>
          {config.method === "s3" && <label className="cloud-sync-option"><input type="checkbox" checked={config.pathStyle} disabled={disabled} onChange={event => update("pathStyle", event.target.checked)} /><span>使用路径风格地址<small>适用于 MinIO 等兼容存储；关闭后使用存储桶子域名。</small></span></label>}
        </>}
        <div className="cloud-sync-grid">{field("remoteRoot", "远程根目录", "cloudhub-sync")}{field("profile", "同步配置名", "default")}</div>
        <p className="cloud-sync-hint">同一组设备使用相同目录和配置名。每次上传新增版本，按机器名称和时间区分，保留历史备份，不自动合并记录。</p>
        <div className="cloud-sync-options">
          {!browserPreview && !mobile && <label className="cloud-sync-option"><input type="checkbox" role="switch" checked={config.autoSync} disabled={disabled} onChange={event => update("autoSync", event.target.checked)} /><span>自动上传<small>应用运行时，业务数据变化后延迟上传为新版本，保留其他设备和历史版本。</small></span></label>}
          {!browserPreview && mobile && <p className="cloud-sync-hint">手机端支持手动测试、上传和下载；自动上传目前仅由桌面端后台执行。</p>}
          {!browserPreview && <label className="cloud-sync-option"><input type="checkbox" checked={config.passwordProtected} disabled={disabled} onChange={event => update("passwordProtected", event.target.checked)} /><span>使用密码保护云备份<small>默认不加密码：敏感字段保持加密，包内包含恢复 key，持有文件即可恢复。启用后，数据库和 key 一起加密。</small></span></label>}
          {!browserPreview && config.passwordProtected && field("backupPassword", "备份密码", saved?.config.hasBackupPassword ? "已保存，留空保留；另一台设备需填写同一密码" : "至少 8 个字符，下载恢复时也需要", true)}
          {browserPreview && field("backupPassword", "云备份解密密码（可选）", "仅密码保护的云备份需要，填写后可直接下载恢复", true)}
          <label className="cloud-sync-option"><input type="checkbox" checked={config.allowInsecure} disabled={disabled} onChange={event => update("allowInsecure", event.target.checked)} /><span>允许 HTTP<small>仅用于可信内网，HTTP 不保护传输中的账号和备份。</small></span></label>
        </div>
      </div>
      {error && <p role="alert" className="data-settings-error">{error}</p>}
    </SharedDialog>}
    {confirmDelete && <ConfirmDialog title="删除同步渠道" confirmLabel="删除渠道" message={`删除“${saved?.config.name ?? "默认渠道"}”的本机连接配置？云端备份文件不会删除。`} onResolve={confirmed => { setConfirmDelete(false); if (confirmed) void run("delete"); }} />}
    {confirmUpload && <ConfirmDialog title="上传云备份" confirmLabel="确认上传" message={`将本机当前数据上传到“${saved?.config.name ?? "默认渠道"}”，以机器名称和上传时间记录为新版本，保留历史备份。`} onResolve={confirmed => { setConfirmUpload(false); if (confirmed) void run("upload"); }} />}
    {historyDialog && <SharedDialog title={historyDialog === "upload" ? "上传记录" : "下载记录"} subtitle={`${saved?.config.name ?? "默认渠道"} · 记录保存在本机，最多保留 2000 条。`} className="cloud-sync-history-dialog" onClose={() => setHistoryDialog(null)} initialFocus="input[type=search]" footer={<><span className="cloud-backup-total">共 {filteredHistory.length} 条</span><button type="button" className="secondary" onClick={() => setHistoryDialog(null)}>关闭</button></>}>
      <label className="cloud-sync-history-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="搜索同步记录" placeholder="搜索时间或版本号" value={historySearch} onChange={event => { setHistorySearch(event.target.value); setHistoryPage(1); }} /></label>
      <div className="cloud-sync-history-table-wrap">{pageHistory.length > 0 ? <table className="cloud-sync-history-table"><thead><tr><th scope="col">时间</th><th scope="col">设备</th><th scope="col">备份版本</th></tr></thead><tbody>{pageHistory.map(item => <tr key={item.id}><td data-label="时间">{timeText(item.occurredAt)}</td><td data-label="设备">本机</td><td data-label="备份版本">{item.versionId ?? "上传新版本（版本号由云端生成）"}</td></tr>)}</tbody></table> : <div className="cloud-sync-history-empty" role="status"><History size={22} aria-hidden="true" /><strong>{historySearch.trim() ? "没有匹配的记录" : "暂无操作记录"}</strong><span>{historySearch.trim() ? "试试其他时间或版本号。" : "完成上传或下载后，记录会显示在这里。"}</span></div>}</div>
      {filteredHistory.length > historyPageSize && <nav className="cloud-sync-history-pagination" aria-label="记录分页"><span>第 {Math.min(historyPage, historyPageCount)} / {historyPageCount} 页</span><button type="button" className="secondary" aria-label="上一页" disabled={historyPage <= 1} onClick={() => setHistoryPage(page => page - 1)}><ChevronLeft size={16} aria-hidden="true" /></button><button type="button" className="secondary" aria-label="下一页" disabled={historyPage >= historyPageCount} onClick={() => setHistoryPage(page => page + 1)}><ChevronRight size={16} aria-hidden="true" /></button></nav>}
    </SharedDialog>}
    {versions !== null && <SharedDialog title="选择云端备份版本" subtitle={`${saved?.config.name ?? "默认渠道"} · 下载后选择恢复模块`} className="cloud-backup-versions" onClose={() => setVersions(null)} closeDisabled={!!busy} initialFocus="input[type=search]" footer={<><span className="cloud-backup-total" role="status">显示 {visibleVersions.length} / {versions.length} 个版本</span><button type="button" className="secondary" disabled={!!busy} onClick={() => void loadVersions()}>{busy === "versions" ? "正在刷新…" : "刷新"}</button><button type="button" className="secondary" disabled={!!busy} onClick={() => setVersions(null)}>取消</button></>}>
      <div className="cloud-backup-toolbar"><label className="cloud-backup-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="搜索备份版本" placeholder="搜索机器名称、时间或版本号" value={versionSearch} onChange={event => setVersionSearch(event.target.value)} /></label><label className="cloud-backup-sort"><span>上传时间</span><select aria-label="上传时间排序" value={versionSort} onChange={event => setVersionSort(event.target.value)}><option value="desc">倒序 · 最新在前</option><option value="asc">正序 · 最早在前</option></select></label></div>
      {versionError && <p role="alert" className="data-settings-error">{versionError}</p>}
      {historyError && <p role="alert" className="data-settings-error">{historyError}</p>}
      {busy === "versions" && <p role="status">正在读取云端版本…</p>}
      <div className="cloud-backup-table" aria-busy={busy === "versions"}>
        <table className="cloud-sync-version-list"><thead><tr><th scope="col">备份设备 / 版本</th><th scope="col">上传时间</th><th scope="col">本机下载记录</th><th scope="col">操作</th></tr></thead><tbody>{visibleVersions.map(version => <tr key={version.id}>
          <td data-label="备份设备 / 版本"><div className="cloud-backup-device"><strong>{version.machineName}</strong>{version.id === newestVersion && <span className="data-settings-badge">最新</span>}<span className="data-settings-badge">{version.passwordProtected === true ? "有密码" : version.passwordProtected === false ? "无密码" : "密码状态未知"}</span></div><details className="cloud-backup-id"><summary>版本 {version.id === "database.chdb" ? "旧版备份" : version.id.slice(7, 15)}</summary><span>{version.id}</span></details></td>
          <td data-label="上传时间">{version.uploadedAt ? timeText(version.uploadedAt) : "时间未知"}</td>
          <td data-label="本机下载记录"><span className="cloud-backup-download-count">本机下载 {downloadHistory[version.id]?.count ?? 0} 次</span><small className="cloud-backup-last-download">{downloadHistory[version.id]?.lastDownload ? `最近 ${timeText(downloadHistory[version.id].lastDownload)}` : "尚无下载记录"}</small></td>
          <td data-label="操作"><div className="cloud-backup-row-actions"><button type="button" className="secondary" disabled={!!busy || blocked} aria-label={`下载 ${version.machineName} ${version.id}`} onClick={() => { setVersions(null); setDownloadError(""); setDownloadPassword(""); if (version.passwordProtected === false) void run("download", version.id); else setDownloadVersion(version); }}><CloudDownload size={15} aria-hidden="true" />下载</button><button type="button" className="secondary cloud-backup-delete" disabled={!!busy || blocked} aria-label={`删除 ${version.machineName} ${version.id}`} onClick={() => { setVersionError(""); setDeleteVersion(version); }}><Trash2 size={15} aria-hidden="true" />删除</button></div></td>
        </tr>)}</tbody></table>
        {!visibleVersions.length && busy !== "versions" && <p className="cloud-backup-empty" role="status">{versionSearch.trim() ? "没有匹配的备份，试试其他关键词。" : versionError ? "版本列表暂不可用，请刷新重试。" : "此配置下暂无云端备份。"}</p>}
      </div>
    </SharedDialog>}
    {downloadVersion && <SharedDialog title="下载并解密云备份" size="small" closeDisabled={!!busy} busy={!!busy} initialFocus="input" onClose={() => { setDownloadVersion(null); setDownloadPassword(""); setDownloadError(""); }} footer={<><button type="button" className="secondary" disabled={!!busy} onClick={() => { setDownloadVersion(null); setDownloadPassword(""); setDownloadError(""); }}>取消</button><button type="button" className="primary" disabled={!!busy || blocked} onClick={() => { const password = downloadPassword; setDownloadPassword(""); setDownloadError(""); void run("download", downloadVersion.id, password || undefined); }}>{busy ? "正在下载并校验…" : "下载并预览"}</button></>}>
      <p>{downloadVersion.machineName} · {downloadVersion.uploadedAt ? timeText(downloadVersion.uploadedAt) : "时间未知"}</p>
      <p>{downloadVersion.passwordProtected === true ? "此备份有密码，请使用创建该备份时的密码。" : "此备份未记录密码状态；有密码请填写，无密码可直接继续。"}</p>
      <label className="cloud-sync-field"><span>本次恢复密码</span><SecretField secretLabel="本次恢复密码" aria-label="本次恢复密码" autoComplete="off" maxLength={4096} value={downloadPassword} disabled={!!busy} onChange={event => setDownloadPassword(event.target.value)} /></label>
      <p>{!browserPreview && saved?.config.hasBackupPassword ? "留空将尝试本机已保存的渠道密码。" : "密码仅用于本次解密，不修改渠道配置。"}</p>
      {downloadError && <p role="alert" className="data-settings-error">{downloadError}</p>}
    </SharedDialog>}
    {deleteVersion && <ConfirmDialog title="删除云端备份版本" confirmLabel="删除此版本" busy={busy === "delete-version"} message={`确定永久删除“${deleteVersion.machineName}”在 ${deleteVersion.uploadedAt ? timeText(deleteVersion.uploadedAt) : "未知时间"} 上传的备份？版本：${deleteVersion.id}。删除后无法恢复，其他版本和本机数据不受影响。`} onResolve={confirmed => { if (confirmed) void removeVersion(deleteVersion); else setDeleteVersion(null); }} />}
    {result && <SharedDialog title={result.title} icon={result.failed ? <AlertTriangle size={18} aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />} role="alertdialog" size="small" showResize={false} onClose={() => setResult(null)} describedBy={`${id}-result`} initialFocus="button[data-result-confirm]" footer={<button type="button" className="primary" data-result-confirm onClick={() => { const preview = result.preview; setResult(null); if (preview) onRestore(preview); }}>确定</button>}>
      <p id={`${id}-result`} className={result.failed ? "data-settings-error" : undefined}>{result.message}</p>
    </SharedDialog>}
  </>;
}
