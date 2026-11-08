import { nativeOnly } from "./base";

/** Proxy row as stored by the Rust layer; credentials never round-trip to the client. */
export type ProxyStatus = { id: string; name: string; url: string; authConfigured: boolean };
export type PoolStatus = { enabled: boolean; selectedId: string | null; proxies: ProxyStatus[] };
export type ProxySaveInput = { enabled: boolean; selectedId: string | null; proxies: Array<{ id: string; name: string; url: string; username: string; password: string }> };
/** System-detected proxy candidate from the desktop-only detection command. */
export type ProxyCandidate = { url: string; source: string; enabled: boolean };

/** Global outbound proxy pool. Mobile builds register get/save/test; detection stays desktop-only. */
export const networkClient = {
  get: () => nativeOnly<PoolStatus>("network_proxy_get"),
  save: (input: ProxySaveInput) => nativeOnly<PoolStatus>("network_proxy_save", input),
  test: (input: { proxyId: string | null; url: string; username: string; password: string; keepAuth: boolean }) => nativeOnly<number>("network_proxy_test", input),
  detect: () => nativeOnly<ProxyCandidate[]>("network_proxy_detect"),
};
