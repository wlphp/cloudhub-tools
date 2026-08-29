export function createVultrProvider({ database, decryptSecret, writeApiLog }) {
  async function request(accountId, pathName, query = {}, init = {}) {
    const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
    if (!row) throw new Error("云账号不存在");
    if (!row.enabled) throw new Error("云账号已停用");
    if (row.cloud_type !== "vultr") throw new Error("当前账号不是 Vultr 账号");
    const params = new URLSearchParams(query);
    const method = String(init.method || "GET").toUpperCase();
    const response = await fetch(`https://api.vultr.com/v2/${pathName}${params.size ? `?${params}` : ""}`, {
      ...init,
      method,
      headers: { Authorization: `Bearer ${decryptSecret(row.secret_ciphertext).trim()}`, Accept: "application/json", ...(init.headers || {}) },
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { body: text }; }
    const action = `${method} /v2/${String(pathName).split("?")[0]}`;
    if (!response.ok) {
      const message = data?.error?.message || data?.error || data?.message || `Vultr API ${response.status}`;
      writeApiLog(accountId, "api.vultr.com", action, query, data, "失败", message);
      throw new Error(message);
    }
    writeApiLog(accountId, "api.vultr.com", action, { ...query, ...(init.body ? { body: init.body } : {}) }, data, "成功");
    return data;
  }

  function firewallRuleInput(payload) {
    const protocol = String(payload.ipProtocol || "").trim().toLowerCase();
    if (!["tcp", "udp"].includes(protocol)) throw new Error("Vultr 防火墙端口仅支持 TCP 或 UDP");
    const port = String(payload.port || "").trim();
    if (!/^\d+(?:-\d+)?$/.test(port)) throw new Error("端口格式无效，请使用 80 或 8000-9000");
    const [start, end = start] = port.split("-").map(Number);
    if (start < 1 || end < start || end > 65535) throw new Error("端口范围必须在 1 到 65535 之间");
    const parts = String(payload.sourceCidrIp || "").trim().split("/");
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) throw new Error("来源地址必须是 IPv4 CIDR，例如 0.0.0.0/0");
    const octets = parts[0].split(".");
    const subnetSize = Number(parts[1]);
    if (octets.length !== 4 || octets.some((octet) => !/^\d+$/.test(octet) || Number(octet) > 255) || subnetSize > 32) throw new Error("来源地址必须是有效 IPv4 CIDR，例如 0.0.0.0/0");
    const rule = { ip_type: "v4", protocol, subnet: parts[0], subnet_size: subnetSize, port };
    const notes = String(payload.description || "").trim();
    if (notes) rule.notes = notes;
    return rule;
  }

  function value(item, ...keys) { return keys.map((key) => item?.[key]).find((itemValue) => itemValue !== undefined && itemValue !== null && itemValue !== "") ?? ""; }

  function firewallRules(data) {
    const values = Array.isArray(data?.firewall_rules) ? data.firewall_rules : [];
    return values.filter((rule) => !rule?.ip_type || rule.ip_type === "v4").map((rule) => ({
      RuleId: value(rule, "id"),
      IpProtocol: value(rule, "protocol"),
      PortRange: value(rule, "port"),
      SourceCidrIp: value(rule, "source") || (rule?.subnet_size !== undefined && rule?.subnet_size !== null ? `${value(rule, "subnet")}/${rule.subnet_size}` : value(rule, "subnet")),
      Description: value(rule, "notes"),
    }));
  }

  function cursor(next) {
    try { return new URL(String(next || ""), "https://api.vultr.com").searchParams.get("cursor") || ""; } catch { return ""; }
  }

  async function pages(accountId, pathName, itemKey) {
    const items = [];
    let nextCursor = "";
    for (let page = 0; page < 100; page += 1) {
      const data = await request(accountId, pathName, { per_page: 100, ...(nextCursor ? { cursor: nextCursor } : {}) });
      const values = Array.isArray(data?.[itemKey]) ? data[itemKey] : [];
      items.push(...values);
      nextCursor = cursor(data?.meta?.links?.next);
      if (!nextCursor || !values.length) break;
    }
    return items;
  }

  function inventory(item, type) {
    const names = { block: ["label", "id"], network: ["description", "id"], firewall: ["description", "id"], ip: ["label", "subnet", "id"], loadbalancer: ["label", "id"], snapshot: ["description", "id"], kubernetes: ["label", "id"] };
    return { AssetId: value(item, "id"), Name: value(item, ...(names[type] || ["label", "description", "id"])), Status: type === "network" || type === "firewall" || type === "ip" ? "active" : value(item, "status"), RegionId: type === "firewall" ? "global" : value(item, "region"), IpAddress: value(item, "ip", "instance_ip"), SizeGb: value(item, "size_gb"), AttachedTo: value(item, "attached_to_instance", "instance_id"), VpcId: value(item, "vpc2_id", "vpc_id"), CreatedAt: value(item, "date_created"), Tags: value(item, "tags"), _region_id: value(item, "region"), _raw: item };
  }

  async function resources(accountId, type) {
    const definitions = {
      ecs: ["instances", "instances", (item) => ({ InstanceId: value(item, "id"), InstanceName: value(item, "label", "hostname", "id"), Status: value(item, "status"), InstanceStatus: value(item, "status"), PublicIpAddress: value(item, "main_ip"), PrivateIpAddress: value(item, "internal_ip"), InstanceType: value(item, "plan"), Cpu: value(item, "vcpu_count"), Memory: value(item, "ram"), Disk: value(item, "disk"), OSName: value(item, "os"), Hostname: value(item, "hostname"), Region: value(item, "region"), AllowedBandwidth: value(item, "allowed_bandwidth"), NetmaskV4: value(item, "netmask_v4"), GatewayV4: value(item, "gateway_v4"), V6MainIp: value(item, "v6_main_ip"), PowerStatus: value(item, "power_status"), ServerStatus: value(item, "server_status"), Backups: value(item, "backups"), DdosProtection: value(item, "ddos_protection"), VpcIds: value(item, "vpc2_ids"), FirewallGroupId: value(item, "firewall_group_id"), Tags: value(item, "tags"), CreationTime: value(item, "date_created"), _region_id: value(item, "region"), _raw: item })],
      domain: ["domains", "domains", (item) => ({ DomainName: value(item, "domain"), DomainStatus: "ACTIVE", RecordCount: 0, RegistrationDate: value(item, "date_created"), ZoneId: value(item, "domain"), _region_id: "global", _raw: item })],
      oss: ["object-storage", "object_storages", (item) => ({ AssetId: value(item, "id", "cluster_id"), Name: value(item, "label", "cluster_id", "id"), BucketName: value(item, "label", "cluster_id", "id"), Status: value(item, "status"), Location: value(item, "region"), CreationDate: value(item, "date_created"), StorageClass: value(item, "plan"), _region_id: value(item, "region"), _raw: item })],
      rds: ["databases", "databases", (item) => ({ DBInstanceId: value(item, "id"), DBInstanceDescription: value(item, "label", "id"), DBInstanceStatus: value(item, "status"), DBInstanceClass: value(item, "plan"), ConnectionString: value(item, "host"), Port: value(item, "port"), Engine: value(item, "database_engine"), EngineVersion: value(item, "database_engine_version"), CreateTime: value(item, "date_created"), VpcId: value(item, "vpc_id"), _region_id: value(item, "region"), _raw: item })],
      block: ["blocks", "blocks", (item) => inventory(item, "block")],
      network: ["vpc2", "vpc2", (item) => inventory(item, "network")],
      firewall: ["firewalls", "firewall_groups", (item) => inventory(item, "firewall")],
      ip: ["reserved-ips", "reserved_ips", (item) => inventory(item, "ip")],
      loadbalancer: ["load-balancers", "load_balancers", (item) => inventory(item, "loadbalancer")],
      snapshot: ["snapshots", "snapshots", (item) => inventory(item, "snapshot")],
      kubernetes: ["kubernetes/clusters", "vke_clusters", (item) => inventory(item, "kubernetes")],
    };
    const definition = definitions[type];
    if (!definition) return { resource_type: type, items: [], errors: [`Vultr 暂未接入 ${type} 资源`], fetched_at: Date.now() };
    try {
      const [pathName, key, normalize] = definition;
      return { resource_type: type, items: (await pages(accountId, pathName, key)).map(normalize), errors: [], fetched_at: Date.now() };
    } catch (error) {
      return { resource_type: type, items: [], errors: [error.message || String(error)], fetched_at: Date.now() };
    }
  }

  async function verifyAccount(id) {
    const [account, regionList] = await Promise.all([request(id, "account"), pages(id, "regions", "regions")]);
    const regions = regionList.map((region) => String(region.id || "")).filter(Boolean);
    return { provider: "vultr", verified: true, region_count: regions.length, regions, default_region: regions[0] || "ewr", account: account.account || account };
  }

  return { request, firewallRuleInput, firewallRules, resources, verifyAccount };
}
