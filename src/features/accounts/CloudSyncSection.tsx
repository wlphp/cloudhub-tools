import { useEffect, useId, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Cloud, CloudDownload, CloudUpload, Link, Save } from "lucide-react";
import { cloudSyncClient, type CloudSyncConfig, type CloudSyncView } from "../../platform/clients/cloudSync";
import type { DatabaseImportPreview } from "../../platform/clients/database";
import { databaseClient } from "../../platform/clients/database";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { SecretField } from "../../shared/SecretField";
import { SharedDialog } from "../../shared/SharedDialog";
import { runningInTauri } from "../../platform/api";

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
  const browserPreview = !runningInTauri;
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [config, setConfig] = useState<CloudSyncConfig>(defaults);
  const [saved, setSaved] = useState<CloudSyncView | null>(null);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ title: string; message: string; failed: boolean; preview?: DatabaseImportPreview } | null>(null);
  const [confirmUpload, setConfirmUpload] = useState(false);
  const [secretRevision, setSecretRevision] = useState(0);
  const dirty = !saved?.configured || JSON.stringify(browserPreview ? { ...config, backupPassword: "" } : config) !== JSON.stringify(editable(saved));
  const disabled = loading || !!busy || !!saved?.status.busy;
  const canTransfer = !disabled && !dirty;
  const transferring = busy === "upload" || busy === "download" || !!saved?.status.busy;
  const progress = transferring ? saved?.status.progress : null;
  const percent = progress && (progress.phase === "uploading" || progress.phase === "downloading") && progress.total && progress.total > 0
    ? Math.min(100, Math.floor(progress.transferred / progress.total * 100)) : undefined;
  const progressLabel = progress ? phaseLabels[progress.phase] : busy === "upload" ? "正在准备上传…" : "正在准备下载…";
  const statusLabel = loading ? "读取中" : !saved ? "读取失败" : saved.status.busy ? "同步中" : saved.status.paused ? "自动上传已暂停" : !saved.configured ? "未配置" : dirty ? "待保存" : "已配置";
  const sameIdentity = saved && config.method === saved.config.method && config.endpoint.replace(/\/$/, "") === saved.config.endpoint && config.username === saved.config.username && config.accessKeyId === saved.config.accessKeyId;
  useEffect(() => {
    let active = true;
    void cloudSyncClient.state().then(view => {
      if (!active || !view?.config) return;
      setSaved(view); setConfig(editable(view));
    }).catch(() => { if (active) setError("读取云同步配置失败，请重新打开此页重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    let timer: number;
    async function poll() {
      let backendBusy = false;
      try {
        const view = await cloudSyncClient.state();
        if (active && view?.config) { setSaved(view); backendBusy = view.status.busy; }
      } catch { /* Keep the last known progress during a transient status failure. */ }
      if (active) timer = window.setTimeout(() => void poll(), busy || backendBusy ? 400 : 5000);
    }
    timer = window.setTimeout(() => void poll(), busy ? 150 : 5000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [busy]);
  function update<K extends keyof CloudSyncConfig>(key: K, value: CloudSyncConfig[K]) {
    setConfig(current => ({ ...current, [key]: value })); setMessage(""); setError("");
  }
  async function run(action: "test" | "save" | "upload" | "download") {
    setBusy(action); setError(""); setMessage("");
    setSaved(current => current ? { ...current, status: { ...current.status, progress: null } } : current);
    const label = { test: "测试连接", save: "保存配置", upload: "上传云备份", download: "下载云备份" }[action];
    let successMessage = "";
    let preview: DatabaseImportPreview | undefined;
    try {
      if (action === "test") { await cloudSyncClient.test(config); successMessage = "连接成功。测试仅检查访问权限，上传仍需写入权限。"; }
      if (action === "save") {
        setSecretRevision(current => current + 1);
        const view = await cloudSyncClient.save(config); setSaved(view); setConfig(editable(view)); successMessage = "配置已保存，凭据已在本机加密存储。";
      }
      if (action === "upload") {
        setSaved(await cloudSyncClient.upload());
        successMessage = "本机当前数据已备份并上传到云端。";
      }
      if (action === "download" && browserPreview) {
        const blob = await cloudSyncClient.downloadFile();
        preview = await databaseClient.prepareBrowserImport(new File([blob], "cloudhub-cloud-backup.chdb"), config.backupPassword);
        successMessage = "云备份已下载并校验，请选择需要恢复的数据。";
        await cloudSyncClient.state().then(view => setSaved(view)).catch(() => {});
      }
      if (action === "download" && !browserPreview) {
        preview = await cloudSyncClient.download();
        successMessage = "云备份已下载并校验，请选择需要恢复的数据。";
        // A status refresh failure must not discard a successfully downloaded preview.
        await cloudSyncClient.state().then(view => { setSaved(view); setConfig(editable(view)); }).catch(() => {});
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
      setSaved(current => current ? { ...current, status: { ...current.status, busy: false, progress: null } } : current);
    }
  }
  function field(key: "endpoint" | "username" | "password" | "accessKeyId" | "secretKey" | "bucket" | "region" | "remoteRoot" | "profile" | "backupPassword", label: string, placeholder = "", secret = false) {
    const props = { id: `${id}-${key}`, autoComplete: secret ? "new-password" : "off", spellCheck: false, value: config[key], placeholder, disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => update(key, event.target.value) };
    const secretKey = key === "password" || key === "secretKey" || key === "backupPassword" ? key : null;
    const hasSaved = secretKey === "backupPassword" ? saved?.config.hasBackupPassword : sameIdentity && (secretKey === "password" ? saved?.config.hasPassword : saved?.config.hasSecretKey);
    return <label className="cloud-sync-field" htmlFor={props.id}><span>{label}</span>{secretKey ? <SecretField {...props} key={JSON.stringify([key, config.method, config.endpoint, config.username, config.accessKeyId, secretRevision])} secretLabel={label} reveal={hasSaved ? () => cloudSyncClient.revealSecret(config, secretKey) : undefined} /> : <input {...props} type="text" />}</label>;
  }
  return <section className="data-settings-section cloud-sync-section" aria-label="云同步">
    <h2>云同步</h2>
    <div className="data-settings-panel cloud-sync-panel" aria-busy={!!busy || !!saved?.status.busy}>
      <div className="data-settings-heading cloud-sync-heading"><Cloud size={17} aria-hidden="true" /><h3>云端备份</h3><span className="data-settings-badge">{statusLabel}</span><button type="button" className="cloud-sync-toggle" aria-expanded={expanded} aria-controls={`${id}-panel`} onClick={() => setExpanded(current => !current)}><span>{expanded ? "收起" : "展开"}</span>{expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}</button></div>
      <p>通过 WebDAV 或 S3 兼容存储在设备间传递 CloudHub 数据库备份。</p>
      {browserPreview && <p className="cloud-sync-hint">网页调试支持真实连接与备份恢复；连接配置单独保存。下载校验后选择恢复范围，确认后写入本机数据。</p>}
      {!expanded && <p className="cloud-sync-hint">展开后填写连接配置、上传或下载数据。</p>}
      <div id={`${id}-panel`} hidden={!expanded}>
      <div className="cloud-sync-form">
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
        <p className="cloud-sync-hint">同一组设备使用相同目录和配置名。上传替换该位置的备份，不自动合并记录。</p>
        <div className="cloud-sync-options">
          {!browserPreview && !mobile && <label className="cloud-sync-option"><input type="checkbox" role="switch" checked={config.autoSync} disabled={disabled} onChange={event => update("autoSync", event.target.checked)} /><span>自动上传<small>应用运行时，业务数据变化后延迟上传；发现远端版本变化会停止覆盖。</small></span></label>}
          {!browserPreview && mobile && <p className="cloud-sync-hint">手机端支持手动测试、上传和下载；自动上传目前仅由桌面端后台执行。</p>}
          {!browserPreview && <label className="cloud-sync-option"><input type="checkbox" checked={config.passwordProtected} disabled={disabled} onChange={event => update("passwordProtected", event.target.checked)} /><span>使用密码保护云备份<small>默认不加密码：敏感字段保持加密，包内包含恢复 key，持有文件即可恢复。启用后，数据库和 key 一起加密。</small></span></label>}
          {!browserPreview && config.passwordProtected && field("backupPassword", "备份密码", saved?.config.hasBackupPassword ? "已保存，留空保留；另一台设备需填写同一密码" : "至少 8 个字符，下载恢复时也需要", true)}
          {browserPreview && field("backupPassword", "云备份解密密码（可选）", "仅密码保护的云备份需要，填写后可直接下载恢复", true)}
          <label className="cloud-sync-option"><input type="checkbox" checked={config.allowInsecure} disabled={disabled} onChange={event => update("allowInsecure", event.target.checked)} /><span>允许 HTTP<small>仅用于可信内网，HTTP 不保护传输中的账号和备份。</small></span></label>
        </div>
      </div>
      <div className="cloud-sync-actions">
        <button type="button" className="secondary" disabled={disabled} onClick={() => void run("test")}><Link size={15} aria-hidden="true" />{busy === "test" ? "正在测试…" : "测试连接"}</button>
        <button type="button" className="secondary" disabled={disabled} onClick={() => void run("save")}><Save size={15} aria-hidden="true" />{busy === "save" ? "正在保存…" : "保存配置"}</button>
      </div>
      <div className="cloud-sync-transfer">
        <div className="cloud-sync-actions">
          <button type="button" className="primary-update-btn" disabled={!canTransfer} onClick={() => setConfirmUpload(true)}><CloudUpload size={16} aria-hidden="true" />{busy === "upload" ? "正在上传…" : "上传到云端"}</button>
          <button type="button" className="secondary" disabled={!canTransfer} onClick={() => void run("download")}><CloudDownload size={16} aria-hidden="true" />{busy === "download" ? "正在下载…" : "从云端下载"}</button>
        </div>
        <p>{dirty ? "请先保存配置，再使用上传或下载。" : "上传会自动备份本机当前数据，无需选择文件；下载后选择要恢复的模块，确认后才写入本机数据。已有云备份须先下载检查，才能覆盖。"}</p>
        <p className="cloud-sync-history"><span>上次上传：<strong>{timeText(saved?.status.lastUpload ?? null)}</strong></span><span>上次下载：<strong>{timeText(saved?.status.lastDownload ?? null)}</strong></span></p>
      </div>
      </div>
      {transferring && <div className="cloud-sync-progress">
        <div className="cloud-sync-progress-heading"><span role="status">{progressLabel}</span><span>{percent !== undefined ? `${percent}% · ` : ""}{progress && progress.transferred > 0 ? `${byteText(progress.transferred)}${progress.total ? ` / ${byteText(progress.total)}` : ""}` : ""}</span></div>
        <progress aria-label={progressLabel} aria-valuetext={percent !== undefined ? `${percent}%` : progressLabel} max={100} value={percent} />
      </div>}
      {(error || saved?.status.error) && <p role="alert" className="data-settings-error">{error || saved?.status.error}</p>}
      {message && <p role="status" className="cloud-sync-success"><CheckCircle2 size={15} aria-hidden="true" /><span>{message}</span></p>}
    </div>
    {confirmUpload && <ConfirmDialog title="上传云备份" confirmLabel="确认上传" message="将自动备份本机当前数据并上传到此配置的云端位置；如已有备份，将替换它。未加密码的备份包含恢复密钥，请妥善保护云存储。请确认这是要保留的版本。" onResolve={confirmed => { setConfirmUpload(false); if (confirmed) void run("upload"); }} />}
    {result && <SharedDialog title={result.title} icon={result.failed ? <AlertTriangle size={18} aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />} role="alertdialog" size="small" showResize={false} onClose={() => setResult(null)} describedBy={`${id}-result`} initialFocus="button[data-result-confirm]" footer={<button type="button" className="primary" data-result-confirm onClick={() => { const preview = result.preview; setResult(null); if (preview) onRestore(preview); }}>确定</button>}>
      <p id={`${id}-result`} className={result.failed ? "data-settings-error" : undefined}>{result.message}</p>
    </SharedDialog>}
  </section>;
}
