import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Fingerprint, Grid3x3, KeyRound, LockKeyhole, Timer, ShieldCheck } from "lucide-react";
import { PlatformError } from "../platform/api";
import { appLockClient, type AppLockStatus } from "../platform/clients/app_lock";

interface MobileAppLockSettingsProps {
  onNotice: (message: string) => void;
  /** “立即锁定”后由 MobileApp 切换到锁屏覆盖层。 */
  onLocked: () => void;
  /** 跳转到数字密码 / 滑动图案独立设置页。 */
  onNavigate: (tab: "appLockPin" | "appLockPattern") => void;
}

const AUTO_LOCK_OPTIONS: Array<{ seconds: number; label: string }> = [
  { seconds: 0, label: "立即" },
  { seconds: 30, label: "30 秒" },
  { seconds: 60, label: "1 分钟" },
  { seconds: 300, label: "5 分钟" },
];

/** 移动端“应用锁”主页：开关与入口；密码、图案的设置在独立子页完成。 */
export function MobileAppLockSettings({ onNotice, onLocked, onNavigate }: MobileAppLockSettingsProps) {
  const [status, setStatus] = useState<AppLockStatus | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await appLockClient.status());
    } catch (reason) {
      if (reason instanceof PlatformError && reason.code === "unsupported-in-preview") { setUnsupported(true); return; }
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
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return unsupported
      ? <div className="mobile-empty"><LockKeyhole size={28} aria-hidden="true" /><strong>应用锁仅移动端 App 支持</strong><span>网页预览无法访问本机安全存储与生物识别，请在手机 App 中设置。</span></div>
      : <div className="mobile-empty">正在读取应用锁状态…</div>;
  }

  const hasLocalSecret = status.hasPin || status.hasPattern;

  return (
    <div className="mobile-domain-list mobile-more-list app-lock-settings">
      <div className="mobile-account-card app-lock-row">
        <span className="mobile-provider-avatar"><LockKeyhole size={20} aria-hidden="true" /></span>
        <span className="mobile-account-copy">
          <strong>启用应用锁</strong>
          <small>启动或切回应用时需先解锁</small>
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
        <div className="mobile-account-card app-lock-row">
          <span className="mobile-provider-avatar"><Fingerprint size={20} aria-hidden="true" /></span>
          <span className="mobile-account-copy">
            <strong>指纹 / 面容解锁</strong>
            <small>锁屏优先使用指纹或面容验证</small>
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

      <button type="button" className="mobile-account-card app-lock-row app-lock-nav-row" onClick={() => onNavigate("appLockPin")}>
        <span className="mobile-provider-avatar"><KeyRound size={20} aria-hidden="true" /></span>
        <span className="mobile-account-copy">
          <strong>数字密码</strong>
          <small>{status.hasPin ? "已设置 · 点击修改" : "未设置 · 4-8 位数字"}</small>
        </span>
        <ChevronRight size={18} className="app-lock-chevron" aria-hidden="true" />
      </button>

      <button type="button" className="mobile-account-card app-lock-row app-lock-nav-row" onClick={() => onNavigate("appLockPattern")}>
        <span className="mobile-provider-avatar"><Grid3x3 size={20} aria-hidden="true" /></span>
        <span className="mobile-account-copy">
          <strong>滑动图案</strong>
          <small>{status.hasPattern ? "已设置 · 点击修改" : "未设置 · 至少连接 4 个点"}</small>
        </span>
        <ChevronRight size={18} className="app-lock-chevron" aria-hidden="true" />
      </button>

      <div className="app-lock-autolock">
        <div className="app-lock-row-head">
          <span className="mobile-provider-avatar"><Timer size={20} aria-hidden="true" /></span>
          <span className="mobile-account-copy">
            <strong>切后台后自动上锁</strong>
            <small>离开应用超过所选时长后重新上锁</small>
          </span>
        </div>
        <div className="app-lock-segments" role="radiogroup" aria-label="自动上锁时长">
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
        <div className="app-lock-locknow">
          <button type="button" className="app-lock-primary" disabled={busy}
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

      <details className="app-lock-help">
        <summary><ShieldCheck size={15} aria-hidden="true" /> 安全说明</summary>
        <p>数字密码与滑动图案只保存 Argon2id 验证值，并再次用本机安全密钥加密，不会明文落库或上传。</p>
        <p>连续失败 5 次后会进入冷却限制。开启指纹解锁时，系统锁屏密码可作为兜底；只设置数字密码或图案且全部忘记时，只能清除应用数据后重新初始化（可提前在“数据导入与迁移”中做加密备份）。</p>
        <p>桌面端与浏览器预览不受应用锁影响。</p>
      </details>
    </div>
  );
}
