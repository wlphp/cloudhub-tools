import { useEffect, useRef, useState } from "react";
import { Delete, Fingerprint, Grid3x3, KeyRound, LockKeyhole } from "lucide-react";
import { appLockClient, type AppLockStatus } from "../platform/clients/app_lock";
import { AppLockPatternGrid } from "./AppLockPatternGrid";

interface AppLockScreenProps {
  status: AppLockStatus;
  onUnlocked: () => void;
}

type AppLockScreenMode = "biometric" | "pin" | "pattern";

const COOLDOWN_POLL_MS = 500;

/** 应用锁全屏覆盖层：挂载期间应用内容不渲染，任务切换器截图只会显示锁屏。 */
export function AppLockScreen({ status, onUnlocked }: AppLockScreenProps) {
  const [mode, setMode] = useState<AppLockScreenMode>(() => {
    if (status.biometricEnabled && status.biometricAvailable) return "biometric";
    if (status.hasPin) return "pin";
    return "pattern";
  });
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldownRemainingMs, setCooldownRemainingMs] = useState(status.cooldownMs);
  const cooldownDeadlineRef = useRef(Date.now() + status.cooldownMs);
  const autoBiometricRef = useRef(false);
  const biometricBusyRef = useRef(false);

  const cooling = cooldownRemainingMs > 0;

  useEffect(() => {
    if (!cooling) return;
    const timer = window.setInterval(() => {
      setCooldownRemainingMs(Math.max(0, cooldownDeadlineRef.current - Date.now()));
    }, COOLDOWN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [cooling]);

  // 锁屏期间后端状态可能刷新（如切后台后冷却延长），取本地与服务端中较长的一个。
  useEffect(() => {
    cooldownDeadlineRef.current = Math.max(cooldownDeadlineRef.current, Date.now() + status.cooldownMs);
    setCooldownRemainingMs((current) => Math.max(current, status.cooldownMs));
  }, [status.cooldownMs]);

  const runBiometric = async (allowDeviceCredentials: boolean) => {
    if (biometricBusyRef.current || cooling) return;
    biometricBusyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const unlocked = await appLockClient.biometricVerify(allowDeviceCredentials);
      if (unlocked) onUnlocked();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "身份验证未通过");
    } finally {
      biometricBusyRef.current = false;
      setBusy(false);
    }
  };

  /** 服务端冷却时长与本地猜测可能不一致，出错后按服务端剩余时间重新倒计时。 */
  const syncCooldownFromServer = async () => {
    try {
      const latest = await appLockClient.status();
      cooldownDeadlineRef.current = Date.now() + latest.cooldownMs;
      setCooldownRemainingMs(latest.cooldownMs);
    } catch {
      cooldownDeadlineRef.current = Date.now() + 30_000;
      setCooldownRemainingMs(30_000);
    }
  };

  // 指纹可用时进入锁屏即自动弹出系统验证框；StrictMode 重复挂载只弹一次。
  useEffect(() => {
    if (mode === "biometric" && !autoBiometricRef.current) {
      autoBiometricRef.current = true;
      void runBiometric(false);
    }
  }, []);

  const submitPin = async () => {
    if (busy || cooling || pin.length < 4) return;
    setBusy(true);
    setError("");
    try {
      const unlocked = await appLockClient.verify("pin", pin);
      if (unlocked) onUnlocked();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "数字密码不正确";
      setError(message);
      setPin("");
      if (message.includes("尝试次数过多")) await syncCooldownFromServer();
    } finally {
      setBusy(false);
    }
  };

  const submitPattern = async (pattern: string) => {
    if (busy || cooling) return;
    setBusy(true);
    setError("");
    try {
      const unlocked = await appLockClient.verify("pattern", pattern);
      if (unlocked) onUnlocked();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "滑动图案不正确";
      setError(message);
      if (message.includes("尝试次数过多")) await syncCooldownFromServer();
    } finally {
      setBusy(false);
    }
  };

  const modeOptions: Array<{ id: AppLockScreenMode; label: string; icon: typeof Fingerprint }> = [];
  if (status.biometricEnabled && status.biometricAvailable) modeOptions.push({ id: "biometric", label: "指纹", icon: Fingerprint });
  if (status.hasPin) modeOptions.push({ id: "pin", label: "数字密码", icon: KeyRound });
  if (status.hasPattern) modeOptions.push({ id: "pattern", label: "滑动图案", icon: Grid3x3 });

  const cooldownSeconds = Math.ceil(cooldownRemainingMs / 1000);

  return (
    <main className="app-lock-screen" aria-label="应用已锁定">
      <div className="app-lock-card">
        <span className="app-lock-badge"><LockKeyhole size={30} aria-hidden="true" /></span>
        <h1>应用已锁定</h1>
        <p className="app-lock-subtitle">验证身份后继续使用云枢工具箱</p>

        {cooling && <p className="app-lock-error" role="alert">尝试次数过多，请在 {cooldownSeconds} 秒后重试</p>}
        {!cooling && error && <p className="app-lock-error" role="alert">{error}</p>}

        {mode === "biometric" && (
          <div className="app-lock-biometric">
            <button
              type="button"
              className="app-lock-biometric-button"
              disabled={busy || cooling || !status.biometricAvailable}
              onClick={() => void runBiometric(false)}
            >
              <Fingerprint size={54} aria-hidden="true" />
              <span>{busy ? "正在验证…" : "点击验证指纹 / 面容"}</span>
            </button>
            <button type="button" className="app-lock-text-button" disabled={busy || cooling} onClick={() => void runBiometric(true)}>
              使用系统锁屏密码解锁
            </button>
          </div>
        )}

        {mode === "pin" && (
          <div className="app-lock-pin">
            <div className="app-lock-pin-dots" aria-label="已输入数字密码长度" aria-live="polite">
              {Array.from({ length: Math.max(4, pin.length || 4) }, (_, index) => (
                <span key={index} className={"app-lock-pin-dot" + (index < pin.length ? " is-filled" : "")} />
              ))}
            </div>
            <div className="app-lock-keypad" aria-label="数字键盘">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"].map((key, index) =>
                key === "" ? (
                  <span key={index} className="app-lock-keypad-spacer" aria-hidden="true" />
                ) : key === "back" ? (
                  <button key={index} type="button" className="app-lock-keypad-key" aria-label="删除一位" disabled={busy || cooling || pin.length === 0}
                    onClick={() => setPin((current) => current.slice(0, -1))}>
                    <Delete size={22} aria-hidden="true" />
                  </button>
                ) : (
                  <button key={index} type="button" className="app-lock-keypad-key" disabled={busy || cooling || pin.length >= 8}
                    onClick={() => setPin((current) => current + key)}>{key}</button>
                ),
              )}
            </div>
            <button type="button" className="app-lock-primary" disabled={busy || cooling || pin.length < 4} onClick={() => void submitPin()}>
              解锁
            </button>
          </div>
        )}

        {mode === "pattern" && (
          <div className="app-lock-pattern-area">
            <AppLockPatternGrid disabled={busy || cooling} onComplete={(pattern) => void submitPattern(pattern)} />
            <p className="app-lock-pattern-hint">滑动连接至少 4 个点完成解锁</p>
          </div>
        )}

        {modeOptions.length > 1 && (
          <div className="app-lock-mode-switch" role="tablist" aria-label="切换解锁方式">
            {modeOptions.filter((option) => option.id !== mode).map((option) => (
              <button key={option.id} type="button" role="tab" aria-selected={false}
                onClick={() => { setError(""); setMode(option.id); }}>
                <option.icon size={16} aria-hidden="true" />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
