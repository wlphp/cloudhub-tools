import { useCallback, useEffect, useState } from "react";
import { Grid3x3 } from "lucide-react";
import { appLockClient, type AppLockStatus } from "../platform/clients/app_lock";
import { AppLockPatternGrid } from "./AppLockPatternGrid";

interface MobileAppLockPatternSettingsProps {
  onNotice: (message: string) => void;
  /** 保存成功后返回应用锁主页。 */
  onDone: () => void;
}

type PatternStep = "current" | "new" | "confirm";

/** 滑动图案独立设置页：按步骤绘制验证并保存 3×3 图案。 */
export function MobileAppLockPatternSettings({ onNotice, onDone }: MobileAppLockPatternSettingsProps) {
  const [status, setStatus] = useState<AppLockStatus | null>(null);
  const [step, setStep] = useState<PatternStep>("current");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const latest = await appLockClient.status();
      setStatus(latest);
      setStep(latest.hasPattern ? "current" : "new");
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "读取应用锁状态失败");
    }
  }, [onNotice]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const stepHint: Record<PatternStep, string> = {
    current: "第 1 步 · 绘制当前图案验证身份",
    new: status?.hasPattern ? "第 2 步 · 绘制新的滑动图案" : "绘制新的滑动图案",
    confirm: "第 3 步 · 再次绘制确认",
  };
  const firstStep: PatternStep = status?.hasPattern ? "current" : "new";

  const reset = () => {
    setCurrent("");
    setNext("");
    setError("");
    setStep(firstStep);
  };

  const complete = async (pattern: string) => {
    if (busy || !status) return;
    if (step === "current") { setCurrent(pattern); setStep("new"); setError(""); return; }
    if (step === "new") { setNext(pattern); setStep("confirm"); setError(""); return; }
    if (pattern !== next) { setError("两次绘制的图案不一致，请重新绘制"); setStep(firstStep); setNext(""); return; }
    setBusy(true);
    setError("");
    try {
      await appLockClient.setSecret("pattern", status.hasPattern ? current : null, next);
      onNotice("滑动图案已更新");
      onDone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
      setStep(firstStep);
      setNext("");
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <div className="mobile-empty">正在读取应用锁状态…</div>;

  return (
    <div className="mobile-domain-list mobile-more-list app-lock-form app-lock-pattern-page">
      <p className="app-lock-form-intro">
        <Grid3x3 size={16} aria-hidden="true" />
        {status.hasPattern ? "当前已设置滑动图案，修改需先绘制原图案验证。" : "尚未设置滑动图案。至少连接 4 个点，用于解锁应用。"}
      </p>
      <div className="app-lock-form-card">
        <p className="app-lock-step" aria-live="polite">{stepHint[step]}</p>
        <AppLockPatternGrid disabled={busy} onComplete={(pattern) => void complete(pattern)} />
        {error && <p className="app-lock-form-error" role="alert">{error}</p>}
        <div className="app-lock-form-actions">
          <button type="button" className="app-lock-secondary" disabled={busy} onClick={reset}>重新绘制</button>
        </div>
      </div>
      <p className="app-lock-form-note">图案只保存在本机，绘制轨迹不会留存；请避免使用过于简单的图案。</p>
    </div>
  );
}
