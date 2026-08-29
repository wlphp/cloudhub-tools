export function createAliyunProvider({ crypto, database, decryptSecret, writeApiLog, arr, xmlText, xmlBlocks, getOss, edgeResources }) {
  function encode(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  async function rpc(accountId, endpoint, version, action, params = {}) {
    const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
    if (!row) throw new Error("云账号不存在");
    if (!row.enabled) throw new Error("云账号已停用");
    if (row.cloud_type !== "aliyun") throw new Error(`${row.cloud_type === "tencent" ? "腾讯云" : "当前云类型"}资源 API 尚未接入`);
    const secret = decryptSecret(row.secret_ciphertext).trim();
    const query = {
      ...params,
      AccessKeyId: row.access_key_id,
      Action: action,
      Format: "JSON",
      SignatureMethod: "HMAC-SHA1",
      SignatureNonce: crypto.randomUUID(),
      SignatureVersion: "1.0",
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      Version: version,
    };
    const encoded = Object.entries(query)
      .map(([key, value]) => [encode(key), encode(value)])
      .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0);
    const canonical = encoded.map(([key, value]) => `${key}=${value}`).join("&");
    const stringToSign = `GET&%2F&${encode(canonical)}`;
    query.Signature = crypto.createHmac("sha1", `${secret}&`).update(stringToSign).digest("base64");
    const finalUrl = new URL(`https://${endpoint}/`);
    for (const [key, value] of Object.entries(query)) finalUrl.searchParams.set(key, String(value));
    const response = await fetch(finalUrl.toString());
    const data = await response.json();
    if (!response.ok || (data.Code && data.Code !== "200" && data.Code !== "Success")) {
      const message = data.Message || data.Code || `Aliyun ${response.status}`;
      writeApiLog(accountId, endpoint, action, query, data, "失败", message);
      throw new Error(message);
    }
    writeApiLog(accountId, endpoint, action, query, data, "成功");
    return data;
  }

  async function regions(id) {
    const data = await rpc(id, "ecs.aliyuncs.com", "2014-05-26", "DescribeRegions");
    return arr(data, ["Regions", "Region"]).map((region) => region.RegionId).filter(Boolean);
  }

  async function domainResources(id) {
    const [registration, dns] = await Promise.allSettled([
      rpc(id, "domain.aliyuncs.com", "2018-01-29", "QueryDomainList", { PageNum: "1", PageSize: "100" }),
      rpc(id, "alidns.aliyuncs.com", "2015-01-09", "DescribeDomains", { PageNumber: "1", PageSize: "20" }),
    ]);
    const merged = new Map();
    const errors = [];
    if (registration.status === "fulfilled") {
      for (const item of arr(registration.value, ["Data", "Domain"])) {
        const name = String(item.DomainName || "").trim();
        if (name) merged.set(name.toLowerCase(), { ...item });
      }
    } else errors.push(`域名注册: ${registration.reason?.message || registration.reason}`);
    if (dns.status === "fulfilled") {
      for (const item of arr(dns.value, ["Domains", "Domain"])) {
        const name = String(item.DomainName || "").trim();
        if (!name) continue;
        const key = name.toLowerCase();
        merged.set(key, { ...(merged.get(key) || { DomainName: name }), ...item, DomainName: name, RecordCount: Number(item.RecordCount || 0) });
      }
    } else errors.push(`AliDNS: ${dns.reason?.message || dns.reason}`);
    return { resource_type: "domain", items: [...merged.values()], errors, fetched_at: Date.now() };
  }

  async function resources(id, type) {
    if (type === "domain") return domainResources(id);
    const items = [];
    const errors = [];
    if (type === "oss") {
      const { request: ossRequest, bucketEndpoint } = getOss();
      let token = "";
      let page = 0;
      do {
        const query = new URLSearchParams({ "max-keys": "1000" });
        if (token) query.set("continuation-token", token);
        const xml = await ossRequest(id, "", "", { query: query.toString(), resource: "/" });
        for (const block of xmlBlocks(xml, "Bucket")) {
          const name = xmlText(block, "Name");
          const location = xmlText(block, "Location");
          if (!name || !location) continue;
          items.push({
            Name: name,
            Location: location,
            CreationDate: xmlText(block, "CreationDate"),
            StorageClass: xmlText(block, "StorageClass") || "Standard",
            ExtranetEndpoint: bucketEndpoint(name, xmlText(block, "ExtranetEndpoint"), location),
            IntranetEndpoint: bucketEndpoint(name, xmlText(block, "IntranetEndpoint"), location, true),
            Acl: xmlText(block, "Acl") || "private",
          });
        }
        token = xmlText(xml, "NextContinuationToken");
        page += 1;
        if (xmlText(xml, "IsTruncated").toLowerCase() !== "true") token = "";
      } while (token && page < 100);
      return { resource_type: type, items, errors: token ? ["OSS 存储桶分页超过 100 页，已停止读取"] : errors, fetched_at: Date.now() };
    }
    if (type === "ecs" || type === "swas") {
      const regionIds = type === "ecs" ? await regions(id) : ["cn-hangzhou", "cn-shanghai", "cn-beijing", "cn-shenzhen", "cn-hongkong", "ap-southeast-1"];
      for (const regionId of regionIds) {
        try {
          const data = type === "ecs"
            ? await rpc(id, `ecs.${regionId}.aliyuncs.com`, "2014-05-26", "DescribeInstances", { RegionId: regionId, PageSize: "100" })
            : await rpc(id, `swas.${regionId}.aliyuncs.com`, "2020-06-01", "ListInstances", { RegionId: regionId, PageSize: "100" });
          const path = type === "ecs" ? ["Instances", "Instance"] : ["Instances"];
          for (const item of arr(data, path)) items.push({ ...item, _region_id: regionId });
        } catch (error) { errors.push(`${regionId}: ${error.message}`); }
      }
      return { resource_type: type, items, errors, fetched_at: Date.now() };
    }
    if (type === "rds" || type === "redis") {
      for (const regionId of await regions(id)) {
        try {
          const data = await rpc(id, type === "rds" ? "rds.aliyuncs.com" : "r-kvstore.aliyuncs.com", type === "rds" ? "2014-08-15" : "2015-01-01", type === "rds" ? "DescribeDBInstances" : "DescribeInstances", { RegionId: regionId, PageSize: "100" });
          const path = type === "rds" ? ["Items", "DBInstance"] : ["Instances", "KVStoreInstance"];
          for (const item of arr(data, path)) items.push({ ...item, _region_id: regionId });
        } catch (error) { errors.push(`${regionId}: ${error.message}`); }
      }
      return { resource_type: type, items, errors, fetched_at: Date.now() };
    }
    if (type === "esa") {
      try {
        const data = await esaRequest(id, "ListSites", { PageNumber: "1", PageSize: "100" });
        return { resource_type: type, items: arr(data, ["Sites"]), errors: [], fetched_at: Date.now() };
      } catch (error) {
        return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() };
      }
    }
    return { resource_type: type, items: [], errors: [`Web 预览暂未接入 ${type} API`], fetched_at: Date.now() };
  }

  async function esaRequest(id, action, params = {}, method = "GET") {
    const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(id);
    if (!row) throw new Error("云账号不存在");
    if (!row.enabled) throw new Error("云账号已停用");
    if (row.cloud_type !== "aliyun") throw new Error(`${row.cloud_type === "tencent" ? "腾讯云" : "当前云类型"}资源 API 尚未接入`);
    const host = "esa.cn-hangzhou.aliyuncs.com";
    const normalizedMethod = method.toUpperCase();
    const query = Object.entries(params).map(([key, value]) => [encode(key), encode(value)]).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("&");
    const payloadHash = crypto.createHash("sha256").update("").digest("hex");
    const acsDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const headers = { host, "x-acs-action": action, "x-acs-content-sha256": payloadHash, "x-acs-date": acsDate, "x-acs-signature-nonce": crypto.randomUUID(), "x-acs-version": "2024-09-10" };
    const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]}\n`).join("");
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalRequest = `${normalizedMethod}\n/\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const stringToSign = `ACS3-HMAC-SHA256\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
    const signature = crypto.createHmac("sha256", decryptSecret(row.secret_ciphertext)).update(stringToSign).digest("hex");
    const authorization = `ACS3-HMAC-SHA256 Credential=${row.access_key_id},SignedHeaders=${signedHeaders},Signature=${signature}`;
    const response = await fetch(`https://${host}/${query ? `?${query}` : ""}`, { method: normalizedMethod, headers: { ...headers, authorization } });
    const data = await response.json();
    if (!response.ok || data.Code) {
      const message = data.Message || data.Code || `ESA ${response.status}`;
      writeApiLog(id, host, action, params, data, "失败", message);
      throw new Error(message);
    }
    writeApiLog(id, host, action, params, data, "成功");
    return data;
  }

  function esaRange(range) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let start = today;
    let end = now;
    let label = "今日";
    if (range === "yesterday") { start = new Date(today); start.setDate(start.getDate() - 1); end = today; label = "昨日"; }
    else if (range === "week") { start = new Date(today); start.setDate(start.getDate() - 6); label = "近 7 日"; }
    else if (range === "month") { start = new Date(today); start.setDate(start.getDate() - 29); label = "近 30 日"; }
    return { start, end, label, interval: range === "week" || range === "month" ? "86400" : "3600" };
  }

  function esaDetails(data, fieldName) {
    const row = arr(data, ["Data"]).find((item) => item.FieldName === fieldName);
    return row ? arr(row, ["DetailData"]) : [];
  }

  async function esaOverview(id, range = "today", siteId = "") {
    const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
    const selectedRange = ["today", "yesterday", "week", "month"].includes(range) ? range : "today";
    if (account?.cloud_type === "tencent" || account?.cloud_type === "volcengine") {
      const zones = await edgeResources(account.cloud_type, id);
      const sites = zones.items;
      return { traffic: 0, requests: 0, defence_requests: 0, site_count: sites.length, active_count: sites.filter((site) => String(site.Status || "").toLowerCase() === "active").length, range_label: esaRange(selectedRange).label, trend: { traffic: [], requests: [], page_view: [] }, site_options: sites.map((site) => ({ id: String(site.SiteId || ""), name: String(site.SiteName || site.DomainName || site.SiteId || "") })) };
    }
    const sitesResult = await esaRequest(id, "ListSites", { SiteSearchType: "fuzzy", SiteName: "", PageNumber: "1", PageSize: "100" });
    const sites = arr(sitesResult, ["Sites"]);
    const period = esaRange(selectedRange);
    const fields = JSON.stringify([{ FieldName: "Requests", Dimension: ["ALL"] }, { FieldName: "Traffic", Dimension: ["ALL"] }, { FieldName: "PageView", Dimension: ["ALL"] }]);
    const base = { StartTime: period.start.toISOString().replace(/\.\d{3}Z$/, "Z"), EndTime: period.end.toISOString().replace(/\.\d{3}Z$/, "Z"), Interval: period.interval };
    const siteParam = siteId ? { SiteId: siteId } : {};
    const [top, defence, trend] = await Promise.all([
      esaRequest(id, "DescribeSiteTopData", { ...base, AnalysisType: "1", Fields: fields, ...siteParam }, "POST"),
      esaRequest(id, "DescribeSiteStatisticsData", { ...base, Fields: JSON.stringify([{ FieldName: "Requests", Dimension: ["ALL"] }]), Filter: JSON.stringify({ where: { and: [[{ key: "MitigationType", operator: "in", value: ["WafMitigated"] }]] } }), ...siteParam }, "POST"),
      esaRequest(id, "DescribeSiteStatisticsData", { ...base, Fields: fields, ...siteParam }, "POST"),
    ]);
    const toNumber = (value) => Number(value || 0) || 0;
    const trendMap = { traffic: [], requests: [], page_view: [] };
    for (const [fieldName, key] of [["Traffic", "traffic"], ["Requests", "requests"], ["PageView", "page_view"]]) trendMap[key] = esaDetails(trend, fieldName).map((detail) => ({ time: detail.Time || detail.Timestamp || detail.TimeStamp || detail.Date || "", value: toNumber(detail.Value) }));
    return { traffic: toNumber(esaDetails(top, "Traffic")[0]?.Value), requests: toNumber(esaDetails(top, "Requests")[0]?.Value), defence_requests: toNumber(esaDetails(defence, "Requests")[0]?.Value), site_count: Number(sitesResult.TotalCount || sites.length), active_count: sites.filter((site) => String(site.Status || "").toLowerCase() === "active").length, range_label: period.label, trend: trendMap, site_options: sites.map((site) => ({ id: String(site.SiteId || ""), name: String(site.SiteName || site.DomainName || site.SiteId || "") })) };
  }

  return { rpc, resources, esaOverview };
}
