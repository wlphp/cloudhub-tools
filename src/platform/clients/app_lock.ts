import { nativeOnly } from "./base";

/** 应用锁状态；与 Rust AppLockStatus 的 camelCase 序列化一一对应。 */
export interface AppLockStatus {
  enabled: boolean;
  hasPin: boolean;
  hasPattern: boolean;
  biometricEnabled: boolean;
  biometricAvailable: boolean;
  locked: boolean;
  cooldownMs: number;
  autoLockSeconds: number;
}

export type AppLockMethod = "pin" | "pattern";

export interface AppLockConfigPatch {
  enabled?: boolean;
  biometricEnabled?: boolean;
  autoLockSeconds?: number;
}

// 仅开发预览（vite dev 且无 Tauri 运行时）生效：为样式调整提供内存模拟状态，
// 使应用锁页面在 H5 中完整可交互。生产构建 import.meta.env.DEV 为 false，
// 全部走原生命令；浏览器打开生产构建仍显示“仅移动端 App 支持”状态。
const previewEnabled =
  import.meta.env.DEV && typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

// H5 访问 ?applock-demo=1 时初始即为锁定，直接演示锁屏覆盖层。
const previewLockedInitially =
  previewEnabled && new URLSearchParams(window.location.search).get("applock-demo") === "1";

const previewStatus: AppLockStatus = {
  enabled: true,
  hasPin: true,
  hasPattern: true,
  biometricEnabled: true,
  biometricAvailable: true,
  locked: previewLockedInitially,
  cooldownMs: 0,
  autoLockSeconds: 60,
};

function previewStatusCopy(): AppLockStatus {
  return { ...previewStatus };
}

export const appLockClient = {
  status(): Promise<AppLockStatus> {
    if (previewEnabled) return Promise.resolve(previewStatusCopy());
    return nativeOnly<AppLockStatus>("app_lock_status");
  },

  verify(method: AppLockMethod, secret: string): Promise<boolean> {
    if (previewEnabled) {
      const unlocked = secret.length >= 4;
      if (unlocked) previewStatus.locked = false;
      return Promise.resolve(unlocked);
    }
    return nativeOnly<boolean>("app_lock_verify", { method, secret });
  },

  /** 弹出系统生物识别/系统锁屏凭据验证框；仅移动端编译注册。 */
  biometricVerify(_allowDeviceCredentials: boolean): Promise<boolean> {
    if (previewEnabled) {
      // 演示模式不模拟生物识别成功：锁屏挂载即自动弹出验证，若返回成功会立刻解锁回到主页。
      return Promise.resolve(false);
    }
    return nativeOnly<boolean>("app_lock_biometric_verify", { allowDeviceCredentials: _allowDeviceCredentials });
  },

  setSecret(method: AppLockMethod, _currentSecret: string | null, _newSecret: string): Promise<boolean> {
    if (previewEnabled) {
      if (method === "pin") previewStatus.hasPin = true; else previewStatus.hasPattern = true;
      return Promise.resolve(true);
    }
    return nativeOnly<boolean>("app_lock_set_secret", { method, currentSecret: _currentSecret, newSecret: _newSecret });
  },

  removeSecret(method: AppLockMethod): Promise<boolean> {
    if (previewEnabled) {
      if (method === "pin") previewStatus.hasPin = false; else previewStatus.hasPattern = false;
      return Promise.resolve(true);
    }
    return nativeOnly<boolean>("app_lock_remove_secret", { method });
  },

  setConfig(patch: AppLockConfigPatch): Promise<boolean> {
    if (previewEnabled) {
      if (patch.enabled !== undefined) {
        previewStatus.enabled = patch.enabled;
        if (!patch.enabled) previewStatus.locked = false;
      }
      if (patch.biometricEnabled !== undefined) previewStatus.biometricEnabled = patch.biometricEnabled;
      if (patch.autoLockSeconds !== undefined) previewStatus.autoLockSeconds = patch.autoLockSeconds;
      return Promise.resolve(true);
    }
    return nativeOnly<boolean>("app_lock_set_config", { ...patch });
  },

  noteBackground(): Promise<void> {
    if (previewEnabled) {
      if (previewStatus.enabled && previewStatus.autoLockSeconds === 0) previewStatus.locked = true;
      return Promise.resolve();
    }
    return nativeOnly<void>("app_lock_note_background");
  },

  lockNow(): Promise<void> {
    if (previewEnabled) {
      if (previewStatus.enabled) previewStatus.locked = true;
      return Promise.resolve();
    }
    return nativeOnly<void>("app_lock_lock_now");
  },
};
