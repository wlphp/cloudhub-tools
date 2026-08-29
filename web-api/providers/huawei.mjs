export function createHuaweiProvider({ crypto, database, decryptSecret, writeApiLog, arr, xmlText, xmlBlocks }) {
  function encode(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  function canonicalUri(pathname) {
    return pathname.split("/").map((part) => encode(decodeURIComponent(part))).join("/") || "/";
  }

  function queryString(query = {}) {
    return Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [encode(key), encode(value)]).sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
      .map(([key, value]) => `${key}=${value}`).join("&");
  }

  function errorMessage(data, status) {
    return data?.error_msg || data?.message || data?.error?.message || data?.code || `华为云 ${status}`;
  }

  async function request(accountId, host, pathname, query = {}) {
    const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
    if (!row) throw new Error("云账号不存在");
    if (!row.enabled) throw new Error("云账号已停用");
    if (row.cloud_type !== "huawei") throw new Error("当前账号不是华为云账号");
    const queryText = queryString(query);
    const requestUri = canonicalUri(pathname);
    const date = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
    const headers = { host, "x-sdk-date": date };
    const canonicalHeaders = Object.entries(headers).map(([key, value]) => `${key}:${value}\n`).join("");
    const signedHeaders = Object.keys(headers).join(";");
    const payloadHash = crypto.createHash("sha256").update("").digest("hex");
    const canonicalRequest = `GET\n${requestUri}\n${queryText}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const stringToSign = `SDK-HMAC-SHA256\n${date}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
    const signature = crypto.createHmac("sha256", decryptSecret(row.secret_ciphertext)).update(stringToSign).digest("hex");
    const authorization = `SDK-HMAC-SHA256 Access=${row.access_key_id}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const response = await fetch(`https://${host}${requestUri}${queryText ? `?${queryText}` : ""}`, { headers: { Host: host, "X-Sdk-Date": date, Authorization: authorization } });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text || `华为云 ${response.status}` }; }
    if (!response.ok) {
      const message = errorMessage(data, response.status);
      writeApiLog(accountId, host, `GET ${pathname}`, query, data, "失败", message);
      throw new Error(message);
    }
    writeApiLog(accountId, host, `GET ${pathname}`, query, data, "成功");
    return data;
  }

  async function offsetPages(fetchPage, path, pageSize = 100) {
    const items = [];
    for (let offset = 0; offset < 10_000; offset += pageSize) {
      const data = await fetchPage(offset);
      const page = arr(data, path);
      items.push(...page);
      if (page.length < pageSize) return items;
    }
    throw new Error("分页超过 100 页，已停止读取");
  }

  async function context(accountId) {
    const account = database().prepare("SELECT region_id FROM cloud_accounts WHERE id=?").get(accountId);
    const defaultRegion = String(account?.region_id || "cn-north-4");
    const data = await request(accountId, `iam.${defaultRegion}.myhuaweicloud.com`, "/v3/projects", { enabled: "true" });
    const projects = arr(data, ["projects"]).filter((item) => item.id && item.name && String(item.status || "enabled").toLowerCase() === "enabled");
    if (!projects.length) throw new Error("未读取到可用项目，请检查 IAM 项目权限");
    return { defaultRegion, projects };
  }

  function instance(item, region, project) {
    const addresses = Object.values(item.addresses || {}).flat();
    const publicIp = addresses.find((address) => String(address?.["OS-EXT-IPS:type"] || "").toLowerCase() === "floating")?.addr || "";
    const privateIp = addresses.find((address) => String(address?.["OS-EXT-IPS:type"] || "").toLowerCase() !== "floating")?.addr || "";
    return { ...item, InstanceId: item.id, InstanceName: item.name || item.id, InstanceStatus: item.status, Status: item.status, PublicIpAddress: publicIp, PrivateIpAddress: privateIp, InstanceType: item.flavor?.id || item.flavor?.name || "", VpcId: item.metadata?.vpc_id || "", _region_id: region, _project_id: project.id };
  }

  function rds(item, region, project) {
    return { ...item, DBInstanceId: item.id, DBInstanceDescription: item.name || item.id, DBInstanceStatus: item.status, DBInstanceClass: item.flavor_ref || item.flavor?.id || "", DBInstanceStorage: Number(item.volume?.size || 0), ConnectionString: item.private_ips?.[0] || item.nodes?.[0]?.private_ip || "", Port: item.port || "", Engine: item.datastore?.type || "", EngineVersion: item.datastore?.version || "", CreateTime: item.created || "", _region_id: region, _project_id: project.id };
  }

  function redis(item, region, project) {
    return { ...item, InstanceId: item.instance_id || item.id, InstanceName: item.name || item.instance_id || item.id, InstanceStatus: item.status || item.operating_status, InstanceType: item.engine || "Redis", InstanceClass: item.specification || item.capacity || "", Capacity: Number(item.capacity || 0) * 1024, ConnectionDomain: item.ip || item.private_ip || "", Port: item.port || "", EngineVersion: item.engine_version || "", NetworkType: item.vpc_name || "", _region_id: region, _project_id: project.id };
  }

  function zone(item) {
    return { ...item, DomainName: String(item.name || "").replace(/\.$/, ""), DomainStatus: item.status || "ACTIVE", ZoneId: item.id, RecordCount: Number(item.record_num || 0), RegistrationDate: item.created_at || "", _region_id: "cn-north-4", _huawei_public_zone: true };
  }

  async function obsBuckets(accountId, region) {
    const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
    if (!row || !row.enabled || row.cloud_type !== "huawei") throw new Error("当前账号不是华为云账号");
    const host = `obs.${region}.myhuaweicloud.com`;
    const date = new Date().toUTCString();
    const signature = crypto.createHmac("sha1", decryptSecret(row.secret_ciphertext)).update(`GET\n\n\n${date}\n/`).digest("base64");
    const response = await fetch(`https://${host}/`, { headers: { Date: date, Host: host, Authorization: `OBS ${row.access_key_id}:${signature}` } });
    const xml = await response.text();
    if (!response.ok) { const message = `OBS ${response.status}: ${xmlText(xml, "Message") || xmlText(xml, "Code") || "请求被拒绝"}`; writeApiLog(accountId, host, "ListBuckets", {}, { body: xml }, "失败", message); throw new Error(message); }
    const buckets = xmlBlocks(xml, "Bucket").map((block) => ({ Name: xmlText(block, "Name"), BucketName: xmlText(block, "Name"), Location: xmlText(block, "Location") || region, CreationDate: xmlText(block, "CreationDate"), StorageClass: "STANDARD", Acl: "private", ExtranetEndpoint: "-", IntranetEndpoint: "-", _region_id: xmlText(block, "Location") || region })).filter((bucket) => bucket.Name);
    writeApiLog(accountId, host, "ListBuckets", {}, { count: buckets.length }, "成功");
    return buckets;
  }

  async function resources(accountId, type) {
    const { defaultRegion, projects } = await context(accountId);
    const items = []; const errors = [];
    if (type === "domain") {
      try { items.push(...await offsetPages((offset) => request(accountId, "dns.cn-north-4.myhuaweicloud.com", "/v2/zones", { limit: 500, offset }), ["zones"], 500)); }
      catch (error) { errors.push(`cn-north-4: ${error.message}`); }
      return { resource_type: type, items: items.map(zone), errors, fetched_at: Date.now() };
    }
    if (type === "oss") {
      const bucketRegions = [...new Set([defaultRegion, ...projects.map((project) => project.name)])];
      for (const region of bucketRegions) { try { items.push(...await obsBuckets(accountId, region)); } catch (error) { errors.push(`${region}: ${error.message}`); } }
      return { resource_type: type, items: Array.from(new Map(items.map((item) => [item.Name, item])).values()), errors, fetched_at: Date.now() };
    }
    const services = { ecs: ["ecs", "/v1/{project}/cloudservers/detail", "servers", instance], rds: ["rds", "/v3/{project}/instances", "instances", rds], redis: ["dcs", "/v2/{project}/instances", "instances", redis] };
    const service = services[type];
    if (!service) return { resource_type: type, items, errors: [`华为云暂未接入 ${type} 资源`], fetched_at: Date.now() };
    for (const project of projects) {
      const [name, template, path, normalize] = service;
      const region = project.name;
      try {
        const values = await offsetPages((offset) => request(accountId, `${name}.${region}.myhuaweicloud.com`, template.replace("{project}", encode(project.id)), { limit: 100, offset }), [path], 100);
        items.push(...values.map((item) => normalize(item, region, project)));
      } catch (error) { errors.push(`${region}: ${error.message}`); }
    }
    return { resource_type: type, items, errors, fetched_at: Date.now() };
  }

  async function verifyAccount(id) {
    const { defaultRegion, projects } = await context(id);
    return { provider: "huawei", verified: true, region_count: new Set(projects.map((project) => project.name)).size, regions: [...new Set(projects.map((project) => project.name))], default_region: defaultRegion, project_count: projects.length };
  }

  return { resources, verifyAccount };
}
