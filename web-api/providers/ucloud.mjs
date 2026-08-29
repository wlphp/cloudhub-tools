export function createUcloudProvider({ crypto, database, decryptSecret, writeApiLog, configuredRegions, firstAddress }) {
async function ucloudRequest(accountId, action, params = {}) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "ucloud") throw new Error("当前账号不是 UCloud 账号");
  const query = { Action: action, PublicKey: row.access_key_id, ...params };
  const plain = Object.keys(query).sort().map((key) => `${key}${query[key]}`).join("") + decryptSecret(row.secret_ciphertext);
  query.Signature = crypto.createHash("sha1").update(plain).digest("base64");
  const response = await fetch(`https://api.ucloud.cn/?${new URLSearchParams(query)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || Number(data?.RetCode || 0) !== 0) {
    const message = data?.Message || data?.message || `UCloud ${response.status}`;
    writeApiLog(accountId, "api.ucloud.cn", action, params, data, "失败", message);
    throw new Error(message);
  }
  writeApiLog(accountId, "api.ucloud.cn", action, params, data, "成功");
  return data;
}
async function ucloudPages(accountId, action, region, keys) {
  const items = [];
  for (let offset = 0; offset < 100_000; offset += 100) {
    const data = await ucloudRequest(accountId, action, { Region: region, Offset: offset, Limit: 100 });
    const page = keys.flatMap((key) => Array.isArray(data?.[key]) ? data[key] : []);
    items.push(...page);
    if (page.length < 100 || items.length >= Number(data?.TotalCount || data?.Total || Infinity)) return items;
  }
  throw new Error("分页超过 1000 页，已停止读取");
}
function ucloudInstance(item, region) {
  return { ...item, InstanceId: item.UHostId, InstanceName: item.Name || item.UHostId, InstanceStatus: item.State, Status: item.State, PublicIpAddress: firstAddress(item.IPSet?.filter((ip) => ip.Type === "EIP") || item.IPSet), PrivateIpAddress: firstAddress(item.IPSet?.filter((ip) => ip.Type !== "EIP")), InstanceType: item.UHostType || item.CPU || "", VpcId: item.VPCId || "", _region_id: region };
}
function ucloudRds(item, region) {
  return { ...item, DBInstanceId: item.DBId, DBInstanceDescription: item.Name || item.DBId, DBInstanceStatus: item.State, DBInstanceClass: item.MemoryLimit || item.DBType || "", DBInstanceStorage: Number(item.DiskSpace || 0), ConnectionString: item.VirtualIP || "", Port: item.Port || "", Engine: item.DBType || "", EngineVersion: item.DBVersion || "", CreateTime: item.CreateTime || "", _region_id: region };
}
function ucloudRedis(item, region) {
  return { ...item, InstanceId: item.GroupId, InstanceName: item.Name || item.GroupId, InstanceStatus: item.State, InstanceType: "Redis", InstanceClass: item.MemoryLimit || "", Capacity: Number(item.MemoryLimit || 0), ConnectionDomain: item.VirtualIP || item.VIP || "", Port: item.Port || "", EngineVersion: item.Version || "", NetworkType: item.VPCId || "", _region_id: region };
}
function ucloudBucket(item, region) {
  const name = item.BucketName || item.Name;
  return { ...item, Name: name, BucketName: name, Location: item.Region || region, CreationDate: item.CreateTime || "", StorageClass: item.StorageClass || "STANDARD", Acl: item.ACL || "private", ExtranetEndpoint: "-", IntranetEndpoint: "-", _region_id: item.Region || region };
}
function ucloudZone(item) {
  return { ...item, DomainName: item.DomainName || item.Domain, DomainStatus: item.Status || "ACTIVE", ZoneId: item.DomainId || item.DomainName, RecordCount: Number(item.RecordCount || 0), RegistrationDate: item.CreateTime || "", _region_id: "global", _ucloud_dns: true };
}
async function ucloudResources(accountId, type) {
  const regions = configuredRegions(accountId, "cn-bj2"); const items = []; const errors = [];
  if (type === "domain") {
    try { items.push(...(await ucloudRequest(accountId, "DescribeUDNSDomain", { Offset: 0, Limit: 100 })).DomainSet || []); } catch (error) { errors.push(error.message); }
    return { resource_type: type, items: items.map(ucloudZone), errors, fetched_at: Date.now() };
  }
  const definitions = { ecs: ["DescribeUHostInstance", ["UHostSet"], ucloudInstance], rds: ["DescribeUDBInstance", ["DataSet"], ucloudRds], redis: ["DescribeURedisGroup", ["DataSet"], ucloudRedis], oss: ["DescribeUFileBucket", ["DataSet"], ucloudBucket] };
  const definition = definitions[type];
  if (!definition) return { resource_type: type, items, errors: [`UCloud 暂未接入 ${type} 资源`], fetched_at: Date.now() };
  const [action, keys, normalize] = definition;
  for (const region of regions) {
    try { items.push(...(await ucloudPages(accountId, action, region, keys)).map((item) => normalize(item, region))); }
    catch (error) { errors.push(`${region}: ${error.message}`); }
  }
  return { resource_type: type, items, errors, fetched_at: Date.now() };
}
async function verifyUcloudAccount(id) {
  const regions = configuredRegions(id, "cn-bj2");
  await ucloudRequest(id, "DescribeUHostInstance", { Region: regions[0], Offset: 0, Limit: 1 });
  return { provider: "ucloud", verified: true, region_count: regions.length, regions, default_region: regions[0] };
}

  return { resources: ucloudResources, verifyAccount: verifyUcloudAccount };
}
