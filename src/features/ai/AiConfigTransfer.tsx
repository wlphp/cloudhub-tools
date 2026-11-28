import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, Upload } from "lucide-react";
import { aiClient, type AiImportPreview, type AiProfile } from "../../platform/clients/ai";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import { SharedDialog } from "../../shared/SharedDialog";

export function AiExportDialog({
  profiles,
  initialSelectedIds,
  onClose,
  onDone,
}: {
  profiles: AiProfile[];
  initialSelectedIds?: string[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>(() => {
    const initial = initialSelectedIds?.filter(id => profiles.some(profile => profile.id === id)) ?? [];
    return initial.length ? initial : profiles.map(profile => profile.id);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const alive = useRef(true);
  const allRef = useRef<HTMLInputElement>(null);

  const validSelected = selected.filter(id => profiles.some(profile => profile.id === id));
  const allChecked = profiles.length > 0 && validSelected.length === profiles.length;
  const indeterminate = validSelected.length > 0 && validSelected.length < profiles.length;

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  function toggle(id: string) {
    setHint("");
    setSelected(values => (values.includes(id) ? values.filter(v => v !== id) : [...values, id]));
  }

  async function exportFile() {
    if (!validSelected.length || busy) return;
    setBusy(true);
    setError("");
    setHint("");
    try {
      const saved = await aiClient.exportConfig(validSelected);
      if (!alive.current) return;
      if (saved) {
        onDone(`已导出 ${validSelected.length} 个模型供应商配置（含 API 密钥），请妥善保管。`);
      } else {
        setHint("已取消保存文件。");
      }
    } catch (e) {
      if (alive.current) setError(platformErrorMessage(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <SharedDialog
      sizeStorageKey="features/ai/ai-config-transfer/export-dialog"
      title="导出模型供应商"
      icon={<Download size={18} aria-hidden="true" />}
      className="ai-transfer-dialog"
      size="small"
      busy={busy}
      closeDisabled={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !validSelected.length || !runningInTauri}
            onClick={() => void exportFile()}
          >
            <Download size={14} aria-hidden="true" />
            {busy ? "正在导出…" : `导出配置文件（${validSelected.length}）`}
          </button>
        </>
      }
    >
      {!runningInTauri && (
        <p className="ai-transfer-preview-note" role="status">
          当前为浏览器预览，导出配置文件需在桌面客户端执行。
        </p>
      )}
      <p className="transfer-warning">
        <AlertTriangle size={16} aria-hidden="true" />
        <span>导出的文件包含明文 API 密钥，请妥善保管，勿分享或上传。</span>
      </p>
      {profiles.length > 0 ? (
        <>
          <label className="transfer-check">
            <input
              ref={allRef}
              type="checkbox"
              checked={allChecked}
              disabled={busy}
              onChange={event => {
                setHint("");
                setSelected(event.target.checked ? profiles.map(profile => profile.id) : []);
              }}
            />
            全选（已选 {validSelected.length} / {profiles.length} 项）
          </label>
          <div className="transfer-list">
            {profiles.map(profile => (
              <label key={profile.id} className="transfer-row">
                <input
                  type="checkbox"
                  checked={validSelected.includes(profile.id)}
                  disabled={busy}
                  onChange={() => toggle(profile.id)}
                />
                <span>
                  <strong>{profile.name}</strong>
                  <small>
                    {profile.baseUrl} · {profile.model}
                    {profile.isDefault ? " · 默认" : ""}
                    {profile.enabled ? "" : " · 已停用"}
                  </small>
                </span>
              </label>
            ))}
          </div>
        </>
      ) : (
        <p className="ai-transfer-empty">暂无可导出的模型供应商。</p>
      )}
      {hint && (
        <p role="status" className="ai-transfer-hint">
          {hint}
        </p>
      )}
      {error && (
        <p role="alert" className="transfer-error">
          {error}
        </p>
      )}
    </SharedDialog>
  );
}

export function AiImportDialog({
  initialPreview = null,
  onClose,
  onImported,
  onDone,
}: {
  initialPreview?: AiImportPreview | null;
  onClose: () => void;
  onImported: () => Promise<void>;
  onDone: (message: string) => void;
}) {
  const [preview, setPreview] = useState<AiImportPreview | null>(initialPreview);
  const [importIds, setImportIds] = useState<string[]>(() => initialPreview?.profiles.map(profile => profile.id) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const token = useRef<string | null>(initialPreview?.token ?? null);
  const allRef = useRef<HTMLInputElement>(null);

  const previewProfiles = preview?.profiles ?? [];
  const allChecked = previewProfiles.length > 0 && importIds.length === previewProfiles.length;
  const indeterminate = importIds.length > 0 && importIds.length < previewProfiles.length;

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (token.current) void aiClient.cancelImport(token.current).catch(() => {});
    };
  }, []);

  async function cancelPendingImport() {
    if (!token.current) return;
    const activeToken = token.current;
    token.current = null;
    try {
      await aiClient.cancelImport(activeToken);
    } catch {
      // Closing the dialog should still proceed even if the staging token already expired.
    }
  }

  async function handleClose() {
    if (busy) return;
    await cancelPendingImport();
    onClose();
  }

  function toggleImport(id: string) {
    setImportIds(values => (values.includes(id) ? values.filter(v => v !== id) : [...values, id]));
  }

  async function prepare() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await aiClient.prepareImport();
      if (!next) return;
      if (!alive.current) {
        void aiClient.cancelImport(next.token).catch(() => {});
        return;
      }
      await cancelPendingImport();
      token.current = next.token;
      setPreview(next);
      setImportIds(next.profiles.map(profile => profile.id));
    } catch (e) {
      if (alive.current) setError(platformErrorMessage(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function confirm() {
    if (!preview || !importIds.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const count = await aiClient.confirmImport(preview.token, importIds);
      token.current = null;
      if (!alive.current) return;
      setPreview(null);
      setImportIds([]);
      await onImported();
      if (alive.current) {
        onDone(`已新增 ${count} 个 AI 配置，已恢复文件中的密钥、模型、启用和默认状态；旧版无密钥配置保持停用。`);
      }
    } catch (e) {
      if (alive.current) setError(platformErrorMessage(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <SharedDialog
      sizeStorageKey="features/ai/ai-config-transfer/import-dialog"
      title="导入模型供应商"
      icon={<Upload size={18} aria-hidden="true" />}
      className="ai-transfer-dialog"
      size="small"
      busy={busy}
      closeDisabled={busy}
      onClose={() => void handleClose()}
      footer={
        <>
          <button type="button" className="secondary" disabled={busy} onClick={() => void handleClose()}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !preview || !importIds.length || !runningInTauri}
            onClick={() => void confirm()}
          >
            <Upload size={14} aria-hidden="true" />
            {busy ? "正在导入…" : preview ? `确认新增配置（${importIds.length}）` : "确认新增配置"}
          </button>
        </>
      }
    >
      {!runningInTauri && (
        <p className="ai-transfer-preview-note" role="status">
          当前为浏览器预览，导入配置文件需在桌面客户端执行。
        </p>
      )}
      <p className="transfer-warning">
        <AlertTriangle size={16} aria-hidden="true" />
        <span>
          导入后恢复密钥、模型、启用状态和默认配置，同名配置自动改名；已有配置保留，导入的默认配置会替换当前默认选择。旧版无密钥文件仍以停用状态导入。
        </span>
      </p>
      {!preview ? (
        <button
          type="button"
          className="secondary ai-transfer-pick-btn"
          disabled={busy || !runningInTauri}
          onClick={() => void prepare()}
        >
          <Upload size={14} aria-hidden="true" />
          {busy ? "正在读取…" : "选择配置文件"}
        </button>
      ) : (
        <section className="ai-transfer-preview" aria-label="AI配置迁移预览">
          <div className="ai-transfer-preview-head">
            <label className="transfer-check">
              <input
                ref={allRef}
                type="checkbox"
                checked={allChecked}
                disabled={busy}
                onChange={event => setImportIds(event.target.checked ? previewProfiles.map(profile => profile.id) : [])}
              />
              确认要新增的配置（已选 {importIds.length} / {previewProfiles.length} 项）
            </label>
            <button
              type="button"
              className="secondary ai-transfer-repick-btn"
              disabled={busy || !runningInTauri}
              onClick={() => void prepare()}
            >
              重新选择
            </button>
          </div>
          <div className="transfer-list">
            {previewProfiles.map(profile => (
              <label key={profile.id} className="transfer-row">
                <input
                  type="checkbox"
                  checked={importIds.includes(profile.id)}
                  disabled={busy}
                  onChange={() => toggleImport(profile.id)}
                />
                <span>
                  <strong>{profile.name}</strong>
                  <small>
                    {profile.baseUrl} · {profile.model} · {profile.hasKey ? "包含密钥" : "不包含密钥"} ·{" "}
                    {profile.enabled ? "已启用" : "已停用"}
                    {profile.isDefault ? " · 默认配置" : ""}
                  </small>
                </span>
              </label>
            ))}
          </div>
        </section>
      )}
      {error && (
        <p role="alert" className="transfer-error">
          {error}
        </p>
      )}
    </SharedDialog>
  );
}
