import crypto from "node:crypto";
import { writeApiLog } from "../core/database.mjs";
import { decryptSecret } from "../core/crypto.mjs";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";

function arrayAt(value, path) {
  let current = value;
  for (const key of path) current = current?.[key];
  return Array.isArray(current) ? current : [];
}

function hmac(key, value) { return crypto.createHmac("sha256", key).update(value).digest(); }

export function total(data) {
  const value = data?.totalCount ?? data?.total ?? data?.totalNum ?? data?.totalSize ?? data?.pageInfo?.total ?? data?.page?.total;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

export async function pages(fetchPage, path, pageSize) {
  const items = [];
  for (let page = 1; page <= 100; page += 1) {
    const data = await fetchPage(page);
    const pageItems = arrayAt(data, path);
    items.push(...pageItems);
    const count = pageItems.length;
    const pageTotal = total(data);
    if (!count || count < pageSize || (pageTotal !== null && items.length >= pageTotal)) return items;
  }
  throw new Error("分页超过 100 页，已停止读取");
}

export async function request(accountId, endpoint, method, requestPath, payload = null, query = {}, extraHeaders = {}) {
  const row = getAccountSecretRecord(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "ctyun") throw new Error("当前账号不是天翼云账号");
  const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null).sort(([left], [right]) => left.localeCompare(right)));
  const queryText = params.toString();
  const body = payload == null ? "" : JSON.stringify(payload);
  const eopDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const requestId = crypto.randomUUID();
  const payloadHash = crypto.createHash("sha256").update(body).digest("hex");
  const stringToSign = `ctyun-eop-request-id:${requestId}\neop-date:${eopDate}\n\n${queryText}\n${payloadHash}`;
  const secret = decryptSecret(row.secret_ciphertext);
  const dateKey = hmac(secret, eopDate);
  const akKey = hmac(dateKey, row.access_key_id);
  const signingKey = hmac(akKey, eopDate.slice(0, 8));
  const signature = hmac(signingKey, stringToSign).toString("base64");
  const authorization = `${row.access_key_id} Headers=ctyun-eop-request-id;eop-date Signature=${signature}`;
  const url = `https://${endpoint}${requestPath}${queryText ? `?${queryText}` : ""}`;
  const response = await fetch(url, { method, headers: { "ctyun-eop-request-id": requestId, "Eop-date": eopDate, "Eop-Authorization": authorization, ...extraHeaders, ...(payload == null ? {} : { "Content-Type": "application/json" }) }, ...(payload == null ? {} : { body }) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text || `天翼云 ${response.status}` }; }
  const code = String(data?.code ?? data?.statusCode ?? "");
  if (!response.ok || (code && !["0", "200", "800", "Success", "SUCCESS"].includes(code))) {
    const message = data?.message || data?.msg || data?.error?.message || code || `天翼云 ${response.status}`;
    writeApiLog(accountId, endpoint, requestPath, payload ?? query, data, "失败", message);
    throw new Error(message);
  }
  writeApiLog(accountId, endpoint, requestPath, payload ?? query, data, "成功");
  return data?.returnObj || data?.result || data;
}

function instance(item, region) {
  const publicIp = item.FloatingIP || item.floatingIP || item.PublicIP || item.publicIP || "";
  const privateIp = item.PrivateIP || item.privateIP || item.FixedIP || item.fixedIP || "";
  return { ...item, InstanceId: item.InstanceID || item.instanceID || item.ResourceID || item.resourceID || "", InstanceName: item.InstanceName || item.instanceName || item.DisplayName || item.displayName || item.InstanceID || item.instanceID || "", InstanceStatus: item.InstanceStatus || item.instanceStatus || item.State || item.state || "", Status: item.InstanceStatus || item.instanceStatus || item.State || item.state || "", PublicIpAddress: publicIp, PrivateIpAddress: privateIp, VpcId: item.VpcID || item.vpcID || item.VpcId || "", InstanceType: item.InstanceType || item.instanceType || item.FlavorName || item.flavorName || "", _region_id: region };
}
function domain(item, region) { return { ...item, DomainName: item.name || item.ZoneName || item.zoneName || item.zoneID || "", DomainStatus: "私有 DNS", ZoneId: item.zoneID || item.ZoneID || "", RecordCount: Number(item.recordCount || 0), RegistrationDate: item.createdAt || item.CreatedAt || "", ExpirationDate: "", _region_id: region, _ctyun_private_zone: true }; }
function rds(item, region) { const running = Number(item.prodRunningStatus) === 0 || String(item.prodRunningStatus || "").toLowerCase() === "running"; return { ...item, DBInstanceId: item.outerProdInstId || item.prodInstId || "", DBInstanceDescription: item.prodInstName || item.outerProdInstId || "", DBInstanceStatus: running ? "Running" : String(item.prodRunningStatus ?? item.alive ?? "Unknown"), DBInstanceType: item.prodType || "", DBInstanceClass: item.machineSpec || item.resources || "", DBInstanceStorage: Number(item.diskSize || 0), ConnectionString: item.vip || "", Port: item.writePort || "", Engine: item.prodDbEngine || "MySQL", EngineVersion: item.newMysqlVersion || item.dbMysqlVersion || "", CreateTime: item.createTime || "", ExpireTime: item.expireTime || "", _region_id: region }; }
function redis(item, region) { const status = Number(item.status) === 0 || String(item.statusName || "").toLowerCase() === "normal" ? "Normal" : String(item.statusName || item.status || "Unknown"); return { ...item, InstanceId: item.prodInstId || item.user || "", InstanceName: item.instanceName || item.prodInstId || "", InstanceStatus: status, InstanceType: item.archTypeName || item.archType || "", InstanceClass: item.capacityInfo || item.capacity || "", Capacity: Number(item.capacity || 0) * 1024, ConnectionDomain: item.connectionAddress || item.vip || "", Port: item.vipPort || "", EngineVersion: item.engineVersionName || item.engineVersion || "", NetworkType: item.netName || "", EndTime: item.expTime || item.expiration || "", ArchitectureType: item.archTypeName || item.archType || "", _region_id: region }; }
function bucket(item, fallbackRegion) { const region = item.regionID || item.RegionID || fallbackRegion; return { ...item, Name: item.bucket || item.Bucket || "", Location: region, CreationDate: item.creationDate || item.CreationDate || "", StorageClass: item.storageType || item.StorageType || "STANDARD", Acl: "private", ExtranetEndpoint: "-", IntranetEndpoint: "-", _region_id: region }; }

