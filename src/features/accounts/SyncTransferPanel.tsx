import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Download, FileLock2, LockKeyhole, ShieldCheck, Upload, X } from "lucide-react";
import { Format, scan } from "@tauri-apps/plugin-barcode-scanner";
import { listen } from "@tauri-apps/api/event";
import { QRCodeSVG } from "qrcode.react";
import type { Account, ManagedHost, PanelConnection } from "../../shared/types";
import { accountsClient, type SyncDeltaApplyResult, type SyncDeltaReview, type SyncDeltaConflictResolution, type SyncEnvelope, type SyncImportPreview, type SyncTrustedDevice } from "../../platform/clients/accounts";
import { runningInTauri } from "../../platform/api";
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

export function SyncTransferPanel({ mode, accounts = [], managedHosts = [], panels = [], onClose, onImported }: Props) {
  const mobile = mode === "mobile";
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectedManagedHostIds, setSelectedManagedHostIds] = useState<Set<number>>(new Set());
  const [selectedPanelIds, setSelectedPanelIds] = useState<Set<number>>(new Set());
  const [includeDeletions, setIncludeDeletions] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [desktopImportPassphrase, setDesktopImportPassphrase] = useState("");
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [exportConfirmation, setExportConfirmation] = useState("");
  const [envelope, setEnvelope] = useState<SyncEnvelope | null>(null);
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
  const [pairingCode, setPairingCode] = useState("");
  const [deltaPairingUrl, setDeltaPairingUrl] = useState("");
  const [waitingForSyncAck, setWaitingForSyncAck] = useState(false);
  const [activeTransferKind, setActiveTransferKind] = useState<"bundle" | "delta" | "deltaReceive" | "">("");
  const [approvalListenerReady, setApprovalListenerReady] = useState(false);
  const [trustedDevices, setTrustedDevices] = useState<SyncTrustedDevice[]>([]);
  const [syncTargetDeviceId, setSyncTargetDeviceId] = useState("");
  const [deltaPassphrase, setDeltaPassphrase] = useState("");
  const [deltaEnvelope, setDeltaEnvelope] = useState<SyncEnvelope | null>(null);
  const [deltaEnvelopeFromLan, setDeltaEnvelopeFromLan] = useState(false);
  const [deltaReview, setDeltaReview] = useState<SyncDeltaReview | null>(null);
  const [pendingAcknowledgements, setPendingAcknowledgements] = useState<SyncDeltaApplyResult[]>([]);
  const [deltaConflictChoices, setDeltaConflictChoices] = useState<Record<string, "incoming" | "local">>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const deltaInput = useRef<HTMLInputElement>(null);
  const acknowledgementInput = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const allSelected = accounts.length > 0 && selectedIds.size === accounts.length;
  const transferableHosts = managedHosts.filter((host) => host.platform === "linux" && (host.auth_method === "private_key" ? host.private_key_saved : host.password_saved));
  const allHostsSelected = transferableHosts.length > 0 && selectedManagedHostIds.size === transferableHosts.length;
  const transferablePanels = panels.filter((panel) => panel.api_key_saved);
  const allPanelsSelected = transferablePanels.length > 0 && selectedPanelIds.size === transferablePanels.length;
  const selectedCount = useMemo(() => selectedIds.size, [selectedIds]);
  const selectedManagedHostCount = useMemo(() => selectedManagedHostIds.size, [selectedManagedHostIds]);
  const selectedPanelCount = useMemo(() => selectedPanelIds.size, [selectedPanelIds]);
  const unresolvedDeltaConflicts = deltaReview?.conflicts.some((item) => !item.resolvable || !deltaConflictChoices[`${item.entityType}:${item.syncId}`]) ?? false;

  useEffect(() => { if (!mobile) panelRef.current?.focus(); }, [mobile]);
  useEffect(() => () => { if (!mobile) void accountsClient.cancelSyncTransfer().catch(() => undefined); }, [mobile]);
  useEffect(() => {
    if (!runningInTauri) return;
    void accountsClient.listSyncDevices().then((devices) => {
      setTrustedDevices(devices);
      setSyncTargetDeviceId((current) => current || devices.find((device) => device.status === "trusted")?.deviceId || "");
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "无法读取已授权设备"));
    if (mobile) void accountsClient.listPendingSyncAcknowledgements().then(setPendingAcknowledgements).catch((cause) => setError(cause instanceof Error ? cause.message : "无法读取待回传回执"));
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
  useEffect(() => {
    if (mobile || !runningInTauri) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen("sync-delta-received", () => {
      void accountsClient.takeReceivedSyncDelta().then(async (received) => {
        if (!active || !received) return;
        setDeltaEnvelope(received);
        setDeltaEnvelopeFromLan(true);
        setDeltaReview(null);
        setDeltaConflictChoices({});
        setNotice("已接收手机的加密增量。输入两端约定的口令并验证签名后，再检查冲突与应用内容。");
        if (deltaPassphrase.length >= 20) {
          try {
            const review = await accountsClient.previewSyncDeltaBundle(received, deltaPassphrase);
            if (!active) return;
            setDeltaReview(review);
            setNotice(`已验证手机签名 · ${review.changeCount} 条变更。检查冲突后再确认应用。`);
          } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "无法验证手机增量"); }
        }
      }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "读取已接收的手机增量失败"); });
    }).then((stop) => { if (active) unlisten = stop; else stop(); })
      .catch(() => setError("无法监听手机局域网增量接收事件。"));
    return () => { active = false; unlisten?.(); };
  }, [mobile, deltaPassphrase]);
  useEffect(() => {
    if (!waitingForSyncAck) return;
    const timeout = window.setTimeout(() => setWaitingForSyncAck(false), 5 * 60 * 1000);
    return () => window.clearTimeout(timeout);
  }, [waitingForSyncAck]);
  useEffect(() => {
    if (mobile || !runningInTauri) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<{ deviceId: string; acknowledged: number }>("sync-transfer-acknowledged", (event) => {
      setWaitingForSyncAck(false);
      setNotice(`已收到 ${event.payload.deviceId.slice(0, 8)} 的签名回执，确认 ${event.payload.acknowledged} 条变更。`);
      setError("");
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    }).catch(() => setError("无法监听局域网签名回执；设备仍可通过签名文件完成确认。"));
    return () => { active = false; unlisten?.(); };
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

  async function createBundle() {
    setError(""); setNotice("");
    if (!selectedIds.size && !selectedManagedHostIds.size && !selectedPanelIds.size && !includeDeletions) { setError("至少选择一个配置，或勾选删除记录同步。"); return; }
    if (passphrase.length < 12) { setError("迁移口令至少需要 12 个字符。"); return; }
    if (passphrase !== confirmation) { setError("两次输入的迁移口令不一致。"); return; }
    setBusy(true);
    try {
      const result = await accountsClient.createSyncBundle([...selectedIds], [...selectedManagedHostIds], [...selectedPanelIds], passphrase, includeDeletions);
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `cloudhub-mobile-transfer-${new Date().toISOString().slice(0, 10)}.chsync.json`;
      document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(href), 1000);
      setNotice("加密迁移包已生成。将文件传到手机，并在手机端输入同一迁移口令。");
      setPassphrase(""); setConfirmation("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  async function exportMobileBundle() {
    setError(""); setNotice("");
    if (!selectedIds.size && !selectedManagedHostIds.size && !selectedPanelIds.size && !includeDeletions) { setError("至少选择一个配置，或勾选删除记录同步。"); return; }
    if (exportPassphrase.length < 12) { setError("迁移口令至少需要 12 个字符。"); return; }
    if (exportPassphrase !== exportConfirmation) { setError("两次输入的迁移口令不一致。"); return; }
    setBusy(true);
    try {
      const saved = await accountsClient.saveSyncBundleFile([...selectedIds], [...selectedManagedHostIds], [...selectedPanelIds], exportPassphrase, includeDeletions);
      setNotice(saved ? "已保存加密迁移包。将文件和迁移口令分开保管；换机时在目标设备导入。" : "已取消保存，未导出迁移包。");
      if (saved) { setExportPassphrase(""); setExportConfirmation(""); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function startQrTransfer() {
    setError(""); setNotice(""); setPairingUrl("");
    if (!selectedIds.size && !selectedManagedHostIds.size && !selectedPanelIds.size && !includeDeletions) { setError("至少选择一个配置，或勾选删除记录同步。"); return; }
    if (passphrase.length < 20) { setError("局域网二维码传输请设置至少 20 个字符的高熵口令。"); return; }
    if (passphrase !== confirmation) { setError("两次输入的迁移口令不一致。"); return; }
    setBusy(true);
    try {
      const transfer = await accountsClient.startSyncTransfer([...selectedIds], [...selectedManagedHostIds], [...selectedPanelIds], passphrase, includeDeletions);
      setActiveTransferKind("bundle");
      setPairingUrl(transfer.pairingUrl);
      setPairingSourceDeviceId(transfer.sourceDeviceId);
      setPairingSourceFingerprint(transfer.sourcePublicKeyFingerprint);
      setPassphrase(""); setConfirmation("");
      setNotice("电脑正在等待手机获取加密迁移包。二维码 5 分钟后失效，成功获取一次后自动关闭。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  async function startDeltaQrTransfer() {
    setError(""); setNotice(""); setPairingUrl(""); setWaitingForSyncAck(false);
    if (!syncTargetDeviceId) { setError("请选择已授权的目标手机。"); return; }
    if (deltaPassphrase.length < 20) { setError("局域网增量传输口令至少需要 20 个字符。"); return; }
    setBusy(true);
    try {
      const transfer = await accountsClient.startSyncDeltaTransfer(syncTargetDeviceId, deltaPassphrase);
      setActiveTransferKind("delta");
      setPairingUrl(transfer.pairingUrl); setPairingSourceDeviceId(transfer.sourceDeviceId); setPairingSourceFingerprint(transfer.sourcePublicKeyFingerprint);
      setDeltaPassphrase(""); setNotice("电脑正在等待指定手机接收签名增量。二维码 5 分钟后失效，且每次传输都需在电脑端批准。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function startDeltaReceiver() {
    setError(""); setNotice(""); setPairingUrl("");
    if (deltaPassphrase.length < 20) { setError("先设置 20 位以上随机高熵增量口令，并在手机端输入同一口令。"); return; }
    setBusy(true);
    try {
      const transfer = await accountsClient.startSyncDeltaReceiver();
      setActiveTransferKind("deltaReceive"); setPairingUrl(transfer.pairingUrl);
      setPairingSourceDeviceId(transfer.sourceDeviceId); setPairingSourceFingerprint(transfer.sourcePublicKeyFingerprint);
      setNotice("桌面正在等待已授权手机推送。二维码 5 分钟后失效，每次请求都需在桌面批准。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法开启手机增量接收服务"); }
    finally { setBusy(false); }
  }

  async function cancelQrTransfer() {
    setBusy(true);
    try { await accountsClient.cancelSyncTransfer(); setPairingUrl(""); setPendingClientAddress(""); setWaitingForSyncAck(false); setActiveTransferKind(""); setNotice("局域网传输已关闭，未批准的请求不会收到数据。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function decideQrRequest(approved: boolean) {
    setBusy(true); setError("");
    try {
      const transferKind = activeTransferKind;
      await accountsClient.approveSyncTransfer(approved);
      setPendingClientAddress(""); setPendingDeviceIdentity(""); setPairingUrl("");
      setWaitingForSyncAck(approved && transferKind === "delta");
      setActiveTransferKind("");
      if (approved) setTrustedDevices(await accountsClient.listSyncDevices());
      setNotice(approved ? transferKind === "delta" ? "已批准本次传输。手机应用签名增量后会自动回传回执；临时会话最多保留 5 分钟。" : transferKind === "deltaReceive" ? "已批准手机推送；桌面正在接收加密增量，随后仍需验证口令并确认应用。" : "已批准本次迁移，密文已发送；局域网会话随即关闭。" : "已拒绝迁移请求，未发送任何数据。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function revokeDevice(device: SyncTrustedDevice) {
    if (!window.confirm(`撤销“${device.deviceName}”的同步授权？该设备之后不能再从本机获取同步数据。`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await accountsClient.revokeSyncDevice(device.deviceId);
      setTrustedDevices(await accountsClient.listSyncDevices());
      setNotice(`已撤销设备 ${device.deviceName} 的授权。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function scanComputerQr() {
    setError(""); setNotice(""); setPreview(null); setEnvelope(null);
    if (passphrase.length < 12) { setError("先输入电脑端设置的迁移口令，再扫描二维码。"); return; }
    setBusy(true);
    try {
      const random = new Uint32Array(1);
      crypto.getRandomValues(random);
      const code = String(random[0] % 1_000_000).padStart(6, "0");
      setPairingCode(code);
      const result = await scan({ windowed: false, formats: [Format.QRCode] });
      setNotice("已向电脑发起申请，请核对两台设备显示的相同校验码，并在电脑端批准。批准前不会发送配置。");
      const received = await accountsClient.fetchSyncTransfer(result.content, code);
      setEnvelope(received.envelope);
      setPairingSourceDeviceId(received.sourceDeviceId);
      setPairingSourceFingerprint(received.sourcePublicKeyFingerprint);
      const devices = await accountsClient.listSyncDevices();
      setTrustedDevices(devices);
      setSyncTargetDeviceId(received.sourceDeviceId);
      const previewResult = await accountsClient.previewSyncBundle(received.envelope, passphrase);
      setPreview(previewResult);
      setNotice(`已安全接收并登记电脑身份 ${received.sourceDeviceId}（指纹 ${received.sourcePublicKeyFingerprint}）。请与电脑端二维码显示的身份核对，再检查配置清单并确认导入。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "扫码或接收失败，请确认电脑仍在等待且两台设备处于同一局域网。");
    } finally { setBusy(false); setPairingCode(""); }
  }

  async function scanComputerDeltaQr() {
    setError(""); setNotice(""); setDeltaReview(null); setDeltaEnvelope(null);
    if (deltaPassphrase.length < 20) { setError("先输入电脑端设置的 20 位以上高熵增量口令，再扫描二维码。"); return; }
    setBusy(true);
    try {
      const random = new Uint32Array(1); crypto.getRandomValues(random);
      const code = String(random[0] % 1_000_000).padStart(6, "0"); setPairingCode(code);
      const result = await scan({ windowed: false, formats: [Format.QRCode] });
      setNotice("已向电脑发起增量接收申请。请核对两台设备显示的相同校验码，并在电脑端批准。");
      const received = await accountsClient.fetchSyncTransfer(result.content, code);
      const review = await accountsClient.previewSyncDeltaBundle(received.envelope, deltaPassphrase);
      const identity = await accountsClient.getSyncDeviceIdentity();
      if (review.targetDeviceId !== identity.deviceId) throw new Error("此增量包并非发给本机，已拒绝应用。");
      setDeltaEnvelope(received.envelope); setDeltaReview(review); setDeltaConflictChoices({});
      setDeltaPairingUrl(result.content);
      setPairingSourceDeviceId(received.sourceDeviceId); setPairingSourceFingerprint(received.sourcePublicKeyFingerprint);
      const devices = await accountsClient.listSyncDevices(); setTrustedDevices(devices); setSyncTargetDeviceId(received.sourceDeviceId);
      setNotice(`已安全接收并验证来源设备签名（${received.sourcePublicKeyFingerprint}）。检查变更与冲突后再确认应用。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "扫码或接收失败，请确认两台设备处于同一局域网且电脑仍在等待。"); }
    finally { setBusy(false); setPairingCode(""); }
  }

  async function scanDesktopDeltaReceiverQr() {
    setError(""); setNotice("");
    if (!syncTargetDeviceId) { setError("请选择已授权的电脑；首次连接请先完成扫码配对。"); return; }
    if (deltaPassphrase.length < 20) { setError("先输入电脑端约定的 20 位以上高熵增量口令。"); return; }
    setBusy(true);
    try {
      const random = new Uint32Array(1); crypto.getRandomValues(random);
      const code = String(random[0] % 1_000_000).padStart(6, "0"); setPairingCode(code);
      const result = await scan({ windowed: false, formats: [Format.QRCode] });
      const envelope = await accountsClient.createSyncDeltaBundle(syncTargetDeviceId, 0, 100, deltaPassphrase);
      setNotice(`请求校验码 ${code}。请在桌面核对设备指纹与此号码并批准；批准后手机会推送加密增量。`);
      const acknowledged = await accountsClient.sendSyncDeltaBundleLan(result.content, code, deltaPassphrase, envelope);
      setNotice(`桌面已应用增量并返回有效签名回执，手机确认了 ${acknowledged} 条变更。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "扫码或局域网推送失败，请确认桌面仍在等待且两台设备处于同一局域网。"); }
    finally { setBusy(false); setPairingCode(""); }
  }

  async function previewReceivedDelta() {
    if (!deltaEnvelope) return;
    if (deltaPassphrase.length < 20) { setError("请输入发送端设置的 20 位以上高熵增量口令。"); return; }
    setBusy(true); setError("");
    try {
      const review = await accountsClient.previewSyncDeltaBundle(deltaEnvelope, deltaPassphrase);
      setDeltaReview(review); setDeltaConflictChoices({});
      setNotice(`已验证设备签名 · ${review.changeCount} 条变更。检查冲突后再确认应用。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法验证收到的增量"); }
    finally { setBusy(false); }
  }

  async function readBundle(file?: File) {
    setError(""); setNotice(""); setPreview(null); setEnvelope(null);
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { setError("迁移包超过 15 MB，已拒绝读取。"); return; }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isEnvelope(parsed)) throw new Error("文件格式不受支持，请选择 CloudHub 加密迁移包。");
      setEnvelope(parsed);
      const importPassword = mobile ? passphrase : desktopImportPassphrase;
      if (importPassword.length < 12) { setError("先输入生成迁移包时使用的口令（至少 12 个字符）。"); return; }
      setBusy(true);
      const result = await accountsClient.previewSyncBundle(parsed, importPassword);
      setPreview(result);
    } catch (cause) {
      setEnvelope(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function confirmImport() {
    if (!envelope || !preview) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const imported = await accountsClient.importSyncBundle(envelope, mobile ? passphrase : desktopImportPassphrase);
      setNotice(`同步完成：新增 ${imported.added} 项，更新 ${imported.updated} 项（云账号 ${imported.accounts}、主机 ${imported.managedHosts}、面板 ${imported.panels}）。`);
      setEnvelope(null); setPreview(null); setPassphrase(""); setDesktopImportPassphrase(""); onImported?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  async function exportDelta() {
    setError(""); setNotice("");
    if (!syncTargetDeviceId) { setError("请选择已授权的目标设备。"); return; }
    if (deltaPassphrase.length < 20) { setError("增量同步口令至少需要 20 个字符，请使用随机高熵口令。"); return; }
    setBusy(true);
    try {
      if (mobile) {
        const saved = await accountsClient.saveSyncDeltaBundleFile(syncTargetDeviceId, 0, 100, deltaPassphrase);
        setNotice(saved ? "手机已保存签名并加密的增量文件。请将文件和口令分开传给电脑；电脑应用后会返回签名回执。" : "已取消保存，未导出增量文件。");
        if (saved) setDeltaPassphrase("");
      } else {
        const result = await accountsClient.createSyncDeltaBundle(syncTargetDeviceId, 0, 100, deltaPassphrase);
        downloadJson(`cloudhub-delta-${new Date().toISOString().slice(0, 10)}.chdelta.json`, result);
        setNotice("已生成签名并加密的增量包。请将文件和口令分开传到目标设备；收到回执后再导入回执文件确认本批消息。");
        setDeltaPassphrase("");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function authorizeMobileShareScope() {
    setError(""); setNotice("");
    if (!syncTargetDeviceId) { setError("请选择已信任的电脑设备。首次连接请先扫码完成配对。 "); return; }
    if (!selectedIds.size && !selectedManagedHostIds.size && !selectedPanelIds.size && !includeDeletions) { setError("至少选择一项要允许同步到电脑的配置。"); return; }
    setBusy(true);
    try {
      const count = await accountsClient.setSyncDeviceShareScope(syncTargetDeviceId, [...selectedIds], [...selectedManagedHostIds], [...selectedPanelIds], includeDeletions);
      setNotice(`已授权向所选电脑共享 ${count} 项配置。接下来可生成手机签名增量文件；本次授权可随时在任一设备撤销。`);
      setTrustedDevices(await accountsClient.listSyncDevices());
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function readDelta(file?: File) {
    setError(""); setNotice(""); setDeltaReview(null); setDeltaEnvelope(null); setDeltaEnvelopeFromLan(false); setDeltaConflictChoices({}); setDeltaPairingUrl("");
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { setError("增量包超过 15 MB，已拒绝读取。"); return; }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isEnvelope(parsed)) throw new Error("文件格式不受支持，请选择 CloudHub 增量同步包。");
      if (deltaPassphrase.length < 20) { setError("先输入生成增量包时使用的 20 位以上高熵口令。"); return; }
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
      if (!mobile && deltaEnvelopeFromLan) {
        try {
          await accountsClient.completeSyncDeltaPush(acknowledgement);
          acknowledgementSaved = true;
          acknowledgementSentOverLan = true;
        } catch { /* The delta was committed; keep the signed receipt as a file fallback if its LAN session expired. */ }
      }
      if (mobile && runningInTauri && deltaPairingUrl) {
        try {
          await accountsClient.sendSyncDeltaAckLan(deltaPairingUrl, acknowledgement);
          acknowledgementSaved = true;
          acknowledgementSentOverLan = true;
        } catch { /* The signed acknowledgement remains durable and can use the file fallback below. */ }
      }
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
      setDeltaPairingUrl("");
      setDeltaEnvelope(null); setDeltaEnvelopeFromLan(false); setDeltaReview(null); setDeltaPassphrase(""); onImported?.();
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

  async function importAcknowledgement(file?: File) {
    setError(""); setNotice("");
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error("签名回执文件过大。");
      const parsed: unknown = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== "object") throw new Error("签名回执格式无效。");
      const value = parsed as Record<string, unknown>;
      if (typeof value.receiverDeviceId !== "string" || typeof value.signature !== "string" || !Array.isArray(value.messageIds)
          || value.messageIds.length < 1 || value.messageIds.length > 100 || !value.messageIds.every((id) => typeof id === "string")) {
        throw new Error("签名回执字段不完整。");
      }
      setBusy(true);
      const count = await accountsClient.acknowledgeSyncDelta(value.receiverDeviceId, value.messageIds as string[], value.signature);
      setNotice(`已验证目标设备签名并确认 ${count} 条同步消息。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); if (acknowledgementInput.current) acknowledgementInput.current.value = ""; }
  }

  return <section ref={panelRef} tabIndex={mobile ? undefined : -1} role={mobile ? undefined : "dialog"} aria-modal={mobile ? undefined : true} onKeyDown={handleDialogKeyDown} className={`sync-transfer-panel ${mobile ? "sync-transfer-mobile" : "sync-transfer-desktop"}`} aria-labelledby="sync-transfer-title">
    <header className="sync-transfer-heading">
      <div className="sync-transfer-icon"><FileLock2 size={19} aria-hidden="true" /></div>
      <div><p>跨设备迁移</p><h2 id="sync-transfer-title">{mobile ? "导入电脑数据" : "生成手机迁移包"}</h2></div>
      {onClose && <button type="button" className="sync-transfer-close" aria-label={mobile ? "返回更多管理" : "关闭迁移面板"} onClick={onClose}><X size={18} /></button>}
    </header>

    {mobile ? <>
      <p className="sync-transfer-intro">迁移包使用独立口令加密。导入前可预览配置并检查冲突；导出时凭据只在 Rust 原生层解密和封装，文件不含明文凭据。</p>
      <div className="sync-transfer-mobile-export">
        <h3>导出本机配置</h3>
        <p>选择要迁移到其他设备的配置。云凭据、SSH 密码/私钥和面板密钥会一起加密。</p>
        <div className="sync-transfer-selection-head"><strong>云账号（{selectedCount}/{accounts.length}）</strong><button type="button" onClick={() => setSelectedIds(selectedIds.size === accounts.length ? new Set() : new Set(accounts.map((account) => account.id)))}>{selectedIds.size === accounts.length && accounts.length ? "清空" : "全选"}</button></div>
        <div className="sync-transfer-account-list">{accounts.map((account) => <label key={account.id} className="sync-transfer-account"><input type="checkbox" checked={selectedIds.has(account.id)} onChange={() => setSelectedIds((current) => { const next = new Set(current); if (next.has(account.id)) next.delete(account.id); else next.add(account.id); return next; })} /><span><strong>{account.account_name}</strong><small>{account.cloud_type}{account.region_id ? ` · ${account.region_id}` : ""}</small></span></label>)}</div>
        <div className="sync-transfer-selection-head"><strong>SSH 主机（{selectedManagedHostCount}/{transferableHosts.length}）</strong><button type="button" onClick={() => setSelectedManagedHostIds(selectedManagedHostIds.size === transferableHosts.length ? new Set() : new Set(transferableHosts.map((host) => host.id)))}>{selectedManagedHostIds.size === transferableHosts.length && transferableHosts.length ? "清空" : "全选"}</button></div>
        <div className="sync-transfer-account-list">{transferableHosts.map((host) => <label key={host.id} className="sync-transfer-account"><input type="checkbox" checked={selectedManagedHostIds.has(host.id)} onChange={() => setSelectedManagedHostIds((current) => { const next = new Set(current); if (next.has(host.id)) next.delete(host.id); else next.add(host.id); return next; })} /><span><strong>{host.name}</strong><small>{host.username}@{host.host}:{host.port}</small></span></label>)}</div>
        <div className="sync-transfer-selection-head"><strong>面板（{selectedPanelCount}/{transferablePanels.length}）</strong><button type="button" onClick={() => setSelectedPanelIds(selectedPanelIds.size === transferablePanels.length ? new Set() : new Set(transferablePanels.map((panel) => panel.id)))}>{selectedPanelIds.size === transferablePanels.length && transferablePanels.length ? "清空" : "全选"}</button></div>
        <div className="sync-transfer-account-list">{transferablePanels.map((panel) => <label key={panel.id} className="sync-transfer-account"><input type="checkbox" checked={selectedPanelIds.has(panel.id)} onChange={() => setSelectedPanelIds((current) => { const next = new Set(current); if (next.has(panel.id)) next.delete(panel.id); else next.add(panel.id); return next; })} /><span><strong>{panel.name}</strong><small>{panel.panel_url}</small></span></label>)}</div>
        <label className="sync-transfer-deletions"><input type="checkbox" checked={includeDeletions} onChange={(event) => setIncludeDeletions(event.target.checked)} /><span><strong>包含源设备删除记录</strong><small>接收端会先列出将删除的配置；只有确认导入后才执行。历史包重放也可能再次删除同一配置。</small></span></label>
        <label className="sync-transfer-field">设置迁移口令<input type="password" value={exportPassphrase} minLength={12} maxLength={1024} autoComplete="new-password" onChange={(event) => setExportPassphrase(event.target.value)} placeholder="至少 12 个字符" /></label>
        <label className="sync-transfer-field">再次输入迁移口令<input type="password" value={exportConfirmation} minLength={12} maxLength={1024} autoComplete="new-password" onChange={(event) => setExportConfirmation(event.target.value)} placeholder="请再次输入" /></label>
        <button className="sync-transfer-primary" type="button" disabled={busy || !runningInTauri || (!accounts.length && !transferableHosts.length && !transferablePanels.length && !includeDeletions)} onClick={() => void exportMobileBundle()}><Download size={17} aria-hidden="true" />{busy ? "正在加密并保存…" : runningInTauri ? "导出加密迁移文件" : "请在手机 App 中导出"}</button>
      </div>
      <h3 className="sync-transfer-mobile-import-title">导入其他设备配置</h3>
      <label className="sync-transfer-field">迁移口令
        <input type="password" value={passphrase} minLength={12} maxLength={1024} autoComplete="current-password" onChange={(event) => setPassphrase(event.target.value)} placeholder="输入电脑端设置的迁移口令" />
      </label>
      {runningInTauri && <button className="sync-transfer-primary" type="button" disabled={busy} onClick={() => void scanComputerQr()}><Upload size={17} aria-hidden="true" />{busy ? "正在连接电脑…" : "扫描电脑二维码并接收"}</button>}
      <label className="sync-transfer-file">
        <Upload size={17} aria-hidden="true" /><span>选择电脑生成的 .chsync.json 文件</span>
        <input ref={fileInput} type="file" accept=".json,.chsync.json,application/json" onChange={(event) => void readBundle(event.currentTarget.files?.[0])} disabled={busy} />
      </label>
      {busy && <p className="sync-transfer-status" role="status">{pairingCode ? <>本次请求校验码：<strong>{pairingCode}</strong>。请核对电脑显示相同号码后再批准。</> : "正在扫码、连接电脑或验证迁移包…"}</p>}
      <section className="sync-transfer-devices" aria-labelledby="sync-mobile-send-title">
        <h3 id="sync-mobile-send-title">授权并发送手机配置到电脑</h3>
        <p>首次扫码接收电脑数据后，手机已保存该电脑的公钥身份。选择目标电脑和允许共享的本机配置；之后手机可独立管理云资源，并按需生成签名增量包发回电脑。</p>
        <label className="sync-transfer-field">已信任的目标电脑<select value={syncTargetDeviceId} onChange={(event) => setSyncTargetDeviceId(event.target.value)} disabled={busy}><option value="">选择电脑</option>{trustedDevices.filter((device) => device.status === "trusted").map((device) => <option key={device.deviceId} value={device.deviceId}>{device.deviceName} · {device.publicKeyFingerprint}</option>)}</select></label>
        {!trustedDevices.some((device) => device.status === "trusted") && <p>尚无可信电脑。请先通过“扫描电脑二维码并接收”完成首次配对。</p>}
        <p>下面所选账号、主机和面板将作为本机共享范围；选择不会向电脑立即发送数据。</p>
        <button className="sync-transfer-primary sync-transfer-secondary" type="button" disabled={busy || !runningInTauri || !syncTargetDeviceId} onClick={() => void authorizeMobileShareScope()}><ShieldCheck size={17} aria-hidden="true" />{busy ? "正在保存授权范围…" : "授权所选配置并更新共享范围"}</button>
        {syncTargetDeviceId && <small>当前目标的已授权范围：{trustedDevices.find((device) => device.deviceId === syncTargetDeviceId)?.sharedEntities.length ?? 0} 项。为安全起见，每次重新选择后显式提交授权范围。</small>}
        <label className="sync-transfer-field">增量同步口令<input type="password" value={deltaPassphrase} minLength={20} maxLength={1024} autoComplete="new-password" onChange={(event) => setDeltaPassphrase(event.target.value)} placeholder="至少 20 个字符的随机高熵口令" /></label>
        <button className="sync-transfer-primary sync-transfer-secondary" type="button" disabled={busy || !runningInTauri || deltaPassphrase.length < 20} onClick={() => void scanComputerDeltaQr()}><Upload size={17} aria-hidden="true" />{busy ? "正在接收…" : "扫描电脑二维码接收增量"}</button>
        <button className="sync-transfer-primary sync-transfer-secondary" type="button" disabled={busy || !runningInTauri || !syncTargetDeviceId || deltaPassphrase.length < 20 || !(trustedDevices.find((device) => device.deviceId === syncTargetDeviceId)?.sharedEntities.length)} onClick={() => void scanDesktopDeltaReceiverQr()}><Upload size={17} aria-hidden="true" />{busy ? "正在推送…" : "扫描桌面接收码并推送增量"}</button>
        <button className="sync-transfer-primary sync-transfer-secondary" type="button" disabled={busy || !runningInTauri || !syncTargetDeviceId || deltaPassphrase.length < 20 || !(trustedDevices.find((device) => device.deviceId === syncTargetDeviceId)?.sharedEntities.length)} onClick={() => void exportDelta()}><Download size={17} aria-hidden="true" />{busy ? "正在签名并加密…" : "生成手机签名增量文件"}</button>
        <p>电脑应用增量后会生成签名回执；导入回执才能确认本机待发送记录。</p>
        <label className="sync-transfer-file"><Upload size={17} aria-hidden="true" /><span>导入电脑签名回执</span><input ref={acknowledgementInput} type="file" accept=".chack.json,.json,application/json" onChange={(event) => void importAcknowledgement(event.currentTarget.files?.[0])} disabled={busy} /></label>
      </section>
    </> : <>
      <p className="sync-transfer-intro">选择要迁移的配置并设置独立口令。可导出加密文件，或由电脑短时显示一次性二维码供同一局域网的手机接收。二维码传输的口令至少 20 个字符；口令不会进入二维码或网络请求。</p>
      <div className="sync-transfer-selection-head"><strong>选择云账号（{selectedCount}/{accounts.length}）</strong><button type="button" onClick={() => setSelectedIds(allSelected ? new Set() : new Set(accounts.map((account) => account.id)))}>{allSelected ? "清空" : "全选"}</button></div>
      <div className="sync-transfer-account-list">{accounts.map((account) => <label key={account.id} className="sync-transfer-account">
        <input type="checkbox" checked={selectedIds.has(account.id)} onChange={() => setSelectedIds((current) => { const next = new Set(current); if (next.has(account.id)) next.delete(account.id); else next.add(account.id); return next; })} />
        <span><strong>{account.account_name}</strong><small>{account.cloud_type}{account.region_id ? ` · ${account.region_id}` : ""}</small></span>
      </label>)}</div>
      <div className="sync-transfer-selection-head"><strong>选择 SSH 主机（{selectedManagedHostCount}/{transferableHosts.length}）</strong><button type="button" onClick={() => setSelectedManagedHostIds(allHostsSelected ? new Set() : new Set(transferableHosts.map((host) => host.id)))}>{allHostsSelected ? "清空" : "全选"}</button></div>
      <div className="sync-transfer-account-list">{transferableHosts.map((host) => <label key={host.id} className="sync-transfer-account">
        <input type="checkbox" checked={selectedManagedHostIds.has(host.id)} onChange={() => setSelectedManagedHostIds((current) => { const next = new Set(current); if (next.has(host.id)) next.delete(host.id); else next.add(host.id); return next; })} />
        <span><strong>{host.name}</strong><small>{host.username}@{host.host}:{host.port} · {host.auth_method === "private_key" ? "SSH 私钥" : "SSH 密码"}</small></span>
      </label>)}</div>
      <div className="sync-transfer-selection-head"><strong>选择面板（{selectedPanelCount}/{transferablePanels.length}）</strong><button type="button" onClick={() => setSelectedPanelIds(allPanelsSelected ? new Set() : new Set(transferablePanels.map((panel) => panel.id)))}>{allPanelsSelected ? "清空" : "全选"}</button></div>
      <div className="sync-transfer-account-list">{transferablePanels.map((panel) => <label key={panel.id} className="sync-transfer-account">
        <input type="checkbox" checked={selectedPanelIds.has(panel.id)} onChange={() => setSelectedPanelIds((current) => { const next = new Set(current); if (next.has(panel.id)) next.delete(panel.id); else next.add(panel.id); return next; })} />
        <span><strong>{panel.name}</strong><small>{panel.panel_url}</small></span>
      </label>)}</div>
      <label className="sync-transfer-deletions"><input type="checkbox" checked={includeDeletions} onChange={(event) => setIncludeDeletions(event.target.checked)} /><span><strong>包含源设备删除记录</strong><small>接收端会先列出将删除的配置；只有确认导入后才执行。历史包重放也可能再次删除同一配置。</small></span></label>
      <label className="sync-transfer-field">设置迁移口令
        <input type="password" value={passphrase} minLength={12} maxLength={1024} autoComplete="new-password" onChange={(event) => setPassphrase(event.target.value)} placeholder="文件迁移至少 12 字符；二维码传输至少 20 字符" />
      </label>
      <label className="sync-transfer-field">再次输入迁移口令
        <input type="password" value={confirmation} minLength={12} maxLength={1024} autoComplete="new-password" onChange={(event) => setConfirmation(event.target.value)} placeholder="二维码传输建议至少 20 个字符" />
      </label>
      <button className="sync-transfer-primary" type="button" disabled={busy || (!accounts.length && !transferableHosts.length && !transferablePanels.length && !includeDeletions)} onClick={() => void createBundle()}><Download size={17} aria-hidden="true" />{busy ? "正在生成…" : "生成加密迁移文件"}</button>
      <button className="sync-transfer-primary sync-transfer-secondary" type="button" disabled={busy || !runningInTauri || !approvalListenerReady || !!pendingClientAddress || (!selectedIds.size && !selectedManagedHostIds.size && !selectedPanelIds.size && !includeDeletions)} onClick={() => void startQrTransfer()}><ShieldCheck size={17} aria-hidden="true" />{busy ? "正在开启…" : !approvalListenerReady ? "正在准备授权…" : "在局域网显示手机配对二维码"}</button>
      {pairingUrl && <div className="sync-transfer-pairing"><QRCodeSVG value={pairingUrl} size={220} level="M" title="一次性局域网迁移二维码" /><p>电脑身份：<code>{pairingSourceDeviceId}</code><br />公钥指纹：<code>{pairingSourceFingerprint}</code></p><p>{activeTransferKind === "deltaReceive" ? "手机扫码后会发送签名并加密的增量请求。电脑批准前不读取增量正文；批准后仍需使用两端约定口令验证并手动确认应用。" : "手机扫码只会发起申请。电脑确认批准后才会发送密文；口令不会进入网络请求。手机也会登记二维码中的电脑身份，请在两台设备核对指纹。"}</p>{pendingClientAddress && <div className="sync-transfer-approval" role="alert"><strong>{activeTransferKind === "deltaReceive" ? "手机请求推送增量" : "手机请求接收配置"}</strong><span>局域网地址：{pendingClientAddress}</span><span>设备身份：<code>{pendingDeviceIdentity}</code></span><span>请求校验码：<strong>{pendingVerificationCode}</strong></span><small>设备使用本机同步密钥证明身份。请核对手机显示的校验码和设备指纹，再确认请求来自你手上的设备。</small><div><button type="button" disabled={busy} onClick={() => void decideQrRequest(false)}>拒绝</button><button type="button" disabled={busy} onClick={() => void decideQrRequest(true)}>{activeTransferKind === "deltaReceive" ? "批准并接收" : "批准并发送"}</button></div></div>}<button type="button" disabled={busy} onClick={() => void cancelQrTransfer()}>立即关闭传输</button></div>}
      {waitingForSyncAck && <div className="sync-transfer-status" role="status"><strong>等待手机应用增量并回传签名回执</strong><p>授权会话最多保留 5 分钟。若手机离线或自动回执失败，可关闭会话后继续用签名文件回传。</p><button type="button" disabled={busy} onClick={() => void cancelQrTransfer()}>关闭回执会话</button></div>}
      <h3 className="sync-transfer-mobile-import-title">导入手机或其他设备的迁移包</h3>
      <p className="sync-transfer-intro">选择加密 `.chsync.json` 文件并输入其独立口令；解密预览不会展示任何凭据。</p>
      <label className="sync-transfer-field">迁移口令<input type="password" value={desktopImportPassphrase} minLength={12} maxLength={1024} autoComplete="current-password" onChange={(event) => setDesktopImportPassphrase(event.target.value)} placeholder="输入导出时设置的口令" /></label>
      <label className="sync-transfer-file"><Upload size={17} aria-hidden="true" /><span>选择加密 .chsync.json 文件</span><input ref={fileInput} type="file" accept=".json,.chsync.json,application/json" onChange={(event) => void readBundle(event.currentTarget.files?.[0])} disabled={busy} /></label>
      {busy && <p className="sync-transfer-status" role="status">正在读取并验证加密迁移包…</p>}
      <section className="sync-transfer-devices" aria-labelledby="sync-delta-title">
        <h3 id="sync-delta-title">向已授权手机发送增量</h3>
        <p>只包含目标手机共享范围内尚未确认的变更。请把加密包与口令分开传输；手机应用成功后会生成签名回执。</p>
        <label className="sync-transfer-field">目标设备<select value={syncTargetDeviceId} onChange={(event) => setSyncTargetDeviceId(event.target.value)} disabled={busy}><option value="">选择已授权设备</option>{trustedDevices.filter((device) => device.status === "trusted").map((device) => <option key={device.deviceId} value={device.deviceId}>{device.deviceName} · {device.publicKeyFingerprint}</option>)}</select></label>
        {syncTargetDeviceId && <small>该设备可接收 {trustedDevices.find((device) => device.deviceId === syncTargetDeviceId)?.sharedEntities.length ?? 0} 项已授权配置。</small>}
        <label className="sync-transfer-field">增量同步口令<input type="password" value={deltaPassphrase} minLength={20} maxLength={1024} autoComplete="new-password" onChange={(event) => setDeltaPassphrase(event.target.value)} placeholder="至少 20 个字符的随机高熵口令" /></label>
        <button className="sync-transfer-primary sync-transfer-secondary" type="button" disabled={busy || !runningInTauri || !syncTargetDeviceId || deltaPassphrase.length < 20} onClick={() => void exportDelta()}><Download size={17} aria-hidden="true" />{busy ? "正在签名并加密…" : "生成签名增量文件"}</button>
        <button className="sync-transfer-primary sync-transfer-secondary" type="button" disabled={busy || !runningInTauri || !approvalListenerReady || !!pendingClientAddress || !syncTargetDeviceId || deltaPassphrase.length < 20} onClick={() => void startDeltaQrTransfer()}><Upload size={17} aria-hidden="true" />{busy ? "正在开启…" : "局域网发送增量到所选手机"}</button>
        <button className="sync-transfer-primary sync-transfer-secondary" type="button" disabled={busy || !runningInTauri || !approvalListenerReady || !!pendingClientAddress || deltaPassphrase.length < 20} onClick={() => void startDeltaReceiver()}><ShieldCheck size={17} aria-hidden="true" />{busy ? "正在开启…" : "显示手机增量接收码"}</button>
        <h3 className="sync-transfer-mobile-import-title">确认手机签名回执</h3>
        <p>手机成功应用后，把下载的 `.chack.json` 回执传回电脑。只有签名有效且消息仍在共享范围内时才会确认 outbox。</p>
        <label className="sync-transfer-file"><Upload size={17} aria-hidden="true" /><span>导入手机签名回执</span><input ref={acknowledgementInput} type="file" accept=".chack.json,.json,application/json" onChange={(event) => void importAcknowledgement(event.currentTarget.files?.[0])} disabled={busy} /></label>
      </section>
      <section className="sync-transfer-devices" aria-labelledby="sync-devices-title"><div><h3 id="sync-devices-title">已授权设备</h3><button type="button" disabled={busy || !runningInTauri} onClick={() => void accountsClient.listSyncDevices().then(setTrustedDevices).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}>刷新</button></div>{trustedDevices.length === 0 ? <p>尚无已授权设备。首次扫码并批准手机请求后，设备会显示在这里。</p> : <ul>{trustedDevices.map((device) => <li key={device.deviceId}><div className="sync-transfer-device-info"><strong>{device.deviceName}</strong><small>{device.status === "trusted" ? "已授权" : device.status === "pending" ? "待授权" : "已撤销"} · 指纹 {device.publicKeyFingerprint}</small><small>{device.deviceId}</small><details className="sync-transfer-device-scope"><summary>共享范围（{device.sharedEntities.length} 项）</summary>{device.sharedEntities.length === 0 ? <small>当前没有共享配置</small> : <ul>{device.sharedEntities.map((entity) => <li key={`${entity.entityType}:${entity.entitySyncId}`}><span>{entity.displayName}</span><small>{entity.entityType} · {entity.entitySyncId}</small></li>)}</ul>}</details></div>{device.status === "trusted" && <button type="button" disabled={busy} onClick={() => void revokeDevice(device)}>撤销</button>}</li>)}</ul>}</section>
    </>}
    {runningInTauri && <section className="sync-transfer-devices" aria-labelledby="sync-delta-receive-title">
      <h3 id="sync-delta-receive-title">接收并应用签名增量</h3>
      <p>{mobile ? "选择电脑生成的签名增量文件。手机会验证来源设备签名和本机冲突；确认后原子应用，并通过系统文件保存器生成回传电脑的签名回执。" : "选择手机或其他已授权设备生成的签名增量文件。桌面会验证设备签名和冲突；确认后原子应用并生成签名回执，发送设备导入回执后才会清除待发记录。"}</p>
      <label className="sync-transfer-field">增量同步口令<input type="password" value={deltaPassphrase} minLength={20} maxLength={1024} autoComplete="current-password" onChange={(event) => setDeltaPassphrase(event.target.value)} placeholder="输入发送端设置的 20 位以上高熵口令" /></label>
      <label className="sync-transfer-file"><Upload size={17} aria-hidden="true" /><span>选择 .chdelta.json 增量文件</span><input ref={deltaInput} type="file" accept=".chdelta.json,.json,application/json" onChange={(event) => void readDelta(event.currentTarget.files?.[0])} disabled={busy} /></label>
      {deltaEnvelope && !deltaReview && <button className="sync-transfer-primary" type="button" disabled={busy || deltaPassphrase.length < 20} onClick={() => void previewReceivedDelta()}><ShieldCheck size={17} aria-hidden="true" />{busy ? "正在验证…" : "验证已接收的局域网增量"}</button>}
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
    </section>}
    {preview && <div className="sync-transfer-preview" aria-live="polite">
      <h3>将处理 {preview.accounts.length} 个云账号、{preview.managedHosts.length} 台托管主机、{preview.panels.length} 个面板和 {preview.deletions.length} 条删除记录</h3>
      {!!preview.accounts.length && <ul>{preview.accounts.map((account) => <li key={account.syncId}><strong>{account.accountName}</strong><span>{account.cloudType}{account.regionId ? ` · ${account.regionId}` : ""}</span></li>)}</ul>}
      {!!preview.managedHosts.length && <ul>{preview.managedHosts.map((host) => <li key={host.syncId}><strong>{host.name}</strong><span>{host.username}@{host.host}:{host.port} · {host.authMethod === "private_key" ? "SSH 私钥" : "SSH 密码"}</span></li>)}</ul>}
      {!!preview.panels.length && <ul>{preview.panels.map((panel) => <li key={panel.syncId}><strong>{panel.name}</strong><span>{panel.panelUrl}{panel.allowInsecureTls ? " · 允许不受信任 HTTPS 证书" : ""}</span></li>)}</ul>}
      {!!preview.deletions.length && <div className="sync-transfer-conflicts" role="alert"><strong>确认后将删除 {preview.deletions.filter((item) => item.willDelete).length} 项本机配置</strong><ul>{preview.deletions.map((item) => <li key={`${item.entityType}:${item.syncId}`}><span>{item.name}</span><small>{item.willDelete ? `删除${item.entityType === "cloud_account" ? "云账号" : item.entityType === "managed_host" ? "托管主机" : "面板"}` : "本机已不存在，不会产生变化"}</small></li>)}</ul></div>}
      {!!preview.conflicts.length && <div className="sync-transfer-conflicts" role="alert"><strong>发现 {preview.conflicts.length} 项与本机配置冲突</strong><ul>{preview.conflicts.map((conflict, index) => <li key={`${conflict.entityType}:${conflict.name}:${index}`}><span>{conflict.name}</span><small>{conflict.reason}</small></li>)}</ul></div>}
      <p>{preview.conflicts.length ? "请先取消同步并处理这些不同身份的凭据或地址冲突，再重新选择文件。" : `确认后按稳定 ID 新增或更新配置；已有配置会以此文件内容覆盖${preview.deletions.length ? "，并执行上面列出的删除" : ""}。如果两台设备都修改过，请先确认要保留的版本。SSH 指纹不会迁移，主机端点变化后需要重新确认。`}</p>
      <button className="sync-transfer-primary" type="button" disabled={busy || preview.conflicts.length > 0} onClick={() => void confirmImport()}><ShieldCheck size={17} aria-hidden="true" />{busy ? "同步中…" : "确认并同步配置"}</button>
    </div>}
    {error && <p className="sync-transfer-error" role="alert">{error}</p>}
    {notice && <p className="sync-transfer-status" role="status">{notice}</p>}
    <div className="sync-transfer-safety"><LockKeyhole size={15} aria-hidden="true" /><span>秘密只在原生层解密/加密；请勿把迁移文件和口令放在同一位置。</span></div>
  </section>;
}
