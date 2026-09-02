import crypto from "node:crypto";
import { writeApiLog } from "../core/database.mjs";
import { decryptSecret } from "../core/crypto.mjs";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";

function encode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function queryText(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [encode(key), encode(value)])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function account(accountId) {
  const row = getAccountSecretRecord(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "volcengine") throw new Error("当前账号不是火山引擎账号");
  return row;
}

function signingKey(row, service, region, date) {
  const secret = decryptSecret(row.secret_ciphertext);
  const dateKey = crypto.createHmac("sha256", secret).update(date).digest();
  const regionKey = crypto.createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = crypto.createHmac("sha256", regionKey).update(service).digest();
  return crypto.createHmac("sha256", serviceKey).update("request").digest();
}

export async function request(accountId, service, version, action, params = {}, region = "cn-beijing") {
  const row = account(accountId);
  const selectedRegion = String(region || row.region_id || "cn-beijing");
  const host = "open.volcengineapi.com";
  const requestParams = { ...params, Action: action, Version: version };
  const query = queryText(requestParams);
  const dateTime = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = dateTime.slice(0, 8);
  const canonicalHeaders = `x-date:${dateTime}\n`;
  const signedHeaders = "x-date";
  const canonicalRequest = `GET\n/\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${crypto.createHash("sha256").update("").digest("hex")}`;
  const credentialScope = `${date}/${selectedRegion}/${service}/request`;
  const stringToSign = `HMAC-SHA256\n${dateTime}\n${credentialScope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const signature = crypto.createHmac("sha256", signingKey(row, service, selectedRegion, date)).update(stringToSign).digest("hex");
  const authorization = `HMAC-SHA256 Credential=${row.access_key_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}/?${query}`, { headers: { "X-Date": dateTime, Authorization: authorization } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ResponseMetadata?.Error || data?.Error) {
    const apiError = data?.ResponseMetadata?.Error || data?.Error || {};
    const message = apiError.Message || apiError.Code || data?.Message || `火山引擎 ${response.status}`;
    writeApiLog(accountId, host, action, requestParams, data, "失败", message);
    throw new Error(message);
  }
  writeApiLog(accountId, host, action, requestParams, data, "成功");
  return data?.Result ?? data;
}

export async function jsonRequest(accountId, service, version, action, payload = {}, region = "cn-beijing") {
  const row = account(accountId);
  const selectedRegion = String(region || row.region_id || "cn-beijing");
  const host = `${service}.volcengineapi.com`;
  const requestParams = { Action: action, Version: version };
  const query = queryText(requestParams);
  const body = JSON.stringify(payload);
  const dateTime = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = dateTime.slice(0, 8);
  const payloadHash = crypto.createHash("sha256").update(body).digest("hex");
  const canonicalHeaders = `x-date:${dateTime}\n`;
  const signedHeaders = "x-date";
  const canonicalRequest = `POST\n/\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${date}/${selectedRegion}/${service}/request`;
  const stringToSign = `HMAC-SHA256\n${dateTime}\n${credentialScope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const signature = crypto.createHmac("sha256", signingKey(row, service, selectedRegion, date)).update(stringToSign).digest("hex");
  const authorization = `HMAC-SHA256 Credential=${row.access_key_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}/?${query}`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Date": dateTime, Authorization: authorization }, body });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { Message: text || `火山引擎 ${response.status}` }; }
  if (!response.ok || data?.ResponseMetadata?.Error || data?.Error) {
    const apiError = data?.ResponseMetadata?.Error || data?.Error || {};
    const message = apiError.Message || apiError.Code || data?.Message || `火山引擎 ${response.status}`;
    writeApiLog(accountId, host, action, requestParams, data, "失败", message);
    throw new Error(message);
  }
  writeApiLog(accountId, host, action, requestParams, data, "成功");
  return data?.Result ?? data;
}

function xmlText(xml, tag) { const match = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i")); return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : ""; }
function xmlBlocks(xml, tag) { return [...String(xml).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"))].map((match) => match[1]); }

export async function tosBuckets(accountId) {
  const row = account(accountId);
  const region = String(row.region_id || "cn-beijing");
  const host = `tos-${region}.volces.com`;
  const dateTime = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = dateTime.slice(0, 8);
  const payloadHash = crypto.createHash("sha256").update("").digest("hex");
  const canonicalHeaders = `host:${host}\nx-tos-content-sha256:${payloadHash}\nx-tos-date:${dateTime}\n`;
  const signedHeaders = "host;x-tos-content-sha256;x-tos-date";
  const canonicalRequest = `GET\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${date}/${region}/tos/request`;
  const stringToSign = `TOS4-HMAC-SHA256\n${dateTime}\n${credentialScope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const signature = crypto.createHmac("sha256", signingKey(row, "tos", region, date)).update(stringToSign).digest("hex");
  const authorization = `TOS4-HMAC-SHA256 Credential=${row.access_key_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}/`, { headers: { Host: host, "X-Tos-Date": dateTime, "X-Tos-Content-Sha256": payloadHash, Authorization: authorization } });
  const xml = await response.text();
  if (!response.ok) {
    const message = xmlText(xml, "Message") || xmlText(xml, "Code") || `TOS ${response.status}`;
    writeApiLog(accountId, host, "ListBuckets", {}, { body: xml }, "失败", message);
    throw new Error(message);
  }
  let buckets = [];
  try { const data = JSON.parse(xml); buckets = Array.isArray(data?.Buckets) ? data.Buckets : (data?.Buckets?.Bucket || data?.Bucket || []); }
  catch { buckets = xmlBlocks(xml, "Bucket").map((block) => ({ Name: xmlText(block, "Name"), Location: xmlText(block, "Location"), CreationDate: xmlText(block, "CreationDate") })); }
  const items = buckets.map((bucket) => { const name = bucket.Name || bucket.BucketName || ""; const location = bucket.Location || bucket.Region || region; return { Name: name, Location: location, CreationDate: bucket.CreationDate || "", StorageClass: "Standard", ExtranetEndpoint: `${name}.tos-${location}.volces.com`, Acl: "private" }; }).filter((item) => item.Name);
  writeApiLog(accountId, host, "ListBuckets", {}, { count: items.length }, "成功");
  return items;
}

function arr(data, path) {
  let value = data;
  for (const key of path) value = value?.[key];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function instance(item, region) { return { ...item, InstanceId: item.InstanceId || item.InstanceID, InstanceName: item.InstanceName || item.InstanceId || item.InstanceID, InstanceStatus: item.Status || item.InstanceStatus, Status: item.Status || item.InstanceStatus, PublicIpAddress: item.PublicIpAddress || item.PublicIpAddresses?.[0] || item.EipAddress || "", _region_id: region }; }
function rds(item, region) { return { ...item, DBInstanceId: item.DBInstanceId || item.InstanceId || item.InstanceID, DBInstanceDescription: item.DBInstanceName || item.InstanceName || item.DBInstanceId || item.InstanceId, DBInstanceStatus: item.Status || item.DBInstanceStatus, Engine: item.Engine || "MySQL", _region_id: region }; }
function swas(item, region) { return { ...item, InstanceId: item.InstanceId || item.InstanceID, InstanceName: item.InstanceName || item.Name || item.InstanceId || item.InstanceID, InstanceStatus: item.Status || item.InstanceStatus, Status: item.Status || item.InstanceStatus, PublicIpAddress: item.PublicIpAddress || item.PublicIp || item.PublicIpAddresses?.[0] || item.EipAddress || "", _region_id: region }; }
function redis(item, region) { const instanceId = item.InstanceId || item.InstanceID || item.DBInstanceId || item.RedisInstanceId; return { ...item, KVStoreInstanceId: instanceId, InstanceId: instanceId, InstanceName: item.InstanceName || item.DBInstanceName || item.Name || instanceId, InstanceStatus: item.Status || item.InstanceStatus, DBInstanceStatus: item.Status || item.InstanceStatus, EngineVersion: item.EngineVersion || item.RedisVersion || "Redis", _region_id: region }; }
function edgeDomain(item) { const domain = item.DomainName || item.Domain || item.Name || ""; return { ...item, SiteId: item.DomainId || item.DomainID || domain, SiteName: domain, DomainName: domain, Status: item.Status || item.DomainStatus || "", AccessType: item.ServiceType || item.BusinessType || "CDN", Coverage: item.Area || item.Scope || "", PlanName: item.Plan || item.ProductType || "" }; }
function dnsZone(item) { const expiresAt = Number(item.ExpiredTime || 0); return { ...item, DomainName: item.ZoneName || "", DomainStatus: "正常", RegistrationDate: item.CreatedAt || "", ExpirationDate: expiresAt ? new Date(expiresAt < 1e12 ? expiresAt * 1000 : expiresAt).toISOString() : "", RecordCount: item.RecordCount || 0 }; }

export async function resources(accountId, type) {
  const row = account(accountId);
  const region = String(row.region_id || "cn-beijing");
  const errors = [];
  try {
    if (type === "ecs") { const data = await request(accountId, "ecs", "2020-04-01", "DescribeInstances", { PageSize: 100, PageNumber: 1 }, region); const items = arr(data, ["Instances"]).length ? arr(data, ["Instances"]) : arr(data, ["Instances", "Instance"]); return { resource_type: type, items: items.map((item) => instance(item, region)), errors, fetched_at: Date.now() }; }
    if (type === "oss") return { resource_type: type, items: await tosBuckets(accountId), errors, fetched_at: Date.now() };
    if (type === "domain") { const data = await jsonRequest(accountId, "dns", "2018-08-01", "ListZones", { PageSize: 100, PageNumber: 1 }, region); return { resource_type: type, items: arr(data, ["Zones"]).map(dnsZone), errors, fetched_at: Date.now() }; }
    const definitions = { rds: ["rds_mysql", "2018-01-01", "DescribeDBInstances", rds, "DBInstances", "Items"], swas: ["lighthouse", "2020-04-01", "DescribeInstances", swas, "Instances", "InstanceSet"], redis: ["Redis", "2020-12-07", "DescribeDBInstances", redis, "DBInstances", "Items"], esa: ["cdn", "2021-03-01", "ListCdnDomains", edgeDomain, "Domains", "DomainList"] };
    const definition = definitions[type];
    if (!definition) return { resource_type: type, items: [], errors: [`火山引擎暂未接入 ${type} 资源`], fetched_at: Date.now() };
    const [service, version, action, normalize, firstKey, fallbackKey] = definition;
    const data = await request(accountId, service, version, action, { PageSize: 100, PageNumber: 1 }, region);
    const items = arr(data, [firstKey]).length ? arr(data, [firstKey]) : arr(data, [fallbackKey]);
    return { resource_type: type, items: items.map((item) => normalize(item, region)), errors, fetched_at: Date.now() };
  } catch (error) { errors.push(error.message); return { resource_type: type, items: [], errors, fetched_at: Date.now() }; }
}
