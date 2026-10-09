import { SecretField } from "../../shared/SecretField";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Download, FileLock2, LockKeyhole, ShieldCheck, Upload, X } from "lucide-react";
import { Format, openAppSettings, requestPermissions, scan } from "@tauri-apps/plugin-barcode-scanner";
import { listen } from "@tauri-apps/api/event";
import { QRCodeSVG } from "qrcode.react";
import type { Account, ManagedHost, PanelConnection } from "../../shared/types";
import { accountsClient, type SyncDeltaApplyResult, type SyncDeltaReview, type SyncDeltaConflictResolution, type SyncEnvelope, type SyncImportPreview } from "../../platform/clients/accounts";
import { runningInTauri } from "../../platform/api";
import { databaseClient, type DatabaseImportPreview } from "../../platform/clients/database";
import "./sync-transfer.css";

type Props = {
  mode: "desktop" | "mobile";
  accounts?: Account[];
  managedHosts?: ManagedHost[];
  panels?: PanelConnection[];
  onClose?: () => void;
  onImported?: () => void;
};

function isEnvelope(value: unknown): value is SyncEnvelope {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.version === 1 && item.kdf === "PBKDF2-HMAC-SHA256" && item.cipher === "AES-256-GCM"
    && ["salt", "nonce", "ciphertext"].every((key) => typeof item[key] === "string");
}

function downloadJson(fileName: string, value: unknown) {
  const href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = href; link.download = fileName; document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function transferErrorMessage(cause: unknown, fallback: string) {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause.trim()) return cause.trim();
  if (cause && typeof cause === "object") {
    const details = cause as { message?: unknown; error?: unknown };
    if (typeof details.message === "string" && details.message.trim()) return details.message.trim();
    if (typeof details.error === "string" && details.error.trim()) return details.error.trim();
  }
  return fallback;
}

