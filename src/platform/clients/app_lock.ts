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

export const appLockClient = {
  status(): Promise<AppLockStatus> {
    return nativeOnly<AppLockStatus>("app_lock_status");
  },

  verify(method: AppLockMethod, secret: string): Promise<boolean> {
    return nativeOnly<boolean>("app_lock_verify", { method, secret });
  },

  /** 弹出系统生物识别/系统锁屏凭据验证框；仅移动端编译注册。 */
  biometricVerify(allowDeviceCredentials: boolean): Promise<boolean> {
    return nativeOnly<boolean>("app_lock_biometric_verify", { allowDeviceCredentials });
  },

  setSecret(method: AppLockMethod, currentSecret: string | null, newSecret: string): Promise<boolean> {
    return nativeOnly<boolean>("app_lock_set_secret", { method, currentSecret, newSecret });
  },

  removeSecret(method: AppLockMethod): Promise<boolean> {
    return nativeOnly<boolean>("app_lock_remove_secret", { method });
  },

  setConfig(patch: AppLockConfigPatch): Promise<boolean> {
    return nativeOnly<boolean>("app_lock_set_config", { ...patch });
  },

  noteBackground(): Promise<void> {
    return nativeOnly<void>("app_lock_note_background");
  },

  lockNow(): Promise<void> {
    return nativeOnly<void>("app_lock_lock_now");
  },
};
