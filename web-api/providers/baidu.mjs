import crypto from "node:crypto";
import { writeApiLog } from "../core/database.mjs";
import { decryptSecret } from "../core/crypto.mjs";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";

function encode(value) { return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); }
function canonicalUri(pathname) { return pathname.split("/").map((part) => encode(decodeURIComponent(part))).join("/") || "/"; }
function queryText(query = {}, includeEmpty = false) { return Object.entries(query).filter(([key, value]) => includeEmpty || (value !== undefined && value !== null && value !== "")).map(([key, value]) => [encode(key), encode(value)]).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("&"); }
function canonicalHeaders(headers) { return Object.entries(headers).filter(([, value]) => value).map(([name, value]) => [name.toLowerCase(), encode(value)]).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}:${value}`).join("\n"); }
function errorMessage(message) { return /BceServiceRole_console_dns/i.test(message) ? "DNS 服务未完成控制台服务角色授权。请用主账号登录百度智能云控制台并开通/访问一次智能云解析 DNS，或为当前子用户授予 DNS 只读权限后重试。" : message; }
function account(accountId) {
  const row = getAccountSecretRecord(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "baidu") throw new Error("当前账号不是百度智能云账号");
  return row;
}

export async function request(accountId, host, pathname, query = {}, { method = "GET", body = null, includeEmptyQuery = false } = {}) {
  const row = account(accountId);
  const canonicalPath = canonicalUri(pathname);
  const encodedQuery = queryText(query, includeEmptyQuery);
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const authPrefix = `bce-auth-v1/${row.access_key_id}/${date}/1800`;
  const bodyText = body == null ? "" : JSON.stringify(body);
  const headers = { host, "x-bce-date": date };
  if (bodyText) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(bodyText)); }
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalRequest = `${method}\n${canonicalPath}\n${encodedQuery}\n${canonicalHeaders(headers)}`;
  const signingKey = crypto.createHmac("sha256", decryptSecret(row.secret_ciphertext)).update(authPrefix).digest("hex");
  const signature = crypto.createHmac("sha256", signingKey).update(canonicalRequest).digest("hex");
  const authorization = `${authPrefix}/${signedHeaders}/${signature}`;
  const response = await fetch(`https://${host}${canonicalPath}${encodedQuery ? `?${encodedQuery}` : ""}`, { method, headers: { ...headers, Authorization: authorization }, body: bodyText || undefined });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text || `百度智能云 ${response.status}` }; }
  if (!response.ok) { const message = errorMessage(data?.message || data?.error?.message || data?.code || `百度智能云 ${response.status}`); writeApiLog(accountId, host, `${method} ${pathname}`, query, data, "失败", message); throw new Error(message); }
  writeApiLog(accountId, host, `${method} ${pathname}`, query, data, "成功");
  return { data, text };
}

export async function pages(accountId, host, pathname, itemKeys) {
  const items = []; let marker = "";
  for (let page = 0; page < 100; page += 1) {
    const { data } = await request(accountId, host, pathname, { marker, maxKeys: 1000 });
    items.push(...itemKeys.flatMap((key) => Array.isArray(data?.[key]) ? data[key] : []));
    const nextMarker = String(data?.nextMarker || data?.NextMarker || "");
    if (!nextMarker || nextMarker === marker || data?.isTruncated === false || data?.IsTruncated === false) return items;
    marker = nextMarker;
  }
  throw new Error("分页超过 100 页，已停止读取");
}

export async function bccAction(accountId, region, instanceId, action, forceStop = false) {
  if (!region || !instanceId) throw new Error("缺少服务器地域或实例 ID");
  const host = `bcc.${region}.baidubce.com`;
  const pathname = `/v2/instance/${encodeURIComponent(instanceId)}`;
  if (action === "status") { const { data } = await request(accountId, host, pathname); const instance = data?.instance || data; return { status: instance?.status || "Unknown" }; }
  if (!["start", "stop", "reboot"].includes(action)) throw new Error("不支持的 BCC 服务器操作");
  const body = forceStop && (action === "stop" || action === "reboot") ? { forceStop: true } : null;
  const { data } = await request(accountId, host, pathname, { [action]: "" }, { method: "PUT", body, includeEmptyQuery: true });
  return data || { ok: true };
}

