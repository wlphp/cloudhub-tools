import suffixList from "./public_suffix_list.dat?raw";
import type { BaotaSiteCertificate } from "../../platform/clients/certificates";

export function normalizeSiteDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  if (!domain || /[\s/:@?#\\]/.test(domain)) return "";
  try { return new URL(`https://${domain}`).hostname; } catch { return ""; }
}

// Offline snapshot from publicsuffix.org; includes private suffixes and PSL exceptions.
const exact = new Set<string>();
const wildcard = new Set<string>();
const exceptions = new Set<string>();
for (const line of suffixList.split(/\r?\n/)) {
  const rule = line.trim();
  if (!rule || rule.startsWith("//")) continue;
  const target = rule.startsWith("!") ? exceptions : rule.startsWith("*.") ? wildcard : exact;
  const normalized = normalizeSiteDomain(rule.replace(/^!|^\*\./, ""));
  if (normalized) target.add(normalized);
}

export function registrableSiteDomain(value: string): string | null {
  const domain = normalizeSiteDomain(value);
  if (!domain || /^[\d.]+$/.test(domain)) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some(label => !label || label.length > 63)) return null;
  let suffixLength = 1;
  for (let index = 0; index < labels.length; index++) {
    const suffix = labels.slice(index).join(".");
    if (exceptions.has(suffix)) return labels.slice(-(labels.length - index)).join(".");
    if (exact.has(suffix)) suffixLength = Math.max(suffixLength, labels.length - index);
    if (index > 0 && wildcard.has(suffix)) suffixLength = Math.max(suffixLength, labels.length - index + 1);
  }
  return labels.length > suffixLength ? labels.slice(-suffixLength - 1).join(".") : null;
}

export type SiteDomainRow = { key: string; domain: string; site: BaotaSiteCertificate };

export function siteDomainRows(sites: BaotaSiteCertificate[]): SiteDomainRow[] {
  return sites.flatMap(site => [...new Set(site.siteDomains.map(domain => domain.trim().toLowerCase()).filter(Boolean))]
    .map(domain => ({ key: `${site.id}:${domain}`, domain, site })));
}

export function summarizeSiteDomains(rows: SiteDomainRow[]) {
  const groups = new Map<string, { domain: string; domains: Set<string>; sites: Set<number> }>();
  for (const row of rows) {
    const domain = registrableSiteDomain(row.domain);
    if (!domain) continue;
    const group = groups.get(domain) ?? { domain, domains: new Set<string>(), sites: new Set<number>() };
    group.domains.add(row.domain);
    group.sites.add(row.site.id);
    groups.set(domain, group);
  }
  return [...groups.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}
