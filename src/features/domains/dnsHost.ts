export function normalizeDnsHost(input: string, domain: string): string {
  let host = input.trim();
  const zone = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host === "@" || !zone) return host;
  const isUrl = /^(?:https?:)?\/\//i.test(host);
  if (isUrl) {
    try { host = new URL(host.startsWith("//") ? `https:${host}` : host).hostname; }
    catch { throw new Error("网址格式不正确，请填写当前域名的网址或主机前缀。"); }
  }
  const absolute = host.endsWith(".");
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === zone) return "@";
  if (name.endsWith(`.${zone}`)) return name.slice(0, -(zone.length + 1));
  if (isUrl || (absolute && name.includes("."))) throw new Error("该主机名不属于当前域名，请填写当前域名下的主机记录。");
  return host;
}

export function dnsBrowserUrl(rr: string, domain: string): string | null {
  const zone = domain.trim().toLowerCase().replace(/\.$/, "");
  const host = rr.trim().toLowerCase().replace(/\.$/, "");
  if (!host || !zone) return null;
  const name = host === "@" ? zone : host === zone || host.endsWith(`.${zone}`) ? host : `${host}.${zone}`;
  if (!name.split(".").every(label => /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(label))) return null;
  try { return new URL(`https://${name}/`).href; } catch { return null; }
}