const BCC_REGIONS = ["bj", "bd", "gz", "su", "hkg", "fwh"];
function xmlText(xml, tag) { const match = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i")); return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : ""; }
function xmlBlocks(xml, tag) { return [...String(xml).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"))].map((match) => match[1]); }
function configuredRegions(accountId) { const row = account(accountId); const values = String(row.region_id || "bj").split(/[,，\s]+/).map((value) => value.trim()).filter(Boolean); return [...new Set([...(values.length ? values : ["bj"]), ...BCC_REGIONS])]; }
function instance(item, region) { const addresses = item.publicIps || item.publicIp || item.eip || []; const privateAddresses = item.internalIps || item.privateIps || item.internalIp || []; return { ...item, InstanceId: item.id || item.instanceId, InstanceName: item.name || item.instanceName || item.id, InstanceStatus: item.status, Status: item.status, PublicIpAddress: Array.isArray(addresses) ? addresses[0] || "" : addresses, PrivateIpAddress: Array.isArray(privateAddresses) ? privateAddresses[0] || "" : privateAddresses, InstanceType: item.cpuCount && item.memoryCapacityInGB ? `${item.cpuCount}C${item.memoryCapacityInGB}G` : item.spec || "", VpcId: item.vpcId || "", _region_id: region }; }
function rds(item, region) { return { ...item, DBInstanceId: item.instanceId || item.id, DBInstanceDescription: item.instanceName || item.name || item.instanceId, DBInstanceStatus: item.status, DBInstanceClass: item.instanceClass || item.instanceType || "", DBInstanceStorage: Number(item.volumeCapacity || item.capacity || 0), ConnectionString: item.endpoint || item.vip || "", Port: item.port || "", Engine: item.engine || item.engineType || "", EngineVersion: item.engineVersion || "", CreateTime: item.createTime || "", _region_id: region }; }
function redis(item, region) { return { ...item, InstanceId: item.instanceId || item.id, InstanceName: item.instanceName || item.name || item.instanceId, InstanceStatus: item.instanceStatus || item.status, InstanceType: item.engine || "Redis", InstanceClass: item.instanceClass || item.nodeType || "", Capacity: Number(item.capacity || item.memorySize || 0), ConnectionDomain: item.domain || item.endpoint || item.vip || "", Port: item.port || "", EngineVersion: item.engineVersion || "", NetworkType: item.vnetIp || item.vpcId || "", CreateTime: item.instanceCreateTime || "", _region_id: region }; }
function zone(item) { return { ...item, DomainName: item.domain || item.name || item.zoneName, DomainStatus: item.status || "ACTIVE", ZoneId: item.id || item.domainId || item.domain, RecordCount: Number(item.recordCount || item.recordNum || 0), RegistrationDate: item.createTime || "", _region_id: "global", _baidu_public_zone: true }; }
function bucket(item) { const name = item.name || item.bucketName; const region = item.location || item.region || "bj"; return { ...item, Name: name, BucketName: name, Location: region, CreationDate: item.creationDate || item.createTime || "", StorageClass: item.storageClass || "STANDARD", Acl: item.acl || "private", ExtranetEndpoint: name ? `${name}.${region}.bcebos.com` : "-", IntranetEndpoint: "-", _region_id: region }; }

export async function resources(accountId, type) {
  const regions = configuredRegions(accountId); const items = []; const errors = [];
  if (type === "domain") { try { items.push(...(await pages(accountId, "dns.baidubce.com", "/v1/dns/zone", ["zones"])).map(zone)); } catch (error) { errors.push(error.message); } return { resource_type: type, items, errors, fetched_at: Date.now() }; }
  if (type === "oss") { try { const { data, text } = await request(accountId, "bj.bcebos.com", "/"); const values = Array.isArray(data?.buckets) ? data.buckets : xmlBlocks(text, "Bucket").map((block) => ({ name: xmlText(block, "Name"), location: xmlText(block, "Location"), creationDate: xmlText(block, "CreationDate") })); items.push(...values.map(bucket).filter((item) => item.Name)); } catch (error) { errors.push(error.message); } return { resource_type: type, items, errors, fetched_at: Date.now() }; }
  const definitions = { ecs: ["bcc", "/v2/instance", ["instances", "instanceList"], instance], rds: ["rds", "/v1/instance", ["instances", "instanceList"], rds], redis: ["redis", "/v2/instance", ["instances", "instanceList"], redis] };
  const definition = definitions[type];
  if (!definition) return { resource_type: type, items, errors: [`百度智能云暂未接入 ${type} 资源`], fetched_at: Date.now() };
  const [name, pathname, keys, normalize] = definition;
  for (const region of regions) { try { items.push(...(await pages(accountId, `${name}.${region}.baidubce.com`, pathname, keys)).map((item) => normalize(item, region))); } catch (error) { errors.push(`${region}: ${error.message}`); } }
  return { resource_type: type, items, errors, fetched_at: Date.now() };
}

export async function verify(accountId) {
  const regions = configuredRegions(accountId);
  await pages(accountId, `bcc.${regions[0]}.baidubce.com`, "/v2/instance", ["instances", "instanceList"]);
  return { provider: "baidu", verified: true, region_count: regions.length, regions, default_region: regions[0] };
}
