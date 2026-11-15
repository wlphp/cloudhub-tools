import { useCallback, useEffect, useState } from "react";
import { Fingerprint, KeyRound, Grid3x3, LockKeyhole, Timer, ShieldCheck } from "lucide-react";
import { appLockClient, type AppLockStatus } from "../platform/clients/app_lock";
import { AppLockPatternGrid } from "./AppLockPatternGrid";

interface MobileAppLockSettingsProps {
  onNotice: (message: string) => void;
  /** “立即锁定”后由 MobileApp 切换到锁屏覆盖层。 */
  onLocked: () => void;
}

const AUTO_LOCK_OPTIONS: Array<{ seconds: number; label: string }> = [
  { seconds: 0, label: "立即" },
  { seconds: 30, label: "30 秒" },
  { seconds: 60, label: "1 分钟" },
  { seconds: 300, label: "5 分钟" },
];

interface PinEditor {
  method: "pin";
  current: string;
  next: string;
  confirm: string;
}

interface PatternEditor {
  method: "pattern";
  step: "current" | "new" | "confirm";
  current: string;
  next: string;
}

type AppLockEditor = PinEditor | PatternEditor | null;

/** 移动端“应用锁”设置页：总开关、指纹、数字密码、滑动图案与自动上锁时长。 */
export function MobileAppLockSettings({ onNotice, onLocked }: MobileAppLockSettingsProps) {
  const [status, setStatus] = useState<AppLockStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<AppLockEditor>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await appLockClient.status());
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "读取应用锁状态失败");
    }
  }, [onNotice]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const apply = async (action: () => Promise<unknown>, successMessage: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      onNotice(successMessage);
      await refreshStatus();
      return true;
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitPin = async () => {
    if (!editor || editor.method !== "pin") return;
    if (!/^\d{4,8}$/.test(editor.next)) { onNotice("数字密码需为 4-8 位数字"); return; }
    if (editor.next !== editor.confirm) { onNotice("两次输入的数字密码不一致"); return; }
    const hasExisting = status?.hasPin ?? false;
    if (hasExisting && !/^\d{4,8}$/.test(editor.current)) { onNotice("请输入当前数字密码"); return; }
    const saved = await apply(
      () => appLockClient.setSecret("pin", hasExisting ? editor.current : null, editor.next),
      "数字密码已更新",
    );
    if (saved) setEditor(null);
  };

  const submitPattern = async (pattern: string) => {
    if (!editor || editor.method !== "pattern") return;
    if (editor.step === "current") {
      setEditor({ ...editor, step: "new", current: pattern });
      return;
    }
    if (editor.step === "new") {
      setEditor({ ...editor, step: "confirm", next: pattern });
      return;
    }
    if (pattern !== editor.next) { onNotice("两次绘制的滑动图案不一致，请重新绘制"); setEditor({ ...editor, step: status?.hasPattern ? "current" : "new", next: "" }); return; }
    const hasExisting = status?.hasPattern ?? false;
    const saved = await apply(
      () => appLockClient.setSecret("pattern", hasExisting ? editor.current : null, editor.next),
      "滑动图案已更新",
    );
    if (saved) setEditor(null);
  };

  if (!status) return <div className="mobile-empty">正在读取应用锁状态…</div>;

  const hasLocalSecret = status.hasPin || status.hasPattern;
  const patternEditorHint = editor?.method === "pattern"
    ? editor.step === "current" ? "请绘制当前滑动图案" : editor.step === "new" ? "请绘制新的滑动图案" : "请再次绘制新的滑动图案"
    : "";

  return (
    <div className="mobile-domain-list mobile-more-list app-lock-settings">
      <div className="mobile-account-card app-lock-settings-row">
        <span className="mobile-provider-avatar"><LockKeyhole size={20} aria-hidden="true" /></span>
        <span className="mobile-account-copy">
          <strong>启用应用锁</strong>
          <small>{hasLocalSecret ? "启动或切回应用时需先解锁" : "请先设置数字密码或滑动图案"}</small>
        </span>
        <input
          type="checkbox"
          aria-label="启用应用锁"
          checked={status.enabled}
          disabled={busy || !hasLocalSecret}
          onChange={(event) => void apply(
            () => appLockClient.setConfig({ enabled: event.target.checked }),
            event.target.checked ? "应用锁已开启" : "应用锁已关闭",
          )}
        />
      </div>

      {status.biometricAvailable && (
        <div className="mobile-account-card app-lock-settings-row">
          <span className="mobile-provider-avatar"><Fingerprint size={20} aria-hidden="true" /></span>
          <span className="mobile-account-copy">
            <strong>指纹 / 面容解锁</strong>
            <small>开启后锁屏优先弹出系统生物识别，可回退系统锁屏密码</small>
          </span>
          <input
            type="checkbox"
            aria-label="启用指纹或面容解锁"
            checked={status.biometricEnabled}
            disabled={busy}
            onChange={(event) => void apply(
              () => appLockClient.setConfig({ biometricEnabled: event.target.checked }),
              event.target.checked ? "生物识别解锁已开启" : "生物识别解锁已关闭",
            )}
          />
        </div>
      )}

      <div className="mobile-account-card app-lock-settings-row">
        <span className="mobile-provider-avatar"><KeyRound size={20} aria-hidden="true" /></span>
        <span className="mobile-account-copy">
          <strong>{status.hasPin ? "修改数字密码" : "设置数字密码"}</strong>
          <small>4-8 位数字</small>
        </span>
        <button
          type="button"
          className="mobile-theme-toggle app-lock-settings-action"
          disabled={busy || editor?.method === "pin"}
          onClick={() => setEditor(editor?.method === "pin" ? null : { method: "pin", current: "", next: "", confirm: "" })}
        >
          {editor?.method === "pin" ? "收起" : status.hasPin ? "修改" : "设置"}
        </button>
      </div>
      {editor?.method === "pin" && (
        <div className="mobile-account-card app-lock-editor">
          {status.hasPin && (
            <label className="app-lock-editor-field">
              <span>当前数字密码</span>
              <input type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={editor.current}
                onChange={(event) => setEditor({ ...editor, current: event.target.value.replace(/\D/g, "") })} />
            </label>
          )}
          <label className="app-lock-editor-field">
            <span>新的数字密码</span>
            <input type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={editor.next}
              onChange={(event) => setEditor({ ...editor, next: event.target.value.replace(/\D/g, "") })} />
          </label>
          <label className="app-lock-editor-field">
            <span>再次输入新密码</span>
            <input type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={editor.confirm}
              onChange={(event) => setEditor({ ...editor, confirm: event.target.value.replace(/\D/g, "") })} />
          </label>
          <div className="app-lock-editor-actions">
            <button type="button" className="mobile-primary" disabled={busy} onClick={() => void submitPin()}>保存</button>
            <button type="button" className="mobile-secondary" disabled={busy} onClick={() => setEditor(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="mobile-account-card app-lock-settings-row">
        <span className="mobile-provider-avatar"><Grid3x3 size={20} aria-hidden="true" /></span>
        <span className="mobile-account-copy">
          <strong>{status.hasPattern ? "修改滑动图案" : "设置滑动图案"}</strong>
          <small>3×3 九宫格，至少连接 4 个点</small>
        </span>
        <button
          type="button"
          className="mobile-theme-toggle app-lock-settings-action"
          disabled={busy || editor?.method === "pattern"}
          onClick={() => setEditor(editor?.method === "pattern" ? null : { method: "pattern", step: status.hasPattern ? "current" : "new", current: "", next: "" })}
        >
          {editor?.method === "pattern" ? "收起" : status.hasPattern ? "修改" : "设置"}
        </button>
      </div>
      {editor?.method === "pattern" && (
        <div className="mobile-account-card app-lock-editor">
          <p className="app-lock-editor-hint">{patternEditorHint}</p>
          <AppLockPatternGrid disabled={busy} onComplete={(pattern) => void submitPattern(pattern)} />
          <div className="app-lock-editor-actions">
            <button type="button" className="mobile-secondary" disabled={busy} onClick={() => setEditor(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="mobile-account-card app-lock-settings-row">
        <span className="mobile-provider-avatar"><Timer size={20} aria-hidden="true" /></span>
        <span className="mobile-account-copy">
          <strong>切后台后自动上锁</strong>
          <small>离开应用超过所选时长后重新上锁</small>
        </span>
        <div className="mobile-theme-toggle app-lock-settings-delay" role="radiogroup" aria-label="自动上锁时长">
          {AUTO_LOCK_OPTIONS.map((option) => (
            <button
              key={option.seconds}
              type="button"
              role="radio"
              aria-checked={status.autoLockSeconds === option.seconds}
              className={status.autoLockSeconds === option.seconds ? "active" : ""}
              disabled={busy || !status.enabled}
              onClick={() => void apply(() => appLockClient.setConfig({ autoLockSeconds: option.seconds }), "自动上锁时长已更新")}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {status.enabled && (
        <div className="mobile-domain-card app-lock-settings-locknow">
          <button type="button" className="mobile-primary" disabled={busy}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              void appLockClient.lockNow()
                .then(() => onLocked())
                .catch((reason) => onNotice(reason instanceof Error ? reason.message : "锁定失败"))
                .finally(() => setBusy(false));
            }}>
            立即锁定
          </button>
          <small>马上回到锁屏界面，验证后才可继续使用。</small>
        </div>
      )}

      <details className="mobile-server-options app-lock-settings-help">
        <summary><ShieldCheck size={15} aria-hidden="true" /> 安全说明</summary>
        <p>数字密码与滑动图案只保存 Argon2id 验证值，并再次用本机安全密钥加密，不会明文落库或上传。</p>
        <p>连续失败 5 次后会进入冷却限制。开启指纹解锁时，系统锁屏密码可作为兜底；只设置数字密码或图案且全部忘记时，只能清除应用数据后重新初始化（可提前在“数据导入与迁移”中做加密备份）。</p>
        <p>桌面端与浏览器预览不受应用锁影响。</p>
      </details>
    </div>
  );
}
