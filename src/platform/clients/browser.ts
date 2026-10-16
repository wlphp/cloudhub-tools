import { nativeOnly } from "./base";

export interface BrowserProxy { kind: "direct" | "http" | "https" | "socks5"; host: string; port: number; username: string }
export interface BrowserFingerprint { seed: number; canvasNoise: boolean; hardwareConcurrency: number; deviceMemory: number }
export interface BrowserConfig {
  name: string; group: string; tags: string; note: string; kernelVersion: string;
  startUrls: string[]; proxy: BrowserProxy; language: string; timezone: string; width: number; height: number;
  geolocation: { latitude: number; longitude: number; accuracy: number } | null;
  fingerprint: BrowserFingerprint | null;
  identity: "native" | "windows10" | "windows11";
}
export interface BrowserEnvironment {
  id: string; config: BrowserConfig; passwordSaved: boolean; createdAt: number;
  lastOpenedAt: number | null; deletedAt: number | null; running: boolean; recoveryRequired: boolean;
}
export interface BrowserKernel {
  label: string; recommended: boolean; experimental: boolean;
  version: string; installed: boolean; phase: "idle" | "downloading" | "verifying" | "extracting" | "ready" | "cancelled" | "failed";
  downloaded: number; total: number; error: string | null;
}
export interface BrowserSnapshot { supported: boolean; kernel: BrowserKernel; kernels: BrowserKernel[]; environments: BrowserEnvironment[] }
export interface SaveBrowserEnvironment { id: string | null; config: BrowserConfig; proxyPassword: string | null }
export const browserClient = {
  snapshot: () => nativeOnly<BrowserSnapshot>("browser_snapshot"),
  save: (input: SaveBrowserEnvironment) => nativeOnly<BrowserEnvironment>("browser_save", { input }),
  setDeleted: (id: string, deleted: boolean) => nativeOnly<void>("browser_set_deleted", { id, deleted }),
  launch: (id: string) => nativeOnly<void>("browser_launch", { id }),
  stop: (id: string) => nativeOnly<void>("browser_stop", { id }),
  install: (version: string) => nativeOnly<void>("browser_install_kernel", { version }),
  cancelInstall: () => nativeOnly<void>("browser_cancel_install"),
  importKernel: (version: string) => nativeOnly<boolean>("browser_import_kernel", { version }),
  uninstallKernel: (version: string) => nativeOnly<void>("browser_uninstall_kernel", { version }),
  remove: (id: string, confirmationName: string) => nativeOnly<void>("browser_remove", { id, confirmationName }),
  moveGroup: (ids: string[], group: string) => nativeOnly<void>("browser_move_group", { ids, group }),
  cookieFile: (id: string, exportFile: boolean) => nativeOnly<boolean>("browser_cookie_file", { id, export: exportFile }),
  checkProxy: (id: string) => nativeOnly<string>("browser_check_proxy", { id }),
};
