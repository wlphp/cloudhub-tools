import crypto from "node:crypto";
import { writeApiLog } from "../core/database.mjs";
import { decryptSecret } from "../core/crypto.mjs";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";

export function rpcEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export async function rpc(accountId, endpoint, version, action, params = {}) {
  const row = getAccountSecretRecord(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "aliyun") throw new Error(`${row.cloud_type === "tencent" ? "腾讯云" : "当前云类型"}资源 API 尚未接入`);
  const secret = decryptSecret(row.secret_ciphertext).trim();
  const query = { ...params, AccessKeyId: row.access_key_id, Action: action, Format: "JSON", SignatureMethod: "HMAC-SHA1", SignatureNonce: crypto.randomUUID(), SignatureVersion: "1.0", Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), Version: version };
  const encoded = Object.entries(query).map(([key, value]) => [rpcEncode(key), rpcEncode(value)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const canonical = encoded.map(([key, value]) => `${key}=${value}`).join("&");
  const stringToSign = `GET&%2F&${rpcEncode(canonical)}`;
  query.Signature = crypto.createHmac("sha1", `${secret}&`).update(stringToSign).digest("base64");
  const finalUrl = new URL(`https://${endpoint}/`);
  for (const [key, value] of Object.entries(query)) finalUrl.searchParams.set(key, String(value));
  const response = await fetch(finalUrl.toString());
  const data = await response.json();
  if (!response.ok || (data.Code && data.Code !== "200" && data.Code !== "Success")) {
    const message = data.Message || data.Code || `Aliyun ${response.status}`;
    writeApiLog(accountId, endpoint, action, query, data, "失败", message);
    throw new Error(message);
  }
  writeApiLog(accountId, endpoint, action, query, data, "成功");
  return data;
}

function arr(data, path) {
  let value = data;
  for (const key of path) value = value?.[key];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export async function regions(accountId) {
  const data = await rpc(accountId, "ecs.aliyuncs.com", "2014-05-26", "DescribeRegions");
  return arr(data, ["Regions", "Region"]).map((item) => item.RegionId).filter(Boolean);
}

export async function resources(accountId, type) {
  const items = [];
  const errors = [];
  if (type === "domain") {
    const [registration, dns] = await Promise.allSettled([
      rpc(accountId, "domain.aliyuncs.com", "2018-01-29", "QueryDomainList", { PageNum: "1", PageSize: "100" }),
      rpc(accountId, "alidns.aliyuncs.com", "2015-01-09", "DescribeDomains", { PageNumber: "1", PageSize: "20" }),
    ]);
    const merged = new Map();
    if (registration.status === "fulfilled") for (const item of arr(registration.value, ["Data", "Domain"])) { const name = String(item.DomainName || "").trim(); if (name) merged.set(name.toLowerCase(), { ...item }); }
    else errors.push(`域名注册: ${registration.reason?.message || registration.reason}`);
    if (dns.status === "fulfilled") for (const item of arr(dns.value, ["Domains", "Domain"])) { const name = String(item.DomainName || "").trim(); if (!name) continue; const key = name.toLowerCase(); merged.set(key, { ...(merged.get(key) || { DomainName: name }), ...item, DomainName: name, RecordCount: Number(item.RecordCount || 0) }); }
    else errors.push(`AliDNS: ${dns.reason?.message || dns.reason}`);
    return { resource_type: type, items: [...merged.values()], errors, fetched_at: Date.now() };
  }
  if (type !== "ecs" && type !== "swas" && type !== "rds" && type !== "redis") return { resource_type: type, items, errors: [`阿里云 RPC 暂未接入 ${type} 资源`], fetched_at: Date.now() };
  const regionIds = type === "ecs" || type === "rds" || type === "redis" ? await regions(accountId) : ["cn-hangzhou", "cn-shanghai", "cn-beijing", "cn-shenzhen", "cn-hongkong", "ap-southeast-1"];
  for (const regionId of regionIds) {
    try {
      let data;
      if (type === "ecs") data = await rpc(accountId, `ecs.${regionId}.aliyuncs.com`, "2014-05-26", "DescribeInstances", { RegionId: regionId, PageSize: "100" });
      else if (type === "swas") data = await rpc(accountId, `swas.${regionId}.aliyuncs.com`, "2020-06-01", "ListInstances", { RegionId: regionId, PageSize: "100" });
      else data = await rpc(accountId, type === "rds" ? "rds.aliyuncs.com" : "r-kvstore.aliyuncs.com", type === "rds" ? "2014-08-15" : "2015-01-01", type === "rds" ? "DescribeDBInstances" : "DescribeInstances", { RegionId: regionId, PageSize: "100" });
      const path = type === "ecs" ? ["Instances", "Instance"] : type === "swas" ? ["Instances"] : type === "rds" ? ["Items", "DBInstance"] : ["Instances", "KVStoreInstance"];
      for (const item of arr(data, path)) items.push({ ...item, _region_id: regionId });
    } catch (error) { errors.push(`${regionId}: ${error.message}`); }
  }
  return { resource_type: type, items, errors, fetched_at: Date.now() };
}
