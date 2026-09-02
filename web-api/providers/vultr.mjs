import { writeApiLog } from "../core/database.mjs";
import { decryptSecret } from "../core/crypto.mjs";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";

export async function request(accountId, pathName, query = {}, init = {}) {
  const row = getAccountSecretRecord(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "vultr") throw new Error("当前账号不是 Vultr 账号");
  const params = new URLSearchParams(query);
  const method = String(init.method || "GET").toUpperCase();
  const response = await fetch(`https://api.vultr.com/v2/${pathName}${params.size ? `?${params}` : ""}`, { ...init, method, headers: { Authorization: `Bearer ${decryptSecret(row.secret_ciphertext).trim()}`, Accept: "application/json", ...(init.headers || {}) } });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { body: text }; }
  const action = `${method} /v2/${String(pathName).split("?")[0]}`;
  if (!response.ok) { const message = data?.error?.message || data?.error || data?.message || `Vultr API ${response.status}`; writeApiLog(accountId, "api.vultr.com", action, query, data, "失败", message); throw new Error(message); }
  writeApiLog(accountId, "api.vultr.com", action, { ...query, ...(init.body ? { body: init.body } : {}) }, data, "成功");
  return data;
}

function cursor(next) { try { return new URL(String(next || ""), "https://api.vultr.com").searchParams.get("cursor") || ""; } catch { return ""; } }

export async function pages(accountId, pathName, itemKey) {
  const items = []; let next = "";
  for (let page = 0; page < 100; page += 1) {
    const data = await request(accountId, pathName, { per_page: 100, ...(next ? { cursor: next } : {}) });
    const values = Array.isArray(data?.[itemKey]) ? data[itemKey] : [];
    items.push(...values);
    next = cursor(data?.meta?.links?.next);
    if (!next || !values.length) break;
  }
  return items;
}

function value(item, ...keys) { return keys.map((key) => item?.[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== "") ?? ""; }
function inventory(item, type) {
  const names = { block: ["label", "id"], network: ["description", "id"], firewall: ["description", "id"], ip: ["label", "subnet", "id"], loadbalancer: ["label", "id"], snapshot: ["description", "id"], kubernetes: ["label", "id"] };
  return { AssetId: value(item, "id"), Name: value(item, ...(names[type] || ["label", "description", "id"])), Status: ["network", "firewall", "ip"].includes(type) ? "active" : value(item, "status"), RegionId: type === "firewall" ? "global" : value(item, "region"), IpAddress: value(item, "ip", "instance_ip"), SizeGb: value(item, "size_gb"), AttachedTo: value(item, "attached_to_instance", "instance_id"), VpcId: value(item, "vpc2_id", "vpc_id"), CreatedAt: value(item, "date_created"), Tags: value(item, "tags"), _region_id: value(item, "region"), _raw: item };
}

export async function resources(accountId, type) {
  const definitions = {
    ecs: ["instances", "instances", (item) => ({ InstanceId: value(item, "id"), InstanceName: value(item, "label", "hostname", "id"), Status: value(item, "status"), InstanceStatus: value(item, "status"), PublicIpAddress: value(item, "main_ip"), PrivateIpAddress: value(item, "internal_ip"), InstanceType: value(item, "plan"), Cpu: value(item, "vcpu_count"), Memory: value(item, "ram"), Disk: value(item, "disk"), OSName: value(item, "os"), Hostname: value(item, "hostname"), Region: value(item, "region"), AllowedBandwidth: value(item, "allowed_bandwidth"), NetmaskV4: value(item, "netmask_v4"), GatewayV4: value(item, "gateway_v4"), V6MainIp: value(item, "v6_main_ip"), PowerStatus: value(item, "power_status"), ServerStatus: value(item, "server_status"), Backups: value(item, "backups"), DdosProtection: value(item, "ddos_protection"), VpcIds: value(item, "vpc2_ids"), FirewallGroupId: value(item, "firewall_group_id"), Tags: value(item, "tags"), CreationTime: value(item, "date_created"), _region_id: value(item, "region"), _raw: item })],
    domain: ["domains", "domains", (item) => ({ DomainName: value(item, "domain"), DomainStatus: "ACTIVE", RecordCount: 0, RegistrationDate: value(item, "date_created"), ZoneId: value(item, "domain"), _region_id: "global", _raw: item })],
    oss: ["object-storage", "object_storages", (item) => ({ AssetId: value(item, "id", "cluster_id"), Name: value(item, "label", "cluster_id", "id"), BucketName: value(item, "label", "cluster_id", "id"), Status: value(item, "status"), Location: value(item, "region"), CreationDate: value(item, "date_created"), StorageClass: value(item, "plan"), _region_id: value(item, "region"), _raw: item })],
    rds: ["databases", "databases", (item) => ({ DBInstanceId: value(item, "id"), DBInstanceDescription: value(item, "label", "id"), DBInstanceStatus: value(item, "status"), DBInstanceClass: value(item, "plan"), ConnectionString: value(item, "host"), Port: value(item, "port"), Engine: value(item, "database_engine"), EngineVersion: value(item, "database_engine_version"), CreateTime: value(item, "date_created"), VpcId: value(item, "vpc_id"), _region_id: value(item, "region"), _raw: item })],
    block: ["blocks", "blocks", (item) => inventory(item, "block")], network: ["vpc2", "vpc2", (item) => inventory(item, "network")], firewall: ["firewalls", "firewall_groups", (item) => inventory(item, "firewall")], ip: ["reserved-ips", "reserved_ips", (item) => inventory(item, "ip")], loadbalancer: ["load-balancers", "load_balancers", (item) => inventory(item, "loadbalancer")], snapshot: ["snapshots", "snapshots", (item) => inventory(item, "snapshot")], kubernetes: ["kubernetes/clusters", "vke_clusters", (item) => inventory(item, "kubernetes")],
  };
  const definition = definitions[type];
  if (!definition) return { resource_type: type, items: [], errors: [`Vultr 暂未接入 ${type} 资源`], fetched_at: Date.now() };
  try { const [pathName, key, normalize] = definition; return { resource_type: type, items: (await pages(accountId, pathName, key)).map(normalize), errors: [], fetched_at: Date.now() }; }
  catch (error) { return { resource_type: type, items: [], errors: [error.message || String(error)], fetched_at: Date.now() }; }
}
