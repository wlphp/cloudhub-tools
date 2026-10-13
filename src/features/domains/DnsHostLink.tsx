import { ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { runningInTauri } from "../../platform/api";

import { dnsBrowserUrl } from "./dnsHost";

export function DnsHostLink({ rr, domain, onStatus }: { rr: string; domain: string; onStatus: (message: string) => void }) {
  const url = dnsBrowserUrl(rr, domain);
  const title = url ? `在浏览器中打开 ${url}` : rr.includes("*") ? "泛域名不能直接打开，请使用具体主机名" : "该主机记录无法直接作为网页地址打开";
  if (!url) return <button type="button" className="dns-browser-link" disabled aria-label={title} title={title}><ExternalLink size={14} aria-hidden="true" /></button>;
  return <a className="dns-browser-link" href={url} target="_blank" rel="noopener noreferrer" aria-label={title} title={title} onClick={(event) => {
    event.stopPropagation();
    if (runningInTauri) { event.preventDefault(); void openUrl(url).catch(() => onStatus("打开浏览器失败，请重试。")); }
  }}><ExternalLink size={14} aria-hidden="true" /></a>;
}
