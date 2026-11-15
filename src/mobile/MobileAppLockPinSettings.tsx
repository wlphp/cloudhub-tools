import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { appLockClient, type AppLockStatus } from "../platform/clients/app_lock";

interface MobileAppLockPinSettingsProps {
  onNotice: (message: string) => void;
  /** 保存成功后返回应用锁主页。 */
  onDone: () => void;
}

const PIN_PATTERN = /^\d{4,8}$/;

/** 数字密码独立设置页：设置或修改 4-8 位数字密码。 */
export function MobileAppLockPinSettings({ onNotice, onDone }: MobileAppLockPinSettingsProps) {
  const [status, setStatus] = useState<AppLockStatus | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await appLockClient.status());
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "读取应用锁状态失败");
    }
  }, [onNotice]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !status) return;
    if (!PIN_PATTERN.test(next)) { setError("新的数字密码需为 4-8 位数字"); return; }
    if (next !== confirm) { setError("两次输入的数字密码不一致"); return; }
    if (status.hasPin && !PIN_PATTERN.test(current)) { setError("请输入当前数字密码"); return; }
    setBusy(true);
    setError("");
    try {
      await appLockClient.setSecret("pin", status.hasPin ? current : null, next);
      onNotice("数字密码已更新");
      onDone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <div className="mobile-empty">正在读取应用锁状态…</div>;

  return (
    <form className="mobile-domain-list mobile-more-list app-lock-form" onSubmit={(event) => void submit(event)}>
      <p className="app-lock-form-intro">
        <KeyRound size={16} aria-hidden="true" />
        {status.hasPin ? "当前已设置数字密码，修改需先验证原密码。" : "尚未设置数字密码。设置后可用于解锁应用。"}
      </p>
      <div className="app-lock-form-card">
        {status.hasPin && (
          <label className="app-lock-field">
            <span>当前数字密码</span>
            <input type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={current}
              placeholder="输入当前 4-8 位数字"
              onChange={(event) => { setCurrent(event.target.value.replace(/\D/g, "")); setError(""); }} />
          </label>
        )}
        <label className="app-lock-field">
          <span>{status.hasPin ? "新的数字密码" : "数字密码"}</span>
          <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={next}
            placeholder="4-8 位数字"
            onChange={(event) => { setNext(event.target.value.replace(/\D/g, "")); setError(""); }} />
        </label>
        <label className="app-lock-field">
          <span>再次输入新密码</span>
          <input type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={confirm}
            placeholder="与上面输入一致"
            onChange={(event) => { setConfirm(event.target.value.replace(/\D/g, "")); setError(""); }} />
        </label>
        {error && <p className="app-lock-form-error" role="alert">{error}</p>}
      </div>
      <button type="submit" className="app-lock-primary" disabled={busy || !next || !confirm || (status.hasPin && !current)}>
        {busy ? "正在保存…" : "保存"}
      </button>
      <p className="app-lock-form-note">数字密码只保存在本机，忘记时需清除应用数据后重新初始化，请务必牢记。</p>
    </form>
  );
}
