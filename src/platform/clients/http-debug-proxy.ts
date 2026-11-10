import { nativeOnly } from "./base";

export interface HttpDebugSession {
  id: string; timestamp: number; method: string; url: string; status: number; durationMs: number;
  requestHeaders: [string, string][]; responseHeaders: [string, string][];
  requestBody: string; responseBody: string; requestImageData?: string | null; responseImageData?: string | null; error: string | null;
  note?: string | null;
}
export interface HttpDebugSnapshot {
  running: boolean; address: string; systemProxy: boolean; upstreamProxy: boolean; rootCertificateInstalled: boolean; httpsDecryption: boolean;
  systemProxyEnabled: boolean; systemProxyServer: string | null; systemProxyRecoveryAvailable: boolean; systemProxyRecoverySafe: boolean;
  sessions: Array<Pick<HttpDebugSession, "id" | "timestamp" | "method" | "url" | "status" | "durationMs"> & { responseContentType: string; note?: string | null }>;
}
export interface HttpDebugCertificate {
  commonName: string; subject: string; issuer: string; serial: string; fingerprint: string;
  notBefore: number; notAfter: number; expired: boolean; isCa: boolean; installed: boolean; isApplication: boolean;
  pem?: string | null;
}
export interface HttpDebugCertificateOverview { application: HttpDebugCertificate; store: HttpDebugCertificate[] }
export const httpDebugProxyClient = {
  state: () => nativeOnly<HttpDebugSnapshot>("http_debug_proxy_state"),
  start: (systemProxy = true) => nativeOnly<HttpDebugSnapshot>("http_debug_proxy_start", { systemProxy }),
  stop: () => nativeOnly<void>("http_debug_proxy_stop"),
  restoreSystemProxy: () => nativeOnly<void>("http_debug_proxy_restore_system_proxy"),
  setCertificate: (installed: boolean) => nativeOnly<HttpDebugSnapshot>("http_debug_proxy_set_certificate", { installed }),
  certificates: () => nativeOnly<HttpDebugCertificateOverview>("http_debug_proxy_certificates"),
  removeCertificate: (fingerprint: string) => nativeOnly<HttpDebugSnapshot>("http_debug_proxy_remove_certificate", { fingerprint }),
  deleteApplicationCertificate: () => nativeOnly<void>("http_debug_proxy_delete_application_certificate"),
  clear: () => nativeOnly<void>("http_debug_proxy_clear"),
  session: (id: string, revealSensitive = false) => nativeOnly<HttpDebugSession>("http_debug_proxy_session", { id, revealSensitive }),
  exportSession: (id: string) => nativeOnly<string | null>("http_debug_proxy_export_session", { id }),
};