async function regions(accountId, fallback) {
  try { const data = await request(accountId, "ctecs-global.ctapi.ctyun.cn", "GET", "/v4/region/list-regions", null, { regionName: "" }); const values = arrayAt(data, ["regionList"]).map((item) => item.regionID || item.RegionID).filter(Boolean); return [...new Set([...values, fallback].filter(Boolean))]; }
  catch { return fallback ? [fallback] : []; }
}

export async function resources(accountId, type) {
  const row = getAccountSecretRecord(accountId);
  const fallbackRegion = String(row?.region_id || "cn-huabei-9");
  const errors = [];
  const regionIds = await regions(accountId, fallbackRegion);
  const items = [];
  if (type === "ecs") for (const region of regionIds) { try { items.push(...(await pages((pageNo) => request(accountId, "ctecs-global.ctapi.ctyun.cn", "POST", "/v4/ecs/list-instances", { regionID: region, pageNo, pageSize: 100 }), ["results"], 100)).map((item) => instance(item, region))); } catch (error) { errors.push(`${region}: ${error.message}`); } }
  else if (type === "domain") for (const region of regionIds) { try { items.push(...(await pages((pageNo) => request(accountId, "ctvpc-global.ctapi.ctyun.cn", "GET", "/v4/private-zone/list", null, { regionID: region, pageNo, pageSize: 50 }), ["zones"], 50)).map((item) => domain(item, region))); } catch (error) { errors.push(`${region}: ${error.message}`); } }
  else if (type === "rds") for (const region of regionIds) { try { items.push(...(await pages((pageNow) => request(accountId, "rds2-global.ctapi.ctyun.cn", "POST", "/RDS2/v1/open-api/instance/instance-list", { pageNow, pageSize: 100 }, {}, { regionId: region }), ["list"], 100)).map((item) => rds(item, region))); } catch (error) { errors.push(`${region}: ${error.message}`); } }
  else if (type === "redis") for (const region of regionIds) { try { items.push(...(await pages((pageIndex) => request(accountId, "dcs2-global.ctapi.ctyun.cn", "GET", "/v2/instanceManageMgrServant/describeInstances", null, { pageIndex, pageSize: 100 }, { regionId: region }), ["rows"], 100)).map((item) => redis(item, region))); } catch (error) { errors.push(`${region}: ${error.message}`); } }
  else if (type === "oss") { try { const data = await request(accountId, "zos-global.ctapi.ctyun.cn", "GET", "/v4/oss/list-regions"); const ossRegions = arrayAt(data, []).map((item) => item.regionID || item.RegionID).filter(Boolean); for (const region of [...new Set([...ossRegions, "public"])]) { try { items.push(...(await pages((pageNo) => request(accountId, "zos-global.ctapi.ctyun.cn", "GET", "/v4/oss/list-buckets", null, { regionID: region, pageNo, pageSize: 50 }), ["bucketList"], 50)).map((item) => bucket(item, region))); } catch (error) { errors.push(`${region}: ${error.message}`); } } } catch (error) { errors.push(error.message); } }
  else errors.push(`天翼云暂未提供 ${type} 对应的统一只读清单 API`);
  const unique = type === "oss" ? Array.from(new Map(items.map((item) => [item.Name, item])).values()) : items;
  return { resource_type: type, items: unique, errors, fetched_at: Date.now() };
}

export async function verify(accountId) {
  const row = getAccountSecretRecord(accountId);
  if (!row) throw new Error("云账号不存在");
  const regionIds = await regions(accountId, String(row.region_id || "cn-huabei-9"));
  if (!regionIds.length) throw new Error("未读取到可用地域，请检查 AccessKey、SecretKey 与 EOP 权限");
  return { provider: "ctyun", verified: true, region_count: regionIds.length, regions: regionIds, default_region: row.region_id || regionIds[0] };
}
