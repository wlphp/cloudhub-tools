import crypto from "node:crypto";
import { decryptSecret } from "../core/crypto.mjs";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";

export function meta(row) {
  let value = {};
  try { value = JSON.parse(row.credential_meta || "{}"); } catch { /* legacy account */ }
  const projectId = String(value.project_id || "").trim();
  if (!projectId) throw new Error("GCP 账号缺少 Project ID");
  return { projectId };
}

function base64Url(value) { return Buffer.from(value).toString("base64url"); }

export async function token(accountId) {
  const row = getAccountSecretRecord(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "gcp") throw new Error("当前账号不是 Google Cloud 账号");
  const { projectId } = meta(row);
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({ iss: row.access_key_id, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  let signature;
  try { signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claim}`), decryptSecret(row.secret_ciphertext).replace(/\\n/g, "\n")).toString("base64url"); }
  catch { throw new Error("GCP 服务账号私钥无效，需填写未加密的 PEM 私钥"); }
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claim}.${signature}` });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || `GCP OAuth ${response.status}`);
  return { token: data.access_token, projectId, accountId: row.access_key_id };
}

export async function get(context, url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${context.token}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `GCP ${response.status}`);
  return data;
}

export async function pages(context, url, key) {
  const items = [];
  let next = url;
  for (let index = 0; next && index < 100; index += 1) {
    const data = await get(context, next);
    items.push(...(Array.isArray(data[key]) ? data[key] : []));
    next = data.nextPageToken ? `${url}${url.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(data.nextPageToken)}` : "";
  }
  return items;
}

function instance(item, region) { const network = item.networkInterfaces?.[0] || {}; return { ...item, InstanceId: String(item.id || item.name), InstanceName: item.name, InstanceStatus: item.status, Status: item.status, PublicIpAddress: network.accessConfigs?.[0]?.natIP || "", PrivateIpAddress: network.networkIP || "", InstanceType: String(item.machineType || "").split("/").pop() || "", VpcId: String(network.network || "").split("/").pop() || "", _region_id: region }; }
function rds(item) { const settings = item.settings || {}; return { ...item, DBInstanceId: item.name, DBInstanceDescription: item.name, DBInstanceStatus: item.state, DBInstanceClass: settings.tier || "", DBInstanceStorage: Number(settings.dataDiskSizeGb || 0), ConnectionString: item.ipAddresses?.find((ip) => ip.type === "PRIMARY")?.ipAddress || "", Port: "3306", Engine: item.databaseVersion || "", EngineVersion: item.databaseVersion || "", CreateTime: item.createTime || "", _region_id: item.region || "" }; }
function redis(item) { const size = Number(item.memorySizeGb || 0); return { ...item, InstanceId: item.name, InstanceName: String(item.name || "").split("/").pop(), InstanceStatus: item.state, InstanceType: "Redis", InstanceClass: item.tier || "", Capacity: size * 1024, ConnectionDomain: item.host || "", Port: item.port || "", EngineVersion: item.redisVersion || "", NetworkType: item.authorizedNetwork || "", _region_id: item.locationId || "" }; }
function bucket(item) { return { ...item, Name: item.name, BucketName: item.name, Location: item.location || "", CreationDate: item.timeCreated || "", StorageClass: item.storageClass || "STANDARD", Acl: item.iamConfiguration?.uniformBucketLevelAccess?.enabled ? "private" : "unknown", ExtranetEndpoint: "-", IntranetEndpoint: "-", _region_id: item.location || "" }; }
function zone(item) { return { ...item, DomainName: String(item.dnsName || "").replace(/\.$/, ""), DomainStatus: "ACTIVE", ZoneId: item.id || item.name, RecordCount: Number(item?.cloudLoggingConfig ? 0 : 0), RegistrationDate: item.creationTime || "", _region_id: "global", _gcp_dns: true, ...item }; }

export async function resources(accountId, type) {
  const context = await token(accountId);
  const project = encodeURIComponent(context.projectId);
  try {
    if (type === "ecs") {
      const data = await get(context, `https://compute.googleapis.com/compute/v1/projects/${project}/aggregated/instances`);
      const items = Object.entries(data.items || {}).flatMap(([scope, value]) => (value?.instances || []).map((item) => instance(item, scope.split("/").pop() || "")));
      return { resource_type: type, items, errors: [], fetched_at: Date.now() };
    }
    const definitions = { rds: [`https://sqladmin.googleapis.com/sql/v1beta4/projects/${project}/instances`, "items", rds], redis: [`https://redis.googleapis.com/v1/projects/${project}/locations/-/instances`, "instances", redis], oss: [`https://storage.googleapis.com/storage/v1/b?project=${project}`, "items", bucket], domain: [`https://dns.googleapis.com/dns/v1/projects/${project}/managedZones`, "managedZones", zone] };
    const definition = definitions[type];
    if (!definition) return { resource_type: type, items: [], errors: [`GCP 暂未接入 ${type} 资源`], fetched_at: Date.now() };
    const [url, key, normalize] = definition;
    return { resource_type: type, items: (await pages(context, url, key)).map(normalize), errors: [], fetched_at: Date.now() };
  } catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; }
}

export async function verify(accountId, regions = ["asia-east1"]) {
  const context = await token(accountId);
  await get(context, `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(context.projectId)}`);
  return { provider: "gcp", verified: true, region_count: regions.length, regions, default_region: regions[0] };
}
