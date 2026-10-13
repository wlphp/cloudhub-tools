import { normalizeDnsHost } from "./dnsHost";
export type ParsedDnsRecord = { type: string; rr?: string; value: string; ttl?: number; priority?: number; line?: string; inference?: string };
export const dnsTypes = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA", "REDIRECT_URL", "FORWARD_URL"];
const lineNames: Record<string, string> = { 默认: "default", 电信: "telecom", 联通: "unicom", 移动: "mobile", 境外: "oversea", 教育网: "edu", 搜索引擎: "search" };
const aliases: Record<string, string> = { type: "type", 记录类型: "type", 类型: "type", rr: "rr", host: "rr", name: "rr", hostname: "rr", 主机记录: "rr", 主机: "rr", 名称: "rr", value: "value", content: "value", target: "value", 记录值: "value", 值: "value", 目标: "value", ttl: "ttl", priority: "priority", 优先级: "priority", line: "line", 线路: "line", 解析线路: "line" };
const ipv4 = (value: string) => value.split(".").length === 4 && value.split(".").every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
function ipv6(value: string) {
  if (!value.includes(":") || !/^[0-9a-f:.]+$/i.test(value)) return false;
  try { return new URL(`http://[${value}]/`).hostname.startsWith("["); } catch { return false; }
}
const targetDomain = (value: string) => /^(?:[a-z0-9_-]+\.)+[a-z0-9_-]+\.?$/i.test(value) && !/^[\d.]+$/.test(value);
function inferType(value: string, fields: Record<string, unknown>): string {
  if (ipv4(value)) return "A";
  if (ipv6(value)) return "AAAA";
  if (/^v=(?:spf1|DKIM1|DMARC1)\b|^(?:google-site-verification|MS|.*-verification)=/i.test(value) || /^".*"$/.test(value) || /(?:^|\.)(?:_acme-challenge|_dmarc|_domainkey)(?:\.|$)/i.test(String(fields.rr || ""))) return "TXT";
  if (/^(?:0|128)\s+(?:issue|issuewild|iodef)\s+".+"$/i.test(value)) return "CAA";
  if (/^\d+\s+\d+\s+\d+\s+\S+$/.test(value) && targetDomain(value.split(/\s+/)[3])) return "SRV";
  if (fields.priority != null && targetDomain(value) || /^\d+\s+\S+$/.test(value) && targetDomain(value.split(/\s+/)[1])) return "MX";
  if (targetDomain(value)) return "CNAME";
  if (/^https?:\/\//i.test(value)) { try { const url = new URL(value); if (url.hostname) return "REDIRECT_URL"; } catch { /* Invalid URLs remain unrecognized. */ } }
  return "";
}
const positiveNumber = (value: unknown) => /^\d+$/.test(String(value)) && Number(value) > 0 && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
function txtValue(value: string) {
  // Adjacent quoted segments are one TXT value. Preserve unquoted text exactly.
  if (/^(?:"(?:[^"\\]|\\.)*"\s*)+$/.test(value)) return [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => match[1].replace(/\\(["\\])/g, "$1")).join("");
  return value;
}
function normalize(fields: Record<string, unknown>, domain: string): ParsedDnsRecord | null {
  const value = String(fields.value ?? "").trim();
  let type = String(fields.type ?? "").trim().toUpperCase();
  const inferred = !type;
  if (!type) type = inferType(value, fields);
  if (!dnsTypes.includes(type) || !value) return null;
  if (type === "A" && !ipv4(value)) return null;
  if (type === "AAAA" && !ipv6(value)) return null;
  let rr = fields.rr == null ? undefined : normalizeDnsHost(String(fields.rr), domain);
  if (!rr && /^v=spf1\b/i.test(value)) rr = "@";
  if (!rr && /^v=DMARC1\b/i.test(value)) rr = "_dmarc";
  const result: ParsedDnsRecord = { type, rr: rr || undefined, value: type === "TXT" ? txtValue(value) : value };
  if (inferred && type === "CNAME") result.inference = "记录值为域名，暂按 CNAME 填入；如果用于邮件或 DNS 服务器，请改为 MX 或 NS。";
  if (inferred && type === "REDIRECT_URL") result.inference = "记录值为网址，暂按显性 URL 填入，请确认是否用于跳转。";
  if (fields.ttl != null) { result.ttl = positiveNumber(fields.ttl); if (!result.ttl || result.ttl > 2147483647) throw new Error("TTL 必须是有效的正整数秒数。"); }
  if (fields.priority != null) { result.priority = positiveNumber(fields.priority); if (!result.priority || result.priority > 50) throw new Error("MX 优先级须填写 1～50。"); }
  if (fields.line != null) {
    const line = String(fields.line).trim(); result.line = lineNames[line] || line;
    if (!["default", "telecom", "unicom", "mobile", "oversea", "edu", "search"].includes(result.line)) throw new Error("解析线路无法识别，请在下方手动选择。");
  }
  if (type === "MX" && result.priority == null) {
    const match = value.match(/^(\d+)\s+(.+)$/);
    if (match) { result.priority = Number(match[1]); result.value = match[2]; if (result.priority < 1 || result.priority > 50) throw new Error("MX 优先级须填写 1～50。"); }
  }
  return result;
}
function fieldsFromObject(object: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) { const alias = aliases[key.toLowerCase()]; if (alias) fields[alias] = value; }
  return fields;
}
export function parseDnsPaste(text: string, domain = ""): ParsedDnsRecord[] {
  if (!text.trim()) throw new Error("请先粘贴 DNS 记录内容。");
  if (text.length > 32768) throw new Error("粘贴内容过长，请分段解析（每次最多 32 KB）。");
  const input = text.trim();
  const records: ParsedDnsRecord[] = [];
  if (/^[\[{]/.test(input)) {
    let json: unknown;
    try { json = JSON.parse(input); } catch { throw new Error("JSON 格式不正确，请检查括号和引号。"); }
    for (const item of Array.isArray(json) ? json : [json]) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("请粘贴 DNS 记录对象或对象数组。");
      const record = normalize(fieldsFromObject(item as Record<string, unknown>), domain);
      if (!record) throw new Error("JSON 记录缺少可识别的类型或记录值。");
      records.push(record);
    }
  } else {
    let fields: Record<string, unknown> = {};
    const flush = () => { if (Object.keys(fields).length) { const record = normalize(fields, domain); if (!record) throw new Error("记录说明缺少可识别的类型或记录值，请补充后重试。"); records.push(record); fields = {}; } };
    for (const raw of input.split(/\r?\n/)) {
      const line = raw.trim(); if (!line) { flush(); continue; }
      const label = line.match(/^([^:=：]+)\s*[:=：]\s*(.*)$/);
      const alias = label && aliases[label[1].trim().toLowerCase()];
      if (label && alias) { if (fields[alias] !== undefined) flush(); fields[alias] = label[2]; continue; }
      flush();
      const tokens = line.match(/"(?:[^"\\]|\\.)*"|\S+/g) || [];
      const typeIndex = tokens.findIndex(token => dnsTypes.includes(token.toUpperCase()));
      let record: ParsedDnsRecord | null = null;
      if (typeIndex >= 0) {
        const before = tokens.slice(0, typeIndex);
        const after = tokens.slice(typeIndex + 1);
        const type = tokens[typeIndex].toUpperCase();
        const valueOnly = typeIndex === 0 && (after.length === 1 || (type === "MX" || type === "SRV" || type === "CAA") && /^\d+$/.test(after[0] || "") || type === "TXT" && /^"/.test(after[0] || ""));
        const rr = typeIndex === 0 ? valueOnly ? undefined : after.shift() : before.shift();
        if (before.every(token => /^\d+$/.test(token) || token.toUpperCase() === "IN")) record = normalize({ type, rr, value: after.join(" "), ...(before.find(token => /^\d+$/.test(token)) ? { ttl: before.find(token => /^\d+$/.test(token)) } : {}) }, domain);
      } else {
        record = normalize({ value: line }, domain);
        if (!record) {
          const pair = line.match(/^(\S+?)\s*(?:→|->|=>|=|：|指向|解析到|绑定到)\s*(.+)$/) || line.match(/^([a-z0-9_*.-]+):\s+(.+)$/i) || line.match(/^(\S+)\s+(.+)$/);
          if (pair && /^(?:@|\*|[a-z0-9_*.-]+|https?:\/\/\S+)$/i.test(pair[1])) record = normalize({ rr: pair[1], value: pair[2] }, domain);
        }
      }
      if (record) records.push(record);
    }
    flush();
  }
  if (!records.length) throw new Error("未识别到 DNS 记录。可使用“主机记录: www / 记录类型: CNAME / 记录值: target.example.com”分行填写，或粘贴“www CNAME target.example.com”。");
  if (records.length > 100) throw new Error("一次最多解析 100 条记录，请分段粘贴。");
  return records;
}
