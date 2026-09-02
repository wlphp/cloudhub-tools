import crypto from "node:crypto";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";
import { decryptSecret } from "../core/crypto.mjs";

function encode(value) { return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
function authorization(accessKeyId, secret, host, method, query = "", signHost = true) {
  const start = Math.round(Date.now() / 1000) - 1;
  const signTime = `${start};${start + 900}`;
  const queryItems = String(query).split("&").filter(Boolean).map((entry) => { const [key, value = ""] = entry.split("=", 2); return [encode(decodeURIComponent(key)), encode(decodeURIComponent(value))]; }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const canonicalQuery = queryItems.map(([key, value]) => `${key}=${value}`).join("&");
  const signedQueryKeys = queryItems.map(([key]) => key).join(";");
  const canonicalRequest = `${method.toLowerCase()}\n/\n${canonicalQuery}\n${signHost ? `host=${host}` : ""}\n`;
  const signKey = crypto.createHmac("sha1", secret).update(signTime).digest("hex");
  const stringToSign = `sha1\n${signTime}\n${crypto.createHash("sha1").update(canonicalRequest).digest("hex")}\n`;
  const signature = crypto.createHmac("sha1", signKey).update(stringToSign).digest("hex");
  return `q-sign-algorithm=sha1&q-ak=${encode(accessKeyId)}&q-sign-time=${signTime}&q-key-time=${signTime}&q-header-list=${signHost ? "host" : ""}&q-url-param-list=${signedQueryKeys}&q-signature=${signature}`;
}

export async function request(id, bucket, location, query = "") {
  const row = getAccountSecretRecord(id);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "tencent") throw new Error("当前账号不是腾讯云账号");
  const host = bucket ? `${bucket}.cos.${location}.myqcloud.com` : "service.cos.myqcloud.com";
  const auth = authorization(row.access_key_id, decryptSecret(row.secret_ciphertext), host, "GET", query, Boolean(bucket));
  const response = await fetch(`https://${host}/${query ? `?${query}` : ""}`, { headers: { Host: host, Authorization: auth } });
  const xml = await response.text();
  if (!response.ok) throw new Error(`COS ${response.status}: ${xml.match(/<Message>([\s\S]*?)<\/Message>/i)?.[1] || xml.match(/<Code>([\s\S]*?)<\/Code>/i)?.[1] || "请求被拒绝"}`);
  return xml;
}

function xmlDecode(value = "") { return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }
function xmlText(xml, tag) { const match = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`)); return match ? xmlDecode(match[1]).trim() : ""; }
function xmlBlocks(xml, tag) { return [...String(xml).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g"))].map((match) => match[1]); }

export async function objects(id, bucket, location, { prefix = "", marker = "" } = {}) {
  const query = new URLSearchParams({ "list-type": "2", "max-keys": "1000", delimiter: "/" });
  if (prefix) query.set("prefix", prefix);
  if (marker) query.set("continuation-token", marker);
  const xml = await request(id, bucket, location, query.toString());
  return { objects: xmlBlocks(xml, "Contents").map((block) => ({ Key: xmlText(block, "Key"), LastModified: xmlText(block, "LastModified"), ETag: xmlText(block, "ETag"), Size: xmlText(block, "Size") })).filter((item) => item.Key && item.Key !== prefix), prefixes: xmlBlocks(xml, "CommonPrefixes").map((block) => xmlText(block, "Prefix")).filter(Boolean), isTruncated: xmlText(xml, "IsTruncated").toLowerCase() === "true", nextMarker: xmlText(xml, "NextContinuationToken") };
}

export async function acl(id, bucket, location) { return xmlText(await request(id, bucket, location, "acl"), "Permission") || "private"; }

export async function detail(id, bucket, location) {
  let marker = ""; let storage = 0; let objectCount = 0; const errors = [];
  try { for (let page = 0; page < 100; page += 1) { const listing = await objects(id, bucket, location, { marker }); objectCount += listing.objects.length; storage += listing.objects.reduce((total, object) => total + Number(object.Size || 0), 0); if (!listing.isTruncated || !listing.nextMarker) break; marker = listing.nextMarker; if (page === 99) errors.push("对象数量超过 100,000，容量统计仅包含前 100,000 个对象"); } } catch (error) { errors.push(error.message || String(error)); }
  let permission = "private"; try { permission = await acl(id, bucket, location); } catch (error) { errors.push(error.message || String(error)); }
  return { storage, objectCount, multipartUploadCount: 0, liveChannelCount: 0, monthTraffic: 0, monthRequests: 0, acl: permission, cnames: [], cors: [], errors };
}
