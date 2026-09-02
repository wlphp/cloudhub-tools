import crypto from "node:crypto";
import { writeApiLog } from "../core/database.mjs";
import { decryptSecret } from "../core/crypto.mjs";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";

function firstAddress(value) {
  if (Array.isArray(value)) return value.find((item) => item !== undefined && item !== null && String(item).trim() !== "") || "";
  return value === undefined || value === null ? "" : String(value);
}

export async function request(accountId, action, params = {}) {
  const row = getAccountSecretRecord(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "ucloud") throw new Error("当前账号不是 UCloud 账号");
  const query = { Action: action, PublicKey: row.access_key_id, ...params };
  const plain = Object.keys(query).sort().map((key) => `${key}${query[key]}`).join("") + decryptSecret(row.secret_ciphertext);
  query.Signature = crypto.createHash("sha1").update(plain).digest("base64");
  const response = await fetch(`https://api.ucloud.cn/?${new URLSearchParams(query)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || Number(data?.RetCode || 0) !== 0) { const message = data?.Message || data?.message || `UCloud ${response.status}`; writeApiLog(accountId, "api.ucloud.cn", action, params, data, "失败", message); throw new Error(message); }
  writeApiLog(accountId, "api.ucloud.cn", action, params, data, "成功");
  return data;
}

export async function pages(accountId, action, region, keys) {
  const items = [];
  for (let offset = 0; offset < 100_000; offset += 100) {
    const data = await request(accountId, action, { Region: region, Offset: offset, Limit: 100 });
    const page = keys.flatMap((key) => Array.isArray(data?.[key]) ? data[key] : []);
    items.push(...page);
    if (page.length < 100 || items.length >= Number(data?.TotalCount || data?.Total || Infinity)) return items;
  }
  throw new Error("分页超过 1000 页，已停止读取");
}

function instance(item, region) { return { ...item, InstanceId: item.UHostId, InstanceName: item.Name || item.UHostId, InstanceStatus: item.State, Status: item.State, PublicIpAddress: firstAddress(item.IPSet?.filter((ip) => ip.Type === "EIP") || item.IPSet), PrivateIpAddress: firstAddress(item.IPSet?.filter((ip) => ip.Type !== "EIP")), InstanceType: item.UHostType || item.CPU || "", VpcId: item.VPCId || "", _region_id: region }; }
function rds(item, region) { return { ...item, DBInstanceId: item.DBId, DBInstanceDescription: item.Name || item.DBId, DBInstanceStatus: item.State, DBInstanceClass: item.MemoryLimit || item.DBType || "", DBInstanceStorage: Number(item.DiskSpace || 0), ConnectionString: item.VirtualIP || "", Port: item.Port || "", Engine: item.DBType || "", EngineVersion: item.DBVersion || "", CreateTime: item.CreateTime || "", _region_id: region }; }
function redis(item, region) { return { ...item, InstanceId: item.GroupId, InstanceName: item.Name || item.GroupId, InstanceStatus: item.State, InstanceType: "Redis", InstanceClass: item.MemoryLimit || "", Capacity: Number(item.MemoryLimit || 0), ConnectionDomain: item.VirtualIP || item.VIP || "", Port: item.Port || "", EngineVersion: item.Version || "", NetworkType: item.VPCId || "", _region_id: region }; }
function bucket(item, region) { const name = item.BucketName || item.Name; return { ...item, Name: name, BucketName: name, Location: item.Region || region, CreationDate: item.CreateTime || "", StorageClass: item.StorageClass || "STANDARD", Acl: item.ACL || "private", ExtranetEndpoint: "-", IntranetEndpoint: "-", _region_id: item.Region || region }; }
function zone(item) { return { ...item, DomainName: item.DomainName || item.Domain, DomainStatus: item.Status || "ACTIVE", ZoneId: item.DomainId || item.DomainName, RecordCount: Number(item.RecordCount || 0), RegistrationDate: item.CreateTime || "", _region_id: "global", _ucloud_dns: true }; }

export async function resources(accountId, type, regions = ["cn-bj2"]) {
  const items = [];
  const errors = [];
  if (type === "domain") {
    try { items.push(...(await request(accountId, "DescribeUDNSDomain", { Offset: 0, Limit: 100 })).DomainSet || []); }
    catch (error) { errors.push(error.message); }
    return { resource_type: type, items: items.map(zone), errors, fetched_at: Date.now() };
  }
  const definitions = { ecs: ["DescribeUHostInstance", ["UHostSet"], instance], rds: ["DescribeUDBInstance", ["DataSet"], rds], redis: ["DescribeURedisGroup", ["DataSet"], redis], oss: ["DescribeUFileBucket", ["DataSet"], bucket] };
  const definition = definitions[type];
  if (!definition) return { resource_type: type, items, errors: [`UCloud 暂未接入 ${type} 资源`], fetched_at: Date.now() };
  const [action, keys, normalize] = definition;
  for (const region of regions) {
    try { items.push(...(await pages(accountId, action, region, keys)).map((item) => normalize(item, region))); }
    catch (error) { errors.push(`${region}: ${error.message}`); }
  }
  return { resource_type: type, items, errors, fetched_at: Date.now() };
}

export async function verify(accountId, regions = ["cn-bj2"]) {
  await request(accountId, "DescribeUHostInstance", { Region: regions[0], Offset: 0, Limit: 1 });
  return { provider: "ucloud", verified: true, region_count: regions.length, regions, default_region: regions[0] };
}
