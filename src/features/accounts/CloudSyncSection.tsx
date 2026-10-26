import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronRight, Cloud, CloudDownload, CloudUpload, Link, Save } from "lucide-react";
import { cloudSyncClient, type CloudSyncConfig, type CloudSyncView } from "../../platform/clients/cloudSync";
import type { DatabaseImportPreview } from "../../platform/clients/database";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { SecretField } from "../../shared/SecretField";

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

export function CloudSyncSection({ available, onRestore }: { available: boolean; onRestore: (preview: DatabaseImportPreview) => void }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [config, setConfig] = useState<CloudSyncConfig>(defaults);
  const [saved, setSaved] = useState<CloudSyncView | null>(null);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(available);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirmUpload, setConfirmUpload] = useState(false);
  const [secretRevision, setSecretRevision] = useState(0);
  const dirty = !saved?.configured || JSON.stringify(config) !== JSON.stringify(editable(saved));
  const disabled = !available || loading || !!busy || !!saved?.status.busy;
  const canTransfer = !disabled && !dirty;
  const sameIdentity = saved && config.method === saved.config.method && config.endpoint.replace(/\/$/, "") === saved.config.endpoint && config.username === saved.config.username && config.accessKeyId === saved.config.accessKeyId;
  useEffect(() => {
    if (!available) return;
    let active = true;
    void cloudSyncClient.state().then(view => {
      if (!active || !view?.config) return;
      setSaved(view); setConfig(editable(view));
    }).catch(() => { if (active) setError("读取云同步配置失败，请重新打开此页重试。"); })
      .finally(() => { if (active) setLoading(false); });
    const timer = window.setInterval(() => {
      void cloudSyncClient.state().then(view => { if (active && view?.config) setSaved(view); }).catch(() => {});
    }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [available]);
  function update<K extends keyof CloudSyncConfig>(key: K, value: CloudSyncConfig[K]) {
    setConfig(current => ({ ...current, [key]: value })); setMessage(""); setError("");
  }
  async function run(action: "test" | "save" | "upload" | "download") {
    setBusy(action); setError(""); setMessage("");
    try {
      if (action === "test") { await cloudSyncClient.test(config); setMessage("连接成功。测试仅检查访问权限，上传仍需写入权限。"); }
      if (action === "save") {
        setSecretRevision(current => current + 1);
        const view = await cloudSyncClient.save(config); setSaved(view); setConfig(editable(view)); setMessage("配置已保存，凭据已在本机加密存储。");
      }
      if (action === "upload") { setSaved(await cloudSyncClient.upload()); setMessage("当前数据已上传到云端。"); }
      if (action === "download") {
        const preview = await cloudSyncClient.download(); onRestore(preview);
        setMessage("云备份已下载，请在预览中确认是否恢复。");
        const view = await cloudSyncClient.state(); setSaved(view); setConfig(editable(view));
      }
    } catch (reason) {
      // The backend supplies safe messages; never render remote response bodies or URLs.
      const text = reason instanceof Error ? reason.message : "";
      setError(text || "操作失败，请检查连接配置、权限或备份密码后重试。");
    } finally { setBusy(""); }
  }
  function field(key: "endpoint" | "username" | "password" | "accessKeyId" | "secretKey" | "bucket" | "region" | "remoteRoot" | "profile" | "backupPassword", label: string, placeholder = "", secret = false) {
    const props = { id: `${id}-${key}`, autoComplete: secret ? "new-password" : "off", spellCheck: false, value: config[key], placeholder, disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => update(key, event.target.value) };
    const secretKey = key === "password" || key === "secretKey" || key === "backupPassword" ? key : null;
    const hasSaved = secretKey === "backupPassword" ? saved?.config.hasBackupPassword : sameIdentity && (secretKey === "password" ? saved?.config.hasPassword : saved?.config.hasSecretKey);
    return <label className="cloud-sync-field" htmlFor={props.id}><span>{label}</span>{secretKey ? <SecretField {...props} key={JSON.stringify([key, config.method, config.endpoint, config.username, config.accessKeyId, secretRevision, available])} secretLabel={label} reveal={hasSaved ? () => cloudSyncClient.revealSecret(config, secretKey) : undefined} /> : <input {...props} type="text" />}</label>;
  }
  return <section className="data-settings-section cloud-sync-section" aria-label="云同步">
    <h2>云同步</h2>
    <div className="data-settings-panel cloud-sync-panel" aria-busy={!!busy || !!saved?.status.busy}>
      <div className="data-settings-heading cloud-sync-heading"><Cloud size={17} aria-hidden="true" /><h3>云端备份</h3><span className="data-settings-badge">{saved?.status.busy ? "同步中" : saved?.status.paused ? "自动上传已暂停" : dirty ? "待保存" : "已配置"}</span><button type="button" className="cloud-sync-toggle" aria-expanded={expanded} aria-controls={`${id}-panel`} onClick={() => setExpanded(current => !current)}><span>{expanded ? "收起" : "展开"}</span>{expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}</button></div>
      <p>通过 WebDAV 或 S3 兼容存储在设备间传递 CloudHub 数据库备份。</p>
      {!available && <p role="status">云同步仅在桌面客户端中可用，浏览器预览不连接远端存储。</p>}
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
          <label className="cloud-sync-option"><input type="checkbox" role="switch" checked={config.autoSync} disabled={disabled} onChange={event => update("autoSync", event.target.checked)} /><span>自动上传<small>应用运行时，业务数据变化后延迟上传；发现远端版本变化会停止覆盖。</small></span></label>
          <label className="cloud-sync-option"><input type="checkbox" checked={config.passwordProtected} disabled={disabled} onChange={event => update("passwordProtected", event.target.checked)} /><span>使用密码保护云备份<small>默认不加密码：敏感字段保持加密，包内包含恢复 key，持有文件即可恢复。启用后，数据库和 key 一起加密。</small></span></label>
          {config.passwordProtected && field("backupPassword", "备份密码", saved?.config.hasBackupPassword ? "已保存，留空保留；另一台设备需填写同一密码" : "至少 8 个字符，下载恢复时也需要", true)}
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
        <p>{dirty ? "请先保存配置，再使用上传或下载。" : "下载时暂停自动上传；先校验和预览，确认后才恢复本机数据。"}</p>
        <p>上次上传：{timeText(saved?.status.lastUpload ?? null)}　·　上次下载：{timeText(saved?.status.lastDownload ?? null)}</p>
      </div>
      </div>
      {(error || saved?.status.error) && <p role="alert" className="data-settings-error">{error || saved?.status.error}</p>}
      {message && <p role="status">{message}</p>}
    </div>
    {confirmUpload && <ConfirmDialog title="上传云备份" confirmLabel="确认上传" message="将本机当前数据库上传到此配置的云端位置；如已有备份，将替换它。请确认本机数据是要保留的版本。" onResolve={confirmed => { setConfirmUpload(false); if (confirmed) void run("upload"); }} />}
  </section>;
}
