import { useEffect, useRef, useState } from "react";
import { Download, FolderOpen, HardDrive, Plus, RefreshCw, Upload } from "lucide-react";
import { runningInTauri } from "../../platform/api";
import { cloudDriveClient as client, type DriveConnection, type DriveSnapshot } from "../../platform/clients/cloudDrive";
import { SharedDialog } from "../../shared/SharedDialog";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { SecretField } from "../../shared/SecretField";
import { useDialogDragging } from "../../shared/useDialogDragging";
import { PlainTransferDialog } from "../../shared/PlainTransferDialog";
import "./cloud-drive.css";

const fresh: DriveConnection = { id: "", name: "", provider: "Alibaba", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", region: "cn-hangzhou", bucket: "", prefix: "", accessKeyId: "", pathStyle: false, mountPoint: "O:", readOnly: true, autoMount: false, cacheDir: "", cacheGib: 10, hasCredentials: false, hasSessionToken: false, alipanAppId: "", alipanDrive: "default" };
const templates = [
  { id: "Alipan", name: "阿里云盘（官方授权）", endpoint: "https://openapi.alipan.com", region: "", pathStyle: false },
  { id: "Alibaba", name: "阿里云 OSS", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", region: "cn-hangzhou", pathStyle: false },
  { id: "AWS", name: "Amazon S3", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", pathStyle: false },
  { id: "Other", name: "通用 S3 兼容", endpoint: "", region: "us-east-1", pathStyle: true },
  { id: "Minio", name: "MinIO（S3）", endpoint: "", region: "us-east-1", pathStyle: true },
  { id: "Cloudflare", name: "Cloudflare R2（S3）", endpoint: "", region: "auto", pathStyle: true },
  { id: "TencentCOS", name: "腾讯云 COS（兼容模板）", endpoint: "", region: "ap-guangzhou", pathStyle: false },
  { id: "HuaweiOBS", name: "华为云 OBS（兼容模板）", endpoint: "", region: "cn-north-4", pathStyle: false },
];
function message(error: unknown) { return error instanceof Error ? error.message : "操作失败，请刷新后重试"; }
function gib(bytes: number) { return `${(bytes / 1024 ** 3).toFixed(2)} GiB`; }

function ConnectionEditor({ value, busy, error, platform, onClose, onSave }: {
  value: DriveConnection; busy: boolean; error: string; onClose: () => void;
  platform?: string;
  onSave: (value: DriveConnection, form: HTMLFormElement) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [pickerError, setPickerError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const request = useRef(0);
  const reading = useRef(false);
  const [buckets, setBuckets] = useState<string[] | null>(null);
  const [bucketBusy, setBucketBusy] = useState(false);
  const [bucketError, setBucketError] = useState("");
  const [manualBucket, setManualBucket] = useState(true);
  const [confirmBuckets, setConfirmBuckets] = useState(false);
  useEffect(() => () => { request.current++; }, []);
  useDialogDragging();
  const invalidateBuckets = () => { request.current++; setBuckets(null); setManualBucket(true); setBucketError(""); };
  const patch = (next: Partial<DriveConnection>) => {
    if (["provider", "endpoint", "region", "pathStyle"].some(key => key in next)) invalidateBuckets();
    setDraft(current => ({ ...current, ...next }));
  };
  async function readBuckets(reuse = false) {
    if (!formRef.current || reading.current) return;
    const fields = new FormData(formRef.current);
    const { hasCredentials: _has, hasSessionToken: _token, authorized: _auth, authorizationExpiresAt: _expiry, ...config } = draft;
    const input = { ...config, accessKeyId: String(fields.get("accessKeyId") ?? ""), secretKey: String(fields.get("secretKey") ?? ""), sessionToken: String(fields.get("sessionToken") ?? "") };
    setBucketError("");
    if (!input.accessKeyId.trim() || (!input.secretKey.trim() && !value.hasCredentials)) {
      setBucketError("请先填写 Access Key ID 和 Secret Access Key"); return;
    }
    if (value.hasCredentials && !input.secretKey && value.accessKeyId !== input.accessKeyId) {
      setBucketError("Access Key ID 已变更，请填写配套的 Secret Access Key"); return;
    }
    if (!reuse && value.hasCredentials && !input.secretKey && (value.endpoint !== input.endpoint || value.provider !== input.provider)) {
      setConfirmBuckets(true); return;
    }
    const current = ++request.current;
    reading.current = true; setBucketBusy(true);
    try {
      const items = await client.listBuckets(input, fields.has("clearSessionToken"), reuse);
      if (current === request.current) { setBuckets([...new Set(items)]); setManualBucket(items.length === 0); }
    } catch (e) { if (current === request.current) { setBuckets(null); setManualBucket(true); setBucketError(message(e)); } }
    finally { reading.current = false; if (current === request.current) setBucketBusy(false); }
  }
  const field = (key: "name" | "endpoint" | "region" | "bucket" | "prefix" | "mountPoint" | "cacheDir", label: string, hint?: string) =>
    <label><span>{label}</span><input value={draft[key]} required={["name", "endpoint", "bucket", "mountPoint"].includes(key)} maxLength={key === "endpoint" ? 2048 : 512} onChange={e => patch({ [key]: e.target.value })} />{hint && <small>{hint}</small>}</label>;
  return <><SharedDialog title={value.id ? "编辑云盘连接" : "新增云盘连接"} icon={<HardDrive size={18} aria-hidden="true" />} className="cloud-drive-editor" onClose={onClose}
    closeDisabled={busy} busy={busy || bucketBusy} initialFocus="input" formRef={formRef} onSubmit={e => { e.preventDefault(); if (!bucketBusy) void onSave(draft, e.currentTarget); }}
    footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy || bucketBusy}>{busy ? "正在保存…" : "保存连接"}</button></>}>
    <fieldset disabled={busy || bucketBusy} className="drive-fields" onChange={e => { if (e.target instanceof HTMLInputElement && ["accessKeyId", "secretKey", "sessionToken", "clearSessionToken"].includes(e.target.name)) invalidateBuckets(); }}>
      {field("name", "连接名称")}
      <label><span>存储服务</span><select value={draft.provider} onChange={e => { const t = templates.find(t => t.id === e.target.value)!; patch({ provider: t.id, endpoint: t.endpoint, region: t.region, pathStyle: t.pathStyle, alipanDrive: draft.alipanDrive || "default" }); }}>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      {draft.provider === "Alipan" ? <>
        <label><span>阿里云盘应用 App ID</span><input value={draft.alipanAppId ?? ""} required minLength={8} maxLength={128} autoComplete="off" spellCheck={false} onChange={e => patch({ alipanAppId: e.target.value })} /><small>填写已启用“公开客户端”的官方应用 ID，无需 App Secret。保存后点击“授权阿里云盘”。</small></label>
        <label><span>云盘空间</span><select value={draft.alipanDrive || "default"} onChange={e => patch({ alipanDrive: e.target.value as DriveConnection["alipanDrive"] })}><option value="default">默认云盘</option><option value="resource">资源库</option><option value="backup">备份盘</option></select></label>
      </> : <>
      {field("endpoint", "Endpoint", "HTTPS 服务地址，不含桶名和路径；更换阿里云地域时须同步修改此地址。")}
      {field("region", "Region / 区域")}
      <label><span>Access Key ID</span><input name="accessKeyId" type="text" defaultValue={value.accessKeyId} autoComplete="off" spellCheck={false} maxLength={8192} required placeholder="输入访问密钥 ID" /></label>
      <label><span>Secret Access Key</span><SecretField name="secretKey" secretLabel="Secret Access Key" autoComplete="new-password" maxLength={8192} required={!value.hasCredentials} placeholder={value.hasCredentials ? "留空保留已保存密钥" : "输入访问密钥"} reveal={value.hasCredentials ? () => client.revealSecret(value.id) : undefined} /></label>
      <label><span>Session Token（可选）</span><input name="sessionToken" type="password" autoComplete="off" maxLength={8192} placeholder={value.hasSessionToken ? "留空保留已保存令牌" : "使用临时凭据时填写"} /></label>
      <label className="drive-check"><input type="checkbox" name="clearSessionToken" />清除已保存的 Session Token</label>
      <div className="drive-bucket-picker">
        <label><span>Bucket / 存储桶</span>{!manualBucket && buckets?.length ? <select required value={draft.bucket} onChange={e => patch({ bucket: e.target.value, prefix: "" })}>
          <option value="" disabled>请选择存储桶</option>
          {draft.bucket && !buckets.includes(draft.bucket) && <option value={draft.bucket}>{draft.bucket}（当前填写）</option>}
          {buckets.map(bucket => <option key={bucket} value={bucket}>{bucket}</option>)}
        </select> : <input required maxLength={63} value={draft.bucket} onChange={e => patch({ bucket: e.target.value })} />}
          <small>按上方凭据读取后选择；没有列桶权限时，可手动填写已授权桶名。桶所在地域须与上方服务地址一致。</small>
        </label>
        <div className="drive-actions"><button type="button" className="secondary" onClick={() => void readBuckets()}>{bucketBusy ? "正在读取存储桶…" : "读取存储桶"}</button>
          {!!buckets?.length && <button type="button" className="secondary" onClick={() => setManualBucket(current => !current)}>{manualBucket ? "从列表选择" : "手动填写桶名"}</button>}</div>
        <p role="status">{bucketBusy ? "正在使用当前凭据读取存储桶，请稍候…" : buckets ? (buckets.length ? `已读取 ${buckets.length} 个存储桶；选择后保存连接。` : "未返回存储桶，可手动填写已授权桶名。") : ""}</p>
        {bucketError && <p role="alert" className="drive-error">{bucketError}。可检查服务地址和列桶权限，或手动填写桶名。</p>}
      </div>
      </>}
      {field("prefix", draft.provider === "Alipan" ? "云盘内目录" : "桶内目录", "留空挂载根目录；例如 资料/项目。")}
      {field("mountPoint", platform === "windows" || !platform ? "盘符或挂载目录" : "挂载目录", platform === "windows" || !platform ? "例如 O: 或 D:\\CloudDrives\\OSS；目录不能已存在，父目录须已存在。" : "填写已存在的本机空目录绝对路径，例如 /home/user/CloudDrive；macOS 可选用户目录下的空文件夹。")}
      <label><span>缓存空间目标（GiB）</span><input type="number" min={1} max={1024} value={draft.cacheGib} onChange={e => patch({ cacheGib: Number(e.target.value) })} /><small>未上传或正使用的文件不会被清理，实际占用可能超过目标。</small></label>
      {field("cacheDir", "缓存父目录", "留空使用 CloudHub 本地数据目录；每个连接独立缓存。")}
      <button type="button" className="secondary drive-browse" onClick={() => { setPickerError(""); void client.selectCache().then(path => { if (path) patch({ cacheDir: path }); }).catch(e => setPickerError(message(e))); }}><FolderOpen size={14} aria-hidden="true" />选择缓存目录</button>
      {draft.provider !== "Alipan" && <label className="drive-check"><input type="checkbox" checked={draft.pathStyle} onChange={e => patch({ pathStyle: e.target.checked })} />使用 Path-style 寻址</label>}
      <label className="drive-check"><input type="checkbox" checked={draft.readOnly} onChange={e => patch({ readOnly: e.target.checked })} />只读挂载（建议先验证读取）</label>
      <label className="drive-check"><input type="checkbox" checked={draft.autoMount} onChange={e => patch({ autoMount: e.target.checked })} />CloudHub 启动时自动挂载</label>
    </fieldset>
    <p className="drive-hint">{draft.provider === "Alipan" ? "授权令牌仅保存到本机加密数据库。公开客户端令牌默认有效 30 天，不支持自动刷新；到期重新授权时必须选择原账户和原云盘。首次建议只读挂载。" : "凭据仅保存到本机加密数据库。修改服务商或 Endpoint 后可确认沿用已保存凭据；更换 Access Key ID 时须填写配套的新密钥。读写挂载中的删除会影响云端对象，重要数据建议开启桶版本控制。"}</p>
    {(error || pickerError) && <p role="alert" className="drive-error">{error || pickerError}</p>}
  </SharedDialog>{confirmBuckets && <ConfirmDialog title="确认读取存储桶" message={`将使用已保存凭据访问 ${draft.endpoint} 读取存储桶，请确认这是你信任的服务地址。`} onResolve={yes => { setConfirmBuckets(false); if (yes) void readBuckets(true); }} />}</>;
}

export function CloudDrivePlugin() {
  const [snapshot, setSnapshot] = useState<DriveSnapshot | null>(null);
  const [busy, setBusy] = useState("");
  const lock = useRef(false);
  const mounted = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<DriveConnection | null>(null);
  const [credentialTarget, setCredentialTarget] = useState<DriveConnection | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; text: string; run: () => Promise<unknown> } | null>(null);
  const [listing, setListing] = useState<{ kind: "buckets" | "directories"; items: string[]; connection: DriveConnection; editable: boolean } | null>(null);
  const [transfer, setTransfer] = useState(false);
  const [authorization, setAuthorization] = useState<{ ticket: string; name: string } | null>(null);
  useEffect(() => () => { if (authorization) void client.alipanCancel(authorization.ticket).catch(() => {}); }, [authorization]);
  const refresh = async () => { const next = await client.snapshot(); if (mounted.current) setSnapshot(next); };
  useEffect(() => {
    mounted.current = true;
    if (!runningInTauri) return () => { mounted.current = false; };
    let checking = false;
    const poll = async () => { if (checking) return; checking = true; try { await refresh(); } catch (e) { if (mounted.current) setError(message(e)); } finally { checking = false; } };
    void poll(); const timer = window.setInterval(() => void poll(), 4000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, []);
  async function operate(label: string, action: () => Promise<unknown>, success = "操作已完成") {
    if (lock.current) return;
    lock.current = true; setBusy(label); setError(""); setNotice("");
    try { await action(); if (mounted.current) setNotice(success); }
    catch (e) { if (mounted.current) setError(message(e)); }
    finally { try { await refresh(); } catch (e) { if (mounted.current) setError(message(e)); } lock.current = false; if (mounted.current) setBusy(""); }
  }
  async function save(draft: DriveConnection, form: HTMLFormElement) {
    const fields = new FormData(form);
    const { hasCredentials: _has, hasSessionToken: _token, authorized: _auth, authorizationExpiresAt: _expiry, ...config } = draft;
    const input = { ...config, accessKeyId: String(fields.get("accessKeyId") ?? ""), secretKey: String(fields.get("secretKey") ?? ""), sessionToken: String(fields.get("sessionToken") ?? "") };
    const old = snapshot?.connections.find(c => c.id === draft.id);
    if (draft.provider !== "Alipan" && old?.hasCredentials && old.accessKeyId !== input.accessKeyId && !input.secretKey) {
      setError("Access Key ID 已变更，请填写配套的 Secret Access Key");
      return;
    }
    const commit = async (reuse = false) => {
      await client.save(input, fields.has("clearSessionToken"), reuse);
      form.reset(); if (mounted.current) setEditor(null);
    };
    if (draft.provider !== "Alipan" && old?.hasCredentials && !input.secretKey && (old.endpoint !== input.endpoint || old.provider !== input.provider)) {
      setError("");
      setConfirm({ title: "确认沿用已保存凭据", text: `保存后，连接将使用已保存凭据访问以下服务。请确认这是你信任的目标。服务商：${templates.find(t => t.id === input.provider)?.name ?? input.provider}；Endpoint：${input.endpoint}`, run: () => commit(true) });
      return;
    }
    await operate("保存连接", () => commit(), "连接已加密保存，可先测试连接再挂载");
  }
  if (!runningInTauri) return <p role="status">云盘挂载仅支持桌面客户端，浏览器和手机不提供系统磁盘挂载。</p>;
  if (!snapshot) return <div className="cloud-drive"><p role="status">正在读取云盘配置…</p>{error && <p role="alert">{error}</p>}</div>;
  const dep = snapshot.dependency;
  if (!dep.supported) return <p role="status">云盘挂载支持 Windows x64、macOS Intel / Apple Silicon 和 Linux x64 / ARM64 桌面客户端。</p>;
  const download = dep.progress;
  const prepareDriveImport = async () => { const preview = await client.prepareImport(); return preview && { token: preview.token, rows: preview.connections.map(item => ({ index: item.index, title: item.name, detail: `${item.provider} · ${item.bucket} → ${item.mountPoint}` })) }; };
  return <section className="cloud-drive" aria-label="云盘挂载管理" aria-busy={!!busy}>
    <header className="drive-toolbar"><div><h2><HardDrive size={19} aria-hidden="true" />云盘挂载</h2><p>将阿里云盘、OSS / S3 挂载为本机磁盘，文件在本机与存储服务间传输。</p></div>
      <div className="drive-actions"><button type="button" className="secondary" disabled={!!busy} onClick={() => setTransfer(true)}><Upload size={14} aria-hidden="true" />导入 / 导出</button><button type="button" className="secondary" disabled={!!busy} onClick={() => void operate("刷新", refresh, "状态已刷新")}><RefreshCw size={14} aria-hidden="true" />刷新</button><button type="button" className="primary" disabled={!!busy} onClick={() => { setError(""); setEditor({ ...fresh, mountPoint: dep.platform && dep.platform !== "windows" ? "" : fresh.mountPoint }); }}><Plus size={14} aria-hidden="true" />新增连接</button></div></header>
    <div className="drive-dependencies"><div><strong>挂载引擎</strong><span>{dep.installed ? `已检测到 · ${dep.source}` : `未安装 · 按需下载 rclone ${dep.version}`}</span></div><button type="button" className="secondary" disabled={!!busy || download.phase === "downloading"} onClick={() => void operate("下载挂载引擎", client.install, "挂载引擎已下载并通过 SHA-256 校验")}><Download size={14} aria-hidden="true" />{dep.installed ? "重新下载已校验版本" : "下载挂载引擎"}</button>
      <div><strong>{dep.driver ?? "WinFsp"} 驱动</strong><span>{dep.winfsp ? "已检测到 · 挂载仍需具备系统权限" : "未检测到 · 安装可能需要管理员权限或重启"}</span></div><button type="button" className="secondary" disabled={!!busy} onClick={() => void operate("打开安装说明", client.winfsp, "已打开挂载驱动官方说明；安装后点击刷新")}>官方安装说明</button>
      {["downloading", "verifying"].includes(download.phase) && <div className="drive-download" role="status">{download.phase === "verifying" ? "正在校验并安装…" : `正在下载：${(download.downloaded / 1024 ** 2).toFixed(1)} MiB${download.total ? ` / ${(download.total / 1024 ** 2).toFixed(1)} MiB` : ""}`}<progress max={download.total || undefined} value={download.total ? download.downloaded : undefined} /></div>}</div>
    <p className="drive-warning">适合资料和媒体文件，不建议用作数据库、虚拟机或软件安装目录。读写保存会先进入本地缓存；确认上传完成后再卸载。公网流量、API 请求及归档恢复可能收费。</p>
    <div role="status" aria-live="polite" className="drive-feedback">{busy ? `正在${busy}…` : notice}</div>
    {error && !editor && <p role="alert" className="drive-error">{error}</p>}
    {!snapshot.connections.length && <p className="drive-empty">还没有云盘连接。新增阿里云盘、OSS 或 S3 配置后，先授权并测试连接，再挂载。</p>}
    <div className="drive-connections">{snapshot.connections.map(c => {
      const state = snapshot.mounts.find(s => s.id === c.id);
      const active = state?.phase === "mounted";
      const recovery = state?.phase === "recovery";
      const pending = !!state && (state.queued > 0 || state.uploading > 0 || state.errors > 0 || state.dirty || state.outOfSpace);
      const alipan = c.provider === "Alipan";
      const expired = alipan && (!c.authorized || !c.authorizationExpiresAt || c.authorizationExpiresAt * 1000 <= Date.now() + 30000);
      return <article key={c.id} className="drive-connection"><header><div><h3>{c.name}<span>{c.readOnly ? "只读" : "读写"}</span></h3><p>{alipan ? "阿里云盘" : c.bucket}{c.prefix ? `/${c.prefix}` : ""} → {c.mountPoint}</p></div><strong>{active ? (pending ? "有待处理数据" : "已挂载") : recovery ? "需要恢复" : "未挂载"}</strong></header>
        <dl><div><dt>服务地址</dt><dd>{c.endpoint}</dd></div><div><dt>启动时挂载</dt><dd>{c.autoMount ? "开启" : "关闭"}</dd></div><div><dt>缓存</dt><dd>{gib(state?.bytesUsed ?? 0)} / 目标 {c.cacheGib} GiB</dd></div><div><dt>上传状态</dt><dd>{active ? `排队 ${state.queued} · 上传中 ${state.uploading} · 失败 ${state.errors}${state.dirty ? " · 尚有未上传修改" : ""}` : "挂载后可查看"}</dd></div></dl>
        {state?.outOfSpace && <p className="drive-error">缓存磁盘空间不足，请释放本机其他文件的空间；不要删除未上传缓存。</p>}
        {state?.message && <p className="drive-error">{state.message}</p>}
        {alipan && <p className={expired ? "drive-warning" : "drive-hint"}>{expired ? "阿里云盘尚未授权或授权已过期。若有挂载，请先保留缓存停止，再重新授权。" : `授权有效至 ${new Date(c.authorizationExpiresAt! * 1000).toLocaleString()}；到期需重新授权，令牌不能自动刷新。`}</p>}
        <div className="drive-actions">
          <button type="button" className="primary" disabled={!!busy || active || !dep.installed || !dep.winfsp || expired} onClick={() => {
            if (!c.readOnly) setConfirm({ title: "确认读写挂载", text: "此盘中的删除和覆盖会影响云端对象，不保证经过系统回收站。请避免多台电脑同时编辑同一文件，并确认权限及版本保护。", run: () => client.mount(c.id) });
            else void operate("挂载", () => client.mount(c.id), "磁盘已挂载");
          }}>{recovery ? "恢复挂载" : "挂载"}</button>
          <button type="button" className="secondary" disabled={!!busy || !active} onClick={() => void operate("打开磁盘", () => client.open(c.id), "已打开磁盘")}><FolderOpen size={14} aria-hidden="true" />打开</button>
          <button type="button" className="secondary" disabled={!!busy || !active || pending} onClick={() => setConfirm({ title: "安全卸载云盘", text: "请先关闭正在使用该磁盘的程序。将再次检查上传队列和缓存；未上传完成或状态不明时会阻止卸载。", run: () => client.unmount(c.id) })}>安全卸载</button>
          <button type="button" className="secondary" disabled={!!busy || !dep.installed} onClick={() => void operate("测试连接", () => client.probe(c.id, "test"), "目标目录列举成功；这不能证明写入、删除权限或所有归档对象可读取")}>测试连接</button>
          {(["buckets", "directories"] as const).filter(kind => !alipan || kind !== "buckets").map(kind => <button key={kind} type="button" className="secondary" disabled={!!busy || !dep.installed} onClick={() => void operate("读取目录", async () => { const items = await client.probe(c.id, kind); if (mounted.current) setListing({ kind, items, connection: c, editable: !active && !recovery }); }, "目录列表已读取")}>{kind === "buckets" ? "查看存储桶" : "查看子目录"}</button>)}
          <button type="button" className="secondary" disabled={!!busy || active || recovery} onClick={() => { setError(""); setEditor(c); }}>配置</button>
          {(pending || recovery) && <button type="button" className="secondary" disabled={!!busy} onClick={() => setConfirm({ title: "保留缓存停止", text: "仅用于凭据过期等无法上传的情况。请先关闭使用此盘的所有程序并保存文件。磁盘将卸载，引擎将停止，未上传文件及恢复记录保留在本机；这些文件此时尚未备份到云端。更新凭据后必须恢复挂载完成上传。", run: () => client.suspend(c.id) })}>保留缓存停止</button>}
          {alipan ? <button type="button" className="secondary" disabled={!!busy || active || !!authorization} onClick={() => void operate("打开阿里云盘授权", async () => { const ticket = await client.alipanBegin(c.id); if (mounted.current) setAuthorization({ ticket, name: c.name }); else await client.alipanCancel(ticket); }, "请在浏览器完成授权，再粘贴授权码")}>{c.authorized ? "重新授权" : "授权阿里云盘"}</button> : <button type="button" className="secondary" disabled={!!busy || active} onClick={() => { setError(""); setCredentialTarget(c); }}>更新凭据</button>}
          {recovery && <button type="button" className="secondary" disabled={!!busy} onClick={() => void operate("清理恢复记录", () => client.clearRecovery(c.id), "已清理停止且无未上传数据的恢复记录；缓存文件保留")}>清理已停止记录</button>}
          <button type="button" className="secondary" disabled={!!busy || active || recovery} onClick={() => setConfirm({ title: "删除连接配置", text: `删除“${c.name}”的本机配置及加密凭据？不会删除云端对象或本地缓存。`, run: () => client.remove(c.id) })}>删除配置</button>
        </div></article>;
    })}</div>
    <details className="drive-help"><summary>使用说明与数据保护</summary><p>挂载盘依赖网络，不能保证完整离线或多端协同。空目录、文件锁和重命名行为可能与本地磁盘不同；归档对象需先恢复。桶容量与磁盘显示的可用空间不一定对应。</p><p>缓存包含实际文件内容，不做额外加密，请放在可信的本机磁盘，敏感文件建议使用系统磁盘加密。异常退出后保留原连接和缓存，点击恢复挂载；不要手动删除缓存。应用正常退出前需安全卸载全部连接。</p><p>阿里云盘使用官方公开客户端授权，速度和额度受平台规则限制。删除使用云盘回收站；覆盖上传先完成临时文件，再将旧文件放入回收站，不保证跨设备原子覆盖。失败时云端可能留下 .cloudhub-upload- 临时文件，请确认本地缓存已恢复后再处理。覆盖已有目标的移动会拒绝执行，避免误删。其他 S3 厂商为兼容模板，实际读写能力需逐项验证。</p></details>
    {editor && <ConnectionEditor key={editor.id || "new"} value={editor} platform={dep.platform} busy={!!busy} error={error} onClose={() => setEditor(null)} onSave={save} />}
    {authorization && <SharedDialog title={`授权阿里云盘 · ${authorization.name}`} size="small" busy={!!busy} closeDisabled={!!busy} onClose={() => setAuthorization(null)} onSubmit={e => {
      e.preventDefault(); const form = e.currentTarget; const code = String(new FormData(form).get("code") ?? "").trim();
      void operate("完成阿里云盘授权", async () => { await client.alipanFinish(authorization.ticket, code); form.reset(); if (mounted.current) setAuthorization(null); }, "授权已加密保存，可测试连接后挂载");
    }} footer={<><button type="button" className="secondary" disabled={!!busy} onClick={() => setAuthorization(null)}>取消</button><button type="submit" className="primary" disabled={!!busy}>完成授权</button></>}>
      <p>已打开阿里云盘官方授权页面。确认应用名称和权限后，将页面显示的授权码或完整的授权结果页地址粘贴到下方；粘贴完整地址可校验是否属于本次授权。授权码 10 分钟内有效且仅能使用一次。</p>
      <label className="drive-fields"><span>授权码</span><input name="code" type="password" autoComplete="off" required maxLength={2048} spellCheck={false} /></label>
      <p>无需填写 App Secret。授权失败后请关闭此窗口，重新点击授权。公开客户端令牌默认有效 30 天，到期需重新授权。</p>
      {error && <p role="alert" className="drive-error">{error}</p>}
    </SharedDialog>}
    {credentialTarget && <SharedDialog title="更新云盘凭据" className="cloud-drive-editor" size="small" busy={!!busy} closeDisabled={!!busy} onClose={() => setCredentialTarget(null)} onSubmit={e => {
      e.preventDefault(); const form = e.currentTarget; const fields = new FormData(form); const id = credentialTarget.id;
      void operate("更新凭据", async () => { await client.credentials(id, String(fields.get("accessKeyId") ?? ""), String(fields.get("secretKey") ?? ""), String(fields.get("sessionToken") ?? "")); form.reset(); if (mounted.current) setCredentialTarget(null); }, "凭据已更新，请恢复挂载完成待上传数据");
    }} footer={<><button type="button" className="secondary" disabled={!!busy} onClick={() => setCredentialTarget(null)}>取消</button><button type="submit" className="primary" disabled={!!busy}>保存凭据</button></>}>
      <p>仅更新“{credentialTarget.name}”的访问凭据，保留存储桶、目录及缓存。请使用同一账户和同一存储空间的有效凭据；引擎仍在运行时需先选择“保留缓存停止”。</p>
      <fieldset disabled={!!busy} className="drive-fields">
        <label><span>Access Key ID</span><input name="accessKeyId" type="text" defaultValue={credentialTarget.accessKeyId} autoComplete="off" spellCheck={false} required maxLength={8192} /></label>
        <label><span>Secret Access Key</span><SecretField name="secretKey" secretLabel="Secret Access Key" autoComplete="new-password" required maxLength={8192} reveal={credentialTarget.hasCredentials ? () => client.revealSecret(credentialTarget.id) : undefined} /></label>
        <label><span>Session Token（可选，留空清除）</span><input name="sessionToken" type="password" autoComplete="off" maxLength={8192} /></label>
      </fieldset>
      {error && <p role="alert" className="drive-error">{error}</p>}
    </SharedDialog>}
    {confirm && <ConfirmDialog title={confirm.title} message={confirm.text} busy={!!busy} onResolve={yes => { const action = confirm; setConfirm(null); if (yes) void operate(action.title, action.run); }} />}
    {transfer && <PlainTransferDialog title="云盘连接" rows={snapshot.connections.map(c => ({ id: c.id, title: c.name, detail: `${c.provider} · ${c.bucket}${c.prefix ? `/${c.prefix}` : ""}` }))} prepareImport={prepareDriveImport} importSelected={client.importSelected} exportSelected={client.exportSelected} onClose={() => setTransfer(false)} onDone={message => { setTransfer(false); setNotice(message); void refresh(); }} />}
    {listing && <SharedDialog title={listing.kind === "buckets" ? "存储桶列表" : "子目录列表"} onClose={() => setListing(null)} size="small" footer={<button type="button" className="secondary" onClick={() => setListing(null)}>关闭</button>}><p>{listing.editable ? "选择条目后在连接配置中确认保存。更换存储位置会使用独立缓存。" : "当前有挂载或恢复记录，仅可查看。安全卸载后可选择存储位置。"}</p>{listing.items.length ? <ul className="drive-listing">{listing.items.map((item, i) => <li key={i}><span>{item}</span>{listing.editable && <button type="button" className="secondary" onClick={() => {
      const c = listing.connection;
      setEditor({ ...c, ...(listing.kind === "buckets" ? { bucket: item, prefix: "" } : { prefix: [c.prefix.replace(/\/+$/, ""), item].filter(Boolean).join("/") }) });
      setListing(null); setError("");
    }}>选择</button>}</li>)}</ul> : <p>没有可列举的条目。</p>}</SharedDialog>}
  </section>;
}
