import crypto from "node:crypto";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";

function errorMessage(status, xml) {
  const message = String(xml).match(/<Message(?:\s[^>]*)?>([\s\S]*?)<\/Message>/i)?.[1]?.trim();
  const code = String(xml).match(/<Code(?:\s[^>]*)?>([\s\S]*?)<\/Code>/i)?.[1]?.trim();
  return `OSS ${status}: ${message || code || "请求被拒绝"}`;
}

export async function request(id, bucket, location, { method = "GET", query = "", resource = "", body = "", contentType = "", headers = {} } = {}) {
  const row = getAccountSecretRecord(id);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "aliyun") throw new Error(`${row.cloud_type === "tencent" ? "腾讯云" : "当前云类型"}对象存储 API 尚未接入`);
  const secret = decryptSecret(row.secret_ciphertext);
  const loc = location || "oss-cn-hangzhou";
  const host = bucket ? `${bucket}.${loc}.aliyuncs.com` : "oss-cn-hangzhou.aliyuncs.com";
  const date = new Date().toUTCString();
  const payloadHeaders = { ...headers };
  const canonicalHeaders = Object.entries(payloadHeaders).filter(([key]) => key.toLowerCase().startsWith("x-oss-")).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key.toLowerCase()}:${String(value).trim()}\n`).join("");
  const md5 = body ? crypto.createHash("md5").update(body).digest("base64") : "";
  const canonicalResource = resource || `/${bucket ? `${bucket}/` : ""}`;
  const signature = crypto.createHmac("sha1", secret).update(`${method}\n${md5}\n${contentType}\n${date}\n${canonicalHeaders}${canonicalResource}`).digest("base64");
  const response = await fetch(`https://${host}/${query ? `?${query}` : ""}`, { method, headers: { Date: date, Host: host, ...(contentType ? { "Content-Type": contentType } : {}), ...(md5 ? { "Content-MD5": md5 } : {}), ...payloadHeaders, Authorization: `OSS ${row.access_key_id}:${signature}` }, body: body || undefined });
  const xml = await response.text();
  if (!response.ok) throw new Error(errorMessage(response.status, xml));
  return xml;
}

function xmlDecode(value = "") { return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }
function xmlText(xml, tag) { const match = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`)); return match ? xmlDecode(match[1]).trim() : ""; }
function xmlBlocks(xml, tag) { return [...String(xml).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g"))].map((match) => match[1]); }

export async function objects(id, bucket, location, { prefix = "", marker = "" } = {}) {
  const query = new URLSearchParams({ "max-keys": "1000", delimiter: "/" });
  if (prefix) query.set("prefix", prefix);
  if (marker) query.set("marker", marker);
  const xml = await request(id, bucket, location, { query: query.toString(), resource: `/${bucket}/` });
  return { objects: xmlBlocks(xml, "Contents").map((block) => ({ Key: xmlText(block, "Key"), LastModified: xmlText(block, "LastModified"), ETag: xmlText(block, "ETag"), Size: xmlText(block, "Size") })).filter((item) => item.Key && item.Key !== prefix), prefixes: xmlBlocks(xml, "CommonPrefixes").map((block) => xmlText(block, "Prefix")).filter(Boolean), isTruncated: xmlText(xml, "IsTruncated").toLowerCase() === "true", nextMarker: xmlText(xml, "NextMarker") };
}

export async function acl(id, bucket, location) { return xmlText(await request(id, bucket, location, { query: "acl", resource: `/${bucket}/?acl` }), "Permission") || "private"; }
export async function stat(id, bucket, location) { const xml = await request(id, bucket, location, { query: "stat", resource: `/${bucket}/?stat` }); return Object.fromEntries(["Storage", "ObjectCount", "MultipartUploadCount", "LiveChannelCount", "LastModifiedTime"].map((key) => [key, xmlText(xml, key)])); }
export async function cnames(id, bucket, location) { const xml = await request(id, bucket, location, { query: "cname", resource: `/${bucket}/?cname` }); return xmlBlocks(xml, "Cname").map((block) => ({ Domain: xmlText(block, "Domain"), Status: xmlText(block, "Status") })).filter((item) => item.Domain); }
export async function cors(id, bucket, location) { const xml = await request(id, bucket, location, { query: "cors", resource: `/${bucket}/?cors` }); return xmlBlocks(xml, "CORSRule").map((block) => ({ origin: xmlBlocks(block, "AllowedOrigin").map(xmlDecode), method: xmlBlocks(block, "AllowedMethod").map(xmlDecode), header: xmlBlocks(block, "AllowedHeader").map(xmlDecode) })); }
