import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Format, openAppSettings, requestPermissions, scan } from "@tauri-apps/plugin-barcode-scanner";
import { QRCodeSVG } from "qrcode.react";
import { ShieldCheck, Upload } from "lucide-react";
import { accountsClient, type SyncImportPreview } from "../../platform/clients/accounts";
import { databaseClient, type DatabaseImportPreview } from "../../platform/clients/database";
import { runningInTauri } from "../../platform/api";
import { SharedDialog } from "../../shared/SharedDialog";
import { DataTransferScope, useTransferCatalog } from "./DataTransferScope";
import { CloudSyncSection } from "./CloudSyncSection";
import "./sync-transfer.css";

type Props = { mode: "desktop" | "mobile"; mobilePage?: boolean; onClose?: () => void; onImported?: () => void };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function UnifiedMigrationPanel({ mode, onClose, onImported }: Props) {
  const mobile = mode === "mobile";
  const scope = useTransferCatalog(!mobile && runningInTauri);
  const [includeTrash, setIncludeTrash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [pairingUrl, setPairingUrl] = useState("");
  const [qrOpen, setQrOpen] = useState(false);
  const [request, setRequest] = useState<{ clientAddress: string; verificationCode: string; deviceId: string; publicKeyFingerprint: string } | null>(null);
  const [preview, setPreview] = useState<SyncImportPreview | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [importTables, setImportTables] = useState<string[]>([]);
  const [backup, setBackup] = useState<DatabaseImportPreview | null>(null);
  const [backupTables, setBackupTables] = useState<string[]>([]);
  const [restoreMode, setRestoreMode] = useState<"merge" | "overwrite" | "replace">("merge");
  const [password, setPassword] = useState("");
  const [cameraDenied, setCameraDenied] = useState(false);

  useEffect(() => {
    if (mobile || !runningInTauri) return;
    let active = true;
    let stop: (() => void) | undefined;
    void listen<NonNullable<typeof request>>("sync-transfer-requested", event => setRequest(event.payload)).then(unlisten => {
      if (active) { stop = unlisten; setReady(true); } else unlisten();
    }).catch(() => setError("无法监听手机授权请求，请重新打开窗口。"));
    return () => { active = false; stop?.(); void accountsClient.cancelSyncTransfer().catch(() => undefined); };
  }, [mobile]);
  useEffect(() => () => { if (sessionId) void accountsClient.cancelQrSyncImport(sessionId).catch(() => undefined); }, [sessionId]);
  useEffect(() => () => { if (backup) void databaseClient.cancelImport(backup.token).catch(() => undefined); }, [backup]);

  async function start() {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await accountsClient.startSyncTransfer([], [], [], false, [], [], [], [], scope.tables, includeTrash);
      setPairingUrl(result.pairingUrl); setQrOpen(true); setRequest(null);
      setNotice("等待手机扫码；核对请求校验码并批准后发送。二维码 5 分钟后失效。");
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  async function approve(approved: boolean) {
    setBusy(true); setError("");
    try {
      await accountsClient.approveSyncTransfer(approved); setRequest(null); setQrOpen(false); setPairingUrl("");
      setNotice(approved ? "配置已发送，请在手机预览并确认导入。" : "已拒绝请求。");
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  async function cancelTransfer() {
    try { await accountsClient.cancelSyncTransfer(); setPairingUrl(""); setQrOpen(false); setRequest(null); }
    catch (cause) { setError(message(cause)); }
  }
  async function receive() {
    setBusy(true); setError(""); setNotice(""); setCameraDenied(false);
    try {
      if (await requestPermissions() !== "granted") { setCameraDenied(true); throw new Error("请在系统设置中允许相机权限。"); }
      const result = await scan({ windowed: false, formats: [Format.QRCode] });
      if (!result.content?.trim()) throw new Error("没有读取到有效二维码。");
      const random = crypto.getRandomValues(new Uint32Array(1));
      const code = String(random[0] % 1_000_000).padStart(6, "0");
      setNotice("请求校验码：" + code + "。请在电脑核对并批准。");
      const received = await accountsClient.fetchSyncTransfer(result.content, code);
      if (received.preview.protocolVersion !== 5) { await accountsClient.cancelQrSyncImport(received.sessionId); throw new Error("请将电脑端升级到支持统一数据迁移的版本后重新扫码。"); }
      setPreview(received.preview); setSessionId(received.sessionId);
      setImportTables((received.preview.categories ?? []).map(item => item.table));
      setNotice("已接收配置，请选择导入范围。已有记录默认保留，缺少的关联配置会一并导入。");
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  async function importQr() {
    setBusy(true); setError("");
    try {
      const result = await accountsClient.confirmQrSyncImport(sessionId, { transferTables: importTables, accountSyncIds: [], managedHostSyncIds: [], panelSyncIds: [], flowConnectionSyncIds: [], includeDeletions: false });
      setPreview(null); setSessionId(""); setNotice("迁移完成：新增 " + result.added + " 条，更新 " + result.updated + " 条；已有记录已保留。"); onImported?.();
    } catch (cause) { setPreview(null); setSessionId(""); setError(message(cause) + "，请重新扫码重试。"); } finally { setBusy(false); }
  }
  function reviewBackup(value: DatabaseImportPreview) { setBackup(value); setBackupTables(value.categories.map(item => item.table)); setRestoreMode("merge"); }
  async function selectBackup() {
    setBusy(true); setError("");
    try { const result = await databaseClient.prepareBackupImport(password || undefined); setPassword(""); if (result) reviewBackup(result); }
    catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  async function restoreBackup() {
    if (!backup) return;
    setBusy(true); setError("");
    try { setNotice(await databaseClient.confirmImport(backup.token, backupTables, restoreMode)); setBackup(null); onImported?.(); }
    catch (cause) { setBackup(null); setError(message(cause) + "，请重新选择备份重试。"); } finally { setBusy(false); }
  }
  const content = <>
    <p className="sync-transfer-intro">统一迁移云账号、主机、宝塔、证书及私钥、FRP、供应商、AI 配置、备忘录、指纹浏览器配置和验证码种子。排除日志、缓存、Codex 登录账号及下载包。</p>
    {mobile ? <>
      <button type="button" className="primary" disabled={busy || !runningInTauri} onClick={() => void receive()}><Upload size={16} />扫码接收电脑配置</button>
      {cameraDenied && <button type="button" className="secondary" onClick={() => void openAppSettings().catch(cause => setError(message(cause)))}>打开相机权限设置</button>}
      {!runningInTauri && <p>扫码和业务备份恢复请使用手机 App。</p>}
      {preview && <section className="sync-transfer-preview"><h3>确认导入配置</h3><DataTransferScope categories={preview.categories ?? []} tables={importTables} onChange={setImportTables} disabled={busy} /><p>默认合并并保留已有记录。桌面专属配置保存至手机，手机不执行桌面功能。</p><button className="primary" type="button" disabled={busy || !importTables.length} onClick={() => void importQr()}>确认导入所选配置</button><button type="button" className="secondary" disabled={busy} onClick={() => { void accountsClient.cancelQrSyncImport(sessionId); setPreview(null); setSessionId(""); }}>取消迁移</button></section>}
      <h3>导入电脑备份</h3>
      <label className="sync-transfer-backup-password">备份密码（可选）<input type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
      <button type="button" className="secondary" disabled={busy || !runningInTauri} onClick={() => void selectBackup()}>选择 .chdb 备份</button>
      {backup && <section className="sync-transfer-preview"><h3>{backup.packageName}</h3><DataTransferScope categories={backup.categories} tables={backupTables} onChange={setBackupTables} disabled={busy} /><label>恢复方式<select value={restoreMode} disabled={busy} onChange={event => setRestoreMode(event.target.value as typeof restoreMode)}><option value="merge">合并，保留已有</option><option value="overwrite">合并，覆盖重复</option><option value="replace">替换所选模块</option></select></label><p>包含回收站；保留手机本机日志、设备身份和登录状态。恢复前自动保存快照。</p><button type="button" className="primary" disabled={busy || !backupTables.length} onClick={() => void restoreBackup()}>确认恢复</button><button type="button" className="secondary" disabled={busy} onClick={() => setBackup(null)}>取消</button></section>}
      <CloudSyncSection available={runningInTauri} mobile onRestore={reviewBackup} />
    </> : <><DataTransferScope categories={scope.categories} tables={scope.tables} onChange={scope.setTables} disabled={busy || !!pairingUrl} /><label className="data-transfer-check"><input type="checkbox" checked={includeTrash} disabled={busy || !!pairingUrl} onChange={event => setIncludeTrash(event.target.checked)} />包含回收站（默认关闭）</label><p>电脑和手机需要使用相同数据库版本。每次最多 64 MB，较大内容可分模块迁移。</p>{scope.error && <p role="alert">{scope.error}</p>}</>}
    {error && <p className="sync-transfer-error" role="alert">{error}</p>}
    {notice && <p className="sync-transfer-status" role="status">{notice}</p>}
    {pairingUrl && qrOpen && <SharedDialog title="手机迁移二维码" size="small" className="sync-transfer-qr-dialog" bodyClassName="sync-transfer-qr-body" closeDisabled={busy} onClose={() => setQrOpen(false)} footer={<><button type="button" className="secondary" disabled={busy} onClick={() => setQrOpen(false)}>暂时关闭</button><button type="button" className="danger" disabled={busy} onClick={() => void cancelTransfer()}>取消本次迁移</button></>}><QRCodeSVG value={pairingUrl} size={220} level="M" title="手机迁移二维码" />{request && <div className="sync-transfer-approval"><strong>手机请求接收配置</strong><p>请求校验码：{request.verificationCode}</p><p>设备：{request.deviceId}<br />指纹：{request.publicKeyFingerprint}<br />地址：{request.clientAddress}</p><button type="button" disabled={busy} onClick={() => void approve(false)}>拒绝</button><button type="button" disabled={busy} onClick={() => void approve(true)}>批准并发送</button></div>}</SharedDialog>}
  </>;
  return mobile ? <section className="sync-transfer-panel sync-transfer-mobile" aria-label="数据迁移">{content}</section> : <SharedDialog title="迁移到手机" icon={<ShieldCheck size={18} />} className="sync-transfer-panel sync-transfer-desktop ide-theme" bodyClassName="sync-transfer-dialog-body" defaultExpanded busy={busy} closeDisabled={busy} onClose={() => onClose?.()} footer={<><small>已选 {scope.tables.length} 类数据</small><button type="button" className="secondary" disabled={busy} onClick={onClose}>关闭</button><button type="button" className="primary" disabled={busy || !ready || !scope.tables.length} onClick={() => pairingUrl ? setQrOpen(true) : void start()}>{busy ? "正在准备…" : pairingUrl ? "显示迁移二维码" : "生成迁移二维码"}</button></>}>{content}</SharedDialog>;
}
