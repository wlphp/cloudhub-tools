export function createQingcloudProvider({ crypto, database, decryptSecret, writeApiLog, configuredRegions, firstAddress, queryString }) {
  async function request(accountId, action, zone, params = {}) {
    const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
    if (!row) throw new Error("云账号不存在");
    if (!row.enabled) throw new Error("云账号已停用");
    if (row.cloud_type !== "qingcloud") throw new Error("当前账号不是青云 QingCloud 账号");

    const query = { action, zone, access_key_id: row.access_key_id, time_stamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), version: 1, signature_method: "HmacSHA256", signature_version: 1, ...params };
    const canonical = queryString(query);
    query.signature = crypto.createHmac("sha256", decryptSecret(row.secret_ciphertext)).update(`GET\n/iaas/\n${canonical}`).digest("base64");
    const response = await fetch(`https://api.qingcloud.com/iaas/?${new URLSearchParams(query)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || Number(data?.ret_code || 0) !== 0) {
      const message = data?.message || data?.ret_message || `青云 ${response.status}`;
      writeApiLog(accountId, "api.qingcloud.com", action, { zone, ...params }, data, "失败", message);
      throw new Error(message);
    }
    writeApiLog(accountId, "api.qingcloud.com", action, { zone, ...params }, data, "成功");
    return data;
  }

  function instance(item, zone) { return { ...item, InstanceId: item.instance_id, InstanceName: item.instance_name || item.instance_id, InstanceStatus: item.status, Status: item.status, PublicIpAddress: firstAddress(item.vxnets?.flatMap((value) => value.eips || [])), PrivateIpAddress: firstAddress(item.vxnets?.flatMap((value) => value.private_ips || [])), InstanceType: item.instance_type || "", VpcId: item.vpc_id || "", _region_id: zone }; }
  function rds(item, zone) { return { ...item, DBInstanceId: item.rdb_id || item.rdb, DBInstanceDescription: item.rdb_name || item.rdb_id || item.rdb, DBInstanceStatus: item.status, DBInstanceClass: item.rdb_type || item.rdb_class || "", DBInstanceStorage: Number(item.storage_size || item.storage || 0), ConnectionString: firstAddress(item.vips || item.private_ips || item.endpoint), Port: item.port || "", Engine: item.rdb_engine || "", EngineVersion: item.engine_version || "", CreateTime: item.create_time || "", _region_id: zone }; }
  function redis(item, zone) { return { ...item, InstanceId: item.cache_id || item.cache, InstanceName: item.cache_name || item.cache_id || item.cache, InstanceStatus: item.status, InstanceType: item.cache_type || "Redis", InstanceClass: item.cache_class || "", Capacity: Number(item.cache_size || item.memory_size || 0), ConnectionDomain: firstAddress(item.vips || item.private_ips || item.endpoint), Port: item.port || "", EngineVersion: item.cache_version || "", NetworkType: item.vxnet_id || item.vxnet || "", _region_id: zone }; }
  function dnsAlias(item, zone) { return { ...item, DomainName: item.domain_name || item.dns_alias || item.dns_alias_id, DomainStatus: item.status || "ACTIVE", ZoneId: item.dns_alias_id || item.dns_alias || item.domain_name, RecordCount: 0, RegistrationDate: item.create_time || "", _region_id: zone, _qingcloud_dns_alias: true }; }

  async function buckets(accountId) {
    const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
    if (!row) throw new Error("云账号不存在");
    if (!row.enabled) throw new Error("云账号已停用");
    if (row.cloud_type !== "qingcloud") throw new Error("当前账号不是青云 QingCloud 账号");
    const date = new Date().toUTCString();
    const signature = crypto.createHmac("sha256", decryptSecret(row.secret_ciphertext)).update(`GET\n\n\n${date}\n/`).digest("base64");
    const response = await fetch("https://qingstor.com/", { headers: { Date: date, Authorization: `QS ${row.access_key_id}:${signature}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.message || `QingStor ${response.status}`;
      writeApiLog(accountId, "qingstor.com", "ListBuckets", {}, data, "失败", message);
      throw new Error(message);
    }
    const items = (data.buckets || []).map((bucket) => ({ Name: bucket.name, BucketName: bucket.name, Location: bucket.location || "", CreationDate: bucket.created || "", StorageClass: "STANDARD", Acl: "private", ExtranetEndpoint: firstAddress(bucket.urls) || "-", IntranetEndpoint: "-", _region_id: bucket.location || "" }));
    writeApiLog(accountId, "qingstor.com", "ListBuckets", {}, { count: items.length }, "成功");
    return items;
  }

  async function resources(accountId, type) {
    if (type === "oss") {
      try { return { resource_type: type, items: await buckets(accountId), errors: [], fetched_at: Date.now() }; }
      catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; }
    }
    const definitions = { ecs: ["DescribeInstances", "instance_set", instance], rds: ["DescribeRDBs", "rdb_set", rds], redis: ["DescribeCaches", "cache_set", redis], domain: ["DescribeDNSAliases", "dns_alias_set", dnsAlias] };
    const definition = definitions[type];
    if (!definition) return { resource_type: type, items: [], errors: [`青云 QingCloud 暂未接入 ${type} 资源`], fetched_at: Date.now() };
    const [action, key, normalize] = definition;
    const zones = configuredRegions(accountId, "pek3a");
    const items = [];
    const errors = [];
    for (const zone of zones) {
      try { items.push(...((await request(accountId, action, zone, { limit: 100 }))[key] || []).map((item) => normalize(item, zone))); }
      catch (error) { errors.push(`${zone}: ${error.message}`); }
    }
    return { resource_type: type, items, errors, fetched_at: Date.now() };
  }

  async function verifyAccount(id) {
    const zones = configuredRegions(id, "pek3a");
    await request(id, "DescribeInstances", zones[0], { limit: 1 });
    return { provider: "qingcloud", verified: true, region_count: zones.length, regions: zones, default_region: zones[0] };
  }

  return { resources, verifyAccount };
}
