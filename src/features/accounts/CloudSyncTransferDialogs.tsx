import { useRef, useState } from "react";
import { FileWarning } from "lucide-react";
import { cloudSyncClient, type CloudSyncImportStaging, type CloudSyncImportSummary, type CloudSyncView } from "../../platform/clients/cloudSync";
import { runningInTauri } from "../../platform/api";
import { SharedDialog } from "../../shared/SharedDialog";

const methodLabel = (method: string) => method === "oss" ? "阿里云 OSS" : method === "s3" ? "S3" : "WebDAV";
const credentialText = (channel: { hasPassword: boolean; hasSecretKey: boolean; hasBackupPassword: boolean }) => {
  const parts = [channel.hasPassword ? "密码" : "", channel.hasSecretKey ? "访问密钥" : "", channel.hasBackupPassword ? "备份密码" : ""].filter(Boolean);
  return parts.length ? `含${parts.join("、")}` : "无凭据";
};

/** 明文导出所选云同步渠道；桌面端经保存对话框写文件，浏览器预览走本地下载。 */
export function CloudSyncChannelExportDialog({ channels, onClose, onStatus }: {
  channels: CloudSyncView[];
  onClose: () => void;
  onStatus: (message: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>(() => channels.map(channel => channel.config.id ?? "default"));
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function toggle(id: string, checked: boolean) {
    setSelected(current => checked ? [...new Set([...current, id])] : current.filter(item => item !== id));
  }
  async function submit() {
    if (busy || !accepted || !selected.length) return;
    setBusy(true); setError("");
    try {
      const result = await cloudSyncClient.exportChannels(selected);
      if (result.path) {
        onStatus(`云同步渠道已导出为明文 JSON（${result.path}），包含账号密码和访问密钥，请妥善保管。`);
        onClose();
        return;
      }
      if (result.content) {
        const anchor = document.createElement("a");
        anchor.href = URL.createObjectURL(new Blob([result.content], { type: "application/json" }));
        anchor.download = `cloudhub-cloud-sync-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(anchor.href);
        onStatus("云同步渠道已导出为明文 JSON，包含账号密码和访问密钥，请妥善保管。");
        onClose();
        return;
      }
      setError("导出已取消。");
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : "导出失败，请检查保存位置后重试。");
    } finally { setBusy(false); }
  }
  return <SharedDialog sizeStorageKey="features/accounts/cloud-sync-section/channel-export-dialog" title="导出同步渠道" size="small" icon={<FileWarning size={18} />} className="data-transfer-dialog" busy={busy} closeDisabled={busy} initialFocus="input[type=checkbox]" onClose={onClose} onSubmit={event => { event.preventDefault(); void submit(); }} footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy || !accepted || !selected.length}>{busy ? "正在导出…" : "导出所选渠道"}</button></>}>
    <p>勾选需要导出的渠道（支持部分导出）。文件为明文 JSON，包含 WebDAV/S3/OSS 账号密码和访问密钥，任何获得文件的人均可读取，请保存到可信位置。</p>
    <fieldset className="cloud-sync-channel-pick" disabled={busy}>
      {channels.map(channel => {
        const id = channel.config.id ?? "default";
        return <label className="data-transfer-check" key={id}>
          <input type="checkbox" checked={selected.includes(id)} onChange={event => toggle(id, event.target.checked)} />
          {channel.config.name ?? "默认渠道"}（{methodLabel(channel.config.method)} · {channel.config.endpoint}）
        </label>;
      })}
    </fieldset>
    <label className="data-transfer-check"><input type="checkbox" checked={accepted} disabled={busy} onChange={event => setAccepted(event.target.checked)} />我了解文件未加密，包含明文凭据</label>
    {error && <p role="alert">{error}</p>}
  </SharedDialog>;
}

/** 先预览再确认：明文渠道 JSON 导入，可跳过或覆盖已有渠道。 */
export function CloudSyncChannelImportDialog({ onClose, onDone }: {
  onClose: () => void;
  onDone: (summary: CloudSyncImportSummary) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [staging, setStaging] = useState<CloudSyncImportStaging | null>(null);
  const [mode, setMode] = useState<"merge" | "overwrite">("merge");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function prepare(fileText?: string) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await cloudSyncClient.importPrepare(fileText);
      if (!result) return; // 桌面端取消了文件选择
      setStaging(result);
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : "读取云同步配置文件失败，请确认使用本应用导出的文件。");
    } finally { setBusy(false); }
  }
  async function submit() {
    if (busy || !staging) return;
    setBusy(true); setError("");
    try {
      const summary = await cloudSyncClient.importApply(staging.token, mode);
      setStaging(null);
      onDone(summary);
      onClose();
    } catch (reason) {
      setStaging(null);
      setError(`${reason instanceof Error && reason.message ? reason.message : "导入失败"}，请重新选择文件重试。`);
    } finally { setBusy(false); }
  }
  return <SharedDialog sizeStorageKey="features/accounts/cloud-sync-section/channel-import-dialog" title="导入同步渠道" size="small" className="data-transfer-dialog" busy={busy} closeDisabled={busy} initialFocus={staging ? "select" : "[data-import-pick]"} onClose={() => { if (!busy) onClose(); }} onSubmit={event => { event.preventDefault(); void submit(); }} footer={<>
    {!staging && <button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button>}
    {!staging && <button type="button" className="primary" data-import-pick disabled={busy} onClick={() => (runningInTauri ? void prepare() : fileInput.current?.click())}>{busy ? "正在读取…" : "选择配置文件"}</button>}
    {staging && <button type="button" className="secondary" disabled={busy} onClick={() => { setStaging(null); setError(""); }}>重新选择</button>}
    {staging && <button type="submit" className="primary" disabled={busy}>{busy ? "正在导入…" : "确认导入"}</button>}
  </>}>
    {!staging && <p>选择本应用导出的云同步配置 JSON 文件。导入前会先预览渠道内容；文件为明文，导入完成后建议删除或妥善保管。</p>}
    {staging && <>
      <p>将导入以下 {staging.channels.length} 条渠道（含明文凭据，导入后使用本机密钥加密保存）：</p>
      <fieldset className="cloud-sync-channel-pick" disabled={busy}>
        {staging.channels.map(channel => <label className="data-transfer-check" key={channel.id}>
          <input type="checkbox" checked readOnly disabled />
          {channel.name || "默认渠道"}（{methodLabel(channel.method)} · {channel.endpoint} · {credentialText(channel)}）
        </label>)}
      </fieldset>
      <label className="data-transfer-field">重复记录
        <select value={mode} disabled={busy} onChange={event => setMode(event.target.value as "merge" | "overwrite")}>
          <option value="merge">跳过已有（默认）</option>
          <option value="overwrite">覆盖已有</option>
        </select>
      </label>
      <p>同渠道按 id 或连接信息识别：跳过已有保留本机配置；覆盖已有会替换账号密码等设置并保留本机渠道身份。</p>
    </>}
    {error && <p role="alert">{error}</p>}
    <input ref={fileInput} type="file" accept=".json,application/json" aria-label="选择云同步配置文件" hidden onChange={event => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { setError("云同步配置文件超过 2 MB 限制。"); return; }
      void file.text().then(text => prepare(text));
    }} />
  </SharedDialog>;
}
