export function createVolcengineProvider({ crypto, database, decryptSecret, writeApiLog, arr, xmlText, xmlBlocks }) {
  function encode(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  function queryString(params) {
    return Object.entries(params).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [encode(key), encode(value)]).sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1])).map(([key, value]) => `${key}=${value}`).join("&");
  }

  async function request(accountId, service, version, action, params = {}, region = "cn-beijing") {
    const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type,region_id FROM cloud_accounts WHERE id=?").get(accountId);
    if (!row) throw new Error("云账号不存在");
    if (!row.enabled) throw new Error("云账号已停用");
    if (row.cloud_type !== "volcengine") throw new Error("当前账号不是火山引擎账号");
    const selectedRegion = String(region || row.region_id || "cn-beijing");
    const host = "open.volcengineapi.com";
    const requestParams = { ...params, Action: action, Version: version };
    const query = queryString(requestParams);
    const dateTime = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
    const date = dateTime.slice(0, 8);
    const canonicalHeaders = `x-date:${dateTime}\n`;
    const signedHeaders = "x-date";
    const canonicalRequest = `GET\n/\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${crypto.createHash("sha256").update("").digest("hex")}`;
    const credentialScope = `${date}/${selectedRegion}/${service}/request`;
    const stringToSign = `HMAC-SHA256\n${dateTime}\n${credentialScope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
    const secret = decryptSecret(row.secret_ciphertext);
    const dateKey = crypto.createHmac("sha256", secret).update(date).digest();
    const regionKey = crypto.createHmac("sha256", dateKey).update(selectedRegion).digest();
    const serviceKey = crypto.createHmac("sha256", regionKey).update(service).digest();
    const signingKey = crypto.createHmac("sha256", serviceKey).update("request").digest();
    const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const authorization = `HMAC-SHA256 Credential=${row.access_key_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const response = await fetch(`https://${host}/?${query}`, { headers: { "X-Date": dateTime, Authorization: authorization } });
    const data = await response.json();
    if (!response.ok || data?.ResponseMetadata?.Error || data?.Error) {
      const apiError = data?.ResponseMetadata?.Error || data?.Error || {};
      const message = apiError.Message || apiError.Code || data?.Message || `火山引擎 ${response.status}`;
      writeApiLog(accountId, host, action, requestParams, data, "失败", message);
      throw new Error(message);
    }
    writeApiLog(accountId, host, action, requestParams, data, "成功");
    return data?.Result ?? data;
  }

  async function jsonRequest(accountId, service, version, action, payload = {}, region = "cn-beijing") {
    const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type,region_id FROM cloud_accounts WHERE id=?").get(accountId);
    if (!row) throw new Error("云账号不存在");
    if (!row.enabled) throw new Error("云账号已停用");
    if (row.cloud_type !== "volcengine") throw new Error("当前账号不是火山引擎账号");
    const selectedRegion = String(region || row.region_id || "cn-beijing");
    const host = `${service}.volcengineapi.com`;
    const requestParams = { Action: action, Version: version };
    const query = queryString(requestParams);
    const body = JSON.stringify(payload);
    const dateTime = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
    const date = dateTime.slice(0, 8);
    const payloadHash = crypto.createHash("sha256").update(body).digest("hex");
    const canonicalHeaders = `x-date:${dateTime}\n`;
    const signedHeaders = "x-date";
    const canonicalRequest = `POST\n/\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${date}/${selectedRegion}/${service}/request`;
    const stringToSign = `HMAC-SHA256\n${dateTime}\n${credentialScope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
    const secret = decryptSecret(row.secret_ciphertext);
    const dateKey = crypto.createHmac("sha256", secret).update(date).digest();
    const regionKey = crypto.createHmac("sha256", dateKey).update(selectedRegion).digest();
    const serviceKey = crypto.createHmac("sha256", regionKey).update(service).digest();
    const signingKey = crypto.createHmac("sha256", serviceKey).update("request").digest();
    const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const authorization = `HMAC-SHA256 Credential=${row.access_key_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const response = await fetch(`https://${host}/?${query}`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Date": dateTime, Authorization: authorization }, body });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { Message: text || `火山引擎 ${response.status}` }; }
    if (!response.ok || data?.ResponseMetadata?.Error || data?.Error) {
      const apiError = data?.ResponseMetadata?.Error || data?.Error || {};
      const message = apiError.Message || apiError.Code || data?.Message || `火山引擎 ${response.status}`;
      writeApiLog(accountId, host, action, requestParams, data, "失败", message);
      throw new Error(message);
    }
    writeApiLog(accountId, host, action, requestParams, data, "成功");
    return data?.Result ?? data;
  }

  async function tosBuckets(accountId) {
    const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type,region_id FROM cloud_accounts WHERE id=?").get(accountId);
    if (!row) throw new Error("云账号不存在");
    if (!row.enabled) throw new Error("云账号已停用");
    if (row.cloud_type !== "volcengine") throw new Error("当前账号不是火山引擎账号");
    const region = String(row.region_id || "cn-beijing");
    const host = `tos-${region}.volces.com`;
    const dateTime = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
    const date = dateTime.slice(0, 8);
    const payloadHash = crypto.createHash("sha256").update("").digest("hex");
    const canonicalHeaders = `host:${host}\nx-tos-content-sha256:${payloadHash}\nx-tos-date:${dateTime}\n`;
    const signedHeaders = "host;x-tos-content-sha256;x-tos-date";
    const canonicalRequest = `GET\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${date}/${region}/tos/request`;
    const stringToSign = `TOS4-HMAC-SHA256\n${dateTime}\n${credentialScope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
    const secret = decryptSecret(row.secret_ciphertext);
    const dateKey = crypto.createHmac("sha256", secret).update(date).digest();
    const regionKey = crypto.createHmac("sha256", dateKey).update(region).digest();
    const serviceKey = crypto.createHmac("sha256", regionKey).update("tos").digest();
    const signingKey = crypto.createHmac("sha256", serviceKey).update("request").digest();
    const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const authorization = `TOS4-HMAC-SHA256 Credential=${row.access_key_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const response = await fetch(`https://${host}/`, { headers: { Host: host, "X-Tos-Date": dateTime, "X-Tos-Content-Sha256": payloadHash, Authorization: authorization } });
    const xml = await response.text();
    if (!response.ok) {
      const message = xmlText(xml, "Message") || xmlText(xml, "Code") || `TOS ${response.status}`;
      writeApiLog(accountId, host, "ListBuckets", {}, { body: xml }, "失败", message);
      throw new Error(message);
    }
    let buckets = [];
    try {
      const data = JSON.parse(xml);
      buckets = Array.isArray(data?.Buckets) ? data.Buckets : (data?.Buckets?.Bucket || data?.Bucket || []);
    } catch { buckets = xmlBlocks(xml, "Bucket").map((block) => ({ Name: xmlText(block, "Name"), Location: xmlText(block, "Location"), CreationDate: xmlText(block, "CreationDate") })); }
    const items = buckets.map((bucket) => {
      const name = bucket.Name || bucket.BucketName || "";
      const location = bucket.Location || bucket.Region || region;
      return { Name: name, Location: location, CreationDate: bucket.CreationDate || "", StorageClass: "Standard", ExtranetEndpoint: `${name}.tos-${location}.volces.com`, Acl: "private" };
    }).filter((item) => item.Name);
    writeApiLog(accountId, host, "ListBuckets", {}, { count: items.length }, "成功");
    return items;
  }

  function instance(item, region) { return { ...item, InstanceId: item.InstanceId || item.InstanceID, InstanceName: item.InstanceName || item.InstanceId || item.InstanceID, InstanceStatus: item.Status || item.InstanceStatus, Status: item.Status || item.InstanceStatus, PublicIpAddress: item.PublicIpAddress || item.PublicIpAddresses?.[0] || item.EipAddress || "", _region_id: region }; }
  function rdsInstance(item, region) { return { ...item, DBInstanceId: item.DBInstanceId || item.InstanceId || item.InstanceID, DBInstanceDescription: item.DBInstanceName || item.InstanceName || item.DBInstanceId || item.InstanceId, DBInstanceStatus: item.Status || item.DBInstanceStatus, Engine: item.Engine || "MySQL", _region_id: region }; }
  function swasInstance(item, region) { return { ...item, InstanceId: item.InstanceId || item.InstanceID, InstanceName: item.InstanceName || item.Name || item.InstanceId || item.InstanceID, InstanceStatus: item.Status || item.InstanceStatus, Status: item.Status || item.InstanceStatus, PublicIpAddress: item.PublicIpAddress || item.PublicIp || item.PublicIpAddresses?.[0] || item.EipAddress || "", _region_id: region }; }
  function redisInstance(item, region) { const instanceId = item.InstanceId || item.InstanceID || item.DBInstanceId || item.RedisInstanceId; return { ...item, KVStoreInstanceId: instanceId, InstanceId: instanceId, InstanceName: item.InstanceName || item.DBInstanceName || item.Name || instanceId, InstanceStatus: item.Status || item.InstanceStatus, DBInstanceStatus: item.Status || item.InstanceStatus, EngineVersion: item.EngineVersion || item.RedisVersion || "Redis", _region_id: region }; }
  function edgeDomain(item) { const domain = item.DomainName || item.Domain || item.Name || ""; return { ...item, SiteId: item.DomainId || item.DomainID || domain, SiteName: domain, DomainName: domain, Status: item.Status || item.DomainStatus || "", AccessType: item.ServiceType || item.BusinessType || "CDN", Coverage: item.Area || item.Scope || "", PlanName: item.Plan || item.ProductType || "" }; }
  function dnsZone(item) { const expiresAt = Number(item.ExpiredTime || 0); return { ...item, DomainName: item.ZoneName || "", DomainStatus: "正常", RegistrationDate: item.CreatedAt || "", ExpirationDate: expiresAt ? new Date(expiresAt < 1e12 ? expiresAt * 1000 : expiresAt).toISOString() : "", RecordCount: item.RecordCount || 0 }; }

  async function resources(id, type) {
    const errors = [];
    const account = database().prepare("SELECT region_id FROM cloud_accounts WHERE id=?").get(id);
    const region = String(account?.region_id || "cn-beijing");
    try {
      if (type === "ecs") { const data = await request(id, "ecs", "2020-04-01", "DescribeInstances", { PageSize: 100, PageNumber: 1 }, region); const items = arr(data, ["Instances"]).length ? arr(data, ["Instances"]) : arr(data, ["Instances", "Instance"]); return { resource_type: type, items: items.map((item) => instance(item, region)), errors, fetched_at: Date.now() }; }
      if (type === "oss") return { resource_type: type, items: await tosBuckets(id), errors, fetched_at: Date.now() };
      if (type === "domain") { const data = await jsonRequest(id, "dns", "2018-08-01", "ListZones", { PageSize: 100, PageNumber: 1 }, region); return { resource_type: type, items: arr(data, ["Zones"]).map(dnsZone), errors, fetched_at: Date.now() }; }
      if (type === "rds") { const data = await request(id, "rds_mysql", "2018-01-01", "DescribeDBInstances", { PageSize: 100, PageNumber: 1 }, region); const items = arr(data, ["DBInstances"]).length ? arr(data, ["DBInstances"]) : arr(data, ["Items"]); return { resource_type: type, items: items.map((item) => rdsInstance(item, region)), errors, fetched_at: Date.now() }; }
      if (type === "swas") { const data = await request(id, "lighthouse", "2020-04-01", "DescribeInstances", { PageSize: 100, PageNumber: 1 }, region); const items = arr(data, ["Instances"]).length ? arr(data, ["Instances"]) : arr(data, ["InstanceSet"]); return { resource_type: type, items: items.map((item) => swasInstance(item, region)), errors, fetched_at: Date.now() }; }
      if (type === "redis") { const data = await request(id, "Redis", "2020-12-07", "DescribeDBInstances", { PageSize: 100, PageNumber: 1 }, region); const items = arr(data, ["DBInstances"]).length ? arr(data, ["DBInstances"]) : arr(data, ["Items"]); return { resource_type: type, items: items.map((item) => redisInstance(item, region)), errors, fetched_at: Date.now() }; }
      if (type === "esa") { const data = await request(id, "cdn", "2021-03-01", "ListCdnDomains", { PageSize: 100, PageNumber: 1 }, region); const items = arr(data, ["Domains"]).length ? arr(data, ["Domains"]) : arr(data, ["DomainList"]); return { resource_type: type, items: items.map(edgeDomain), errors, fetched_at: Date.now() }; }
    } catch (error) { errors.push(error.message); }
    return { resource_type: type, items: [], errors: errors.length ? errors : [`火山引擎暂未接入 ${type} 资源`], fetched_at: Date.now() };
  }

  return { resources };
}
