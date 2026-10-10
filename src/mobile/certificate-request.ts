import type { CertificateRequest } from "../platform/clients/certificates";

export function certificateDomains(value: string): string[] {
  return [...new Set(value.split(/[\n,\s]+/).map((v) => v.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean))];
}

export function validateCertificateRequest(input: CertificateRequest, availableZones: string[]): string {
  if (!Number.isSafeInteger(input.accountId) || input.accountId <= 0) return "请选择阿里云 DNS 账号";
  if (!availableZones.includes(input.dnsZone)) return "请选择当前账号已同步的 DNS 区域";
  const valid = (domain: string) => {
    const name = domain.replace(/^\*\./, "");
    return name.length <= 253 && name.includes(".") && name.split(".").every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
  };
  if (!input.domains.length || input.domains.length > 100 || !input.domains.every(valid)) return "请输入有效的证书域名，最多 100 个";
  if (!input.domains.every((domain) => { const name = domain.replace(/^\*\./, ""); return name === input.dnsZone || name.endsWith(`.${input.dnsZone}`); })) return "所有证书域名必须属于所选 DNS 区域";
  if (input.provider === "litessl" && (!input.eabKid || !input.eabHmacKey || !/^[A-Za-z0-9_-]+={0,2}$/.test(input.eabHmacKey))) return "请填写 LiteSSL 的 EAB KID 和有效的 Base64URL HMAC 密钥";
  return "";
}