export function SyncTransferPanel({ mode, accounts = [], managedHosts = [], panels = [], onClose, onImported }: Props) {
  const mobile = mode === "mobile";
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectedManagedHostIds, setSelectedManagedHostIds] = useState<Set<number>>(new Set());
  const [selectedPanelIds, setSelectedPanelIds] = useState<Set<number>>(new Set());
  const [desktopSelectionTab, setDesktopSelectionTab] = useState<"accounts" | "hosts" | "panels">("accounts");
  const [preview, setPreview] = useState<SyncImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pairingUrl, setPairingUrl] = useState("");
  const [pairingSourceDeviceId, setPairingSourceDeviceId] = useState("");
  const [pairingSourceFingerprint, setPairingSourceFingerprint] = useState("");
  const [pendingClientAddress, setPendingClientAddress] = useState("");
  const [pendingVerificationCode, setPendingVerificationCode] = useState("");
  const [pendingDeviceIdentity, setPendingDeviceIdentity] = useState("");
  const [qrImportSessionId, setQrImportSessionId] = useState("");
  const [qrImportAccountIds, setQrImportAccountIds] = useState<Set<string>>(new Set());
  const [qrImportHostIds, setQrImportHostIds] = useState<Set<string>>(new Set());
  const [qrImportPanelIds, setQrImportPanelIds] = useState<Set<string>>(new Set());
  const [includeQrDeletions, setIncludeQrDeletions] = useState(false);
  const [approvalListenerReady, setApprovalListenerReady] = useState(false);
  const [deltaPassphrase, setDeltaPassphrase] = useState("");
  const [deltaEnvelope, setDeltaEnvelope] = useState<SyncEnvelope | null>(null);
  const [deltaReview, setDeltaReview] = useState<SyncDeltaReview | null>(null);
  const [pendingAcknowledgements, setPendingAcknowledgements] = useState<SyncDeltaApplyResult[]>([]);
  const [deltaConflictChoices, setDeltaConflictChoices] = useState<Record<string, "incoming" | "local">>({});
  const [databasePreview, setDatabasePreview] = useState<DatabaseImportPreview | null>(null);
  const [cameraPermissionDenied, setCameraPermissionDenied] = useState(false);
  const databaseFileInput = useRef<HTMLInputElement>(null);
  const deltaInput = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const initializedAccountSelection = useRef(false);
  const initializedHostSelection = useRef(false);
  const initializedPanelSelection = useRef(false);
  const allSelected = accounts.length > 0 && selectedIds.size === accounts.length;
  const transferableHosts = managedHosts.filter((host) => host.platform === "linux" && (host.auth_method === "private_key" ? host.private_key_saved : host.password_saved));
  const allHostsSelected = transferableHosts.length > 0 && selectedManagedHostIds.size === transferableHosts.length;
  const transferablePanels = panels.filter((panel) => panel.api_key_saved);
  const allPanelsSelected = transferablePanels.length > 0 && selectedPanelIds.size === transferablePanels.length;
  const selectedCount = useMemo(() => selectedIds.size, [selectedIds]);
  const selectedManagedHostCount = useMemo(() => selectedManagedHostIds.size, [selectedManagedHostIds]);
  const selectedPanelCount = useMemo(() => selectedPanelIds.size, [selectedPanelIds]);
  const unresolvedDeltaConflicts = deltaReview?.conflicts.some((item) => !item.resolvable || !deltaConflictChoices[`${item.entityType}:${item.syncId}`]) ?? false;
  const hasQrImportSelection = qrImportAccountIds.size + qrImportHostIds.size + qrImportPanelIds.size > 0 || includeQrDeletions;
  const selectedQrConflicts = preview?.conflicts.filter((item) => !qrImportSessionId || (
    item.entityType === "cloudAccount" ? qrImportAccountIds.has(item.syncId)
      : item.entityType === "managedHost" ? qrImportHostIds.has(item.syncId)
        : qrImportPanelIds.has(item.syncId)
  )) ?? [];

  useEffect(() => {
    if (mobile || initializedAccountSelection.current || accounts.length === 0) return;
    initializedAccountSelection.current = true;
    setSelectedIds(new Set(accounts.map((account) => account.id)));
  }, [accounts, mobile]);
  useEffect(() => {
    if (mobile || initializedHostSelection.current || transferableHosts.length === 0) return;
    initializedHostSelection.current = true;
    setSelectedManagedHostIds(new Set(transferableHosts.map((host) => host.id)));
  }, [mobile, transferableHosts]);
  useEffect(() => {
    if (mobile || initializedPanelSelection.current || transferablePanels.length === 0) return;
    initializedPanelSelection.current = true;
    setSelectedPanelIds(new Set(transferablePanels.map((panel) => panel.id)));
  }, [mobile, transferablePanels]);

  useEffect(() => { if (!mobile) panelRef.current?.focus(); }, [mobile]);
  useEffect(() => () => { if (!mobile) void accountsClient.cancelSyncTransfer().catch(() => undefined); }, [mobile]);
  useEffect(() => () => { if (databasePreview && !runningInTauri) void databaseClient.cancelBrowserImport(databasePreview.token).catch(() => undefined); }, [databasePreview]);
  useEffect(() => {
    if (mobile && runningInTauri) void accountsClient.listPendingSyncAcknowledgements().then(setPendingAcknowledgements).catch((cause) => setError(cause instanceof Error ? cause.message : "无法读取待回传回执"));
  }, [mobile]);
  useEffect(() => {
    if (mobile || !runningInTauri) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<{ clientAddress: string; verificationCode: string; deviceId: string; publicKeyFingerprint: string }>("sync-transfer-requested", (event) => {
      setPendingClientAddress(event.payload.clientAddress);
      setPendingVerificationCode(event.payload.verificationCode);
      setPendingDeviceIdentity(`${event.payload.deviceId} · 密钥指纹 ${event.payload.publicKeyFingerprint}`);
      setError("");
    }).then((stop) => {
      if (active) { unlisten = stop; setApprovalListenerReady(true); }
      else stop();
    }).catch(() => setError("无法监听手机迁移授权请求，请关闭并重新打开迁移面板。"));
    return () => { active = false; unlisten?.(); setApprovalListenerReady(false); };
  }, [mobile]);

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && onClose) { event.preventDefault(); onClose(); return; }
    if (mobile || event.key !== "Tab" || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.tabIndex >= 0 && element.offsetParent !== null);
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function startQrTransfer() {
    setError(""); setNotice(""); setPairingUrl("");
    if (!selectedIds.size && !selectedManagedHostIds.size && !selectedPanelIds.size) { setError("至少选择一个配置后再生成二维码。"); return; }
    setBusy(true);
    try {
      const transfer = await accountsClient.startSyncTransfer([...selectedIds], [...selectedManagedHostIds], [...selectedPanelIds], false);
      setPairingUrl(transfer.pairingUrl);
      setPairingSourceDeviceId(transfer.sourceDeviceId);
      setPairingSourceFingerprint(transfer.sourcePublicKeyFingerprint);
      setNotice("电脑正在等待手机扫码。二维码含一次性加密密钥，5 分钟后失效；手机请求需在电脑批准后才会发送数据。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  async function cancelQrTransfer() {
    setBusy(true);
    try { await accountsClient.cancelSyncTransfer(); setPairingUrl(""); setPendingClientAddress(""); setNotice("局域网传输已关闭，未批准的请求不会收到数据。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function decideQrRequest(approved: boolean) {
    setBusy(true); setError("");
    try {
      await accountsClient.approveSyncTransfer(approved);
      setPendingClientAddress(""); setPendingDeviceIdentity(""); setPairingUrl("");
      setNotice(approved ? "已批准本次迁移，密文已发送；局域网会话随即关闭。" : "已拒绝迁移请求，未发送任何数据。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function scanComputerQr() {
    setError(""); setNotice(""); setPreview(null); setQrImportSessionId("");
    setCameraPermissionDenied(false);
    setBusy(true);
    let stage = "请求相机权限";
    try {
      const permission = await requestPermissions();
      if (permission !== "granted") {
        setCameraPermissionDenied(true);
        setError("相机权限未开启，无法扫码。请允许 CloudHub Tools 使用相机后重试。");
        return;
      }
      const random = new Uint32Array(1);
      crypto.getRandomValues(random);
      const code = String(random[0] % 1_000_000).padStart(6, "0");
      stage = "读取二维码";
      const result = await scan({ windowed: false, formats: [Format.QRCode] });
      if (!result.content?.trim()) throw new Error("没有读取到有效二维码内容");
      setNotice("已向电脑发起申请，请核对两台设备显示的相同校验码，并在电脑端批准。批准前不会发送配置。");
      stage = "连接电脑并接收数据";
      const received = await accountsClient.fetchSyncTransfer(result.content, code);
      stage = "验证并解密迁移数据";
      setQrImportSessionId(received.sessionId);
      setPreview(received.preview);
      setQrImportAccountIds(new Set(received.preview.accounts.map((item) => item.syncId)));
      setQrImportHostIds(new Set(received.preview.managedHosts.map((item) => item.syncId)));
      setQrImportPanelIds(new Set(received.preview.panels.map((item) => item.syncId)));
      setIncludeQrDeletions(false);
      setPairingSourceDeviceId(received.sourceDeviceId);
      setPairingSourceFingerprint(received.sourcePublicKeyFingerprint);
      setNotice(`已安全接收电脑配置（指纹 ${received.sourcePublicKeyFingerprint}）。选择要导入的项目并确认；凭据仅在原生层解密和写入。`);
    } catch (cause) {
      setError(`${stage}失败：${transferErrorMessage(cause, "未知错误，请重新操作。")}`);
    } finally { setBusy(false); }
  }

  async function openCameraPermissionSettings() {
    try { await openAppSettings(); }
    catch (cause) { setError(`无法打开系统权限设置：${transferErrorMessage(cause, "请手动在系统设置中允许相机权限。")}`); }
  }



  async function previewReceivedDelta() {
    if (!deltaEnvelope) return;
    if (!deltaPassphrase) { setError("请输入发送端设置的增量同步口令。"); return; }
    setBusy(true); setError("");
    try {
      const review = await accountsClient.previewSyncDeltaBundle(deltaEnvelope, deltaPassphrase);
      setDeltaReview(review); setDeltaConflictChoices({});
      setNotice(`已验证设备签名 · ${review.changeCount} 条变更。检查冲突后再确认应用。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法验证收到的增量"); }
    finally { setBusy(false); }
  }

  async function readDatabaseBackup(file?: File) {
    setError(""); setNotice(""); setDatabasePreview(null); setPreview(null);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".chdb")) { setError("请选择电脑导出的 .chdb 数据备份。"); return; }
    if (runningInTauri) { setError("整库备份导入目前需要使用手机浏览器预览版。"); return; }
    setBusy(true);
    try {
      const result = await databaseClient.prepareBrowserImport(file);
      setDatabasePreview(result);
      setNotice("文件校验通过。确认后将用电脑数据替换手机当前数据。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取电脑备份");
    } finally { setBusy(false); if (databaseFileInput.current) databaseFileInput.current.value = ""; }
  }

  async function confirmDatabaseBackupImport() {
    if (!databasePreview) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await databaseClient.confirmBrowserImport(databasePreview.token);
      setDatabasePreview(null);
      setNotice(`${result.message}。正在重新载入手机数据…`);
      window.setTimeout(() => window.location.reload(), 900);
    } catch (cause) {
      setDatabasePreview(null);
      setError(`${cause instanceof Error ? cause.message : "导入电脑备份失败"}，请重新选择备份后重试。`);
    } finally { setBusy(false); }
  }

  async function cancelDatabaseBackupImport() {
    if (!databasePreview) return;
    const token = databasePreview.token;
    setDatabasePreview(null);
    try { await databaseClient.cancelBrowserImport(token); }
    catch { /* The server also removes expired previews. */ }
  }

  async function confirmImport() {
    if (!preview) return;
    if (mobile && qrImportSessionId) {
      if (!qrImportAccountIds.size && !qrImportHostIds.size && !qrImportPanelIds.size && !includeQrDeletions) { setError("至少选择一项配置后再导入。"); return; }
      setBusy(true); setError(""); setNotice("");
      try {
        const imported = await accountsClient.confirmQrSyncImport(qrImportSessionId, {
          accountSyncIds: [...qrImportAccountIds], managedHostSyncIds: [...qrImportHostIds], panelSyncIds: [...qrImportPanelIds], includeDeletions: includeQrDeletions,
        });
        setNotice(`迁移完成：新增 ${imported.added} 项，更新 ${imported.updated} 项（云账号 ${imported.accounts}、主机 ${imported.managedHosts}、面板 ${imported.panels}）。`);
        setPreview(null); setQrImportSessionId(""); setIncludeQrDeletions(false); onImported?.();
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setBusy(false); }
      return;
    }
  }

  async function cancelQrImportPreview() {
    if (qrImportSessionId) await accountsClient.cancelQrSyncImport(qrImportSessionId).catch(() => undefined);
    setQrImportSessionId(""); setPreview(null); setIncludeQrDeletions(false);
  }

  async function readDelta(file?: File) {
    setError(""); setNotice(""); setDeltaReview(null); setDeltaEnvelope(null); setDeltaConflictChoices({});
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { setError("增量包超过 15 MB，已拒绝读取。"); return; }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isEnvelope(parsed)) throw new Error("文件格式不受支持，请选择 CloudHub 增量同步包。");
      if (!deltaPassphrase) { setError("先输入生成增量包时使用的 增量同步口令。"); return; }
      setBusy(true);
      const review = await accountsClient.previewSyncDeltaBundle(parsed, deltaPassphrase);
      setDeltaEnvelope(parsed); setDeltaReview(review); setDeltaConflictChoices({});
      setNotice(`已验证来源设备签名。批次 ${review.fromSequence}–${review.throughSequence}，包含 ${review.changeCount} 条变更。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); if (deltaInput.current) deltaInput.current.value = ""; }
  }

  async function applyDelta() {
    if (!deltaEnvelope || !deltaReview || unresolvedDeltaConflicts) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const resolutions: SyncDeltaConflictResolution[] = deltaReview.conflicts.filter((item) => item.resolvable).map((item) => ({ entityType: item.entityType, syncId: item.syncId, choice: deltaConflictChoices[`${item.entityType}:${item.syncId}`] }));
      const acknowledgement: SyncDeltaApplyResult = await accountsClient.applySyncDeltaBundle(deltaEnvelope, deltaPassphrase, resolutions);
      setPendingAcknowledgements((current) => [acknowledgement, ...current.filter((item) => item.sourceDeviceId !== acknowledgement.sourceDeviceId || item.messageIds.join() !== acknowledgement.messageIds.join())]);
      let acknowledgementSaved = false;
      let acknowledgementSentOverLan = false;
      if (mobile && runningInTauri) {
        if (!acknowledgementSentOverLan) {
          try { acknowledgementSaved = await accountsClient.saveSyncAcknowledgementFile(acknowledgement); }
          catch (cause) { setError(cause instanceof Error ? cause.message : "增量已应用，但保存签名回执失败。可稍后重试保存回执。"); }
        }
      } else if (!acknowledgementSentOverLan) {
        downloadJson(`cloudhub-ack-${new Date().toISOString().slice(0, 10)}.chack.json`, acknowledgement);
        acknowledgementSaved = true;
      }
      if (acknowledgementSaved) setPendingAcknowledgements((current) => current.filter((item) => item.sourceDeviceId !== acknowledgement.sourceDeviceId || item.messageIds.join() !== acknowledgement.messageIds.join()));
      setNotice(`增量已安全应用：新增 ${acknowledgement.added} 项、更新 ${acknowledgement.updated} 项、删除 ${acknowledgement.deleted} 项。${acknowledgementSentOverLan ? "签名回执已通过局域网传回电脑。" : acknowledgementSaved ? "签名回执已保存，请交还发送设备。" : "回执尚未保存，请使用下方按钮重试；保存前请勿关闭页面。"}`);
      setDeltaEnvelope(null); setDeltaReview(null); setDeltaPassphrase(""); onImported?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function retrySaveAcknowledgement() {
    if (!pendingAcknowledgements.length) return;
    setBusy(true); setError("");
    try {
      const acknowledgement = pendingAcknowledgements[0];
      const saved = await accountsClient.saveSyncAcknowledgementFile(acknowledgement);
      if (saved) { setPendingAcknowledgements((current) => current.slice(1)); setNotice("签名回执已保存，请交还发送设备以确认同步消息。"); }
      else setNotice("已取消保存；回执仍保留在当前页面，可再次保存。请勿关闭页面。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <section ref={panelRef} tabIndex={mobile ? undefined : -1} role={mobile ? undefined : "dialog"} aria-modal={mobile ? undefined : true} onKeyDown={handleDialogKeyDown} className={`sync-transfer-panel ${mobile ? "sync-transfer-mobile" : "sync-transfer-desktop"}`} aria-labelledby="sync-transfer-title">
    <header className="sync-transfer-heading">
      <div className="sync-transfer-icon"><FileLock2 size={19} aria-hidden="true" /></div>
      <div><p>跨设备迁移</p><h2 id="sync-transfer-title">{mobile ? "导入电脑数据" : "迁移到手机"}</h2></div>
      {onClose && <button type="button" className="sync-transfer-close" aria-label={mobile ? "返回更多管理" : "关闭迁移面板"} onClick={onClose}><X size={18} /></button>}
    </header>

    {mobile ? <>
      <p className="sync-transfer-intro">电脑和手机在同一局域网时，可扫码选择性迁移；也可导入电脑导出的整库备份。</p>
      {runningInTauri ? <button className="sync-transfer-primary" type="button" disabled={busy} onClick={() => void scanComputerQr()}><Upload size={17} aria-hidden="true" />{busy ? "正在扫码并连接电脑…" : "扫码从电脑迁移（免口令）"}</button> : <p className="sync-transfer-status">扫码迁移需要在手机 App 中使用；当前浏览器预览不支持原生扫码。</p>}
      <h3 className="sync-transfer-mobile-import-title">导入电脑备份</h3>
      <label className="sync-transfer-file">
        <Upload size={17} aria-hidden="true" /><span>{busy ? "正在校验备份…" : "选择 .chdb 电脑备份文件"}</span>
        <input ref={databaseFileInput} type="file" accept=".chdb,application/octet-stream" onChange={(event) => void readDatabaseBackup(event.currentTarget.files?.[0])} disabled={busy} />
      </label>
      <div className="sync-transfer-safety" role="note"><LockKeyhole size={15} aria-hidden="true" /><span>.chdb 包含完整数据库和解密密钥，无需口令。请只导入可信文件；确认后会替换手机现有数据，并自动保留导入前备份。</span></div>
      {databasePreview && <div className="sync-transfer-preview" aria-live="polite">
        <h3>备份内容：{databasePreview.packageName}</h3>
        <p>导出时间：{databasePreview.exportedAt} · 共 {databasePreview.totalRecords} 条记录</p>
        <ul>{databasePreview.categories.filter((item) => item.count > 0).map((item) => <li key={item.label}><strong>{item.label}</strong><span>{item.count} 条</span></li>)}</ul>
        <p>确认后会以电脑备份完整替换手机数据库。手机当前数据会自动留存为导入前备份。</p>
        <button className="sync-transfer-primary" type="button" disabled={busy} onClick={() => void confirmDatabaseBackupImport()}><ShieldCheck size={17} aria-hidden="true" />{busy ? "正在导入…" : "确认替换并导入"}</button>
        <button className="sync-transfer-file" type="button" disabled={busy} onClick={() => void cancelDatabaseBackupImport()}>取消</button>
      </div>}
    </> : <>
      <p className="sync-transfer-intro">选择要迁移到手机的配置，然后扫码接收。传输会自动加密，无需迁移口令。</p>
      <div className="sync-transfer-desktop-selection">
        <div className="sync-transfer-tabs" role="tablist" aria-label="选择要迁移的配置类型">
          <button type="button" role="tab" id="sync-transfer-tab-accounts" aria-selected={desktopSelectionTab === "accounts"} aria-controls="sync-transfer-selection-panel" onClick={() => setDesktopSelectionTab("accounts")}>云账号 <span>{selectedCount}/{accounts.length}</span></button>
          <button type="button" role="tab" id="sync-transfer-tab-hosts" aria-selected={desktopSelectionTab === "hosts"} aria-controls="sync-transfer-selection-panel" onClick={() => setDesktopSelectionTab("hosts")}>SSH 主机 <span>{selectedManagedHostCount}/{transferableHosts.length}</span></button>
          <button type="button" role="tab" id="sync-transfer-tab-panels" aria-selected={desktopSelectionTab === "panels"} aria-controls="sync-transfer-selection-panel" onClick={() => setDesktopSelectionTab("panels")}>面板 <span>{selectedPanelCount}/{transferablePanels.length}</span></button>
        </div>
        <div className="sync-transfer-selection-toolbar">
          <strong>{desktopSelectionTab === "accounts" ? "选择云账号" : desktopSelectionTab === "hosts" ? "选择 SSH 主机" : "选择面板"}</strong>
          <button type="button" onClick={() => {
            if (desktopSelectionTab === "accounts") setSelectedIds(allSelected ? new Set() : new Set(accounts.map((account) => account.id)));
            else if (desktopSelectionTab === "hosts") setSelectedManagedHostIds(allHostsSelected ? new Set() : new Set(transferableHosts.map((host) => host.id)));
            else setSelectedPanelIds(allPanelsSelected ? new Set() : new Set(transferablePanels.map((panel) => panel.id)));
          }}>{(desktopSelectionTab === "accounts" ? allSelected : desktopSelectionTab === "hosts" ? allHostsSelected : allPanelsSelected) ? "清空" : "全选"}</button>
        </div>
        <div className="sync-transfer-account-list" id="sync-transfer-selection-panel" role="tabpanel" aria-labelledby={`sync-transfer-tab-${desktopSelectionTab}`}>
          {desktopSelectionTab === "accounts" && accounts.map((account) => <label key={account.id} className="sync-transfer-account">
            <input type="checkbox" checked={selectedIds.has(account.id)} onChange={() => setSelectedIds((current) => { const next = new Set(current); if (next.has(account.id)) next.delete(account.id); else next.add(account.id); return next; })} />
            <span><strong>{account.account_name}</strong><small>{account.cloud_type}{account.region_id ? ` · ${account.region_id}` : ""}</small></span>
          </label>)}
          {desktopSelectionTab === "hosts" && transferableHosts.map((host) => <label key={host.id} className="sync-transfer-account">
            <input type="checkbox" checked={selectedManagedHostIds.has(host.id)} onChange={() => setSelectedManagedHostIds((current) => { const next = new Set(current); if (next.has(host.id)) next.delete(host.id); else next.add(host.id); return next; })} />
            <span><strong>{host.name}</strong><small>{host.username}@{host.host}:{host.port} · {host.auth_method === "private_key" ? "SSH 私钥" : "SSH 密码"}</small></span>
          </label>)}
          {desktopSelectionTab === "panels" && transferablePanels.map((panel) => <label key={panel.id} className="sync-transfer-account">
            <input type="checkbox" checked={selectedPanelIds.has(panel.id)} onChange={() => setSelectedPanelIds((current) => { const next = new Set(current); if (next.has(panel.id)) next.delete(panel.id); else next.add(panel.id); return next; })} />
            <span><strong>{panel.name}</strong><small>{panel.panel_url}</small></span>
          </label>)}
          {((desktopSelectionTab === "accounts" && accounts.length === 0) || (desktopSelectionTab === "hosts" && transferableHosts.length === 0) || (desktopSelectionTab === "panels" && transferablePanels.length === 0)) && <p className="sync-transfer-empty">当前没有可迁移的{desktopSelectionTab === "accounts" ? "云账号" : desktopSelectionTab === "hosts" ? "SSH 主机" : "面板"}</p>}
        </div>
        <p className="sync-transfer-selection-summary">已选 {selectedCount + selectedManagedHostCount + selectedPanelCount} 项</p>
      </div>
      <button className="sync-transfer-primary sync-transfer-secondary" type="button" disabled={busy || !runningInTauri || !approvalListenerReady || !!pendingClientAddress || (!selectedIds.size && !selectedManagedHostIds.size && !selectedPanelIds.size)} onClick={() => void startQrTransfer()}><ShieldCheck size={17} aria-hidden="true" />{busy ? "正在开启…" : !approvalListenerReady ? "正在准备授权…" : "显示手机迁移二维码（免口令）"}</button>
      {pairingUrl && <div className="sync-transfer-pairing"><QRCodeSVG value={pairingUrl} size={220} level="M" title="一次性局域网迁移二维码" /><p>电脑身份：<code>{pairingSourceDeviceId}</code><br />公钥指纹：<code>{pairingSourceFingerprint}</code></p><p>二维码仅用于本次加密传输。手机扫码后会显示设备校验信息；电脑批准后才发送所选配置。</p>{pendingClientAddress && <div className="sync-transfer-approval" role="alert"><strong>手机请求接收配置</strong><span>局域网地址：{pendingClientAddress}</span><span>设备身份：<code>{pendingDeviceIdentity}</code></span><span>请求校验码：<strong>{pendingVerificationCode}</strong></span><small>请核对手机显示的校验码和设备指纹，再确认请求来自你手上的设备。</small><div><button type="button" disabled={busy} onClick={() => void decideQrRequest(false)}>拒绝</button><button type="button" disabled={busy} onClick={() => void decideQrRequest(true)}>批准并发送</button></div></div>}<button type="button" disabled={busy} onClick={() => void cancelQrTransfer()}>关闭二维码</button></div>}
    </>}
    {runningInTauri && mobile && <details className="sync-transfer-advanced"><summary><strong>接收签名增量</strong><small>仅在需要设备间增量同步时使用</small></summary><section className="sync-transfer-devices" aria-labelledby="sync-delta-receive-title">
      <h3 id="sync-delta-receive-title">接收并应用签名增量</h3>
      <p>{mobile ? "选择电脑生成的签名增量文件。手机会验证来源设备签名和本机冲突；确认后原子应用，并通过系统文件保存器生成回传电脑的签名回执。" : "选择手机或其他已授权设备生成的签名增量文件。桌面会验证设备签名和冲突；确认后原子应用并生成签名回执，发送设备导入回执后才会清除待发记录。"}</p>
      <label className="sync-transfer-field">增量同步口令<SecretField secretLabel="同步口令" value={deltaPassphrase} maxLength={1024} autoComplete="current-password" onChange={(event) => setDeltaPassphrase(event.target.value)} placeholder="输入发送端设置的 增量同步口令" /></label>
      <label className="sync-transfer-file"><Upload size={17} aria-hidden="true" /><span>选择 .chdelta.json 增量文件</span><input ref={deltaInput} type="file" accept=".chdelta.json,.json,application/json" onChange={(event) => void readDelta(event.currentTarget.files?.[0])} disabled={busy} /></label>
      {deltaEnvelope && !deltaReview && <button className="sync-transfer-primary" type="button" disabled={busy || !deltaPassphrase} onClick={() => void previewReceivedDelta()}><ShieldCheck size={17} aria-hidden="true" />{busy ? "正在验证…" : "验证已接收的局域网增量"}</button>}
      {deltaReview && <section className="sync-transfer-preview" aria-live="polite">
        <h3>已验证设备签名 · {deltaReview.changeCount} 条变更</h3>
        <p>来源设备 {deltaReview.sourceDeviceId} · 序号 {deltaReview.fromSequence}–{deltaReview.throughSequence}</p>
        {!!deltaReview.deletions.length && <div className="sync-transfer-conflicts" role="alert"><strong>确认后将删除 {deltaReview.deletions.filter((item) => item.willDelete).length} 项本机配置</strong><ul>{deltaReview.deletions.map((item) => <li key={`${item.entityType}:${item.syncId}`}><span>{item.name}</span><small>{item.willDelete ? `删除 ${item.entityType}` : "本机已不存在"}</small></li>)}</ul></div>}
        {!!deltaReview.conflicts.length && <div className="sync-transfer-conflicts" role="alert"><strong>处理 {deltaReview.conflicts.length} 项版本或配置冲突</strong><ul>{deltaReview.conflicts.map((item) => {
          const key = `${item.entityType}:${item.syncId}`;
          return <li key={key}><span>{item.name}</span><small>{item.reason}</small>{item.resolvable ? <label className="sync-transfer-conflict-choice">处理方式<select value={deltaConflictChoices[key] ?? ""} onChange={(event) => { const value = event.target.value; setDeltaConflictChoices((current) => { const next = { ...current }; if (value === "incoming" || value === "local") next[key] = value; else delete next[key]; return next; }); }}><option value="">请选择</option><option value="incoming">使用收到的版本</option><option value="local">保留本机版本</option></select></label> : <small>这是不同配置占用相同凭据或地址，需先手动整理配置，再重新导入。</small>}</li>;
        })}</ul></div>}
        <button className="sync-transfer-primary" type="button" disabled={busy || unresolvedDeltaConflicts} onClick={() => void applyDelta()}><ShieldCheck size={17} aria-hidden="true" />{busy ? "正在原子应用…" : "确认并应用增量"}</button>
      </section>}
      {mobile && pendingAcknowledgements.length > 0 && <div className="sync-transfer-preview" role="status"><strong>有 {pendingAcknowledgements.length} 个签名回执待保存</strong><p>这些回执已保存在本机数据库。保存后通过系统分享功能交还电脑；发送设备收到回执前会保留待发送记录。</p><button className="sync-transfer-primary" type="button" disabled={busy} onClick={() => void retrySaveAcknowledgement()}><Download size={17} aria-hidden="true" />{busy ? "正在保存…" : "保存最早的签名回执"}</button></div>}
    </section></details>}
    {preview && <div className="sync-transfer-preview" aria-live="polite">
      <h3>{qrImportSessionId ? `已选择 ${qrImportAccountIds.size} 个云账号、${qrImportHostIds.size} 台主机、${qrImportPanelIds.size} 个面板${includeQrDeletions ? `和 ${preview.deletions.filter((item) => item.willDelete).length} 条删除记录` : ""}` : `将处理 ${preview.accounts.length} 个云账号、${preview.managedHosts.length} 台托管主机、${preview.panels.length} 个面板和 ${preview.deletions.length} 条删除记录`}</h3>
      {qrImportSessionId && <p>勾选要导入到手机的配置；未勾选的项目不会写入手机。</p>}
      {!!preview.accounts.length && <ul>{preview.accounts.map((account) => <li key={account.syncId}>{qrImportSessionId && <input type="checkbox" aria-label={`导入云账号 ${account.accountName}`} checked={qrImportAccountIds.has(account.syncId)} onChange={() => setQrImportAccountIds((current) => { const next = new Set(current); if (next.has(account.syncId)) next.delete(account.syncId); else next.add(account.syncId); return next; })} />}<strong>{account.accountName}</strong><span>{account.cloudType}{account.regionId ? ` · ${account.regionId}` : ""}</span></li>)}</ul>}
      {!!preview.managedHosts.length && <ul>{preview.managedHosts.map((host) => <li key={host.syncId}>{qrImportSessionId && <input type="checkbox" aria-label={`导入 SSH 主机 ${host.name}`} checked={qrImportHostIds.has(host.syncId)} onChange={() => setQrImportHostIds((current) => { const next = new Set(current); if (next.has(host.syncId)) next.delete(host.syncId); else next.add(host.syncId); return next; })} />}<strong>{host.name}</strong><span>{host.username}@{host.host}:{host.port} · {host.authMethod === "private_key" ? "SSH 私钥" : "SSH 密码"}</span></li>)}</ul>}
      {!!preview.panels.length && <ul>{preview.panels.map((panel) => <li key={panel.syncId}>{qrImportSessionId && <input type="checkbox" aria-label={`导入面板 ${panel.name}`} checked={qrImportPanelIds.has(panel.syncId)} onChange={() => setQrImportPanelIds((current) => { const next = new Set(current); if (next.has(panel.syncId)) next.delete(panel.syncId); else next.add(panel.syncId); return next; })} />}<strong>{panel.name}</strong><span>{panel.panelUrl}{panel.allowInsecureTls ? " · 允许不受信任 HTTPS 证书" : ""}</span></li>)}</ul>}
      {qrImportSessionId && !!preview.deletions.length && <label className="sync-transfer-deletions"><input type="checkbox" checked={includeQrDeletions} onChange={(event) => setIncludeQrDeletions(event.target.checked)} /><span><strong>同时应用 {preview.deletions.filter((item) => item.willDelete).length} 条删除记录</strong><small>取消勾选时只导入已选配置，不执行删除。</small></span></label>}
      {!!preview.deletions.length && <div className="sync-transfer-conflicts" role="alert"><strong>确认后将删除 {preview.deletions.filter((item) => item.willDelete).length} 项本机配置</strong><ul>{preview.deletions.map((item) => <li key={`${item.entityType}:${item.syncId}`}><span>{item.name}</span><small>{item.willDelete ? `删除${item.entityType === "cloud_account" ? "云账号" : item.entityType === "managed_host" ? "托管主机" : "面板"}` : "本机已不存在，不会产生变化"}</small></li>)}</ul></div>}
      {!!selectedQrConflicts.length && <div className="sync-transfer-conflicts" role="alert"><strong>发现 {selectedQrConflicts.length} 项与本机配置冲突</strong><ul>{selectedQrConflicts.map((conflict, index) => <li key={`${conflict.entityType}:${conflict.name}:${index}`}><span>{conflict.name}</span><small>{conflict.reason}</small></li>)}</ul></div>}
      <p>{preview.conflicts.length ? "请先取消同步并处理这些不同身份的凭据或地址冲突，再重新选择文件。" : `确认后按稳定 ID 新增或更新配置；已有配置会以此文件内容覆盖${preview.deletions.length ? "，并执行上面列出的删除" : ""}。如果两台设备都修改过，请先确认要保留的版本。SSH 指纹不会迁移，主机端点变化后需要重新确认。`}</p>
      {qrImportSessionId && <button className="sync-transfer-file" type="button" disabled={busy} onClick={() => void cancelQrImportPreview()}>取消本次扫码迁移</button>}
      <button className="sync-transfer-primary" type="button" disabled={busy || selectedQrConflicts.length > 0 || (!!qrImportSessionId && !hasQrImportSelection)} onClick={() => void confirmImport()}><ShieldCheck size={17} aria-hidden="true" />{busy ? "同步中…" : qrImportSessionId ? "确认导入所选配置" : "确认并同步配置"}</button>
    </div>}
    {error && <p className="sync-transfer-error" role="alert">{error}</p>}
    {cameraPermissionDenied && <button className="sync-transfer-file" type="button" onClick={() => void openCameraPermissionSettings()}>打开相机权限设置</button>}
    {notice && <p className="sync-transfer-status" role="status">{notice}</p>}
    <div className="sync-transfer-safety"><LockKeyhole size={15} aria-hidden="true" /><span>{mobile ? "秘密只在原生层解密/加密；请勿把迁移文件和口令放在同一位置。" : "迁移二维码仅本次有效，手机请求需经电脑批准后才会发送数据。"}</span></div>
  </section>;
}
