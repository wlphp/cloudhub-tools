import type { FrpProxy } from "../../shared/types";

export function frpRuleUrl(proxy: FrpProxy, serverAddress: string): string | null {
  if (!["tcp", "http", "https"].includes(proxy.kind)) return null;
  const host = (proxy.kind === "tcp" ? serverAddress : proxy.customDomains?.[0] ?? proxy.customDomain ?? "").trim();
  // Only accept a hostname/IP, never a scheme, credentials, path, or query.
  if (!host || (!/^[a-zA-Z0-9.-]+$/.test(host) && !(proxy.kind === "tcp" && /^[a-fA-F0-9:]+$/.test(host)))) return null;
  const authority = host.includes(":") ? `[${host}]` : host;
  const port = proxy.kind === "tcp" ? proxy.remotePort : null;
  if (proxy.kind === "tcp" && (!port || !Number.isInteger(port) || port < 1 || port > 65535)) return null;
  try {
    return new URL(`${proxy.kind === "https" ? "https" : "http"}://${authority}${port ? `:${port}` : ""}/`).href;
  } catch { return null; }
}
