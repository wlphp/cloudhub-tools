export function createTencentProvider({ crypto, database, decryptSecret, writeApiLog, arr, cosBuckets }) {
function tencentSecurityGroupPolicy({ ipProtocol, portRange, sourceCidrIp, description = "" }) {
  const protocol = String(ipProtocol || "").trim().toLowerCase();
  const range = String(portRange || "").trim();
  const source = String(sourceCidrIp || "").trim();
  const [start, end, extra] = range.split("/");
  if (!["tcp", "udp", "icmp", "gre", "all"].includes(protocol)) throw new Error("不支持的安全组协议");
  if (extra !== undefined || !/^-?\d+$/.test(start || "") || !/^-?\d+$/.test(end || "")) throw new Error("端口范围格式无效，请使用 80/80 或 8000/9000");
  const validRange = ["tcp", "udp"].includes(protocol) ? ((Number(start) === -1 && Number(end) === -1) || (Number(start) >= 1 && Number(end) >= Number(start) && Number(end) <= 65535)) : Number(start) === -1 && Number(end) === -1;
  if (!validRange) throw new Error("端口范围与协议不匹配，请使用 80/80、8000/9000 或 -1/-1");
  if (!source || !source.includes("/")) throw new Error("来源地址必须是 CIDR，例如 0.0.0.0/0");
  const port = protocol === "all" ? "ALL" : start === end ? start : `${start}-${end}`;
  const policy = { Action: "ACCEPT", CidrBlock: source, Port: port, Protocol: protocol.toUpperCase() };
  if (String(description || "").trim()) policy.PolicyDescription = String(description).trim();
  return policy;
}

function tencentSecurityGroupPort(port) {
  const value = String(port || "");
  if (!value || value.toLowerCase() === "all") return "-1/-1";
  const [start, end] = value.split("-");
  return end === undefined ? `${start}/${start}` : `${start}/${end}`;
}

async function tencentSecurityGroupDetails(id, regionId, instanceId, securityGroupId = "") {
  if (!regionId || !instanceId) throw new Error("缺少服务器地域或实例 ID");
  const instanceData = await tencentRequest(id, "cvm", "2017-03-12", "DescribeInstances", { InstanceIds: [instanceId] }, regionId);
  const attachedGroupIds = arr(instanceData, ["InstanceSet"])[0]?.SecurityGroupIds || [];
  const groupsData = await tencentRequest(id, "cvm", "2017-03-12", "DescribeSecurityGroups", { Limit: 100 }, regionId);
  const groups = arr(groupsData, ["SecurityGroupSet"]).map((group) => ({ SecurityGroupId: String(group.SecurityGroupId || ""), SecurityGroupName: String(group.SecurityGroupName || ""), Description: String(group.SecurityGroupDesc || ""), VpcId: String(group.VpcId || ""), NicType: "" })).filter((group) => group.SecurityGroupId && (!attachedGroupIds.length || attachedGroupIds.includes(group.SecurityGroupId)));
  const selectedSecurityGroupId = groups.some((group) => group.SecurityGroupId === securityGroupId) ? securityGroupId : groups[0]?.SecurityGroupId || "";
  if (!selectedSecurityGroupId) return { groups, selectedSecurityGroupId, rules: [] };
  const policies = await tencentRequest(id, "cvm", "2017-03-12", "DescribeSecurityGroupPolicies", { SecurityGroupId: selectedSecurityGroupId }, regionId);
  const rules = arr(policies, ["SecurityGroupPolicySet", "Ingress"]).map((rule) => ({ Direction: "ingress", IpProtocol: String(rule.Protocol || "").toLowerCase(), PortRange: tencentSecurityGroupPort(rule.Port), SourceCidrIp: String(rule.CidrBlock || ""), SourceGroupId: String(rule.SecurityGroupId || ""), Policy: String(rule.Action || "ACCEPT"), Priority: Number(rule.PolicyIndex || 0), Description: String(rule.PolicyDescription || ""), NicType: "" }));
  return { groups, selectedSecurityGroupId, rules };
}


function tencentLighthousePort(port) {
  const value = String(port || "").trim();
  if (!value || value.toLowerCase() === "all") return "-1/-1";
  const [start, end] = value.split("-");
  return end === undefined ? `${start}/${start}` : `${start}/${end}`;
}


async function tencentRequest(accountId, service, version, action, payload = {}, region = "") {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "tencent") throw new Error("当前账号不是腾讯云账号");
  const host = `${service}.tencentcloudapi.com`;
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const hashedPayload = crypto.createHash("sha256").update(body).digest("hex");
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const secret = decryptSecret(row.secret_ciphertext);
  const secretDate = crypto.createHmac("sha256", `TC3${secret}`).update(date).digest();
  const secretService = crypto.createHmac("sha256", secretDate).update(service).digest();
  const secretSigning = crypto.createHmac("sha256", secretService).update("tc3_request").digest();
  const signature = crypto.createHmac("sha256", secretSigning).update(stringToSign).digest("hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${row.access_key_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Host: host,
      Authorization: authorization,
      "X-TC-Action": action,
      "X-TC-Version": version,
      "X-TC-Timestamp": String(timestamp),
      ...(region ? { "X-TC-Region": region } : {}),
    },
    body,
  });
  const data = await response.json();
  const apiError = data?.Response?.Error;
  if (!response.ok || apiError) {
    const message = apiError?.Message || apiError?.Code || `腾讯云 ${response.status}`;
    writeApiLog(accountId, host, action, payload, data, "失败", message);
    throw new Error(message);
  }
  writeApiLog(accountId, host, action, payload, data, "成功");
  return data.Response || {};
}

function tencentNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}
function tencentInstance(item, region) {
  const network = item.InternetAccessible || {};
  const state = String(item.InstanceState || "").toUpperCase();
  return {
    ...item,
    InstanceName: item.InstanceName || item.InstanceId,
    Status: state === "RUNNING" ? "Running" : state === "STOPPED" ? "Stopped" : item.InstanceState || "Unknown",
    PublicIpAddress: item.PublicIpAddresses || [],
    PrivateIpAddress: item.PrivateIpAddresses || [],
    Cpu: item.CPU || 0,
    Memory: item.Memory || 0,
    InternetMaxBandwidthIn: 0,
    InternetMaxBandwidthOut: network.InternetMaxBandwidthOut || 0,
    OSName: item.OsName || item.OsType || "-",
    CreationTime: item.CreatedTime || "",
    ExpiredTime: item.ExpiredTime || "",
    _region_id: region.Region || "",
    _region_name: region.RegionName || region.Region || "",
  };
}
function tencentLighthouseInstance(item, region) {
  const state = String(item.InstanceState || item.InstanceStatus || "").toUpperCase();
  return {
    ...item,
    InstanceName: item.InstanceName || item.InstanceId,
    InstanceStatus: state === "RUNNING" ? "Running" : state === "STOPPED" ? "Stopped" : item.InstanceState || item.InstanceStatus || "Unknown",
    Status: state === "RUNNING" ? "Running" : state === "STOPPED" ? "Stopped" : item.InstanceState || item.InstanceStatus || "Unknown",
    PublicIpAddress: item.PublicAddresses || item.PublicIpAddresses || [],
    PublicIp: Array.isArray(item.PublicAddresses) ? item.PublicAddresses[0] || "" : item.PublicAddresses || "",
    ImageName: item.BlueprintName || item.BlueprintId || "",
    PlanId: item.BundleId || item.BundleName || "",
    ExpiredTime: item.ExpiredTime || "",
    _region_id: region,
  };
}
function tencentCdbInstance(item, region) {
  const status = String(item.Status || item.DBInstanceStatus || "");
  return {
    ...item,
    DBInstanceId: item.InstanceId || item.DBInstanceId,
    DBInstanceDescription: item.InstanceName || item.DBInstanceDescription || item.InstanceId,
    DBInstanceStatus: status === "1" ? "Running" : status === "0" ? "Stopped" : status,
    DBInstanceType: item.DeviceType || item.InstanceType || "",
    DBInstanceClass: item.InstanceType || item.Model || "",
    DBInstanceStorage: item.Volume || item.Storage || 0,
    ConnectionString: item.Vip || item.ConnectionString || "",
    Port: item.Vport || item.Port || "",
    DBInstanceNetType: item.ProjectId ? "私有网络" : "-",
    Engine: item.Engine || "MySQL",
    EngineVersion: item.EngineVersion || "",
    CreateTime: item.CreateTime || "",
    ExpireTime: item.DeadlineTime || item.ExpireTime || "",
    _region_id: region,
  };
}
function tencentRedisInstance(item, region) {
  const status = String(item.Status || item.InstanceStatus || "");
  return {
    ...item,
    InstanceId: item.InstanceId,
    InstanceName: item.InstanceName || item.InstanceId,
    InstanceStatus: ["2", "RUNNING", "NORMAL"].includes(status.toUpperCase()) ? "Normal" : status,
    InstanceType: item.Type || item.TypeName || "",
    InstanceClass: item.Size || item.TypeName || "",
    Capacity: item.Size || item.Capacity || 0,
    Bandwidth: item.Bandwidth || 0,
    Connections: item.ClientLimit || item.Connections || 0,
    ConnectionDomain: item.WanIp || item.PrivateIp || item.ConnectionDomain || "",
    Port: item.Port || "",
    EngineVersion: item.CurrentRedisVersion || item.RedisVersion || "",
    NetworkType: item.NetType || "",
    ChargeType: item.BillingMode || "",
    EndTime: item.DeadTime || item.EndTime || "",
    ArchitectureType: item.Type || "standard",
    _region_id: region,
  };
}
function tencentEdgeZone(item) {
  return {
    ...item,
    SiteId: item.ZoneId || item.Id,
    SiteName: item.ZoneName || item.ZoneId,
    DomainName: item.ZoneName || "",
    Status: item.ActiveStatus || item.Status || "",
    AccessType: item.Type || item.ZoneType || "",
    Coverage: item.Area || item.PlanType || "",
    PlanName: item.PlanType || item.Plan || "",
  };
}
function tencentDomainFromRegistration(item) {
  return {
    ...item,
    DomainName: item.DomainName || item.Name,
    RegistrationDate: item.RegistrationDate || item.CreationDate || item.CreatedOn || "",
    ExpirationDate: item.ExpirationDate || item.ExpiredDate || "",
    RegistrantOrganization: item.RegistrantOrganization || item.RegistrantName || "",
    DomainAuditStatus: item.RealNameAuditStatus || item.DomainAuditStatus || "",
    DomainStatus: item.Status || "",
    DnsServers: item.DnsList || item.NameServerSet || [],
  };
}
function tencentDomainFromDnsPod(item) {
  return {
    ...item,
    DomainName: item.Name || item.DomainName,
    RecordCount: tencentNumber(item.RecordCount),
    VersionCode: item.Grade || item.GradeTitle || "",
    CreateTime: item.CreatedOn || item.CreatedAt || "",
    DomainStatus: item.Status || "",
    DnsServers: item.NameServers || [],
    DnsSource: "DNSPod",
  };
}
async function tencentPaged(accountId, service, version, action, payload, path, region = "") {
  const items = [];
  const limit = 100;
  for (let offset = 0; offset < 10000; offset += limit) {
    const data = await tencentRequest(accountId, service, version, action, { ...payload, Offset: offset, Limit: limit }, region);
    const page = arr(data, path);
    items.push(...page);
    const total = tencentNumber(data.TotalCount || data.DomainCountInfo?.AllTotal || data.DomainCountInfo?.TotalCount);
    if (!page.length || page.length < limit || (total && items.length >= total)) break;
  }
  return items;
}
async function tencentResources(id, type) {
  const errors = [];
  if (type === "ecs") {
    let regions = [];
    try { regions = arr(await tencentRequest(id, "cvm", "2017-03-12", "DescribeRegions"), ["RegionSet"]); }
    catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; }
    const items = [];
    for (const region of regions.filter((item) => String(item.RegionState || "AVAILABLE").toUpperCase() === "AVAILABLE")) {
      try {
        const instances = await tencentPaged(id, "cvm", "2017-03-12", "DescribeInstances", {}, ["InstanceSet"], String(region.Region || ""));
        items.push(...instances.map((item) => tencentInstance(item, region)));
      } catch (error) { errors.push(`${region.Region || "未知地域"}: ${error.message}`); }
    }
    return { resource_type: type, items, errors, fetched_at: Date.now() };
  }
  if (type === "domain") {
    const [registered, hosted] = await Promise.allSettled([
      tencentPaged(id, "domain", "2018-08-08", "DescribeDomainNameList", {}, ["DomainSet"]),
      tencentPaged(id, "dnspod", "2021-03-23", "DescribeDomainList", {}, ["DomainList"]),
    ]);
    const merged = new Map();
    if (registered.status === "fulfilled") {
      for (const item of registered.value) {
        const normalized = tencentDomainFromRegistration(item);
        if (normalized.DomainName) merged.set(String(normalized.DomainName).toLowerCase(), normalized);
      }
    } else errors.push(`域名注册: ${registered.reason?.message || registered.reason}`);
    if (hosted.status === "fulfilled") {
      for (const item of hosted.value) {
        const normalized = tencentDomainFromDnsPod(item);
        if (!normalized.DomainName) continue;
        const key = String(normalized.DomainName).toLowerCase();
        merged.set(key, { ...(merged.get(key) || {}), ...normalized, DomainName: normalized.DomainName });
      }
    } else errors.push(`DNSPod: ${hosted.reason?.message || hosted.reason}`);
    return { resource_type: type, items: [...merged.values()], errors, fetched_at: Date.now() };
  }
  if (type === "swas") {
    const account = database().prepare("SELECT region_id FROM cloud_accounts WHERE id=?").get(id);
    const fallbackRegion = String(account?.region_id || "ap-guangzhou");
    let regions = [fallbackRegion];
    try {
      const regionData = await tencentRequest(id, "lighthouse", "2020-03-24", "DescribeRegions");
      regions = [...new Set(
        arr(regionData, ["RegionSet"])
          .filter((item) => String(item.RegionState || "AVAILABLE").toUpperCase() === "AVAILABLE")
          .map((item) => String(item.Region || ""))
          .filter(Boolean),
      )];
    } catch (error) {
      errors.push(`读取轻量服务器地域失败，已仅查询 ${fallbackRegion}: ${error.message}`);
    }
    const items = [];
    for (const region of regions) {
      try {
        const instances = await tencentPaged(id, "lighthouse", "2020-03-24", "DescribeInstances", {}, ["InstanceSet"], region);
        items.push(...instances.map((item) => tencentLighthouseInstance(item, region)));
      } catch (error) { errors.push(`${region}: ${error.message}`); }
    }
    return { resource_type: type, items, errors, fetched_at: Date.now() };
  }
  if (type === "rds" || type === "redis") {
    let regions = [];
    try { regions = arr(await tencentRequest(id, "cvm", "2017-03-12", "DescribeRegions"), ["RegionSet"]).filter((item) => String(item.RegionState || "AVAILABLE").toUpperCase() === "AVAILABLE").map((item) => String(item.Region || "")).filter(Boolean); }
    catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; }
    const items = [];
    const service = type === "rds" ? "cdb" : "redis";
    const version = type === "rds" ? "2017-03-20" : "2018-04-12";
    const action = type === "rds" ? "DescribeDBInstances" : "DescribeInstances";
    const path = type === "rds" ? ["Items"] : ["InstanceSet"];
    for (const region of regions) {
      try {
        const values = await tencentPaged(id, service, version, action, {}, path, region);
        items.push(...values.map((item) => type === "rds" ? tencentCdbInstance(item, region) : tencentRedisInstance(item, region)));
      } catch (error) { errors.push(`${region}: ${error.message}`); }
    }
    return { resource_type: type, items, errors, fetched_at: Date.now() };
  }
  if (type === "oss") {
    try { return { resource_type: type, items: await cosBuckets(id), errors, fetched_at: Date.now() }; }
    catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; }
  }
  if (type === "esa") {
    try {
      const zones = await tencentPaged(id, "teo", "2022-09-01", "DescribeZones", {}, ["Zones"], "");
      return { resource_type: type, items: zones.map(tencentEdgeZone), errors, fetched_at: Date.now() };
    } catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; }
  }
  return { resource_type: type, items: [], errors: [`腾讯云暂未接入 ${type} 资源`], fetched_at: Date.now() };
}

  return {
    request: tencentRequest,
    resources: tencentResources,
    number: tencentNumber,
    securityGroupDetails: tencentSecurityGroupDetails,
    securityGroupPolicy: tencentSecurityGroupPolicy,
    lighthousePort: tencentLighthousePort,
  };
}
