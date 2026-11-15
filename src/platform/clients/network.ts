import { nativeOnly } from "./base";

/** Proxy row as stored by the Rust layer; credentials never round-trip to the client. */
export type ProxyStatus = { id: string; name: string; url: string; authConfigured: boolean };
export type PoolStatus = { enabled: boolean; selectedId: string | null; proxies: ProxyStatus[] };
export type ProxySaveInput = { enabled: boolean; selectedId: string | null; proxies: Array<{ id: string; name: string; url: string; username: string; password: string }> };
/** System-detected proxy candidate from the desktop-only detection command. */
export type ProxyCandidate = { url: string; source: string; enabled: boolean };

// 仅开发预览（vite dev 且无 Tauri 运行时）生效：为样式调整提供内存模拟代理池，
// H5 中网络设置页完整可交互。生产构建 import.meta.env.DEV 为 false，全部走原生命令。
export const networkPreviewEnabled =
  import.meta.env.DEV && typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

const previewPool: PoolStatus = {
  enabled: true,
  selectedId: "preview-hk",
  proxies: [
    { id: "preview-hk", name: "香港节点", url: "http://127.0.0.1:7890", authConfigured: false },
    { id: "preview-local", name: "本机 Clash", url: "http://127.0.0.1:7891", authConfigured: true },
  ],
};

function previewPoolCopy(): PoolStatus {
  return { ...previewPool, proxies: previewPool.proxies.map(proxy => ({ ...proxy })) };
}

/** Global outbound proxy pool. Mobile builds register get/save/test; detection stays desktop-only. */
export const networkClient = {
  get: () => {
    if (networkPreviewEnabled) return Promise.resolve(previewPoolCopy());
    return nativeOnly<PoolStatus>("network_proxy_get");
  },
  save: (input: ProxySaveInput) => {
    if (networkPreviewEnabled) {
      previewPool.enabled = input.enabled;
      previewPool.selectedId = input.selectedId;
      previewPool.proxies = input.proxies.map(proxy => ({
        id: proxy.id,
        name: proxy.name,
        url: proxy.url,
        authConfigured: previewPool.proxies.find(current => current.id === proxy.id)?.authConfigured || Boolean(proxy.username || proxy.password),
      }));
      return Promise.resolve(previewPoolCopy());
    }
    return nativeOnly<PoolStatus>("network_proxy_save", input);
  },
  test: (input: { proxyId: string | null; url: string; username: string; password: string; keepAuth: boolean }) => {
    if (networkPreviewEnabled) return Promise.resolve(80 + Math.floor(Math.random() * 160));
    return nativeOnly<number>("network_proxy_test", input);
  },
  detect: () => nativeOnly<ProxyCandidate[]>("network_proxy_detect"),
};
