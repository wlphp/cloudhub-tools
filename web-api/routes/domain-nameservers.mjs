const endpoints = ["https://dns.alidns.com/resolve", "https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"];

export async function resolveDomainNameservers(input, request = fetch) {
  const domain = String(input || "").trim().replace(/\.$/, "").toLowerCase();
  if (domain.length > 253 || !domain.includes(".") || /^[0-9.]+$/.test(domain) || !domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error("域名格式无效，请使用有效域名（国际域名请使用 Punycode）");
  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint);
      url.search = new URLSearchParams({ name: domain, type: "NS" }).toString();
      const response = await request(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const data = await response.json();
      if (data.Status !== 0) continue;
      const servers = [...new Set((Array.isArray(data.Answer) ? data.Answer : []).filter(item => item.type === 2 && String(item.name).replace(/\.$/, "").toLowerCase() === domain).map(item => String(item.data || "").replace(/\.$/, "").toLowerCase()).filter(Boolean))].sort();
      if (servers.length) return servers;
    } catch { /* 尝试备用公网解析器，不回退到云账户配置。 */ }
  }
  throw new Error("公网 NS 查询失败或未返回 NS 记录，请稍后重试");
}
