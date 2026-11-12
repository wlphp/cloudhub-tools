import { useEffect, useState } from "react";
import { domainsClient } from "../../platform/clients";
import { platformErrorMessage } from "../../platform/api";

export type PublicDns = { servers?: string[]; error?: string };
export function dnsProvider(servers: string[]) {
  const all = (suffixes: string[]) => servers.length > 0 && servers.every(ns => suffixes.some(suffix => ns.toLowerCase().endsWith(suffix)));
  if (all([".ns.cloudflare.com"])) return "Cloudflare DNS";
  if (all([".hichina.com", ".alidns.com"])) return "阿里云 DNS";
  if (all([".dnspod.net", ".dnspod.com"])) return "DNSPod";
  if (all([".awsdns.com", ".awsdns.net", ".awsdns.org", ".awsdns.co.uk"])) return "AWS DNS";
  return "第三方 DNS";
}

export function usePublicNameservers(names: string[], revision: number) {
  const key = [...new Set(names.filter(Boolean))].sort().join("\n");
  const [entries, setEntries] = useState<Record<string, PublicDns>>({});
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    const queue = key ? key.split("\n") : [];
    setEntries({});
    async function worker() {
      while (alive && queue.length) {
        const domain = queue.shift()!;
        let entry: PublicDns;
        try {
          const servers = await domainsClient.nameservers(domain);
          if (!Array.isArray(servers) || !servers.length || !servers.every(ns => typeof ns === "string")) throw new Error("公网查询未返回 NS 记录");
          entry = { servers };
        } catch (reason) { entry = { error: platformErrorMessage(reason) }; }
        if (alive) setEntries(current => ({ ...current, [domain]: entry }));
      }
    }
    void Promise.all(Array.from({ length: Math.min(queue.length, 4) }, worker));
    return () => { alive = false; };
  }, [key, revision, refresh]);
  return { entries, refresh: () => setRefresh(value => value + 1) };
}
