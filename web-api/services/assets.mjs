export async function syncCloudAssets(id, resourceTypes, { database, cloudResources }) {
  const account = database().prepare("SELECT cloud_type,enabled FROM cloud_accounts WHERE id=?").get(id);
  if (!account) throw new Error("云账号不存在");
  if (!account.enabled) throw new Error("云账号已停用");
  const supportedCloudTypes = ["aliyun", "vultr", "tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud", "qiniu", "aws", "azure", "gcp", "jdcloud", "qingcloud", "ksyun"];
  if (!supportedCloudTypes.includes(account.cloud_type)) throw new Error("当前云类型资源实时拉取尚未接入");
  const supportedTypes = ["ecs", "domain", "oss", "rds", "redis", "swas", "esa"];
  const availableTypes = account.cloud_type === "vultr" ? ["ecs", "domain", "oss", "rds", "block", "network", "firewall", "ip", "loadbalancer", "snapshot", "kubernetes"] : account.cloud_type === "qiniu" ? ["oss"] : account.cloud_type === "jdcloud" ? ["ecs", "domain", "swas", "rds", "redis", "oss"] : account.cloud_type === "qingcloud" ? ["ecs", "domain", "rds", "redis", "oss"] : account.cloud_type === "ksyun" ? ["ecs", "rds", "redis", "oss"] : ["huawei", "baidu", "ucloud", "aws", "azure", "gcp"].includes(account.cloud_type) ? ["ecs", "domain", "rds", "redis", "oss"] : account.cloud_type === "oracle" ? ["ecs", "domain", "rds", "oss"] : account.cloud_type === "ctyun" ? ["ecs", "domain", "rds", "redis", "oss"] : account.cloud_type === "volcengine" ? ["ecs", "domain", "swas", "rds", "redis", "oss", "esa"] : supportedTypes;
  const requestedTypes = Array.isArray(resourceTypes) ? resourceTypes : [];
  const types = (requestedTypes.length ? requestedTypes : availableTypes).filter((type) => availableTypes.includes(type));
  const rows = [];
  const errors = (requestedTypes.length ? requestedTypes : availableTypes).filter((type) => !availableTypes.includes(type)).map((type) => `${type}: 暂未接入此资源`);
  for (const type of types) {
    try {
      const response = await cloudResources(id, type);
      errors.push(...(response.errors || []).map((error) => `${type}: ${error}`));
      rows.push({ type, items: response.items || [], fetchedAt: Date.now() });
    } catch (error) {
      errors.push(`${type}: ${error.message}`);
      rows.push({ type, items: [], fetchedAt: Date.now() });
    }
  }
  const db = database();
  const remove = db.prepare("DELETE FROM cloud_assets WHERE account_id=? AND resource_type=?");
  const insert = db.prepare("INSERT OR REPLACE INTO cloud_assets(account_id,resource_type,asset_key,region_id,payload_json,fetched_at) VALUES(?,?,?,?,?,?)");
  db.exec("BEGIN");
  try {
    let fetched = 0;
    const counts = {};
    for (const row of rows) {
      remove.run(id, row.type);
      counts[row.type] = row.items.length;
      for (let index = 0; index < row.items.length; index += 1) {
        const item = row.items[index];
        const key = String(item.InstanceId || item.DBInstanceId || item.KVStoreInstanceId || item.AssetId || item.SiteId || item.DomainName || item.Name || item.BucketName || item.id || `${row.type}-${index}`);
        insert.run(id, row.type, key, item._region_id || item.RegionId || null, JSON.stringify(item), row.fetchedAt);
        fetched += 1;
      }
    }
    db.exec("COMMIT");
    return { fetched, counts, errors, fetched_at: Date.now() };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
