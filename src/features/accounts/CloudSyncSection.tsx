import { useEffect, useId, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Cloud, CloudDownload, CloudUpload, Link, Save, Plus, Pencil, Trash2 } from "lucide-react";
import { cloudSyncClient, cloudSyncChannelClient, type CloudBackupVersion, type CloudSyncConfig, type CloudSyncView } from "../../platform/clients/cloudSync";
import type { DatabaseImportPreview } from "../../platform/clients/database";
import { databaseClient } from "../../platform/clients/database";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { SecretField } from "../../shared/SecretField";
import { SharedDialog } from "../../shared/SharedDialog";
import { runningInTauri } from "../../platform/api";
import { DataTransferScope, useTransferCatalog } from "./DataTransferScope";

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
    <p className="cloud-sync-hint">每条渠道独立配置 WebDAV 或 S3 存储；上传保留历史版本，下载时选择机器和时间。</p>
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
  const [selectedVersion, setSelectedVersion] = useState("");
  const [versionError, setVersionError] = useState("");
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
    setVersions([]); setSelectedVersion(""); setVersionError(""); setBusy("versions");
    try {
      const items = await client.versions();
      setVersions(current => current === null ? null : items); setSelectedVersion(items[0]?.id ?? "");
    } catch (reason) {
      setVersionError(reason instanceof Error ? reason.message : "读取版本列表失败，请重试。");
    } finally { setBusy(""); onBusy(false); }
  }
  async function run(action: "test" | "save" | "upload" | "download" | "delete", versionId?: string) {
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
        const view = await client.save(config); setSaved(view); setConfig(editable(view)); setExpanded(false); onChanged(); successMessage = "配置已保存，凭据已在本机加密存储。";
      }
      if (action === "upload") {
        setSaved(await client.upload());
        successMessage = "本机当前数据已作为新版本上传到云端，历史版本已保留。";
      }
      if (action === "download" && browserPreview) {
        const blob = await client.downloadFile(versionId);
        preview = await databaseClient.prepareBrowserImport(new File([blob], "cloudhub-cloud-backup.chdb"), config.backupPassword);
        successMessage = "云备份已下载并校验，请选择需要恢复的数据。";
        await client.state().then(view => setSaved(view)).catch(() => {});
      }
      if (action === "download" && !browserPreview) {
        preview = await client.download(versionId);
        successMessage = "云备份已下载并校验，请选择需要恢复的数据。";
        // A status refresh failure must not discard a successfully downloaded preview.
        await client.state().then(view => { setSaved(view); setConfig(editable(view)); }).catch(() => {});
      }
      setMessage(successMessage);
      if (preview) onRestore(preview);
      else setResult({ title: `${label}成功`, message: successMessage, failed: false });
    } catch (reason) {
      // The backend supplies safe messages; never render remote response bodies or URLs.
      const text = reason instanceof Error ? reason.message : "";
      const failureMessage = text || "操作失败，请检查连接配置、权限或备份密码后重试。";
      setError(failureMessage);
      setResult({ title: `${label}失败`, message: failureMessage, failed: true });
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
  return <>
    {channel.configured && <article className="data-settings-panel cloud-sync-panel" aria-label={saved?.config.name ?? "默认渠道"} aria-busy={!!busy || !!saved?.status.busy}>
      <div className="data-settings-heading cloud-sync-heading"><Cloud size={17} aria-hidden="true" /><h3>{saved?.config.name ?? "默认渠道"}</h3><span className="data-settings-badge">{saved?.config.method === "s3" ? "S3" : "WebDAV"}</span><span className="data-settings-badge">{statusLabel === "待保存" ? "已配置" : statusLabel}</span></div>
      <p className="cloud-sync-channel-target">{saved?.config.endpoint} · {saved?.config.remoteRoot}/v1/{saved?.config.profile}</p>
      <div className="cloud-sync-actions cloud-sync-row-actions">
        <button type="button" className="primary-update-btn" disabled={!canTransfer} onClick={() => setConfirmUpload(true)}><CloudUpload size={16} aria-hidden="true" />{busy === "upload" ? "正在上传…" : "上传备份"}</button>
        <button type="button" className="secondary" disabled={!canTransfer} onClick={() => void loadVersions()}><CloudDownload size={16} aria-hidden="true" />下载备份</button>
        <button type="button" className="secondary" disabled={disabled} onClick={() => { setConfig(editable(saved ?? channel)); setExpanded(true); }}><Pencil size={15} aria-hidden="true" />编辑</button>
        <button type="button" className="secondary" disabled={disabled} onClick={() => setConfirmDelete(true)}><Trash2 size={15} aria-hidden="true" />删除</button>
      </div>
      <p className="cloud-sync-history"><span>上次上传：<strong>{timeText(saved?.status.lastUpload ?? null)}</strong></span><span>上次下载：<strong>{timeText(saved?.status.lastDownload ?? null)}</strong></span></p>
      {transferring && <div className="cloud-sync-progress"><div className="cloud-sync-progress-heading"><span role="status">{progressLabel}</span><span>{percent !== undefined ? `${percent}% · ` : ""}{progress && progress.transferred > 0 ? `${byteText(progress.transferred)}${progress.total ? ` / ${byteText(progress.total)}` : ""}` : ""}</span></div><progress aria-label={progressLabel} max={100} value={percent} /></div>}
      {(error || saved?.status.error) && <p role="alert" className="data-settings-error">{error || saved?.status.error}</p>}
      {message && <p role="status" className="cloud-sync-success"><CheckCircle2 size={15} aria-hidden="true" /><span>{message}</span></p>}
    </article>}
    {expanded && <SharedDialog title={channel.configured ? "编辑同步渠道" : "添加同步渠道"} subtitle="为每条渠道设置独立的连接信息，凭据在本机加密保存。" className="cloud-sync-editor" closeDisabled={!!busy} onClose={closeEditor} initialFocus="input" footer={<><button type="button" className="secondary" disabled={disabled} onClick={() => void run("test")}><Link size={15} aria-hidden="true" />{busy === "test" ? "正在测试…" : "测试连接"}</button><button type="button" className="secondary" disabled={!!busy} onClick={closeEditor}>取消</button><button type="button" className="primary" disabled={disabled} onClick={() => void run("save")}><Save size={15} aria-hidden="true" />{busy === "save" ? "正在保存…" : "保存配置"}</button></>}>
      <div className="cloud-sync-form">
        {field("name", "渠道名称", "例如：家庭 NAS、备用 S3")}
        <DataTransferScope categories={scope.categories} tables={config.tables ?? scope.categories.map(item => item.table)} onChange={tables => setConfig(current => ({ ...current, tables }))} disabled={disabled} />
        {scope.error && <p role="alert">{scope.error}</p>}
        <p>此渠道保存所选业务模块和回收站；云同步为版本化备份，下载后需手动选择恢复，不自动双向合并。</p>
        <label className="cloud-sync-field" htmlFor={`${id}-method`}><span>同步方式</span><select id={`${id}-method`} disabled={disabled} value={config.method} onChange={event => setConfig(current => ({ ...current, method: event.target.value as CloudSyncConfig["method"], password: "", secretKey: "" }))}><option value="webdav">WebDAV</option><option value="s3">S3 兼容存储</option></select></label>
        {config.method === "webdav" ? <>
          <label className="cloud-sync-field" htmlFor={`${id}-provider`}><span>服务商</span><select id={`${id}-provider`} disabled={disabled} value={config.provider} onChange={event => { const provider = event.target.value; setConfig(current => ({ ...current, provider, endpoint: provider === "jianguoyun" ? "https://dav.jianguoyun.com/dav" : current.endpoint })); }}><option value="custom">自定义</option><option value="jianguoyun">坚果云</option><option value="nextcloud">Nextcloud</option><option value="alist">Alist / OpenList</option></select></label>
          {field("endpoint", "WebDAV 服务器地址", "https://dav.example.com/dav/")}
          <div className="cloud-sync-grid">{field("username", "WebDAV 账号", "邮箱或账号")}{field("password", "WebDAV 密码", sameIdentity && saved?.config.hasPassword ? "已保存，留空保留原应用密码" : "第三方应用密码", true)}</div>
        </> : <>
          {field("endpoint", "S3 服务地址", "https://s3.example.com")}
          <div className="cloud-sync-grid">{field("bucket", "存储桶", "bucket-name")}{field("region", "区域", "us-east-1")}{field("accessKeyId", "Access Key ID")}{field("secretKey", "Secret Access Key", sameIdentity && saved?.config.hasSecretKey ? "已保存，留空保留原密钥" : "存储访问密钥", true)}</div>
          <label className="cloud-sync-option"><input type="checkbox" checked={config.pathStyle} disabled={disabled} onChange={event => update("pathStyle", event.target.checked)} /><span>使用路径风格地址<small>适用于 MinIO 等兼容存储；关闭后使用存储桶子域名。</small></span></label>
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
    {versions !== null && <SharedDialog title="选择云端备份版本" subtitle={`${saved?.config.name ?? "默认渠道"} · 最新版本在最前面；下载校验后选择恢复模块。`} size="small" onClose={() => setVersions(null)} initialFocus="select" footer={<><button type="button" className="secondary" disabled={busy === "versions"} onClick={() => void loadVersions()}>刷新</button><button type="button" className="secondary" onClick={() => setVersions(null)}>取消</button><button type="button" className="primary" disabled={!!busy || !selectedVersion || !!versionError} onClick={() => { setVersions(null); void run("download", selectedVersion); }}>下载所选版本</button></>}>
      {busy === "versions" ? <p role="status">正在读取云端版本…</p> : versionError ? <p role="alert" className="data-settings-error">{versionError}</p> : versions.length === 0 ? <p role="status">此配置下暂无云端备份。</p> : <><label className="cloud-sync-field"><span>备份版本（机器名称 · 上传时间）</span><select value={selectedVersion} onChange={event => setSelectedVersion(event.target.value)}>{versions.map((version, index) => <option key={version.id} value={version.id}>{index === 0 && version.uploadedAt ? "最新 · " : ""}{version.machineName} · {version.uploadedAt ? timeText(version.uploadedAt) : "时间未知"} · {version.id.slice(7, 15)}</option>)}</select></label><ul className="cloud-sync-version-list">{versions.map((version, index) => <li key={version.id}><strong>{version.machineName}{index === 0 && version.uploadedAt ? " · 最新" : ""}</strong><span>{version.uploadedAt ? timeText(version.uploadedAt) : "时间未知"}</span></li>)}</ul></>}
      {browserPreview && versions.length > 0 && field("backupPassword", "云备份解密密码（可选）", "仅密码保护的云备份需要", true)}
    </SharedDialog>}
    {result && <SharedDialog title={result.title} icon={result.failed ? <AlertTriangle size={18} aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />} role="alertdialog" size="small" showResize={false} onClose={() => setResult(null)} describedBy={`${id}-result`} initialFocus="button[data-result-confirm]" footer={<button type="button" className="primary" data-result-confirm onClick={() => { const preview = result.preview; setResult(null); if (preview) onRestore(preview); }}>确定</button>}>
      <p id={`${id}-result`} className={result.failed ? "data-settings-error" : undefined}>{result.message}</p>
    </SharedDialog>}
  </>;
}
