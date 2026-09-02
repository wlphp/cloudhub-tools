import crypto from "node:crypto";
import { writeApiLog } from "../core/database.mjs";
import { decryptSecret } from "../core/crypto.mjs";
import { getAccountRegion, getAccountSecretRecord } from "../repositories/accounts.mjs";
import * as cosProvider from "./tencent-cos.mjs";

function arr(data, path) { let value = data; for (const key of path) value = value?.[key]; if (!value) return []; return Array.isArray(value) ? value : [value]; }
function number(value) { const result = Number(value || 0); return Number.isFinite(result) ? result : 0; }
function instance(item, region) { const network = item.InternetAccessible || {}; const state = String(item.InstanceState || "").toUpperCase(); return { ...item, InstanceName: item.InstanceName || item.InstanceId, Status: state === "RUNNING" ? "Running" : state === "STOPPED" ? "Stopped" : item.InstanceState || "Unknown", PublicIpAddress: item.PublicIpAddresses || [], PrivateIpAddress: item.PrivateIpAddresses || [], Cpu: item.CPU || 0, Memory: item.Memory || 0, InternetMaxBandwidthIn: 0, InternetMaxBandwidthOut: network.InternetMaxBandwidthOut || 0, OSName: item.OsName || item.OsType || "-", CreationTime: item.CreatedTime || "", ExpiredTime: item.ExpiredTime || "", _region_id: region.Region || "", _region_name: region.RegionName || region.Region || "" }; }
function lighthouseInstance(item, region) { const state = String(item.InstanceState || item.InstanceStatus || "").toUpperCase(); const status = state === "RUNNING" ? "Running" : state === "STOPPED" ? "Stopped" : item.InstanceState || item.InstanceStatus || "Unknown"; return { ...item, InstanceName: item.InstanceName || item.InstanceId, InstanceStatus: status, Status: status, PublicIpAddress: item.PublicAddresses || item.PublicIpAddresses || [], PublicIp: Array.isArray(item.PublicAddresses) ? item.PublicAddresses[0] || "" : item.PublicAddresses || "", ImageName: item.BlueprintName || item.BlueprintId || "", PlanId: item.BundleId || item.BundleName || "", ExpiredTime: item.ExpiredTime || "", _region_id: region }; }
function cdbInstance(item, region) { const status = String(item.Status || item.DBInstanceStatus || ""); return { ...item, DBInstanceId: item.InstanceId || item.DBInstanceId, DBInstanceDescription: item.InstanceName || item.DBInstanceDescription || item.InstanceId, DBInstanceStatus: status === "1" ? "Running" : status === "0" ? "Stopped" : status, DBInstanceType: item.DeviceType || item.InstanceType || "", DBInstanceClass: item.InstanceType || item.Model || "", DBInstanceStorage: item.Volume || item.Storage || 0, ConnectionString: item.Vip || item.ConnectionString || "", Port: item.Vport || item.Port || "", DBInstanceNetType: item.ProjectId ? "私有网络" : "-", Engine: item.Engine || "MySQL", EngineVersion: item.EngineVersion || "", CreateTime: item.CreateTime || "", ExpireTime: item.DeadlineTime || item.ExpireTime || "", _region_id: region }; }
function redisInstance(item, region) { const status = String(item.Status || item.InstanceStatus || ""); return { ...item, InstanceId: item.InstanceId, InstanceName: item.InstanceName || item.InstanceId, InstanceStatus: ["2", "RUNNING", "NORMAL"].includes(status.toUpperCase()) ? "Normal" : status, InstanceType: item.Type || item.TypeName || "", InstanceClass: item.Size || item.TypeName || "", Capacity: item.Size || item.Capacity || 0, Bandwidth: item.Bandwidth || 0, Connections: item.ClientLimit || item.Connections || 0, ConnectionDomain: item.WanIp || item.PrivateIp || item.ConnectionDomain || "", Port: item.Port || "", EngineVersion: item.CurrentRedisVersion || item.RedisVersion || "", NetworkType: item.NetType || "", ChargeType: item.BillingMode || "", EndTime: item.DeadTime || item.EndTime || "", ArchitectureType: item.Type || "standard", _region_id: region }; }
function edgeZone(item) { return { ...item, SiteId: item.ZoneId || item.Id, SiteName: item.ZoneName || item.ZoneId, DomainName: item.ZoneName || "", Status: item.ActiveStatus || item.Status || "", AccessType: item.Type || item.ZoneType || "", Coverage: item.Area || item.PlanType || "", PlanName: item.PlanType || item.Plan || "" }; }
function registeredDomain(item) { return { ...item, DomainName: item.DomainName || item.Name, RegistrationDate: item.RegistrationDate || item.CreationDate || item.CreatedOn || "", ExpirationDate: item.ExpirationDate || item.ExpiredDate || "", RegistrantOrganization: item.RegistrantOrganization || item.RegistrantName || "", DomainAuditStatus: item.RealNameAuditStatus || item.DomainAuditStatus || "", DomainStatus: item.Status || "", DnsServers: item.DnsList || item.NameServerSet || [] }; }
function hostedDomain(item) { return { ...item, DomainName: item.Name || item.DomainName, RecordCount: number(item.RecordCount), VersionCode: item.Grade || item.GradeTitle || "", CreateTime: item.CreatedOn || item.CreatedAt || "", DomainStatus: item.Status || "", DnsServers: item.NameServers || [], DnsSource: "DNSPod" }; }
async function paged(accountId, service, version, action, payload, path, region = "") { const items = []; for (let offset = 0; offset < 10000; offset += 100) { const data = await request(accountId, service, version, action, { ...payload, Offset: offset, Limit: 100 }, region); const page = arr(data, path); items.push(...page); const total = number(data.TotalCount || data.DomainCountInfo?.AllTotal || data.DomainCountInfo?.TotalCount); if (!page.length || page.length < 100 || (total && items.length >= total)) break; } return items; }
function xmlDecode(value = "") { return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }
function xmlText(xml, tag) { const match = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`)); return match ? xmlDecode(match[1]).trim() : ""; }
function xmlBlocks(xml, tag) { return [...String(xml).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g"))].map((match) => match[1]); }
async function cosBuckets(accountId) { const xml = await cosProvider.request(accountId, "", ""); return xmlBlocks(xml, "Bucket").map((block) => ({ Name: xmlText(block, "Name"), Location: xmlText(block, "Location"), CreationDate: xmlText(block, "CreationDate"), StorageClass: "Standard", ExtranetEndpoint: `${xmlText(block, "Name")}.cos.${xmlText(block, "Location")}.myqcloud.com`, IntranetEndpoint: "-", Acl: "private" })).filter((bucket) => bucket.Name && bucket.Location); }

export async function request(accountId, service, version, action, payload = {}, region = "") {
  const row = getAccountSecretRecord(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "tencent") throw new Error("当前账号不是腾讯云账号");
  const host = `${service}.tencentcloudapi.com`;
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const hashedPayload = crypto.createHash("sha256").update(body).digest("hex");
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const secret = decryptSecret(row.secret_ciphertext);
  const secretDate = crypto.createHmac("sha256", `TC3${secret}`).update(date).digest();
  const secretService = crypto.createHmac("sha256", secretDate).update(service).digest();
  const secretSigning = crypto.createHmac("sha256", secretService).update("tc3_request").digest();
  const signature = crypto.createHmac("sha256", secretSigning).update(stringToSign).digest("hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${row.access_key_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Host: host,
      Authorization: authorization,
      "X-TC-Action": action,
      "X-TC-Version": version,
      "X-TC-Timestamp": String(timestamp),
      ...(region ? { "X-TC-Region": region } : {}),
    },
    body,
  });
  const data = await response.json().catch(() => ({}));
  const apiError = data?.Response?.Error;
  if (!response.ok || apiError) {
    const message = apiError?.Message || apiError?.Code || `腾讯云 ${response.status}`;
    writeApiLog(accountId, host, action, payload, data, "失败", message);
    throw new Error(message);
  }
  writeApiLog(accountId, host, action, payload, data, "成功");
  return data.Response || {};
}

export async function resources(id, type) {
  const errors = [];
  if (type === "ecs") {
    let regions;
    try { regions = arr(await request(id, "cvm", "2017-03-12", "DescribeRegions"), ["RegionSet"]); } catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; }
    const items = [];
    for (const region of regions.filter((item) => String(item.RegionState || "AVAILABLE").toUpperCase() === "AVAILABLE")) { try { items.push(...(await paged(id, "cvm", "2017-03-12", "DescribeInstances", {}, ["InstanceSet"], String(region.Region || ""))).map((item) => instance(item, region))); } catch (error) { errors.push(`${region.Region || "未知地域"}: ${error.message}`); } }
    return { resource_type: type, items, errors, fetched_at: Date.now() };
  }
  if (type === "domain") {
    const [registered, hosted] = await Promise.allSettled([paged(id, "domain", "2018-08-08", "DescribeDomainNameList", {}, ["DomainSet"]), paged(id, "dnspod", "2021-03-23", "DescribeDomainList", {}, ["DomainList"])]);
    const merged = new Map();
    if (registered.status === "fulfilled") for (const item of registered.value) { const value = registeredDomain(item); if (value.DomainName) merged.set(String(value.DomainName).toLowerCase(), value); } else errors.push(`域名注册: ${registered.reason?.message || registered.reason}`);
    if (hosted.status === "fulfilled") for (const item of hosted.value) { const value = hostedDomain(item); if (!value.DomainName) continue; merged.set(String(value.DomainName).toLowerCase(), { ...(merged.get(String(value.DomainName).toLowerCase()) || {}), ...value, DomainName: value.DomainName }); } else errors.push(`DNSPod: ${hosted.reason?.message || hosted.reason}`);
    return { resource_type: type, items: [...merged.values()], errors, fetched_at: Date.now() };
  }
  if (type === "swas") {
    const account = getAccountRegion(id); const fallbackRegion = String(account?.region_id || "ap-guangzhou"); let regions = [fallbackRegion];
    try { regions = [...new Set(arr(await request(id, "lighthouse", "2020-03-24", "DescribeRegions"), ["RegionSet"]).filter((item) => String(item.RegionState || "AVAILABLE").toUpperCase() === "AVAILABLE").map((item) => String(item.Region || "")).filter(Boolean))]; } catch (error) { errors.push(`读取轻量服务器地域失败，已仅查询 ${fallbackRegion}: ${error.message}`); }
    const items = []; for (const region of regions) { try { items.push(...(await paged(id, "lighthouse", "2020-03-24", "DescribeInstances", {}, ["InstanceSet"], region)).map((item) => lighthouseInstance(item, region))); } catch (error) { errors.push(`${region}: ${error.message}`); } }
    return { resource_type: type, items, errors, fetched_at: Date.now() };
  }
  if (type === "rds" || type === "redis") {
    let regions; try { regions = arr(await request(id, "cvm", "2017-03-12", "DescribeRegions"), ["RegionSet"]).filter((item) => String(item.RegionState || "AVAILABLE").toUpperCase() === "AVAILABLE").map((item) => String(item.Region || "")).filter(Boolean); } catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; }
    const items = []; const service = type === "rds" ? "cdb" : "redis"; const version = type === "rds" ? "2017-03-20" : "2018-04-12"; const action = type === "rds" ? "DescribeDBInstances" : "DescribeInstances"; const path = type === "rds" ? ["Items"] : ["InstanceSet"];
    for (const region of regions) { try { const values = await paged(id, service, version, action, {}, path, region); items.push(...values.map((item) => type === "rds" ? cdbInstance(item, region) : redisInstance(item, region))); } catch (error) { errors.push(`${region}: ${error.message}`); } }
    return { resource_type: type, items, errors, fetched_at: Date.now() };
  }
  if (type === "oss") { try { return { resource_type: type, items: await cosBuckets(id), errors, fetched_at: Date.now() }; } catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; } }
  if (type === "esa") { try { return { resource_type: type, items: (await paged(id, "teo", "2022-09-01", "DescribeZones", {}, ["Zones"])).map(edgeZone), errors, fetched_at: Date.now() }; } catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; } }
  return { resource_type: type, items: [], errors: [`腾讯云暂未接入 ${type} 资源`], fetched_at: Date.now() };
}
