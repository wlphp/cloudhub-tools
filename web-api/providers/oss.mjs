export function createOssProvider({ crypto, database, decryptSecret, rpc, xmlDecode, xmlText, xmlBlocks }) {
function cosEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
function cosAuthorization(accessKeyId, secret, host, method, query = "", signHost = true) {
  const start = Math.round(Date.now() / 1000) - 1;
  const signTime = `${start};${start + 900}`;
  const queryItems = String(query).split("&").filter(Boolean).map((entry) => {
    const [key, value = ""] = entry.split("=", 2);
    return [cosEncode(decodeURIComponent(key)), cosEncode(decodeURIComponent(value))];
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const canonicalQuery = queryItems.map(([key, value]) => `${key}=${value}`).join("&");
  const signedQueryKeys = queryItems.map(([key]) => key).join(";");
  const canonicalRequest = `${method.toLowerCase()}\n/\n${canonicalQuery}\n${signHost ? `host=${host}` : ""}\n`;
  const signKey = crypto.createHmac("sha1", secret).update(signTime).digest("hex");
  const stringToSign = `sha1\n${signTime}\n${crypto.createHash("sha1").update(canonicalRequest).digest("hex")}\n`;
  const signature = crypto.createHmac("sha1", signKey).update(stringToSign).digest("hex");
  return `q-sign-algorithm=sha1&q-ak=${cosEncode(accessKeyId)}&q-sign-time=${signTime}&q-key-time=${signTime}&q-header-list=${signHost ? "host" : ""}&q-url-param-list=${signedQueryKeys}&q-signature=${signature}`;
}
function cosAccount(id) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(id);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "tencent") throw new Error("当前账号不是腾讯云账号");
  return { ...row, secret: decryptSecret(row.secret_ciphertext) };
}
async function cosRequest(id, bucket, location, query = "") {
  const row = cosAccount(id);
  const host = bucket ? `${bucket}.cos.${location}.myqcloud.com` : "service.cos.myqcloud.com";
  const authorization = cosAuthorization(row.access_key_id, row.secret, host, "GET", query, Boolean(bucket));
  const response = await fetch(`https://${host}/${query ? `?${query}` : ""}`, { headers: { Host: host, Authorization: authorization } });
  const xml = await response.text();
  if (!response.ok) throw new Error(`COS ${response.status}: ${xmlText(xml, "Message") || xmlText(xml, "Code") || "请求被拒绝"}`);
  return xml;
}
async function cosBuckets(id) {
  const xml = await cosRequest(id, "", "");
  return xmlBlocks(xml, "Bucket").map((block) => ({
    Name: xmlText(block, "Name"), Location: xmlText(block, "Location"), CreationDate: xmlText(block, "CreationDate"),
    StorageClass: "Standard", ExtranetEndpoint: `${xmlText(block, "Name")}.cos.${xmlText(block, "Location")}.myqcloud.com`, IntranetEndpoint: "-", Acl: "private",
  })).filter((bucket) => bucket.Name && bucket.Location);
}
async function cosObjects(id, bucket, location, { prefix = "", marker = "" } = {}) {
  const query = new URLSearchParams({ "list-type": "2", "max-keys": "1000", delimiter: "/" });
  if (prefix) query.set("prefix", prefix);
  if (marker) query.set("continuation-token", marker);
  const xml = await cosRequest(id, bucket, location, query.toString());
  return {
    objects: xmlBlocks(xml, "Contents").map((block) => ({ Key: xmlText(block, "Key"), LastModified: xmlText(block, "LastModified"), ETag: xmlText(block, "ETag"), Size: xmlText(block, "Size") })).filter((item) => item.Key && item.Key !== prefix),
    prefixes: xmlBlocks(xml, "CommonPrefixes").map((block) => xmlText(block, "Prefix")).filter(Boolean),
    isTruncated: xmlText(xml, "IsTruncated").toLowerCase() === "true",
    nextMarker: xmlText(xml, "NextContinuationToken"),
  };
}
async function cosAcl(id, bucket, location) {
  const xml = await cosRequest(id, bucket, location, "acl");
  return xmlText(xml, "Permission") || "private";
}
async function cosDetail(id, bucket, location) {
  // COS does not expose the OSS-style stat endpoint. Walk the V2 object list
  // instead so the reused bucket UI can still show a real file count and size.
  let marker = "";
  let storage = 0;
  let objectCount = 0;
  const errors = [];
  try {
    for (let page = 0; page < 100; page += 1) {
      const listing = await cosObjects(id, bucket, location, { marker });
      objectCount += listing.objects.length;
      storage += listing.objects.reduce((total, object) => total + Number(object.Size || 0), 0);
      if (!listing.isTruncated || !listing.nextMarker) break;
      marker = listing.nextMarker;
      if (page === 99) errors.push("对象数量超过 100,000，容量统计仅包含前 100,000 个对象");
    }
  } catch (error) {
    errors.push(error.message || String(error));
  }
  let acl = "private";
  try { acl = await cosAcl(id, bucket, location); }
  catch (error) { errors.push(error.message || String(error)); }
  return {
    storage,
    objectCount,
    multipartUploadCount: 0,
    liveChannelCount: 0,
    monthTraffic: 0,
    monthRequests: 0,
    acl,
    cnames: [],
    cors: [],
    errors,
  };
}
function ossError(status, xml) {
  return `OSS ${status}: ${xmlText(xml, "Message") || xmlText(xml, "Code") || "请求被拒绝"}`;
}
function bucketEndpoint(name, endpoint, location, internal = false) {
  const fallback = `${location}${internal ? "-internal" : ""}.aliyuncs.com`;
  const value = String(endpoint || fallback).replace(/^https?:\/\//, "").replace(/\/$/, "");
  return value === name || value.startsWith(`${name}.`) ? value : `${name}.${value}`;
}
function ossAccount(id) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(id);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "aliyun") throw new Error(`${row.cloud_type === "tencent" ? "腾讯云" : "当前云类型"}对象存储 API 尚未接入`);
  return { ...row, secret: decryptSecret(row.secret_ciphertext) };
}
async function ossRequest(id, bucket, location, { method = "GET", query = "", resource = "", body = "", contentType = "", headers = {} } = {}) {
  const row = ossAccount(id);
  const loc = location || "oss-cn-hangzhou";
  const host = bucket ? `${bucket}.${loc}.aliyuncs.com` : "oss-cn-hangzhou.aliyuncs.com";
  const date = new Date().toUTCString();
  const payloadHeaders = { ...headers };
  const canonicalHeaders = Object.entries(payloadHeaders)
    .filter(([key]) => key.toLowerCase().startsWith("x-oss-"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key.toLowerCase()}:${String(value).trim()}\n`).join("");
  const md5 = body ? crypto.createHash("md5").update(body).digest("base64") : "";
  const canonicalResource = resource || `/${bucket ? `${bucket}/` : ""}`;
  const signature = crypto.createHmac("sha1", row.secret)
    .update(`${method}\n${md5}\n${contentType}\n${date}\n${canonicalHeaders}${canonicalResource}`)
    .digest("base64");
  const response = await fetch(`https://${host}/${query ? `?${query}` : ""}`, {
    method,
    headers: { Date: date, Host: host, ...(contentType ? { "Content-Type": contentType } : {}), ...(md5 ? { "Content-MD5": md5 } : {}), ...payloadHeaders, Authorization: `OSS ${row.access_key_id}:${signature}` },
    body: body || undefined,
  });
  const xml = await response.text();
  if (!response.ok) throw new Error(ossError(response.status, xml));
  return xml;
}
async function ossObjects(id, bucket, location, { prefix = "", marker = "" } = {}) {
  const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
  if (account?.cloud_type === "tencent") return cosObjects(id, bucket, location, { prefix, marker });
  // delimiter lets OSS return the immediate folders as CommonPrefixes instead
  // of forcing the client to fetch and reconstruct every object in the bucket.
  const query = new URLSearchParams({ "max-keys": "1000", delimiter: "/" });
  if (prefix) query.set("prefix", prefix);
  if (marker) query.set("marker", marker);
  const xml = await ossRequest(id, bucket, location, { query: query.toString(), resource: `/${bucket}/` });
  const objects = xmlBlocks(xml, "Contents")
    .map((block) => ({ Key: xmlText(block, "Key"), LastModified: xmlText(block, "LastModified"), ETag: xmlText(block, "ETag"), Size: xmlText(block, "Size") }))
    // OSS may return the zero-byte directory marker itself; it is already shown
    // by CommonPrefixes and should not appear as a duplicate file.
    .filter((object) => object.Key && object.Key !== prefix);
  return {
    objects,
    prefixes: xmlBlocks(xml, "CommonPrefixes").map((block) => xmlText(block, "Prefix")).filter(Boolean),
    isTruncated: xmlText(xml, "IsTruncated").toLowerCase() === "true",
    nextMarker: xmlText(xml, "NextMarker"),
  };
}
async function ossAcl(id, bucket, location) {
  const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
  if (account?.cloud_type === "tencent") return cosAcl(id, bucket, location);
  const xml = await ossRequest(id, bucket, location, { query: "acl", resource: `/${bucket}/?acl` });
  return xmlText(xml, "Permission") || "private";
}
async function ossStat(id, bucket, location) {
  const xml = await ossRequest(id, bucket, location, { query: "stat", resource: `/${bucket}/?stat` });
  return Object.fromEntries(["Storage", "ObjectCount", "MultipartUploadCount", "LiveChannelCount", "LastModifiedTime"].map((key) => [key, xmlText(xml, key)]));
}
async function ossCnames(id, bucket, location) {
  const xml = await ossRequest(id, bucket, location, { query: "cname", resource: `/${bucket}/?cname` });
  return xmlBlocks(xml, "Cname").map((block) => ({ Domain: xmlText(block, "Domain"), Status: xmlText(block, "Status") })).filter((item) => item.Domain);
}
async function ossCors(id, bucket, location) {
  const xml = await ossRequest(id, bucket, location, { query: "cors", resource: `/${bucket}/?cors` });
  return xmlBlocks(xml, "CORSRule").map((block) => ({ origin: xmlBlocks(block, "AllowedOrigin").map(xmlDecode), method: xmlBlocks(block, "AllowedMethod").map(xmlDecode), header: xmlBlocks(block, "AllowedHeader").map(xmlDecode) }));
}
function metricTotal(data) {
  const points = typeof data?.Datapoints === "string" ? JSON.parse(data.Datapoints || "[]") : data?.Datapoints || [];
  return Array.isArray(points) ? points.reduce((sum, point) => sum + Number(point?.Value || 0), 0) : 0;
}
async function ossMonthMetrics(id, bucket) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().replace(/\.\d{3}Z$/, "Z");
  const end = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const params = { Namespace: "acs_oss_dashboard", Dimensions: JSON.stringify({ BucketName: bucket }), StartTime: start, EndTime: end, Period: "3600" };
  const [traffic, get, put] = await Promise.all([
    rpc(id, "metrics.aliyuncs.com", "2019-01-01", "DescribeMetricList", { ...params, MetricName: "MeteringInternetTX" }),
    rpc(id, "metrics.aliyuncs.com", "2019-01-01", "DescribeMetricList", { ...params, MetricName: "MeteringGetRequest" }),
    rpc(id, "metrics.aliyuncs.com", "2019-01-01", "DescribeMetricList", { ...params, MetricName: "MeteringPutRequest" }),
  ]);
  return { monthTraffic: metricTotal(traffic), monthRequests: metricTotal(get) + metricTotal(put) };
}
async function ossDetail(id, bucket, location) {
  const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
  if (account?.cloud_type === "tencent") return cosDetail(id, bucket, location);
  const [stat, cnames, acl, cors, metrics] = await Promise.allSettled([ossStat(id, bucket, location), ossCnames(id, bucket, location), ossAcl(id, bucket, location), ossCors(id, bucket, location), ossMonthMetrics(id, bucket)]);
  const errors = [stat, cnames, acl, cors]
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason?.message || result.reason))
    .filter((message) => !message.includes("The CORS Configuration does not exist"));
  const values = (result, fallback) => result.status === "fulfilled" ? result.value : fallback;
  const summary = values(stat, {});
  return { storage: Number(summary.Storage || 0), objectCount: Number(summary.ObjectCount || 0), multipartUploadCount: Number(summary.MultipartUploadCount || 0), liveChannelCount: Number(summary.LiveChannelCount || 0), monthTraffic: values(metrics, {}).monthTraffic || 0, monthRequests: values(metrics, {}).monthRequests || 0, acl: values(acl, "private"), cnames: values(cnames, []), cors: values(cors, []), errors };
}
async function ossSetPublicRead(id, bucket, location) {
  await ossRequest(id, bucket, location, { method: "PUT", query: "acl", resource: `/${bucket}/?acl`, headers: { "x-oss-acl": "public-read", "Content-Length": "0" } });
}
async function ossSetCors(id, bucket, location, origins) {
  const safeOrigin = String(origins || "*").replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]);
  const body = `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule><AllowedOrigin>${safeOrigin}</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>POST</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>DELETE</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>`;
  await ossRequest(id, bucket, location, { method: "PUT", query: "cors", resource: `/${bucket}/?cors`, body, contentType: "application/xml" });
}
function validCname(domain) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(domain);
}
async function ossCnameMutation(id, bucket, location, operation, domain) {
  const value = String(domain || "").trim().toLowerCase();
  if (!validCname(value)) throw new Error("请输入有效的完整域名，例如 img.example.com");
  const component = operation === "token" ? "token" : operation === "bind" ? "add" : "delete";
  const query = `cname&comp=${component}`;
  const body = `<BucketCnameConfiguration><Cname><Domain>${value.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character])}</Domain></Cname></BucketCnameConfiguration>`;
  const xml = await ossRequest(id, bucket, location, { method: "POST", query, resource: `/${bucket}/?${query}`, body, contentType: "application/xml" });
  return { domain: value, token: xmlText(xml, "Token"), cname: xmlText(xml, "Cname"), expireTime: xmlText(xml, "ExpireTime") };
}

  return {
    request: ossRequest,
    listBuckets: cosBuckets,
    objects: ossObjects,
    acl: ossAcl,
    detail: ossDetail,
    setPublicRead: ossSetPublicRead,
    setCors: ossSetCors,
    cnameMutation: ossCnameMutation,
    bucketEndpoint,
  };
}