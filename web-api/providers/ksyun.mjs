export function createKsyunProvider({ crypto, database, decryptSecret, writeApiLog, configuredRegions, firstAddress, queryString, xmlText, xmlBlocks }) {
  async function request(accountId, service, region, action, version, params = {}) {
    const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
    if (!row) throw new Error("云账号不存在");
    if (!row.enabled) throw new Error("云账号已停用");
    if (row.cloud_type !== "ksyun") throw new Error("当前账号不是金山云账号");
    const host = `${service}.${region}.api.ksyun.com`;
    const query = { Action: action, Version: version, AccessKeyId: row.access_key_id, SignatureMethod: "HMAC-SHA256", SignatureVersion: "1.0", Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), ...params };
    const canonical = queryString(query);
    query.Signature = crypto.createHmac("sha256", decryptSecret(row.secret_ciphertext)).update(`GET\n${host}\n/\n${canonical}`).digest("base64");
    const response = await fetch(`https://${host}/?${new URLSearchParams(query)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.Error) {
      const message = data?.Error?.Message || data?.Message || `金山云 ${response.status}`;
      writeApiLog(accountId, host, action, params, data, "失败", message);
      throw new Error(message);
    }
    writeApiLog(accountId, host, action, params, data, "成功");
    return data;
  }

  function instance(item, region) { return { ...item, InstanceId: item.InstanceId, InstanceName: item.InstanceName || item.InstanceId, InstanceStatus: item.InstanceState?.Name || item.InstanceState, Status: item.InstanceState?.Name || item.InstanceState, PublicIpAddress: firstAddress(item.NetworkInterfaces?.[0]?.PrivateIpAddress || item.PublicIpAddress), PrivateIpAddress: firstAddress(item.NetworkInterfaces?.[0]?.PrivateIpAddress), InstanceType: item.InstanceType || "", VpcId: item.VpcId || "", _region_id: region }; }
  function rds(item, region) { return { ...item, DBInstanceId: item.DBInstanceIdentifier, DBInstanceDescription: item.DBInstanceName || item.DBInstanceIdentifier, DBInstanceStatus: item.DBInstanceStatus, DBInstanceClass: item.DBInstanceClass?.Id || item.DBInstanceClass || "", DBInstanceStorage: Number(item.DBInstanceClass?.Disk || item.Storage || 0), ConnectionString: item.Vip || item.VipAddress || "", Port: item.Port || "", Engine: item.Engine || "", EngineVersion: item.EngineVersion || "", CreateTime: item.InstanceCreateTime || "", _region_id: region }; }
  function redis(item, region) { return { ...item, InstanceId: item.CacheId || item.CacheClusterId || item.InstanceId, InstanceName: item.Name || item.CacheName || item.CacheClusterName || item.CacheId, InstanceStatus: item.Status || item.CacheStatus || item.CacheClusterStatus, InstanceType: "Redis", InstanceClass: item.CacheNodeType || item.InstanceClass || item.Type || "", Capacity: Number(item.Capacity || item.MemorySize || 0), ConnectionDomain: item.Vip || item.Host || item.Endpoint || "", Port: item.Port || "", EngineVersion: item.EngineVersion || item.RedisVersion || "", NetworkType: item.VpcId || "", _region_id: region }; }

  async function buckets(accountId) {
    const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
    if (!row) throw new Error("云账号不存在");
    if (!row.enabled) throw new Error("云账号已停用");
    if (row.cloud_type !== "ksyun") throw new Error("当前账号不是金山云账号");
    const date = new Date().toUTCString();
    const signature = crypto.createHmac("sha1", decryptSecret(row.secret_ciphertext)).update(`GET\n\n\n${date}\n/`).digest("base64");
    const host = "kss.ksyun.com";
    const response = await fetch(`https://${host}/`, { headers: { Date: date, Authorization: `KSS ${row.access_key_id}:${signature}` } });
    const xml = await response.text();
    if (!response.ok) {
      const message = xmlText(xml, "Message") || xmlText(xml, "Code") || `KS3 ${response.status}`;
      writeApiLog(accountId, host, "ListBuckets", {}, { body: xml }, "失败", message);
      throw new Error(message);
    }
    const items = xmlBlocks(xml, "Bucket").map((block) => {
      const name = xmlText(block, "Name");
      const location = xmlText(block, "Location");
      return { Name: name, BucketName: name, Location: location, CreationDate: xmlText(block, "CreationDate"), StorageClass: "STANDARD", Acl: "private", ExtranetEndpoint: name ? `${name}.${host}` : "-", IntranetEndpoint: "-", _region_id: location || "global" };
    }).filter((bucket) => bucket.Name);
    writeApiLog(accountId, host, "ListBuckets", {}, { count: items.length }, "成功");
    return items;
  }

  async function resources(accountId, type) {
    const regions = configuredRegions(accountId, "cn_beijing_6");
    const items = [];
    const errors = [];
    if (type === "oss") {
      try { items.push(...await buckets(accountId)); }
      catch (error) { errors.push(error.message); }
      return { resource_type: type, items, errors, fetched_at: Date.now() };
    }
    const definitions = { ecs: ["kec", "DescribeInstances", "2016-03-04", (data) => data.InstancesSet || data.Instances || [], instance], rds: ["krds", "DescribeDBInstances", "2016-07-01", (data) => data.Data?.Instances || data.Instances || [], rds], redis: ["kcs", "DescribeCacheClusters", "2016-07-01", (data) => data.CacheClusters || data.Data?.CacheClusters || data.Data?.Instances || [], redis] };
    const definition = definitions[type];
    if (!definition) return { resource_type: type, items, errors: [`金山云暂未接入 ${type} 资源`], fetched_at: Date.now() };
    const [service, action, version, extract, normalize] = definition;
    for (const region of regions) {
      try { items.push(...extract(await request(accountId, service, region, action, version, type === "ecs" ? { MaxResults: 100 } : { MaxRecords: 100 })).map((item) => normalize(item, region))); }
      catch (error) { errors.push(`${region}: ${error.message}`); }
    }
    return { resource_type: type, items, errors, fetched_at: Date.now() };
  }

  async function verifyAccount(id) {
    const regions = configuredRegions(id, "cn_beijing_6");
    await request(id, "kec", regions[0], "DescribeInstances", "2016-03-04", { MaxResults: 1 });
    return { provider: "ksyun", verified: true, region_count: regions.length, regions, default_region: regions[0] };
  }

  return { resources, verifyAccount };
}
