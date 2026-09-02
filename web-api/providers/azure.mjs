import { decryptSecret } from "../core/crypto.mjs";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";

export function meta(row) {
  let value = {};
  try { value = JSON.parse(row.credential_meta || "{}"); } catch { /* legacy account */ }
  const tenantId = String(value.tenant_id || "").trim();
  const subscriptionId = String(value.subscription_id || "").trim();
  if (!tenantId || !subscriptionId) throw new Error("Azure 账号缺少 Tenant ID 或 Subscription ID");
  return { tenantId, subscriptionId };
}

export async function token(accountId) {
  const row = getAccountSecretRecord(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "azure") throw new Error("当前账号不是 Microsoft Azure 账号");
  const { tenantId, subscriptionId } = meta(row);
  const body = new URLSearchParams({ client_id: row.access_key_id, client_secret: decryptSecret(row.secret_ciphertext), grant_type: "client_credentials", scope: "https://management.azure.com/.default" });
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || `Azure OAuth ${response.status}`);
  return { token: data.access_token, subscriptionId, accountId: row.access_key_id };
}

export async function pages(context, pathname, apiVersion) {
  const items = [];
  let next = `https://management.azure.com${pathname}${pathname.includes("?") ? "&" : "?"}api-version=${encodeURIComponent(apiVersion)}`;
  for (let index = 0; next && index < 100; index += 1) {
    const response = await fetch(next, { headers: { Authorization: `Bearer ${context.token}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `Azure ${response.status}`);
    items.push(...(Array.isArray(data.value) ? data.value : []));
    next = data.nextLink || "";
  }
  return items;
}

function instance(item) { const p = item.properties || {}; return { ...item, InstanceId: item.id, InstanceName: item.name, InstanceStatus: p.provisioningState || "", Status: p.provisioningState || "", PublicIpAddress: "", PrivateIpAddress: "", InstanceType: item.properties?.hardwareProfile?.vmSize || "", VpcId: "", _region_id: item.location || "" }; }
function rds(item) { const p = item.properties || {}; return { ...item, DBInstanceId: item.id, DBInstanceDescription: item.name, DBInstanceStatus: p.state || p.provisioningState || "", DBInstanceClass: p.sku?.name || item.sku?.name || "", DBInstanceStorage: 0, ConnectionString: p.fullyQualifiedDomainName || "", Port: "", Engine: "Azure SQL", EngineVersion: p.version || "", CreateTime: "", _region_id: item.location || "" }; }
function redis(item) { const p = item.properties || {}; return { ...item, InstanceId: item.id, InstanceName: item.name, InstanceStatus: p.provisioningState || "", InstanceType: "Redis", InstanceClass: item.sku?.name || "", Capacity: Number(item.sku?.capacity || 0), ConnectionDomain: p.hostName || "", Port: p.sslPort || p.port || "", EngineVersion: p.redisVersion || "", NetworkType: p.subnetId || "", _region_id: item.location || "" }; }
function bucket(item) { return { ...item, Name: item.name, BucketName: item.name, Location: item.location || "", CreationDate: item.properties?.creationTime || "", StorageClass: item.sku?.name || "Standard", Acl: item.properties?.allowBlobPublicAccess ? "public" : "private", ExtranetEndpoint: "-", IntranetEndpoint: "-", _region_id: item.location || "" }; }
function zone(item) { return { ...item, DomainName: item.name, DomainStatus: item.properties?.provisioningState || "ACTIVE", ZoneId: item.id, RecordCount: Number(item.properties?.numberOfRecordSets || 0), RegistrationDate: "", _region_id: item.location || "global", _azure_dns: true }; }

export async function resources(accountId, type) {
  const context = await token(accountId);
  const root = `/subscriptions/${encodeURIComponent(context.subscriptionId)}/providers`;
  const definitions = { ecs: [`${root}/Microsoft.Compute/virtualMachines`, "2024-03-01", instance], rds: [`${root}/Microsoft.Sql/servers`, "2023-08-01-preview", rds], redis: [`${root}/Microsoft.Cache/Redis`, "2023-08-01", redis], oss: [`${root}/Microsoft.Storage/storageAccounts`, "2023-05-01", bucket], domain: [`${root}/Microsoft.Network/dnszones`, "2023-09-01", zone] };
  const definition = definitions[type];
  if (!definition) return { resource_type: type, items: [], errors: [`Azure 暂未接入 ${type} 资源`], fetched_at: Date.now() };
  try { const [path, version, normalize] = definition; return { resource_type: type, items: (await pages(context, path, version)).map(normalize), errors: [], fetched_at: Date.now() }; }
  catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; }
}

export async function verify(accountId, regions = ["eastasia"]) {
  const context = await token(accountId);
  await pages(context, `/subscriptions/${encodeURIComponent(context.subscriptionId)}`, "2022-12-01");
  return { provider: "azure", verified: true, region_count: regions.length, regions, default_region: regions[0] };
}
