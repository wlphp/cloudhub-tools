import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const localAppData =
  process.env.LOCALAPPDATA ||
  path.join(process.env.USERPROFILE, "AppData", "Local");
const dataDir = path.join(localAppData, "CloudHubTools");
const legacyDataDir = path.join(localAppData, "AliyunTools");
const dbPath = path.join(dataDir, "cloudhub_tools.sqlite3");
const keyPath = path.join(dataDir, ".key");
const port = Number(process.env.CLOUDHUB_TOOLS_WEB_API_PORT || process.env.ALIYUN_TOOLS_WEB_API_PORT || 1430);

function migrateLegacyData() {
  if (fs.existsSync(dataDir) || !fs.existsSync(legacyDataDir)) return;
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [legacyName, currentName] of [["aliyun_tools.sqlite3", "cloudhub_tools.sqlite3"], [".key", ".key"]]) {
    const source = path.join(legacyDataDir, legacyName);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dataDir, currentName));
  }
}

migrateLegacyData();
fs.mkdirSync(dataDir, { recursive: true });

function database() {
  const db = new DatabaseSync(dbPath);
  try { db.exec("ALTER TABLE cloud_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"); } catch { /* already migrated */ }
  try { db.exec("ALTER TABLE cloud_accounts ADD COLUMN credential_meta TEXT"); } catch { /* already migrated */ }
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_assets (
    account_id INTEGER NOT NULL,
    resource_type TEXT NOT NULL,
    asset_key TEXT NOT NULL,
    region_id TEXT,
    payload_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY(account_id, resource_type, asset_key)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS api_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, endpoint TEXT NOT NULL,
    action TEXT NOT NULL, request_params TEXT NOT NULL, response_params TEXT,
    status TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, action TEXT NOT NULL,
    result TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL
  )`);
  return db;
}
function writeApiLog(accountId, endpoint, action, request, response, status, message = null) {
  const db = database();
  db.prepare("INSERT INTO api_logs(account_id,endpoint,action,request_params,response_params,status,message,created_at) VALUES(?,?,?,?,?,?,?,?)").run(accountId, endpoint, action, JSON.stringify(request || {}), response == null ? null : JSON.stringify(response), status, message, Date.now());
}
function decryptSecret(ciphertext) {
  const packed = Buffer.from(ciphertext, "base64");
  const key = fs.readFileSync(keyPath);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    packed.subarray(0, 12),
  );
  decipher.setAuthTag(packed.subarray(packed.length - 16));
  return Buffer.concat([
    decipher.update(packed.subarray(12, packed.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}
function encryptSecret(secret) {
  const key = fs.readFileSync(keyPath);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(String(secret), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString(
    "base64",
  );
}
function oracleMeta(row) {
  let meta = {};
  try { meta = JSON.parse(row.credential_meta || "{}"); } catch { /* legacy account */ }
  const tenancyOcid = String(meta.tenancy_ocid || "").trim();
  const fingerprint = String(meta.key_fingerprint || "").trim();
  if (!tenancyOcid || !fingerprint) throw new Error("OCI 账号缺少 Tenancy OCID 或 Key Fingerprint");
  return { tenancyOcid, fingerprint };
}
function normalizeOciPrivateKey(value) {
  let key = String(value || "").trim()
    .replace(/^OCI_API_KEY\s*=\s*/i, "")
    .replace(/^(["'])([\s\S]*)\1$/, "$2")
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\r\n?/g, "\n");
  key = key.replace(/^[ \t]*\\+(?=-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----)/gm, "");

  for (const type of ["PRIVATE KEY", "RSA PRIVATE KEY"]) {
    const begin = `-----BEGIN ${type}-----`;
    const end = `-----END ${type}-----`;
    const start = key.indexOf(begin);
    const finish = start < 0 ? -1 : key.indexOf(end, start + begin.length);
    if (start < 0 || finish < 0) continue;
    const body = key.slice(start + begin.length, finish).replace(/\s/g, "");
    if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return key;
    const lines = body.match(/.{1,64}/g)?.join("\n") || body;
    return `${begin}\n${lines}\n${end}`;
  }
  return key;
}
function serializeOciPrivateKey(value) {
  return normalizeOciPrivateKey(value).replace(/\n/g, "\\n");
}
function oracleEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
async function oracleRequest(accountId, host, requestPath, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const body = options.body === undefined ? "" : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,credential_meta,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "oracle") throw new Error("当前账号不是 Oracle Cloud 账号");
  const { tenancyOcid, fingerprint } = oracleMeta(row);
  const privateKey = normalizeOciPrivateKey(decryptSecret(row.secret_ciphertext));
  const date = new Date().toUTCString();
  const signedHeaders = ["(request-target)", "host", "date"];
  const canonicalLines = [`(request-target): ${method.toLowerCase()} ${requestPath}`, `host: ${host}`, `date: ${date}`];
  const headers = { host, date };
  if (method !== "GET" && method !== "HEAD") {
    const contentLength = Buffer.byteLength(body, "utf8");
    const contentSha256 = crypto.createHash("sha256").update(body, "utf8").digest("base64");
    signedHeaders.push("content-type", "content-length", "x-content-sha256");
    canonicalLines.push("content-type: application/json", `content-length: ${contentLength}`, `x-content-sha256: ${contentSha256}`);
    Object.assign(headers, { "content-type": "application/json", "content-length": String(contentLength), "x-content-sha256": contentSha256 });
  }
  const canonical = canonicalLines.join("\n");
  let signature;
  try { signature = crypto.sign("RSA-SHA256", Buffer.from(canonical), privateKey).toString("base64"); }
  catch { throw new Error("OCI API 私钥无效，需使用未加密的 RSA PEM 私钥"); }
  const keyId = `${tenancyOcid}/${row.access_key_id}/${fingerprint}`;
  const authorization = `Signature version=\"1\",keyId=\"${keyId}\",algorithm=\"rsa-sha256\",headers=\"${signedHeaders.join(" ")}\",signature=\"${signature}\"`;
  const response = await fetch(`https://${host}${requestPath}`, { method, headers: { ...headers, authorization }, body: method === "GET" || method === "HEAD" ? undefined : body });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) {
    const message = data?.message || data?.code || `OCI ${response.status}`;
    writeApiLog(accountId, host, `${method} ${requestPath.split("?")[0]}`, {}, data, "失败", message);
    throw new Error(message);
  }
  writeApiLog(accountId, host, `${method} ${requestPath.split("?")[0]}`, {}, data, "成功");
  return { data, nextPage: response.headers.get("opc-next-page") || "" };
}
async function oraclePages(accountId, host, pathName, query = {}) {
  const items = [];
  let page = "";
  for (let index = 0; index < 100; index += 1) {
    const params = new URLSearchParams(query);
    if (page) params.set("page", page);
    const { data, nextPage } = await oracleRequest(accountId, host, `${pathName}${params.size ? `?${params.toString()}` : ""}`);
    items.push(...(Array.isArray(data) ? data : []));
    if (!nextPage) return items;
    page = nextPage;
  }
  throw new Error("OCI 分页超过 100 页，已停止读取");
}
async function oracleContext(accountId) {
  const row = database().prepare("SELECT access_key_id,credential_meta,region_id FROM cloud_accounts WHERE id=?").get(accountId);
  if (!row) throw new Error("云账号不存在");
  const { tenancyOcid } = oracleMeta(row);
  const homeRegion = String(row.region_id || "ap-tokyo-1");
  const identityHost = `identity.${homeRegion}.oci.oraclecloud.com`;
  const compartments = await oraclePages(accountId, identityHost, "/20160918/compartments", { compartmentId: tenancyOcid, compartmentIdInSubtree: "true", accessLevel: "ACCESSIBLE", lifecycleState: "ACTIVE" });
  // Region subscriptions can be independently restricted by OCI IAM. The configured
  // region remains a valid scope for read-only resource discovery in that case.
  const subscriptions = await oraclePages(accountId, identityHost, `/20160918/tenancy/${oracleEncode(tenancyOcid)}/regionSubscriptions`).catch(() => []);
  const allCompartments = [{ id: tenancyOcid, name: "Root Compartment" }, ...compartments].filter((value, index, values) => values.findIndex((item) => item.id === value.id) === index);
  const regions = [...new Set(subscriptions.filter((item) => String(item.status || "").toUpperCase() === "READY").map((item) => item.regionName).filter(Boolean))];
  return { compartments: allCompartments, regions: regions.length ? regions : [homeRegion] };
}
function oracleAddressList(values) {
  return [...new Set(values.filter(Boolean).map(String))].join(", ");
}
async function oracleImageName(accountId, host, imageId) {
  if (!imageId) return "";
  try {
    const image = (await oracleRequest(accountId, host, `/20160918/images/${oracleEncode(imageId)}`)).data;
    return image.displayName || [image.operatingSystem, image.operatingSystemVersion].filter(Boolean).join(" ") || imageId;
  } catch {
    return imageId;
  }
}
async function oracleInstance(accountId, host, item, region, compartment, shape) {
  const attachmentQuery = { compartmentId: compartment.id, instanceId: item.id };
  const [detailResult, attachmentResult] = await Promise.allSettled([
    oracleRequest(accountId, host, `/20160918/instances/${oracleEncode(item.id)}`),
    oraclePages(accountId, host, "/20160918/vnicAttachments", attachmentQuery),
  ]);
  const instance = detailResult.status === "fulfilled" ? detailResult.value.data : item;
  const networkErrors = attachmentResult.status === "rejected" ? [attachmentResult.reason?.message || String(attachmentResult.reason)] : [];
  const attachments = attachmentResult.status === "fulfilled" ? attachmentResult.value : [];
  const vnicResults = await Promise.all(attachments.map(async (attachment) => {
    const publicIps = [attachment.publicIp, attachment.publicIpAddress].filter(Boolean);
    const privateIps = [attachment.privateIp, attachment.privateIpAddress].filter(Boolean);
    if (!attachment.vnicId) return { publicIps, privateIps, error: "VNIC attachment 缺少 vnicId" };
    try {
      const vnic = (await oracleRequest(accountId, host, `/20160918/vnics/${oracleEncode(attachment.vnicId)}`)).data;
      return { publicIps: [...publicIps, vnic.publicIp, vnic.publicIpAddress].filter(Boolean), privateIps: [...privateIps, vnic.privateIp, vnic.privateIpAddress].filter(Boolean), vnic };
    } catch (error) {
      return { publicIps, privateIps, error: error.message || String(error) };
    }
  }));
  vnicResults.forEach((result) => { if (result.error) networkErrors.push(result.error); });
  const vnics = vnicResults.map((result) => result.vnic || null);
  const shapeConfig = instance.shapeConfig || item.shapeConfig || {};
  const ocpus = shapeConfig.ocpus ?? shape?.ocpus ?? null;
  const memoryInGBs = shapeConfig.memoryInGBs ?? shape?.memoryInGBs ?? null;
  const attachmentPublicIps = vnicResults.flatMap((result) => result.publicIps);
  const attachmentPrivateIps = vnicResults.flatMap((result) => result.privateIps);
  return {
    ...item,
    ...instance,
    InstanceId: instance.id || item.id,
    InstanceName: instance.displayName || item.displayName || item.id,
    InstanceStatus: instance.lifecycleState || item.lifecycleState,
    Status: instance.lifecycleState || item.lifecycleState,
    InstanceType: instance.shape || item.shape || "",
    Cpu: ocpus,
    Memory: memoryInGBs == null ? null : Number(memoryInGBs) * 1024,
    PublicIpAddress: oracleAddressList([...vnics.map((vnic) => vnic?.publicIp || vnic?.publicIpAddress), ...attachmentPublicIps]),
    PrivateIpAddress: oracleAddressList([...vnics.map((vnic) => vnic?.privateIp || vnic?.privateIpAddress), ...attachmentPrivateIps]),
    OSName: await oracleImageName(accountId, host, instance.imageId || item.imageId),
    ImageId: instance.imageId || item.imageId || "",
    CreationTime: instance.timeCreated || item.timeCreated || "",
    _network_error: networkErrors.length ? [...new Set(networkErrors)].join("；") : "",
    _region_id: region,
    _compartment_ocid: compartment.id,
    _compartment_name: compartment.name,
  };
}
async function oracleInstanceAction(accountId, region, instanceId, action) {
  if (!region || !instanceId) throw new Error("缺少 OCI 地域或实例 ID");
  const actionName = { start: "START", stop: "STOP", reboot: "SOFTRESET", forceReboot: "RESET" }[action];
  if (!actionName) throw new Error("不支持的 OCI 实例操作");
  const host = `iaas.${region}.oci.oraclecloud.com`;
  return (await oracleRequest(accountId, host, `/20160918/instances/${oracleEncode(instanceId)}?action=${actionName}`, { method: "POST", body: "" })).data;
}
function oracleDbSystem(item, region, compartment) {
  return { ...item, DBInstanceId: item.id, DBInstanceDescription: item.displayName || item.id, DBInstanceStatus: item.lifecycleState, Engine: item.dbSystemOptions?.storageManagement || item.databaseEdition || "Oracle Database", EngineVersion: item.dbVersion || "", ConnectionString: item.hostname || "", _region_id: region, _compartment_ocid: compartment.id, _compartment_name: compartment.name };
}
function oracleZone(item, region, compartment) {
  return { ...item, DomainName: String(item.name || "").replace(/\.$/, ""), DomainStatus: item.lifecycleState || "ACTIVE", RecordCount: 0, ZoneId: item.id || item.name, _region_id: region, _compartment_ocid: compartment.id, _compartment_name: compartment.name };
}
function oracleBucket(item, region, compartment) {
  return { ...item, Name: item.name, BucketName: item.name, Location: region, StorageClass: item.publicAccessType || "Standard", Acl: item.publicAccessType || "NoPublicAccess", _region_id: region, _compartment_ocid: compartment.id, _compartment_name: compartment.name };
}
async function oracleInstanceDisks(accountId, region, instanceId, compartmentId) {
  if (!region || !instanceId || !compartmentId) return [];
  const host = `iaas.${region}.oci.oraclecloud.com`;
  const query = { compartmentId, instanceId };
  const [bootAttachments, volumeAttachments] = await Promise.all([
    oraclePages(accountId, host, "/20160918/bootVolumeAttachments", query).catch(() => []),
    oraclePages(accountId, host, "/20160918/volumeAttachments", query).catch(() => []),
  ]);
  const bootVolumes = await Promise.all(bootAttachments.map(async (attachment) => {
    if (!attachment.bootVolumeId) return null;
    try {
      const volume = (await oracleRequest(accountId, host, `/20160918/bootVolumes/${oracleEncode(attachment.bootVolumeId)}`)).data;
      return { DiskId: attachment.bootVolumeId, DiskName: volume.displayName || attachment.displayName || attachment.bootVolumeId, Category: "启动卷", Size: volume.sizeInGBs ?? 0, Status: volume.lifecycleState || attachment.lifecycleState || "", Device: attachment.device || "" };
    } catch { return null; }
  }));
  const volumes = await Promise.all(volumeAttachments.map(async (attachment) => {
    if (!attachment.volumeId) return null;
    try {
      const volume = (await oracleRequest(accountId, host, `/20160918/volumes/${oracleEncode(attachment.volumeId)}`)).data;
      return { DiskId: attachment.volumeId, DiskName: volume.displayName || attachment.displayName || attachment.volumeId, Category: "数据卷", Size: volume.sizeInGBs ?? 0, Status: volume.lifecycleState || attachment.lifecycleState || "", Device: attachment.device || "" };
    } catch { return null; }
  }));
  return [...bootVolumes, ...volumes].filter(Boolean);
}
async function oracleResources(accountId, type) {
  const { compartments, regions } = await oracleContext(accountId);
  const items = []; const errors = [];
  for (const region of regions) {
    const hosts = { ecs: `iaas.${region}.oraclecloud.com`, rds: `database.${region}.oci.oraclecloud.com`, domain: `dns.${region}.oci.oraclecloud.com`, oss: `objectstorage.${region}.oraclecloud.com` };
    if (!hosts[type]) return { resource_type: type, items, errors: [`Oracle Cloud 暂未接入 ${type} 资源`], fetched_at: Date.now() };
    let namespace = "";
    if (type === "oss") {
      try { namespace = String((await oracleRequest(accountId, hosts.oss, "/n/")).data || ""); } catch (error) { errors.push(`${region}: ${error.message}`); continue; }
      if (!namespace) { errors.push(`${region}: 未能读取 Object Storage namespace`); continue; }
    }
    for (const compartment of compartments) {
      try {
        const values = type === "ecs" ? await oraclePages(accountId, hosts.ecs, "/20160918/instances", { compartmentId: compartment.id })
          : type === "rds" ? await oraclePages(accountId, hosts.rds, "/20160918/dbSystems", { compartmentId: compartment.id })
          : type === "domain" ? await oraclePages(accountId, hosts.domain, "/20180115/zones", { compartmentId: compartment.id })
          : await oraclePages(accountId, hosts.oss, `/n/${oracleEncode(namespace)}/b/`, { compartmentId: compartment.id });
        const shapes = type === "ecs" ? await oraclePages(accountId, hosts.ecs, "/20160928/shapes", { compartmentId: compartment.id }).catch(() => []) : [];
        const normalized = type === "ecs"
          ? await Promise.all(values.map((item) => oracleInstance(accountId, hosts.ecs, item, region, compartment, shapes.find((shape) => shape.shape === item.shape))))
          : type === "rds" ? values.map((item) => oracleDbSystem(item, region, compartment)) : type === "domain" ? values.map((item) => oracleZone(item, region, compartment)) : values.map((item) => oracleBucket(item, region, compartment));
        items.push(...normalized);
      } catch (error) { errors.push(`${region}/${compartment.name}: ${error.message}`); }
    }
  }
  return { resource_type: type, items, errors, fetched_at: Date.now() };
}
function rpcEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
async function rpc(accountId, endpoint, version, action, params = {}) {
  const row = database()
    .prepare(
      "SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?",
    )
    .get(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "aliyun") throw new Error(`${row.cloud_type === "tencent" ? "腾讯云" : "当前云类型"}资源 API 尚未接入`);
  // Cloud access-key secrets cannot contain meaningful leading/trailing whitespace.
  // Tolerate accidental whitespace from a pasted credential without rewriting it.
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
    .map(([k, v]) => [rpcEncode(k), rpcEncode(v)])
    // RPC signing requires byte-wise ordering of percent-encoded pairs.
    // localeCompare is locale-sensitive (for example, it can sort Timestamp
    // before TTL), producing a signature Aliyun cannot verify.
    .sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
    );
  const canonical = encoded.map(([k, v]) => `${k}=${v}`).join("&");
  const stringToSign = `GET&%2F&${rpcEncode(canonical)}`;
  query.Signature = crypto
    .createHmac("sha1", `${secret}&`)
    .update(stringToSign)
    .digest("base64");
  const finalUrl = new URL(`https://${endpoint}/`);
  for (const [k, v] of Object.entries(query)) finalUrl.searchParams.set(k, String(v));
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
function ctyunHmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}
function ctyunTotal(data) {
  const value = data?.totalCount ?? data?.total ?? data?.totalNum ?? data?.totalSize ?? data?.pageInfo?.total ?? data?.page?.total;
  const total = Number(value);
  return Number.isFinite(total) && total >= 0 ? total : null;
}
async function ctyunPages(fetchPage, path, pageSize) {
  const items = [];
  for (let page = 1; page <= 100; page += 1) {
    const data = await fetchPage(page);
    const pageItems = arr(data, path);
    items.push(...pageItems);
    const total = ctyunTotal(data);
    if (!pageItems.length || pageItems.length < pageSize || (total !== null && items.length >= total)) return items;
  }
  throw new Error("分页超过 100 页，已停止读取");
}
async function ctyunRequest(accountId, endpoint, method, requestPath, payload = null, query = {}, extraHeaders = {}) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "ctyun") throw new Error("当前账号不是天翼云账号");
  const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null).sort(([a], [b]) => a.localeCompare(b)));
  const queryText = params.toString();
  const body = payload == null ? "" : JSON.stringify(payload);
  const now = new Date();
  const eopDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const requestId = crypto.randomUUID();
  const payloadHash = crypto.createHash("sha256").update(body).digest("hex");
  const stringToSign = `ctyun-eop-request-id:${requestId}\neop-date:${eopDate}\n\n${queryText}\n${payloadHash}`;
  const secret = decryptSecret(row.secret_ciphertext);
  const dateKey = ctyunHmac(secret, eopDate);
  const akKey = ctyunHmac(dateKey, row.access_key_id);
  const signingKey = ctyunHmac(akKey, eopDate.slice(0, 8));
  const signature = ctyunHmac(signingKey, stringToSign).toString("base64");
  const authorization = `${row.access_key_id} Headers=ctyun-eop-request-id;eop-date Signature=${signature}`;
  const url = `https://${endpoint}${requestPath}${queryText ? `?${queryText}` : ""}`;
  const response = await fetch(url, {
    method,
    headers: {
      "ctyun-eop-request-id": requestId,
      "Eop-date": eopDate,
      "Eop-Authorization": authorization,
      ...extraHeaders,
      ...(payload == null ? {} : { "Content-Type": "application/json" }),
    },
    ...(payload == null ? {} : { body }),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text || `天翼云 ${response.status}` }; }
  const code = String(data?.code ?? data?.statusCode ?? "");
  if (!response.ok || (code && !["0", "200", "800", "Success", "SUCCESS"].includes(code))) {
    const message = data?.message || data?.msg || data?.error?.message || code || `天翼云 ${response.status}`;
    writeApiLog(accountId, endpoint, requestPath, payload ?? query, data, "失败", message);
    throw new Error(message);
  }
  writeApiLog(accountId, endpoint, requestPath, payload ?? query, data, "成功");
  return data?.returnObj || data?.result || data;
}
function ctyunInstance(item, region) {
  const publicIp = item.FloatingIP || item.floatingIP || item.PublicIP || item.publicIP || "";
  const privateIp = item.PrivateIP || item.privateIP || item.FixedIP || item.fixedIP || "";
  return {
    ...item,
    InstanceId: item.InstanceID || item.instanceID || item.ResourceID || item.resourceID || "",
    InstanceName: item.InstanceName || item.instanceName || item.DisplayName || item.displayName || item.InstanceID || item.instanceID || "",
    InstanceStatus: item.InstanceStatus || item.instanceStatus || item.State || item.state || "",
    Status: item.InstanceStatus || item.instanceStatus || item.State || item.state || "",
    PublicIpAddress: publicIp,
    PrivateIpAddress: privateIp,
    VpcId: item.VpcID || item.vpcID || item.VpcId || "",
    InstanceType: item.InstanceType || item.instanceType || item.FlavorName || item.flavorName || "",
    _region_id: region,
  };
}
function ctyunDomain(item, region) {
  return {
    ...item,
    DomainName: item.name || item.ZoneName || item.zoneName || item.zoneID || "",
    DomainStatus: "私有 DNS",
    ZoneId: item.zoneID || item.ZoneID || "",
    RecordCount: Number(item.recordCount || 0),
    RegistrationDate: item.createdAt || item.CreatedAt || "",
    ExpirationDate: "",
    _region_id: region,
    _ctyun_private_zone: true,
  };
}
function ctyunRdsInstance(item, region) {
  const running = Number(item.prodRunningStatus) === 0 || String(item.prodRunningStatus || "").toLowerCase() === "running";
  return {
    ...item,
    DBInstanceId: item.outerProdInstId || item.prodInstId || "",
    DBInstanceDescription: item.prodInstName || item.outerProdInstId || "",
    DBInstanceStatus: running ? "Running" : String(item.prodRunningStatus ?? item.alive ?? "Unknown"),
    DBInstanceType: item.prodType || "",
    DBInstanceClass: item.machineSpec || item.resources || "",
    DBInstanceStorage: Number(item.diskSize || 0),
    ConnectionString: item.vip || "",
    Port: item.writePort || "",
    Engine: item.prodDbEngine || "MySQL",
    EngineVersion: item.newMysqlVersion || item.dbMysqlVersion || "",
    CreateTime: item.createTime || "",
    ExpireTime: item.expireTime || "",
    _region_id: region,
  };
}
function ctyunRedisInstance(item, region) {
  const status = Number(item.status) === 0 || String(item.statusName || "").toLowerCase() === "normal" ? "Normal" : String(item.statusName || item.status || "Unknown");
  return {
    ...item,
    InstanceId: item.prodInstId || item.user || "",
    InstanceName: item.instanceName || item.prodInstId || "",
    InstanceStatus: status,
    InstanceType: item.archTypeName || item.archType || "",
    InstanceClass: item.capacityInfo || item.capacity || "",
    Capacity: Number(item.capacity || 0) * 1024,
    ConnectionDomain: item.connectionAddress || item.vip || "",
    Port: item.vipPort || "",
    EngineVersion: item.engineVersionName || item.engineVersion || "",
    NetworkType: item.netName || "",
    EndTime: item.expTime || item.expiration || "",
    ArchitectureType: item.archTypeName || item.archType || "",
    _region_id: region,
  };
}
function ctyunBucket(item, fallbackRegion) {
  const region = item.regionID || item.RegionID || fallbackRegion;
  return {
    ...item,
    Name: item.bucket || item.Bucket || "",
    Location: region,
    CreationDate: item.creationDate || item.CreationDate || "",
    StorageClass: item.storageType || item.StorageType || "STANDARD",
    Acl: "private",
    ExtranetEndpoint: "-",
    IntranetEndpoint: "-",
    _region_id: region,
  };
}
async function ctyunRegions(id, fallback) {
  try {
    const data = await ctyunRequest(id, "ctecs-global.ctapi.ctyun.cn", "GET", "/v4/region/list-regions", null, { regionName: "" });
    const regions = arr(data, ["regionList"]).map((item) => item.regionID || item.RegionID).filter(Boolean);
    return [...new Set([...regions, fallback].filter(Boolean))];
  } catch {
    return fallback ? [fallback] : [];
  }
}
async function ctyunResources(id, type) {
  const account = database().prepare("SELECT region_id FROM cloud_accounts WHERE id=?").get(id);
  const fallbackRegion = String(account?.region_id || "cn-huabei-9");
  const errors = [];
  const regions = await ctyunRegions(id, fallbackRegion);
  const items = [];
  if (type === "ecs") {
    for (const region of regions) {
      try {
        const values = await ctyunPages((pageNo) => ctyunRequest(id, "ctecs-global.ctapi.ctyun.cn", "POST", "/v4/ecs/list-instances", { regionID: region, pageNo, pageSize: 100 }), ["results"], 100);
        items.push(...values.map((item) => ctyunInstance(item, region)));
      } catch (error) { errors.push(`${region}: ${error.message}`); }
    }
  } else if (type === "domain") {
    for (const region of regions) {
      try {
        const values = await ctyunPages((pageNo) => ctyunRequest(id, "ctvpc-global.ctapi.ctyun.cn", "GET", "/v4/private-zone/list", null, { regionID: region, pageNo, pageSize: 50 }), ["zones"], 50);
        items.push(...values.map((item) => ctyunDomain(item, region)));
      } catch (error) { errors.push(`${region}: ${error.message}`); }
    }
  } else if (type === "rds") {
    for (const region of regions) {
      try {
        const values = await ctyunPages((pageNow) => ctyunRequest(id, "rds2-global.ctapi.ctyun.cn", "POST", "/RDS2/v1/open-api/instance/instance-list", { pageNow, pageSize: 100 }, {}, { regionId: region }), ["list"], 100);
        items.push(...values.map((item) => ctyunRdsInstance(item, region)));
      } catch (error) { errors.push(`${region}: ${error.message}`); }
    }
  } else if (type === "redis") {
    for (const region of regions) {
      try {
        const values = await ctyunPages((pageIndex) => ctyunRequest(id, "dcs2-global.ctapi.ctyun.cn", "GET", "/v2/instanceManageMgrServant/describeInstances", null, { pageIndex, pageSize: 100 }, { regionId: region }), ["rows"], 100);
        items.push(...values.map((item) => ctyunRedisInstance(item, region)));
      } catch (error) { errors.push(`${region}: ${error.message}`); }
    }
  } else if (type === "oss") {
    try {
      const data = await ctyunRequest(id, "zos-global.ctapi.ctyun.cn", "GET", "/v4/oss/list-regions");
      const ossRegions = arr(data, []).map((item) => item.regionID || item.RegionID).filter(Boolean);
      for (const region of [...new Set([...ossRegions, "public"])]) {
        try {
          const values = await ctyunPages((pageNo) => ctyunRequest(id, "zos-global.ctapi.ctyun.cn", "GET", "/v4/oss/list-buckets", null, { regionID: region, pageNo, pageSize: 50 }), ["bucketList"], 50);
          items.push(...values.map((item) => ctyunBucket(item, region)));
        } catch (error) { errors.push(`${region}: ${error.message}`); }
      }
    } catch (error) { errors.push(error.message); }
  } else {
    errors.push(`天翼云暂未提供 ${type} 对应的统一只读清单 API`);
  }
  const unique = type === "oss" ? Array.from(new Map(items.map((item) => [item.Name, item])).values()) : items;
  return { resource_type: type, items: unique, errors, fetched_at: Date.now() };
}
async function verifyCtyunAccount(id) {
  const account = database().prepare("SELECT cloud_type,region_id FROM cloud_accounts WHERE id=?").get(id);
  if (!account) throw new Error("云账号不存在");
  if (account.cloud_type !== "ctyun") throw new Error("当前账号不是天翼云账号");
  const regions = await ctyunRegions(id, String(account.region_id || "cn-huabei-9"));
  if (!regions.length) throw new Error("未读取到可用地域，请检查 AccessKey、SecretKey 与 EOP 权限");
  return { provider: "ctyun", verified: true, region_count: regions.length, regions, default_region: account.region_id || regions[0] };
}
function huaweiEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function huaweiCanonicalUri(pathname) {
  return pathname.split("/").map((part) => huaweiEncode(decodeURIComponent(part))).join("/") || "/";
}
function huaweiQuery(query = {}) {
  return Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [huaweiEncode(key), huaweiEncode(value)]).sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${key}=${value}`).join("&");
}
function huaweiError(data, status) {
  return data?.error_msg || data?.message || data?.error?.message || data?.code || `华为云 ${status}`;
}
async function huaweiRequest(accountId, host, pathname, query = {}) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "huawei") throw new Error("当前账号不是华为云账号");
  const queryText = huaweiQuery(query);
  const canonicalUri = huaweiCanonicalUri(pathname);
  const date = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const headers = { host, "x-sdk-date": date };
  const canonicalHeaders = Object.entries(headers).map(([key, value]) => `${key}:${value}\n`).join("");
  const signedHeaders = Object.keys(headers).join(";");
  const payloadHash = crypto.createHash("sha256").update("").digest("hex");
  const canonicalRequest = `GET\n${canonicalUri}\n${queryText}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `SDK-HMAC-SHA256\n${date}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const signature = crypto.createHmac("sha256", decryptSecret(row.secret_ciphertext)).update(stringToSign).digest("hex");
  const authorization = `SDK-HMAC-SHA256 Access=${row.access_key_id}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}${canonicalUri}${queryText ? `?${queryText}` : ""}`, { headers: { Host: host, "X-Sdk-Date": date, Authorization: authorization } });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text || `华为云 ${response.status}` }; }
  if (!response.ok) {
    const message = huaweiError(data, response.status);
    writeApiLog(accountId, host, `GET ${pathname}`, query, data, "失败", message);
    throw new Error(message);
  }
  writeApiLog(accountId, host, `GET ${pathname}`, query, data, "成功");
  return data;
}
async function huaweiOffsetPages(fetchPage, path, pageSize = 100) {
  const items = [];
  for (let offset = 0; offset < 10_000; offset += pageSize) {
    const data = await fetchPage(offset);
    const page = arr(data, path);
    items.push(...page);
    if (page.length < pageSize) return items;
  }
  throw new Error("分页超过 100 页，已停止读取");
}
async function huaweiContext(accountId) {
  const account = database().prepare("SELECT region_id FROM cloud_accounts WHERE id=?").get(accountId);
  const defaultRegion = String(account?.region_id || "cn-north-4");
  const data = await huaweiRequest(accountId, `iam.${defaultRegion}.myhuaweicloud.com`, "/v3/projects", { enabled: "true" });
  const projects = arr(data, ["projects"]).filter((item) => item.id && item.name && String(item.status || "enabled").toLowerCase() === "enabled");
  if (!projects.length) throw new Error("未读取到可用项目，请检查 IAM 项目权限");
  return { defaultRegion, projects };
}
function huaweiInstance(item, region, project) {
  const addresses = Object.values(item.addresses || {}).flat();
  const publicIp = addresses.find((address) => String(address?.["OS-EXT-IPS:type"] || "").toLowerCase() === "floating")?.addr || "";
  const privateIp = addresses.find((address) => String(address?.["OS-EXT-IPS:type"] || "").toLowerCase() !== "floating")?.addr || "";
  return { ...item, InstanceId: item.id, InstanceName: item.name || item.id, InstanceStatus: item.status, Status: item.status, PublicIpAddress: publicIp, PrivateIpAddress: privateIp, InstanceType: item.flavor?.id || item.flavor?.name || "", VpcId: item.metadata?.vpc_id || "", _region_id: region, _project_id: project.id };
}
function huaweiRds(item, region, project) {
  return { ...item, DBInstanceId: item.id, DBInstanceDescription: item.name || item.id, DBInstanceStatus: item.status, DBInstanceClass: item.flavor_ref || item.flavor?.id || "", DBInstanceStorage: Number(item.volume?.size || 0), ConnectionString: item.private_ips?.[0] || item.nodes?.[0]?.private_ip || "", Port: item.port || "", Engine: item.datastore?.type || "", EngineVersion: item.datastore?.version || "", CreateTime: item.created || "", _region_id: region, _project_id: project.id };
}
function huaweiRedis(item, region, project) {
  return { ...item, InstanceId: item.instance_id || item.id, InstanceName: item.name || item.instance_id || item.id, InstanceStatus: item.status || item.operating_status, InstanceType: item.engine || "Redis", InstanceClass: item.specification || item.capacity || "", Capacity: Number(item.capacity || 0) * 1024, ConnectionDomain: item.ip || item.private_ip || "", Port: item.port || "", EngineVersion: item.engine_version || "", NetworkType: item.vpc_name || "", _region_id: region, _project_id: project.id };
}
function huaweiZone(item) {
  return { ...item, DomainName: String(item.name || "").replace(/\.$/, ""), DomainStatus: item.status || "ACTIVE", ZoneId: item.id, RecordCount: Number(item.record_num || 0), RegistrationDate: item.created_at || "", _region_id: "cn-north-4", _huawei_public_zone: true };
}
async function huaweiObsBuckets(accountId, region) {
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
async function huaweiResources(accountId, type) {
  const { defaultRegion, projects } = await huaweiContext(accountId);
  const items = []; const errors = [];
  if (type === "domain") {
    try { items.push(...await huaweiOffsetPages((offset) => huaweiRequest(accountId, "dns.cn-north-4.myhuaweicloud.com", "/v2/zones", { limit: 500, offset }), ["zones"], 500)); }
    catch (error) { errors.push(`cn-north-4: ${error.message}`); }
    return { resource_type: type, items: items.map(huaweiZone), errors, fetched_at: Date.now() };
  }
  if (type === "oss") {
    const bucketRegions = [...new Set([defaultRegion, ...projects.map((project) => project.name)])];
    for (const region of bucketRegions) { try { items.push(...await huaweiObsBuckets(accountId, region)); } catch (error) { errors.push(`${region}: ${error.message}`); } }
    return { resource_type: type, items: Array.from(new Map(items.map((item) => [item.Name, item])).values()), errors, fetched_at: Date.now() };
  }
  const services = { ecs: ["ecs", "/v1/{project}/cloudservers/detail", "servers", huaweiInstance], rds: ["rds", "/v3/{project}/instances", "instances", huaweiRds], redis: ["dcs", "/v2/{project}/instances", "instances", huaweiRedis] };
  const service = services[type];
  if (!service) return { resource_type: type, items, errors: [`华为云暂未接入 ${type} 资源`], fetched_at: Date.now() };
  for (const project of projects) {
    const [name, template, path, normalize] = service;
    const region = project.name;
    try {
      const values = await huaweiOffsetPages((offset) => huaweiRequest(accountId, `${name}.${region}.myhuaweicloud.com`, template.replace("{project}", huaweiEncode(project.id)), { limit: 100, offset }), [path], 100);
      items.push(...values.map((item) => normalize(item, region, project)));
    } catch (error) { errors.push(`${region}: ${error.message}`); }
  }
  return { resource_type: type, items, errors, fetched_at: Date.now() };
}
async function verifyHuaweiAccount(id) {
  const { defaultRegion, projects } = await huaweiContext(id);
  return { provider: "huawei", verified: true, region_count: new Set(projects.map((project) => project.name)).size, regions: [...new Set(projects.map((project) => project.name))], default_region: defaultRegion, project_count: projects.length };
}
function baiduEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function baiduQuery(query = {}, includeEmpty = false) {
  return Object.entries(query).filter(([, value]) => value !== undefined && value !== null && (includeEmpty || value !== ""))
    .map(([key, value]) => [baiduEncode(key), baiduEncode(value)]).sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${key}=${value}`).join("&");
}
const BAIDU_BCC_REGIONS = ["bj", "bd", "gz", "su", "hkg", "fwh"];
function baiduRegions(accountId) {
  const account = database().prepare("SELECT region_id FROM cloud_accounts WHERE id=?").get(accountId);
  const regions = String(account?.region_id || "bj").split(/[,，\s]+/).map((value) => value.trim()).filter(Boolean);
  // BCC does not expose a global instance-list endpoint. Scan every standard
  // region so an account saved with the historical default "bj" cannot hide assets.
  return [...new Set([...(regions.length ? regions : ["bj"]), ...BAIDU_BCC_REGIONS])];
}
function baiduCanonicalUri(pathname) {
  return pathname.split("/").map((part) => baiduEncode(decodeURIComponent(part))).join("/") || "/";
}
function baiduCanonicalHeaders(headers) {
  return Object.entries(headers)
    .map(([name, value]) => [String(name).toLowerCase(), String(value).trim()])
    .filter(([, value]) => value)
    .map(([name, value]) => `${baiduEncode(name)}:${baiduEncode(value)}`)
    .sort()
    .join("\n");
}
function baiduErrorMessage(message) {
  if (/BceServiceRole_console_dns/i.test(message))
    return "DNS 服务未完成控制台服务角色授权。请用主账号登录百度智能云控制台并开通/访问一次智能云解析 DNS，或为当前子用户授予 DNS 只读权限后重试。";
  return message;
}
async function baiduRequest(accountId, host, pathname, query = {}, { method = "GET", body = null, includeEmptyQuery = false } = {}) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "baidu") throw new Error("当前账号不是百度智能云账号");
  const canonicalUri = baiduCanonicalUri(pathname);
  const queryText = baiduQuery(query, includeEmptyQuery);
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const authPrefix = `bce-auth-v1/${row.access_key_id}/${date}/1800`;
  const bodyText = body == null ? "" : JSON.stringify(body);
  const headers = { host, "x-bce-date": date };
  if (bodyText) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(bodyText));
  }
  const canonicalHeaders = baiduCanonicalHeaders(headers);
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalRequest = `${method}\n${canonicalUri}\n${queryText}\n${canonicalHeaders}`;
  // BCE v1 uses the hexadecimal HMAC output as the key for the request signature.
  const signingKey = crypto.createHmac("sha256", decryptSecret(row.secret_ciphertext)).update(authPrefix).digest("hex");
  const signature = crypto.createHmac("sha256", signingKey).update(canonicalRequest).digest("hex");
  const authorization = `${authPrefix}/${signedHeaders}/${signature}`;
  const response = await fetch(`https://${host}${canonicalUri}${queryText ? `?${queryText}` : ""}`, { method, headers: { ...headers, Authorization: authorization }, body: bodyText || undefined });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text || `百度智能云 ${response.status}` }; }
  if (!response.ok) {
    const message = baiduErrorMessage(data?.message || data?.error?.message || data?.code || `百度智能云 ${response.status}`);
    writeApiLog(accountId, host, `${method} ${pathname}`, query, data, "失败", message);
    throw new Error(message);
  }
  writeApiLog(accountId, host, `${method} ${pathname}`, query, data, "成功");
  return { data, text };
}
async function baiduBccAction(accountId, region, instanceId, action, forceStop = false) {
  if (!region || !instanceId) throw new Error("缺少服务器地域或实例 ID");
  const host = `bcc.${region}.baidubce.com`;
  const pathname = `/v2/instance/${instanceId}`;
  if (action === "status") {
    const { data } = await baiduRequest(accountId, host, pathname);
    const instance = data?.instance || data;
    return { status: instance?.status || "Unknown" };
  }
  if (!["start", "stop", "reboot"].includes(action)) throw new Error("不支持的 BCC 服务器操作");
  const body = forceStop && (action === "stop" || action === "reboot") ? { forceStop: true } : null;
  const { data } = await baiduRequest(accountId, host, pathname, { [action]: "" }, { method: "PUT", body, includeEmptyQuery: true });
  return data || { ok: true };
}
async function baiduPages(accountId, host, pathname, itemKeys) {
  const items = []; let marker = "";
  for (let page = 0; page < 100; page += 1) {
    const { data } = await baiduRequest(accountId, host, pathname, { marker, maxKeys: 1000 });
    const values = itemKeys.flatMap((key) => Array.isArray(data?.[key]) ? data[key] : []);
    items.push(...values);
    const nextMarker = String(data?.nextMarker || data?.NextMarker || "");
    if (!nextMarker || nextMarker === marker || data?.isTruncated === false || data?.IsTruncated === false) return items;
    marker = nextMarker;
  }
  throw new Error("分页超过 100 页，已停止读取");
}
function baiduInstance(item, region) {
  const addresses = item.publicIps || item.publicIp || item.eip || [];
  const privateAddresses = item.internalIps || item.privateIps || item.internalIp || [];
  return { ...item, InstanceId: item.id || item.instanceId, InstanceName: item.name || item.instanceName || item.id, InstanceStatus: item.status, Status: item.status, PublicIpAddress: Array.isArray(addresses) ? addresses[0] || "" : addresses, PrivateIpAddress: Array.isArray(privateAddresses) ? privateAddresses[0] || "" : privateAddresses, InstanceType: item.cpuCount && item.memoryCapacityInGB ? `${item.cpuCount}C${item.memoryCapacityInGB}G` : item.spec || "", VpcId: item.vpcId || "", _region_id: region };
}
function baiduRds(item, region) {
  return { ...item, DBInstanceId: item.instanceId || item.id, DBInstanceDescription: item.instanceName || item.name || item.instanceId, DBInstanceStatus: item.status, DBInstanceClass: item.instanceClass || item.instanceType || "", DBInstanceStorage: Number(item.volumeCapacity || item.capacity || 0), ConnectionString: item.endpoint || item.vip || "", Port: item.port || "", Engine: item.engine || item.engineType || "", EngineVersion: item.engineVersion || "", CreateTime: item.createTime || "", _region_id: region };
}
function baiduRedis(item, region) {
  return { ...item, InstanceId: item.instanceId || item.id, InstanceName: item.instanceName || item.name || item.instanceId, InstanceStatus: item.instanceStatus || item.status, InstanceType: item.engine || "Redis", InstanceClass: item.instanceClass || item.nodeType || "", Capacity: Number(item.capacity || item.memorySize || 0), ConnectionDomain: item.domain || item.endpoint || item.vip || "", Port: item.port || "", EngineVersion: item.engineVersion || "", NetworkType: item.vnetIp || item.vpcId || "", CreateTime: item.instanceCreateTime || "", _region_id: region };
}
function baiduZone(item) {
  return { ...item, DomainName: item.domain || item.name || item.zoneName, DomainStatus: item.status || "ACTIVE", ZoneId: item.id || item.domainId || item.domain, RecordCount: Number(item.recordCount || item.recordNum || 0), RegistrationDate: item.createTime || "", _region_id: "global", _baidu_public_zone: true };
}
function baiduBucket(item) {
  const name = item.name || item.bucketName;
  const region = item.location || item.region || "bj";
  return { ...item, Name: name, BucketName: name, Location: region, CreationDate: item.creationDate || item.createTime || "", StorageClass: item.storageClass || "STANDARD", Acl: item.acl || "private", ExtranetEndpoint: name ? `${name}.${region}.bcebos.com` : "-", IntranetEndpoint: "-", _region_id: region };
}
async function baiduResources(accountId, type) {
  const regions = baiduRegions(accountId); const items = []; const errors = [];
  if (type === "domain") {
    try { items.push(...await baiduPages(accountId, "dns.baidubce.com", "/v1/dns/zone", ["zones"])); }
    catch (error) { errors.push(error.message); }
    return { resource_type: type, items: items.map(baiduZone), errors, fetched_at: Date.now() };
  }
  if (type === "oss") {
    try {
      const { data, text } = await baiduRequest(accountId, "bj.bcebos.com", "/");
      const values = Array.isArray(data?.buckets) ? data.buckets : xmlBlocks(text, "Bucket").map((block) => ({ name: xmlText(block, "Name"), location: xmlText(block, "Location"), creationDate: xmlText(block, "CreationDate") }));
      items.push(...values.map(baiduBucket).filter((item) => item.Name));
    } catch (error) { errors.push(error.message); }
    return { resource_type: type, items, errors, fetched_at: Date.now() };
  }
  const services = { ecs: ["bcc", "/v2/instance", ["instances", "instanceList"], baiduInstance], rds: ["rds", "/v1/instance", ["instances", "instanceList"], baiduRds], redis: ["redis", "/v2/instance", ["instances", "instanceList"], baiduRedis] };
  const service = services[type];
  if (!service) return { resource_type: type, items, errors: [`百度智能云暂未接入 ${type} 资源`], fetched_at: Date.now() };
  for (const region of regions) {
    const [name, pathname, keys, normalize] = service;
    try { items.push(...(await baiduPages(accountId, `${name}.${region}.baidubce.com`, pathname, keys)).map((item) => normalize(item, region))); }
    catch (error) { errors.push(`${region}: ${error.message}`); }
  }
  return { resource_type: type, items, errors, fetched_at: Date.now() };
}
async function verifyBaiduAccount(id) {
  const regions = baiduRegions(id);
  await baiduPages(id, `bcc.${regions[0]}.baidubce.com`, "/v2/instance", ["instances", "instanceList"]);
  return { provider: "baidu", verified: true, region_count: regions.length, regions, default_region: regions[0] };
}
function configuredRegions(accountId, fallback) {
  const account = database().prepare("SELECT region_id FROM cloud_accounts WHERE id=?").get(accountId);
  const values = String(account?.region_id || fallback).split(/[,，\s]+/).map((value) => value.trim()).filter(Boolean);
  return [...new Set(values.length ? values : [fallback])];
}
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
async function qiniuBuckets(accountId) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type,region_id FROM cloud_accounts WHERE id=?").get(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "qiniu") throw new Error("当前账号不是七牛云账号");
  const signing = "/buckets\n";
  const signature = crypto.createHmac("sha1", decryptSecret(row.secret_ciphertext)).update(signing).digest("base64url");
  const response = await fetch("https://rs.qiniuapi.com/buckets", { headers: { Authorization: `QBox ${row.access_key_id}:${signature}` } });
  const data = await response.json().catch(() => []);
  if (!response.ok) { const message = data?.error || data?.message || `七牛云 ${response.status}`; writeApiLog(accountId, "rs.qiniuapi.com", "ListBuckets", {}, data, "失败", message); throw new Error(message); }
  const region = String(row.region_id || "z0");
  const items = (Array.isArray(data) ? data : []).map((name) => ({ Name: String(name), BucketName: String(name), Location: region, CreationDate: "", StorageClass: "STANDARD", Acl: "private", ExtranetEndpoint: "-", IntranetEndpoint: "-", _region_id: region }));
  writeApiLog(accountId, "rs.qiniuapi.com", "ListBuckets", {}, { count: items.length }, "成功"); return items;
}
async function qiniuResources(accountId, type) {
  if (type !== "oss") return { resource_type: type, items: [], errors: [`七牛云暂未接入 ${type} 资源；当前仅支持 Kodo 空间`], fetched_at: Date.now() };
  try { return { resource_type: type, items: await qiniuBuckets(accountId), errors: [], fetched_at: Date.now() }; }
  catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; }
}
async function verifyQiniuAccount(id) {
  const items = await qiniuBuckets(id); const regions = configuredRegions(id, "z0");
  return { provider: "qiniu", verified: true, region_count: regions.length, regions, default_region: regions[0], bucket_count: items.length };
}
function awsSign(key, value) { return crypto.createHmac("sha256", key).update(value).digest(); }
function awsQuery(query = {}) { return Object.entries(query).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [rpcEncode(key), rpcEncode(value)]).sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)).map(([key, value]) => `${key}=${value}`).join("&"); }
async function awsRequest(accountId, service, region, host, pathname = "/", query = {}) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
  if (!row) throw new Error("云账号不存在"); if (!row.enabled) throw new Error("云账号已停用"); if (row.cloud_type !== "aws") throw new Error("当前账号不是 AWS 账号");
  const now = new Date(); const date = now.toISOString().replace(/[-:]|\.\d{3}/g, ""); const day = date.slice(0, 8); const queryText = awsQuery(query); const payloadHash = crypto.createHash("sha256").update("").digest("hex");
  const headers = `host:${host}\nx-amz-date:${date}\n`; const signedHeaders = "host;x-amz-date"; const canonicalRequest = `GET\n${pathname}\n${queryText}\n${headers}\n${signedHeaders}\n${payloadHash}`; const scope = `${day}/${region}/${service}/aws4_request`; const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const secret = decryptSecret(row.secret_ciphertext); const keyDate = awsSign(`AWS4${secret}`, day); const keyRegion = awsSign(keyDate, region); const keyService = awsSign(keyRegion, service); const keySigning = awsSign(keyService, "aws4_request"); const signature = awsSign(keySigning, stringToSign).toString("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${row.access_key_id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}${pathname}${queryText ? `?${queryText}` : ""}`, { headers: { Host: host, "X-Amz-Date": date, Authorization: authorization } }); const text = await response.text();
  if (!response.ok) { const message = xmlText(text, "Message") || xmlText(text, "Code") || `AWS ${response.status}`; writeApiLog(accountId, host, `GET ${pathname}`, query, { body: text }, "失败", message); throw new Error(message); }
  writeApiLog(accountId, host, `GET ${pathname}`, query, { body: text }, "成功"); return text;
}
function awsInstance(item, region) { return { InstanceId: xmlText(item, "instanceId"), InstanceName: xmlText(item, "tagSet") ? xmlBlocks(item, "item").find((tag) => xmlText(tag, "key") === "Name") ? xmlText(xmlBlocks(item, "item").find((tag) => xmlText(tag, "key") === "Name"), "value") : xmlText(item, "instanceId") : xmlText(item, "instanceId"), InstanceStatus: xmlText(item, "instanceState") || xmlText(item, "name"), Status: xmlText(item, "name"), PublicIpAddress: xmlText(item, "ipAddress"), PrivateIpAddress: xmlText(item, "privateIpAddress"), InstanceType: xmlText(item, "instanceType"), VpcId: xmlText(item, "vpcId"), _region_id: region, _raw_xml: item }; }
function awsRds(item, region) { return { DBInstanceId: xmlText(item, "DBInstanceIdentifier"), DBInstanceDescription: xmlText(item, "DBInstanceIdentifier"), DBInstanceStatus: xmlText(item, "DBInstanceStatus"), DBInstanceClass: xmlText(item, "DBInstanceClass"), DBInstanceStorage: Number(xmlText(item, "AllocatedStorage") || 0), ConnectionString: xmlText(item, "Address"), Port: xmlText(item, "Port"), Engine: xmlText(item, "Engine"), EngineVersion: xmlText(item, "EngineVersion"), CreateTime: xmlText(item, "InstanceCreateTime"), _region_id: region, _raw_xml: item }; }
function awsRedis(item, region) { return { InstanceId: xmlText(item, "CacheClusterId"), InstanceName: xmlText(item, "CacheClusterId"), InstanceStatus: xmlText(item, "CacheClusterStatus"), InstanceType: "Redis", InstanceClass: xmlText(item, "CacheNodeType"), Capacity: 0, ConnectionDomain: xmlText(item, "Address"), Port: xmlText(item, "Port"), EngineVersion: xmlText(item, "EngineVersion"), NetworkType: xmlText(item, "VpcId"), _region_id: region, _raw_xml: item }; }
async function awsResources(accountId, type) {
  const regions = configuredRegions(accountId, "ap-northeast-1"); const items = []; const errors = [];
  if (type === "oss") { try { const xml = await awsRequest(accountId, "s3", "us-east-1", "s3.amazonaws.com"); items.push(...xmlBlocks(xml, "Bucket").map((block) => ({ Name: xmlText(block, "Name"), BucketName: xmlText(block, "Name"), Location: "global", CreationDate: xmlText(block, "CreationDate"), StorageClass: "STANDARD", Acl: "private", ExtranetEndpoint: "-", IntranetEndpoint: "-", _region_id: "global" }))); } catch (error) { errors.push(error.message); } return { resource_type: type, items, errors, fetched_at: Date.now() }; }
  if (type === "domain") { try { const xml = await awsRequest(accountId, "route53", "us-east-1", "route53.amazonaws.com", "/2013-04-01/hostedzone"); items.push(...xmlBlocks(xml, "HostedZone").map((block) => ({ DomainName: xmlText(block, "Name").replace(/\.$/, ""), DomainStatus: xmlText(block, "PrivateZone") === "true" ? "PRIVATE" : "ACTIVE", ZoneId: xmlText(block, "Id"), RecordCount: Number(xmlText(block, "ResourceRecordSetCount") || 0), RegistrationDate: "", _region_id: "global", _aws_route53: true }))); } catch (error) { errors.push(error.message); } return { resource_type: type, items, errors, fetched_at: Date.now() }; }
  const services = { ecs: ["ec2", "ec2", "DescribeInstances", "2016-11-15", "reservationSet", awsInstance], rds: ["rds", "rds", "DescribeDBInstances", "2014-10-31", "DBInstances", awsRds], redis: ["elasticache", "elasticache", "DescribeCacheClusters", "2015-02-02", "CacheClusters", awsRedis] };
  const service = services[type]; if (!service) return { resource_type: type, items, errors: [`AWS 暂未接入 ${type} 资源`], fetched_at: Date.now() };
  for (const region of regions) { const [serviceName, subdomain, action, version, tag, normalize] = service; try { const xml = await awsRequest(accountId, serviceName, region, `${subdomain}.${region}.amazonaws.com`, "/", { Action: action, Version: version, ...(type === "redis" ? { ShowCacheNodeInfo: "true" } : {}) }); const blocks = type === "ecs" ? xmlBlocks(xml, "instancesSet").flatMap((set) => xmlBlocks(set, "item")) : xmlBlocks(xml, tag).flatMap((set) => xmlBlocks(set, "item")); items.push(...blocks.map((block) => normalize(block, region))); } catch (error) { errors.push(`${region}: ${error.message}`); } }
  return { resource_type: type, items, errors, fetched_at: Date.now() };
}
async function verifyAwsAccount(id) { const regions = configuredRegions(id, "ap-northeast-1"); await awsRequest(id, "ec2", regions[0], `ec2.${regions[0]}.amazonaws.com`, "/", { Action: "DescribeInstances", Version: "2016-11-15", "MaxResults": "5" }); return { provider: "aws", verified: true, region_count: regions.length, regions, default_region: regions[0] }; }
function azureMeta(row) { let meta = {}; try { meta = JSON.parse(row.credential_meta || "{}"); } catch { /* legacy account */ } const tenantId = String(meta.tenant_id || "").trim(); const subscriptionId = String(meta.subscription_id || "").trim(); if (!tenantId || !subscriptionId) throw new Error("Azure 账号缺少 Tenant ID 或 Subscription ID"); return { tenantId, subscriptionId }; }
async function azureToken(accountId) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,credential_meta,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId); if (!row) throw new Error("云账号不存在"); if (!row.enabled) throw new Error("云账号已停用"); if (row.cloud_type !== "azure") throw new Error("当前账号不是 Microsoft Azure 账号"); const { tenantId, subscriptionId } = azureMeta(row);
  const body = new URLSearchParams({ client_id: row.access_key_id, client_secret: decryptSecret(row.secret_ciphertext), grant_type: "client_credentials", scope: "https://management.azure.com/.default" });
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }); const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || `Azure OAuth ${response.status}`); return { token: data.access_token, subscriptionId, accountId: row.access_key_id };
}
async function azurePages(context, pathname, apiVersion) { const items = []; let next = `https://management.azure.com${pathname}${pathname.includes("?") ? "&" : "?"}api-version=${encodeURIComponent(apiVersion)}`; for (let index = 0; next && index < 100; index += 1) { const response = await fetch(next, { headers: { Authorization: `Bearer ${context.token}` } }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error?.message || data.message || `Azure ${response.status}`); items.push(...(Array.isArray(data.value) ? data.value : [])); next = data.nextLink || ""; } return items; }
function azureInstance(item) { const p = item.properties || {}; return { ...item, InstanceId: item.id, InstanceName: item.name, InstanceStatus: p.provisioningState || "", Status: p.provisioningState || "", PublicIpAddress: "", PrivateIpAddress: "", InstanceType: item.properties?.hardwareProfile?.vmSize || "", VpcId: "", _region_id: item.location || "" }; }
function azureRds(item) { const p = item.properties || {}; return { ...item, DBInstanceId: item.id, DBInstanceDescription: item.name, DBInstanceStatus: p.state || p.provisioningState || "", DBInstanceClass: p.sku?.name || item.sku?.name || "", DBInstanceStorage: 0, ConnectionString: p.fullyQualifiedDomainName || "", Port: "", Engine: "Azure SQL", EngineVersion: p.version || "", CreateTime: "", _region_id: item.location || "" }; }
function azureRedis(item) { const p = item.properties || {}; return { ...item, InstanceId: item.id, InstanceName: item.name, InstanceStatus: p.provisioningState || "", InstanceType: "Redis", InstanceClass: item.sku?.name || "", Capacity: Number(item.sku?.capacity || 0), ConnectionDomain: p.hostName || "", Port: p.sslPort || p.port || "", EngineVersion: p.redisVersion || "", NetworkType: p.subnetId || "", _region_id: item.location || "" }; }
function azureBucket(item) { return { ...item, Name: item.name, BucketName: item.name, Location: item.location || "", CreationDate: item.properties?.creationTime || "", StorageClass: item.sku?.name || "Standard", Acl: item.properties?.allowBlobPublicAccess ? "public" : "private", ExtranetEndpoint: "-", IntranetEndpoint: "-", _region_id: item.location || "" }; }
function azureZone(item) { return { ...item, DomainName: item.name, DomainStatus: item.properties?.provisioningState || "ACTIVE", ZoneId: item.id, RecordCount: Number(item.properties?.numberOfRecordSets || 0), RegistrationDate: "", _region_id: item.location || "global", _azure_dns: true }; }
async function azureResources(accountId, type) { const context = await azureToken(accountId); const root = `/subscriptions/${encodeURIComponent(context.subscriptionId)}/providers`; const definitions = { ecs: [`${root}/Microsoft.Compute/virtualMachines`, "2024-03-01", azureInstance], rds: [`${root}/Microsoft.Sql/servers`, "2023-08-01-preview", azureRds], redis: [`${root}/Microsoft.Cache/Redis`, "2023-08-01", azureRedis], oss: [`${root}/Microsoft.Storage/storageAccounts`, "2023-05-01", azureBucket], domain: [`${root}/Microsoft.Network/dnszones`, "2023-09-01", azureZone] }; const def = definitions[type]; if (!def) return { resource_type: type, items: [], errors: [`Azure 暂未接入 ${type} 资源`], fetched_at: Date.now() }; try { const [path, version, normalize] = def; return { resource_type: type, items: (await azurePages(context, path, version)).map(normalize), errors: [], fetched_at: Date.now() }; } catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; } }
async function verifyAzureAccount(id) { const context = await azureToken(id); await azurePages(context, `/subscriptions/${encodeURIComponent(context.subscriptionId)}`, "2022-12-01"); return { provider: "azure", verified: true, region_count: configuredRegions(id, "eastasia").length, regions: configuredRegions(id, "eastasia"), default_region: configuredRegions(id, "eastasia")[0] }; }
function gcpMeta(row) { let meta = {}; try { meta = JSON.parse(row.credential_meta || "{}"); } catch { /* legacy account */ } const projectId = String(meta.project_id || "").trim(); if (!projectId) throw new Error("GCP 账号缺少 Project ID"); return { projectId }; }
function base64Url(value) { return Buffer.from(value).toString("base64url"); }
async function gcpToken(accountId) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,credential_meta,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId); if (!row) throw new Error("云账号不存在"); if (!row.enabled) throw new Error("云账号已停用"); if (row.cloud_type !== "gcp") throw new Error("当前账号不是 Google Cloud 账号"); const { projectId } = gcpMeta(row); const now = Math.floor(Date.now() / 1000); const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" })); const claim = base64Url(JSON.stringify({ iss: row.access_key_id, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  let signature; try { signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claim}`), decryptSecret(row.secret_ciphertext).replace(/\\n/g, "\n")).toString("base64url"); } catch { throw new Error("GCP 服务账号私钥无效，需填写未加密的 PEM 私钥"); }
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claim}.${signature}` }); const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }); const data = await response.json().catch(() => ({})); if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || `GCP OAuth ${response.status}`); return { token: data.access_token, projectId, accountId: row.access_key_id };
}
async function gcpGet(context, url) { const response = await fetch(url, { headers: { Authorization: `Bearer ${context.token}` } }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error?.message || data.message || `GCP ${response.status}`); return data; }
async function gcpPages(context, url, key) { const items = []; let next = url; for (let index = 0; next && index < 100; index += 1) { const data = await gcpGet(context, next); items.push(...(Array.isArray(data[key]) ? data[key] : [])); next = data.nextPageToken ? `${url}${url.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(data.nextPageToken)}` : ""; } return items; }
function gcpInstance(item, region) { const network = item.networkInterfaces?.[0] || {}; return { ...item, InstanceId: String(item.id || item.name), InstanceName: item.name, InstanceStatus: item.status, Status: item.status, PublicIpAddress: network.accessConfigs?.[0]?.natIP || "", PrivateIpAddress: network.networkIP || "", InstanceType: String(item.machineType || "").split("/").pop() || "", VpcId: String(network.network || "").split("/").pop() || "", _region_id: region }; }
function gcpRds(item) { const settings = item.settings || {}; return { ...item, DBInstanceId: item.name, DBInstanceDescription: item.name, DBInstanceStatus: item.state, DBInstanceClass: settings.tier || "", DBInstanceStorage: Number(settings.dataDiskSizeGb || 0), ConnectionString: item.ipAddresses?.find((ip) => ip.type === "PRIMARY")?.ipAddress || "", Port: "3306", Engine: item.databaseVersion || "", EngineVersion: item.databaseVersion || "", CreateTime: item.createTime || "", _region_id: item.region || "" }; }
function gcpRedis(item) { const size = Number(item.memorySizeGb || 0); return { ...item, InstanceId: item.name, InstanceName: String(item.name || "").split("/").pop(), InstanceStatus: item.state, InstanceType: "Redis", InstanceClass: item.tier || "", Capacity: size * 1024, ConnectionDomain: item.host || "", Port: item.port || "", EngineVersion: item.redisVersion || "", NetworkType: item.authorizedNetwork || "", _region_id: item.locationId || "" }; }
function gcpBucket(item) { return { ...item, Name: item.name, BucketName: item.name, Location: item.location || "", CreationDate: item.timeCreated || "", StorageClass: item.storageClass || "STANDARD", Acl: item.iamConfiguration?.uniformBucketLevelAccess?.enabled ? "private" : "unknown", ExtranetEndpoint: "-", IntranetEndpoint: "-", _region_id: item.location || "" }; }
function gcpZone(item) { return { ...item, DomainName: String(item.dnsName || "").replace(/\.$/, ""), DomainStatus: "ACTIVE", ZoneId: item.id || item.name, RecordCount: Number(item?.cloudLoggingConfig ? 0 : 0), RegistrationDate: item.creationTime || "", _region_id: "global", _gcp_dns: true, ...item }; }
async function gcpResources(accountId, type) { const context = await gcpToken(accountId); const project = encodeURIComponent(context.projectId); try { if (type === "ecs") { const data = await gcpGet(context, `https://compute.googleapis.com/compute/v1/projects/${project}/aggregated/instances`); const items = Object.entries(data.items || {}).flatMap(([scope, value]) => (value?.instances || []).map((item) => gcpInstance(item, scope.split("/").pop() || ""))); return { resource_type: type, items, errors: [], fetched_at: Date.now() }; } const definitions = { rds: [`https://sqladmin.googleapis.com/sql/v1beta4/projects/${project}/instances`, "items", gcpRds], redis: [`https://redis.googleapis.com/v1/projects/${project}/locations/-/instances`, "instances", gcpRedis], oss: [`https://storage.googleapis.com/storage/v1/b?project=${project}`, "items", gcpBucket], domain: [`https://dns.googleapis.com/dns/v1/projects/${project}/managedZones`, "managedZones", gcpZone] }; const def = definitions[type]; if (!def) return { resource_type: type, items: [], errors: [`GCP 暂未接入 ${type} 资源`], fetched_at: Date.now() }; const [url, key, normalize] = def; return { resource_type: type, items: (await gcpPages(context, url, key)).map(normalize), errors: [], fetched_at: Date.now() }; } catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; } }
async function verifyGcpAccount(id) { const context = await gcpToken(id); await gcpGet(context, `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(context.projectId)}`); const regions = configuredRegions(id, "asia-east1"); return { provider: "gcp", verified: true, region_count: regions.length, regions, default_region: regions[0] }; }
async function jdcloudRequest(accountId, service, region, pathname, query = {}) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId); if (!row) throw new Error("云账号不存在"); if (!row.enabled) throw new Error("云账号已停用"); if (row.cloud_type !== "jdcloud") throw new Error("当前账号不是京东云账号");
  const host = service === "oss" ? "oss.jdcloud-api.com" : service === "domainservice" ? "domainservice.jdcloud-api.com" : `${service}.${region}.jdcloud-api.com`; const datetime = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""); const date = datetime.slice(0, 8); const queryText = awsQuery(query); const payloadHash = crypto.createHash("sha256").update("").digest("hex"); const canonicalHeaders = `host:${host}\nx-jdcloud-date:${datetime}\n`; const signedHeaders = "host;x-jdcloud-date"; const canonicalRequest = `GET\n${pathname}\n${queryText}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`; const scope = `${date}/${region}/${service}/jdcloud2_request`; const stringToSign = `JDCLOUD2-HMAC-SHA256\n${datetime}\n${scope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`; const secret = decryptSecret(row.secret_ciphertext); const signingKey = awsSign(awsSign(awsSign(awsSign(`JDCLOUD2${secret}`, date), region), service), "jdcloud2_request"); const signature = awsSign(signingKey, stringToSign).toString("hex"); const authorization = `JDCLOUD2-HMAC-SHA256 Credential=${row.access_key_id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}${pathname}${queryText ? `?${queryText}` : ""}`, { headers: { Host: host, "X-Jdcloud-Date": datetime, Authorization: authorization } }); const data = await response.json().catch(() => ({})); if (!response.ok) { const message = data?.error?.message || data?.message || data?.code || `京东云 ${response.status}`; writeApiLog(accountId, host, `GET ${pathname}`, query, data, "失败", message); throw new Error(message); } writeApiLog(accountId, host, `GET ${pathname}`, query, data, "成功"); return data;
}
function jdcloudInstance(item, region) { return { ...item, InstanceId: item.instanceId || item.id, InstanceName: item.name || item.instanceId, InstanceStatus: item.status, Status: item.status, PublicIpAddress: firstAddress(item.elasticIp || item.publicIpAddress), PrivateIpAddress: firstAddress(item.privateIpAddress), InstanceType: item.instanceType || "", VpcId: item.vpcId || "", _region_id: region }; }
function jdcloudRds(item, region) { return { ...item, DBInstanceId: item.instanceId || item.id, DBInstanceDescription: item.instanceName || item.name || item.instanceId, DBInstanceStatus: item.instanceStatus || item.status, DBInstanceClass: item.instanceClass || item.instanceType || "", DBInstanceStorage: Number(item.instanceStorageGB || item.storageGB || 0), ConnectionString: item.internalDomainName || item.connectionString || "", Port: item.port || "", Engine: item.engine || item.engineType || "", EngineVersion: item.engineVersion || "", CreateTime: item.createTime || "", _region_id: region }; }
function jdcloudRedis(item, region) { return { ...item, InstanceId: item.cacheInstanceId || item.instanceId || item.id, InstanceName: item.cacheInstanceName || item.name || item.cacheInstanceId, InstanceStatus: item.cacheInstanceStatus || item.status, InstanceType: "Redis", InstanceClass: item.cacheInstanceClass || item.instanceClass || "", Capacity: Number(item.cacheInstanceMemoryMB || item.memory || 0), ConnectionDomain: item.cacheInstanceDomainName || item.connectionDomain || "", Port: item.port || "", EngineVersion: item.engineVersion || "", NetworkType: item.vpcId || "", _region_id: region }; }
function jdcloudBucket(item, region) { const name = item.name || item.bucketName || item.bucket; return { ...item, Name: name, BucketName: name, Location: item.location || item.region || region, CreationDate: item.creationDate || item.createTime || "", StorageClass: item.storageClass || "STANDARD", Acl: item.acl || "private", ExtranetEndpoint: name ? `${name}.s3.${region}.jdcloud-oss.com` : "-", IntranetEndpoint: "-", _region_id: item.location || item.region || region }; }
function jdcloudZone(item, region) { return { ...item, DomainName: item.domainName || item.domain || item.name, DomainStatus: item.status || "ACTIVE", ZoneId: item.id || item.domainId || item.domainName, RecordCount: Number(item.recordCount || item.recordNum || 0), RegistrationDate: item.createTime || "", _region_id: region, _jdcloud_dns: true }; }
function jdcloudSwasInstance(item, region) { return { ...item, InstanceId: item.instanceId || item.id, InstanceName: item.name || item.instanceName || item.instanceId, InstanceStatus: item.status || item.instanceStatus, Status: item.status || item.instanceStatus, PublicIpAddress: firstAddress(item.publicIpAddress || item.elasticIp), PrivateIpAddress: firstAddress(item.privateIpAddress), InstanceType: item.instanceType || item.planName || "", VpcId: item.vpcId || "", _region_id: region }; }
async function jdcloudResources(accountId, type) { const regions = configuredRegions(accountId, "cn-north-1"); const definitions = { ecs: ["vm", "v1", "instances", jdcloudInstance], rds: ["rds", "v1", "instances", jdcloudRds], redis: ["redis", "v1", "cacheInstance", jdcloudRedis], oss: ["oss", "v1", "buckets", jdcloudBucket], domain: ["domainservice", "v2", "domain", jdcloudZone], swas: ["lavm", "v1", "instances", jdcloudSwasInstance] }; const def = definitions[type]; if (!def) return { resource_type: type, items: [], errors: [`京东云暂未接入 ${type} 资源`], fetched_at: Date.now() }; const [service, version, resource, normalize] = def; const items = []; const errors = []; for (const region of regions) { try { const data = await jdcloudRequest(accountId, service, region, `/${version}/regions/${encodeURIComponent(region)}/${resource}`, type === "oss" ? {} : { pageNumber: 1, pageSize: 100 }); const result = data?.result || {}; const page = result.instances || result.cacheInstances || result.cacheInstance || result.buckets || result.dataList || result.data || data.buckets || []; items.push(...(Array.isArray(page) ? page : []).map((item) => normalize(item, region))); } catch (error) { errors.push(`${region}: ${error.message}`); } } return { resource_type: type, items, errors, fetched_at: Date.now() }; }
async function verifyJdcloudAccount(id) { const regions = configuredRegions(id, "cn-north-1"); await jdcloudRequest(id, "vm", regions[0], `/v1/regions/${encodeURIComponent(regions[0])}/instances`, { pageNumber: 1, pageSize: 1 }); return { provider: "jdcloud", verified: true, region_count: regions.length, regions, default_region: regions[0] }; }
async function qingcloudRequest(accountId, action, zone, params = {}) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId); if (!row) throw new Error("云账号不存在"); if (!row.enabled) throw new Error("云账号已停用"); if (row.cloud_type !== "qingcloud") throw new Error("当前账号不是青云 QingCloud 账号");
  const query = { action, zone, access_key_id: row.access_key_id, time_stamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), version: 1, signature_method: "HmacSHA256", signature_version: 1, ...params }; const canonical = awsQuery(query); const signature = crypto.createHmac("sha256", decryptSecret(row.secret_ciphertext)).update(`GET\n/iaas/\n${canonical}`).digest("base64"); query.signature = signature;
  const response = await fetch(`https://api.qingcloud.com/iaas/?${new URLSearchParams(query)}`); const data = await response.json().catch(() => ({})); if (!response.ok || Number(data?.ret_code || 0) !== 0) { const message = data?.message || data?.ret_message || `青云 ${response.status}`; writeApiLog(accountId, "api.qingcloud.com", action, { zone, ...params }, data, "失败", message); throw new Error(message); } writeApiLog(accountId, "api.qingcloud.com", action, { zone, ...params }, data, "成功"); return data;
}
function qingcloudInstance(item, zone) { return { ...item, InstanceId: item.instance_id, InstanceName: item.instance_name || item.instance_id, InstanceStatus: item.status, Status: item.status, PublicIpAddress: firstAddress(item.vxnets?.flatMap((value) => value.eips || [])), PrivateIpAddress: firstAddress(item.vxnets?.flatMap((value) => value.private_ips || [])), InstanceType: item.instance_type || "", VpcId: item.vpc_id || "", _region_id: zone }; }
function qingcloudRds(item, zone) { return { ...item, DBInstanceId: item.rdb_id || item.rdb, DBInstanceDescription: item.rdb_name || item.rdb_id || item.rdb, DBInstanceStatus: item.status, DBInstanceClass: item.rdb_type || item.rdb_class || "", DBInstanceStorage: Number(item.storage_size || item.storage || 0), ConnectionString: firstAddress(item.vips || item.private_ips || item.endpoint), Port: item.port || "", Engine: item.rdb_engine || "", EngineVersion: item.engine_version || "", CreateTime: item.create_time || "", _region_id: zone }; }
function qingcloudRedis(item, zone) { return { ...item, InstanceId: item.cache_id || item.cache, InstanceName: item.cache_name || item.cache_id || item.cache, InstanceStatus: item.status, InstanceType: item.cache_type || "Redis", InstanceClass: item.cache_class || "", Capacity: Number(item.cache_size || item.memory_size || 0), ConnectionDomain: firstAddress(item.vips || item.private_ips || item.endpoint), Port: item.port || "", EngineVersion: item.cache_version || "", NetworkType: item.vxnet_id || item.vxnet || "", _region_id: zone }; }
function qingcloudDnsAlias(item, zone) { return { ...item, DomainName: item.domain_name || item.dns_alias || item.dns_alias_id, DomainStatus: item.status || "ACTIVE", ZoneId: item.dns_alias_id || item.dns_alias || item.domain_name, RecordCount: 0, RegistrationDate: item.create_time || "", _region_id: zone, _qingcloud_dns_alias: true }; }
async function qingcloudBuckets(accountId) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId); if (!row) throw new Error("云账号不存在"); if (!row.enabled) throw new Error("云账号已停用"); if (row.cloud_type !== "qingcloud") throw new Error("当前账号不是青云 QingCloud 账号");
  const date = new Date().toUTCString(); const signature = crypto.createHmac("sha256", decryptSecret(row.secret_ciphertext)).update(`GET\n\n\n${date}\n/`).digest("base64"); const response = await fetch("https://qingstor.com/", { headers: { Date: date, Authorization: `QS ${row.access_key_id}:${signature}` } }); const data = await response.json().catch(() => ({}));
  if (!response.ok) { const message = data?.message || `QingStor ${response.status}`; writeApiLog(accountId, "qingstor.com", "ListBuckets", {}, data, "失败", message); throw new Error(message); }
  const items = (data.buckets || []).map((bucket) => ({ Name: bucket.name, BucketName: bucket.name, Location: bucket.location || "", CreationDate: bucket.created || "", StorageClass: "STANDARD", Acl: "private", ExtranetEndpoint: firstAddress(bucket.urls) || "-", IntranetEndpoint: "-", _region_id: bucket.location || "" })); writeApiLog(accountId, "qingstor.com", "ListBuckets", {}, { count: items.length }, "成功"); return items;
}
async function qingcloudResources(accountId, type) {
  if (type === "oss") { try { return { resource_type: type, items: await qingcloudBuckets(accountId), errors: [], fetched_at: Date.now() }; } catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; } }
  const definitions = { ecs: ["DescribeInstances", "instance_set", qingcloudInstance], rds: ["DescribeRDBs", "rdb_set", qingcloudRds], redis: ["DescribeCaches", "cache_set", qingcloudRedis], domain: ["DescribeDNSAliases", "dns_alias_set", qingcloudDnsAlias] }; const definition = definitions[type]; if (!definition) return { resource_type: type, items: [], errors: [`青云 QingCloud 暂未接入 ${type} 资源`], fetched_at: Date.now() };
  const [action, key, normalize] = definition; const zones = configuredRegions(accountId, "pek3a"); const items = []; const errors = []; for (const zone of zones) { try { const data = await qingcloudRequest(accountId, action, zone, { limit: 100 }); items.push(...(data[key] || []).map((item) => normalize(item, zone))); } catch (error) { errors.push(`${zone}: ${error.message}`); } } return { resource_type: type, items, errors, fetched_at: Date.now() }; }
async function verifyQingcloudAccount(id) { const zones = configuredRegions(id, "pek3a"); await qingcloudRequest(id, "DescribeInstances", zones[0], { limit: 1 }); return { provider: "qingcloud", verified: true, region_count: zones.length, regions: zones, default_region: zones[0] }; }
async function ksyunRequest(accountId, service, region, action, version, params = {}) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId); if (!row) throw new Error("云账号不存在"); if (!row.enabled) throw new Error("云账号已停用"); if (row.cloud_type !== "ksyun") throw new Error("当前账号不是金山云账号"); const host = `${service}.${region}.api.ksyun.com`; const query = { Action: action, Version: version, AccessKeyId: row.access_key_id, SignatureMethod: "HMAC-SHA256", SignatureVersion: "1.0", Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), ...params }; const canonical = awsQuery(query); const stringToSign = `GET\n${host}\n/\n${canonical}`; query.Signature = crypto.createHmac("sha256", decryptSecret(row.secret_ciphertext)).update(stringToSign).digest("base64"); const response = await fetch(`https://${host}/?${new URLSearchParams(query)}`); const data = await response.json().catch(() => ({})); if (!response.ok || data?.Error) { const message = data?.Error?.Message || data?.Message || `金山云 ${response.status}`; writeApiLog(accountId, host, action, params, data, "失败", message); throw new Error(message); } writeApiLog(accountId, host, action, params, data, "成功"); return data;
}
function ksyunInstance(item, region) { return { ...item, InstanceId: item.InstanceId, InstanceName: item.InstanceName || item.InstanceId, InstanceStatus: item.InstanceState?.Name || item.InstanceState, Status: item.InstanceState?.Name || item.InstanceState, PublicIpAddress: firstAddress(item.NetworkInterfaces?.[0]?.PrivateIpAddress || item.PublicIpAddress), PrivateIpAddress: firstAddress(item.NetworkInterfaces?.[0]?.PrivateIpAddress), InstanceType: item.InstanceType || "", VpcId: item.VpcId || "", _region_id: region }; }
async function ksyunKs3Buckets(accountId) {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId); if (!row) throw new Error("云账号不存在"); if (!row.enabled) throw new Error("云账号已停用"); if (row.cloud_type !== "ksyun") throw new Error("当前账号不是金山云账号");
  const date = new Date().toUTCString(); const signature = crypto.createHmac("sha1", decryptSecret(row.secret_ciphertext)).update(`GET\n\n\n${date}\n/`).digest("base64"); const host = "kss.ksyun.com"; const response = await fetch(`https://${host}/`, { headers: { Date: date, Authorization: `KSS ${row.access_key_id}:${signature}` } }); const xml = await response.text();
  if (!response.ok) { const message = xmlText(xml, "Message") || xmlText(xml, "Code") || `KS3 ${response.status}`; writeApiLog(accountId, host, "ListBuckets", {}, { body: xml }, "失败", message); throw new Error(message); }
  const items = xmlBlocks(xml, "Bucket").map((block) => { const name = xmlText(block, "Name"); const location = xmlText(block, "Location"); return { Name: name, BucketName: name, Location: location, CreationDate: xmlText(block, "CreationDate"), StorageClass: "STANDARD", Acl: "private", ExtranetEndpoint: name ? `${name}.${host}` : "-", IntranetEndpoint: "-", _region_id: location || "global" }; }).filter((bucket) => bucket.Name); writeApiLog(accountId, host, "ListBuckets", {}, { count: items.length }, "成功"); return items;
}
function ksyunRds(item, region) { return { ...item, DBInstanceId: item.DBInstanceIdentifier, DBInstanceDescription: item.DBInstanceName || item.DBInstanceIdentifier, DBInstanceStatus: item.DBInstanceStatus, DBInstanceClass: item.DBInstanceClass?.Id || item.DBInstanceClass || "", DBInstanceStorage: Number(item.DBInstanceClass?.Disk || item.Storage || 0), ConnectionString: item.Vip || item.VipAddress || "", Port: item.Port || "", Engine: item.Engine || "", EngineVersion: item.EngineVersion || "", CreateTime: item.InstanceCreateTime || "", _region_id: region }; }
function ksyunRedis(item, region) { return { ...item, InstanceId: item.CacheId || item.CacheClusterId || item.InstanceId, InstanceName: item.Name || item.CacheName || item.CacheClusterName || item.CacheId, InstanceStatus: item.Status || item.CacheStatus || item.CacheClusterStatus, InstanceType: "Redis", InstanceClass: item.CacheNodeType || item.InstanceClass || item.Type || "", Capacity: Number(item.Capacity || item.MemorySize || 0), ConnectionDomain: item.Vip || item.Host || item.Endpoint || "", Port: item.Port || "", EngineVersion: item.EngineVersion || item.RedisVersion || "", NetworkType: item.VpcId || "", _region_id: region }; }
async function ksyunResources(accountId, type) {
  const regions = configuredRegions(accountId, "cn_beijing_6"); const items = []; const errors = []; if (type === "oss") { try { items.push(...await ksyunKs3Buckets(accountId)); } catch (error) { errors.push(error.message); } return { resource_type: type, items, errors, fetched_at: Date.now() }; }
  const definitions = { ecs: ["kec", "DescribeInstances", "2016-03-04", (data) => data.InstancesSet || data.Instances || [], ksyunInstance], rds: ["krds", "DescribeDBInstances", "2016-07-01", (data) => data.Data?.Instances || data.Instances || [], ksyunRds], redis: ["kcs", "DescribeCacheClusters", "2016-07-01", (data) => data.CacheClusters || data.Data?.CacheClusters || data.Data?.Instances || [], ksyunRedis] }; const definition = definitions[type]; if (!definition) return { resource_type: type, items, errors: [`金山云暂未接入 ${type} 资源`], fetched_at: Date.now() };
  const [service, action, version, extract, normalize] = definition; for (const region of regions) { try { const data = await ksyunRequest(accountId, service, region, action, version, type === "ecs" ? { MaxResults: 100 } : { MaxRecords: 100 }); items.push(...extract(data).map((item) => normalize(item, region))); } catch (error) { errors.push(`${region}: ${error.message}`); } } return { resource_type: type, items, errors, fetched_at: Date.now() }; }
async function verifyKsyunAccount(id) { const regions = configuredRegions(id, "cn_beijing_6"); await ksyunRequest(id, "kec", regions[0], "DescribeInstances", "2016-03-04", { MaxResults: 1 }); return { provider: "ksyun", verified: true, region_count: regions.length, regions, default_region: regions[0] }; }
function volcEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function volcQuery(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [volcEncode(key), volcEncode(value)])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}
async function volcRequest(accountId, service, version, action, params = {}, region = "cn-beijing") {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type,region_id FROM cloud_accounts WHERE id=?").get(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "volcengine") throw new Error("当前账号不是火山引擎账号");
  const selectedRegion = String(region || row.region_id || "cn-beijing");
  const host = "open.volcengineapi.com";
  const requestParams = { ...params, Action: action, Version: version };
  const query = volcQuery(requestParams);
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
async function volcJsonRequest(accountId, service, version, action, payload = {}, region = "cn-beijing") {
  const row = database().prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type,region_id FROM cloud_accounts WHERE id=?").get(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "volcengine") throw new Error("当前账号不是火山引擎账号");
  const selectedRegion = String(region || row.region_id || "cn-beijing");
  const host = `${service}.volcengineapi.com`;
  const requestParams = { Action: action, Version: version };
  const query = volcQuery(requestParams);
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
  const response = await fetch(`https://${host}/?${query}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Date": dateTime, Authorization: authorization },
    body,
  });
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
async function volcTosBuckets(accountId) {
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
  } catch {
    buckets = xmlBlocks(xml, "Bucket").map((block) => ({
      Name: xmlText(block, "Name"),
      Location: xmlText(block, "Location"),
      CreationDate: xmlText(block, "CreationDate"),
    }));
  }
  const items = buckets.map((bucket) => {
    const name = bucket.Name || bucket.BucketName || "";
    const location = bucket.Location || bucket.Region || region;
    return { Name: name, Location: location, CreationDate: bucket.CreationDate || "", StorageClass: "Standard", ExtranetEndpoint: `${name}.tos-${location}.volces.com`, Acl: "private" };
  }).filter((item) => item.Name);
  writeApiLog(accountId, host, "ListBuckets", {}, { count: items.length }, "成功");
  return items;
}
function volcInstance(item, region) {
  return { ...item, InstanceId: item.InstanceId || item.InstanceID, InstanceName: item.InstanceName || item.InstanceId || item.InstanceID, InstanceStatus: item.Status || item.InstanceStatus, Status: item.Status || item.InstanceStatus, PublicIpAddress: item.PublicIpAddress || item.PublicIpAddresses?.[0] || item.EipAddress || "", _region_id: region };
}
function volcRdsInstance(item, region) {
  return { ...item, DBInstanceId: item.DBInstanceId || item.InstanceId || item.InstanceID, DBInstanceDescription: item.DBInstanceName || item.InstanceName || item.DBInstanceId || item.InstanceId, DBInstanceStatus: item.Status || item.DBInstanceStatus, Engine: item.Engine || "MySQL", _region_id: region };
}
function volcSwasInstance(item, region) {
  return { ...item, InstanceId: item.InstanceId || item.InstanceID, InstanceName: item.InstanceName || item.Name || item.InstanceId || item.InstanceID, InstanceStatus: item.Status || item.InstanceStatus, Status: item.Status || item.InstanceStatus, PublicIpAddress: item.PublicIpAddress || item.PublicIp || item.PublicIpAddresses?.[0] || item.EipAddress || "", _region_id: region };
}
function volcRedisInstance(item, region) {
  const instanceId = item.InstanceId || item.InstanceID || item.DBInstanceId || item.RedisInstanceId;
  return { ...item, KVStoreInstanceId: instanceId, InstanceId: instanceId, InstanceName: item.InstanceName || item.DBInstanceName || item.Name || instanceId, InstanceStatus: item.Status || item.InstanceStatus, DBInstanceStatus: item.Status || item.InstanceStatus, EngineVersion: item.EngineVersion || item.RedisVersion || "Redis", _region_id: region };
}
function volcEdgeDomain(item) {
  const domain = item.DomainName || item.Domain || item.Name || "";
  return { ...item, SiteId: item.DomainId || item.DomainID || domain, SiteName: domain, DomainName: domain, Status: item.Status || item.DomainStatus || "", AccessType: item.ServiceType || item.BusinessType || "CDN", Coverage: item.Area || item.Scope || "", PlanName: item.Plan || item.ProductType || "" };
}
function volcDnsZone(item) {
  const expiresAt = Number(item.ExpiredTime || 0);
  return {
    ...item,
    DomainName: item.ZoneName || "",
    DomainStatus: "正常",
    RegistrationDate: item.CreatedAt || "",
    ExpirationDate: expiresAt ? new Date(expiresAt < 1e12 ? expiresAt * 1000 : expiresAt).toISOString() : "",
    RecordCount: item.RecordCount || 0,
  };
}
async function volcResources(id, type) {
  const errors = [];
  const account = database().prepare("SELECT region_id FROM cloud_accounts WHERE id=?").get(id);
  const region = String(account?.region_id || "cn-beijing");
  try {
    if (type === "ecs") {
      const data = await volcRequest(id, "ecs", "2020-04-01", "DescribeInstances", { PageSize: 100, PageNumber: 1 }, region);
      const items = arr(data, ["Instances"]).length ? arr(data, ["Instances"]) : arr(data, ["Instances", "Instance"]);
      return { resource_type: type, items: items.map((item) => volcInstance(item, region)), errors, fetched_at: Date.now() };
    }
    if (type === "oss") return { resource_type: type, items: await volcTosBuckets(id), errors, fetched_at: Date.now() };
    if (type === "domain") {
      const data = await volcJsonRequest(id, "dns", "2018-08-01", "ListZones", { PageSize: 100, PageNumber: 1 }, region);
      return { resource_type: type, items: arr(data, ["Zones"]).map(volcDnsZone), errors, fetched_at: Date.now() };
    }
    if (type === "rds") {
      const data = await volcRequest(id, "rds_mysql", "2018-01-01", "DescribeDBInstances", { PageSize: 100, PageNumber: 1 }, region);
      const items = arr(data, ["DBInstances"]).length ? arr(data, ["DBInstances"]) : arr(data, ["Items"]);
      return { resource_type: type, items: items.map((item) => volcRdsInstance(item, region)), errors, fetched_at: Date.now() };
    }
    if (type === "swas") {
      const data = await volcRequest(id, "lighthouse", "2020-04-01", "DescribeInstances", { PageSize: 100, PageNumber: 1 }, region);
      const items = arr(data, ["Instances"]).length ? arr(data, ["Instances"]) : arr(data, ["InstanceSet"]);
      return { resource_type: type, items: items.map((item) => volcSwasInstance(item, region)), errors, fetched_at: Date.now() };
    }
    if (type === "redis") {
      const data = await volcRequest(id, "Redis", "2020-12-07", "DescribeDBInstances", { PageSize: 100, PageNumber: 1 }, region);
      const items = arr(data, ["DBInstances"]).length ? arr(data, ["DBInstances"]) : arr(data, ["Items"]);
      return { resource_type: type, items: items.map((item) => volcRedisInstance(item, region)), errors, fetched_at: Date.now() };
    }
    if (type === "esa") {
      const data = await volcRequest(id, "cdn", "2021-03-01", "ListCdnDomains", { PageSize: 100, PageNumber: 1 }, region);
      const items = arr(data, ["Domains"]).length ? arr(data, ["Domains"]) : arr(data, ["DomainList"]);
      return { resource_type: type, items: items.map(volcEdgeDomain), errors, fetched_at: Date.now() };
    }
  } catch (error) { errors.push(error.message); }
  return { resource_type: type, items: [], errors: errors.length ? errors : [`火山引擎暂未接入 ${type} 资源`], fetched_at: Date.now() };
}
function arr(data, path) {
  let value = data;
  for (const key of path) value = value?.[key];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
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
      regions = [...new Set([
        ...arr(regionData, ["RegionSet"])
          .filter((item) => String(item.RegionState || "AVAILABLE").toUpperCase() === "AVAILABLE")
          .map((item) => String(item.Region || ""))
          .filter(Boolean),
        fallbackRegion,
      ])];
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
async function regions(id) {
  const data = await rpc(
    id,
    "ecs.aliyuncs.com",
    "2014-05-26",
    "DescribeRegions",
  );
  return arr(data, ["Regions", "Region"])
    .map((r) => r.RegionId)
    .filter(Boolean);
}
function xmlDecode(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function xmlText(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return match ? xmlDecode(match[1]).trim() : "";
}
function xmlBlocks(xml, tag) {
  return [...String(xml).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g"))].map((match) => match[1]);
}
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
async function vultrRequest(accountId, pathName, query = {}, init = {}) {
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
function vultrCursor(next) {
  try { return new URL(String(next || ""), "https://api.vultr.com").searchParams.get("cursor") || ""; } catch { return ""; }
}
async function vultrPages(accountId, pathName, itemKey) {
  const items = []; let cursor = "";
  for (let page = 0; page < 100; page += 1) {
    const data = await vultrRequest(accountId, pathName, { per_page: 100, ...(cursor ? { cursor } : {}) });
    const values = Array.isArray(data?.[itemKey]) ? data[itemKey] : [];
    items.push(...values);
    cursor = vultrCursor(data?.meta?.links?.next);
    if (!cursor || !values.length) break;
  }
  return items;
}
function vultrValue(item, ...keys) { return keys.map((key) => item?.[key]).find((value) => value !== undefined && value !== null && value !== "") ?? ""; }
function vultrInventory(item, type) {
  const names = { block: ["label", "id"], network: ["description", "id"], firewall: ["description", "id"], ip: ["label", "subnet", "id"], loadbalancer: ["label", "id"], snapshot: ["description", "id"], kubernetes: ["label", "id"] };
  return { AssetId: vultrValue(item, "id"), Name: vultrValue(item, ...(names[type] || ["label", "description", "id"])), Status: type === "network" || type === "firewall" || type === "ip" ? "active" : vultrValue(item, "status"), RegionId: type === "firewall" ? "global" : vultrValue(item, "region"), IpAddress: vultrValue(item, "ip", "instance_ip"), SizeGb: vultrValue(item, "size_gb"), AttachedTo: vultrValue(item, "attached_to_instance", "instance_id"), VpcId: vultrValue(item, "vpc2_id", "vpc_id"), CreatedAt: vultrValue(item, "date_created"), Tags: vultrValue(item, "tags"), _region_id: vultrValue(item, "region"), _raw: item };
}
async function vultrResources(accountId, type) {
  const definitions = {
    ecs: ["instances", "instances", (item) => ({ InstanceId: vultrValue(item, "id"), InstanceName: vultrValue(item, "label", "hostname", "id"), Status: vultrValue(item, "status"), InstanceStatus: vultrValue(item, "status"), PublicIpAddress: vultrValue(item, "main_ip"), PrivateIpAddress: vultrValue(item, "internal_ip"), InstanceType: vultrValue(item, "plan"), Cpu: vultrValue(item, "vcpu_count"), Memory: vultrValue(item, "ram"), Disk: vultrValue(item, "disk"), OSName: vultrValue(item, "os"), Hostname: vultrValue(item, "hostname"), Region: vultrValue(item, "region"), AllowedBandwidth: vultrValue(item, "allowed_bandwidth"), NetmaskV4: vultrValue(item, "netmask_v4"), GatewayV4: vultrValue(item, "gateway_v4"), V6MainIp: vultrValue(item, "v6_main_ip"), PowerStatus: vultrValue(item, "power_status"), ServerStatus: vultrValue(item, "server_status"), Backups: vultrValue(item, "backups"), DdosProtection: vultrValue(item, "ddos_protection"), VpcIds: vultrValue(item, "vpc2_ids"), FirewallGroupId: vultrValue(item, "firewall_group_id"), Tags: vultrValue(item, "tags"), CreationTime: vultrValue(item, "date_created"), _region_id: vultrValue(item, "region"), _raw: item })],
    domain: ["domains", "domains", (item) => ({ DomainName: vultrValue(item, "domain"), DomainStatus: "ACTIVE", RecordCount: 0, RegistrationDate: vultrValue(item, "date_created"), ZoneId: vultrValue(item, "domain"), _region_id: "global", _raw: item })],
    oss: ["object-storage", "object_storages", (item) => ({ AssetId: vultrValue(item, "id", "cluster_id"), Name: vultrValue(item, "label", "cluster_id", "id"), BucketName: vultrValue(item, "label", "cluster_id", "id"), Status: vultrValue(item, "status"), Location: vultrValue(item, "region"), CreationDate: vultrValue(item, "date_created"), StorageClass: vultrValue(item, "plan"), _region_id: vultrValue(item, "region"), _raw: item })],
    rds: ["databases", "databases", (item) => ({ DBInstanceId: vultrValue(item, "id"), DBInstanceDescription: vultrValue(item, "label", "id"), DBInstanceStatus: vultrValue(item, "status"), DBInstanceClass: vultrValue(item, "plan"), ConnectionString: vultrValue(item, "host"), Port: vultrValue(item, "port"), Engine: vultrValue(item, "database_engine"), EngineVersion: vultrValue(item, "database_engine_version"), CreateTime: vultrValue(item, "date_created"), VpcId: vultrValue(item, "vpc_id"), _region_id: vultrValue(item, "region"), _raw: item })],
    block: ["blocks", "blocks", (item) => vultrInventory(item, "block")],
    network: ["vpc2", "vpc2", (item) => vultrInventory(item, "network")],
    firewall: ["firewalls", "firewall_groups", (item) => vultrInventory(item, "firewall")],
    ip: ["reserved-ips", "reserved_ips", (item) => vultrInventory(item, "ip")],
    loadbalancer: ["load-balancers", "load_balancers", (item) => vultrInventory(item, "loadbalancer")],
    snapshot: ["snapshots", "snapshots", (item) => vultrInventory(item, "snapshot")],
    kubernetes: ["kubernetes/clusters", "vke_clusters", (item) => vultrInventory(item, "kubernetes")],
  };
  const definition = definitions[type];
  if (!definition) return { resource_type: type, items: [], errors: [`Vultr 暂未接入 ${type} 资源`], fetched_at: Date.now() };
  try { const [pathName, key, normalize] = definition; return { resource_type: type, items: (await vultrPages(accountId, pathName, key)).map(normalize), errors: [], fetched_at: Date.now() }; }
  catch (error) { return { resource_type: type, items: [], errors: [error.message || String(error)], fetched_at: Date.now() }; }
}
async function verifyVultrAccount(id) {
  const [account, regions] = await Promise.all([vultrRequest(id, "account"), vultrPages(id, "regions", "regions")]);
  const ids = regions.map((region) => String(region.id || "")).filter(Boolean);
  return { provider: "vultr", verified: true, region_count: ids.length, regions: ids, default_region: ids[0] || "ewr", account: account.account || account };
}
async function aliyunDomainResources(id) {
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

async function cloudResources(id, type) {
  const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
  if (!account) throw new Error("云账号不存在");
  if (account.cloud_type === "vultr") return vultrResources(id, type);
  if (account.cloud_type === "tencent") return tencentResources(id, type);
  if (account.cloud_type === "volcengine") return volcResources(id, type);
  if (account.cloud_type === "ctyun") return ctyunResources(id, type);
  if (account.cloud_type === "huawei") return huaweiResources(id, type);
  if (account.cloud_type === "baidu") return baiduResources(id, type);
  if (account.cloud_type === "ucloud") return ucloudResources(id, type);
  if (account.cloud_type === "qiniu") return qiniuResources(id, type);
  if (account.cloud_type === "aws") return awsResources(id, type);
  if (account.cloud_type === "azure") return azureResources(id, type);
  if (account.cloud_type === "gcp") return gcpResources(id, type);
  if (account.cloud_type === "jdcloud") return jdcloudResources(id, type);
  if (account.cloud_type === "qingcloud") return qingcloudResources(id, type);
  if (account.cloud_type === "ksyun") return ksyunResources(id, type);
  if (account.cloud_type === "oracle") return oracleResources(id, type);
  if (type === "domain") return aliyunDomainResources(id);
  const items = [];
  const errors = [];
  if (type === "oss") {
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
    return {
      resource_type: type,
      items,
      errors: token ? ["OSS 存储桶分页超过 100 页，已停止读取"] : errors,
      fetched_at: Date.now(),
    };
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
        const endpoint =
          type === "rds" ? "rds.aliyuncs.com" : "r-kvstore.aliyuncs.com";
        const version = type === "rds" ? "2014-08-15" : "2015-01-01";
        const action =
          type === "rds" ? "DescribeDBInstances" : "DescribeInstances";
        const data = await rpc(id, endpoint, version, action, {
          RegionId: regionId,
          PageSize: "100",
        });
        const path =
          type === "rds"
            ? ["Items", "DBInstance"]
            : ["Instances", "KVStoreInstance"];
        for (const item of arr(data, path))
          items.push({ ...item, _region_id: regionId });
      } catch (error) {
        errors.push(`${regionId}: ${error.message}`);
      }
    }
    return { resource_type: type, items, errors, fetched_at: Date.now() };
  }
  if (type === "esa") {
    try {
      const data = await esaRequest(id, "ListSites", { PageNumber: "1", PageSize: "100" });
      return {
        resource_type: type,
        items: arr(data, ["Sites"]),
        errors: [],
        fetched_at: Date.now(),
      };
    } catch (error) {
      return {
        resource_type: type,
        items: [],
        errors: [error.message],
        fetched_at: Date.now(),
      };
    }
  }
  return {
    resource_type: type,
    items: [],
    errors: [`Web 预览暂未接入 ${type} API`],
    fetched_at: Date.now(),
  };
}

async function esaRequest(id, action, params = {}, method = "GET") {
  const row = database()
    .prepare("SELECT access_key_id,secret_ciphertext,enabled,cloud_type FROM cloud_accounts WHERE id=?")
    .get(id);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "aliyun")
    throw new Error(`${row.cloud_type === "tencent" ? "腾讯云" : "当前云类型"}资源 API 尚未接入`);
  const host = "esa.cn-hangzhou.aliyuncs.com";
  const normalizedMethod = method.toUpperCase();
  const query = Object.entries(params)
    .map(([key, value]) => [rpcEncode(key), rpcEncode(value)])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const payloadHash = crypto.createHash("sha256").update("").digest("hex");
  const acsDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const headers = {
    host,
    "x-acs-action": action,
    "x-acs-content-sha256": payloadHash,
    "x-acs-date": acsDate,
    "x-acs-signature-nonce": crypto.randomUUID(),
    "x-acs-version": "2024-09-10",
  };
  const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]}\n`).join("");
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalRequest = `${normalizedMethod}\n/\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `ACS3-HMAC-SHA256\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const signature = crypto.createHmac("sha256", decryptSecret(row.secret_ciphertext)).update(stringToSign).digest("hex");
  const authorization = `ACS3-HMAC-SHA256 Credential=${row.access_key_id},SignedHeaders=${signedHeaders},Signature=${signature}`;
  const response = await fetch(`https://${host}/${query ? `?${query}` : ""}`, {
    method: normalizedMethod,
    headers: { ...headers, authorization },
  });
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
  if (range === "yesterday") {
    start = new Date(today); start.setDate(start.getDate() - 1); end = today; label = "昨日";
  } else if (range === "week") {
    start = new Date(today); start.setDate(start.getDate() - 6); label = "近 7 日";
  } else if (range === "month") {
    start = new Date(today); start.setDate(start.getDate() - 29); label = "近 30 日";
  }
  return { start, end, label, interval: range === "week" || range === "month" ? "86400" : "3600" };
}

function esaDetails(data, fieldName) {
  const row = arr(data, ["Data"]).find((item) => item.FieldName === fieldName);
  return row ? arr(row, ["DetailData"]) : [];
}

async function esaOverview(id, range = "today", siteId = "") {
  const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
  if (account?.cloud_type === "tencent" || account?.cloud_type === "volcengine") {
    const zones = account.cloud_type === "tencent" ? await tencentResources(id, "esa") : await volcResources(id, "esa");
    const sites = zones.items;
    return {
      traffic: 0, requests: 0, defence_requests: 0, site_count: sites.length,
      active_count: sites.filter((site) => String(site.Status || "").toLowerCase() === "active").length,
      range_label: esaRange(["today", "yesterday", "week", "month"].includes(range) ? range : "today").label,
      trend: { traffic: [], requests: [], page_view: [] },
      site_options: sites.map((site) => ({ id: String(site.SiteId || ""), name: String(site.SiteName || site.DomainName || site.SiteId || "") })),
    };
  }
  const sitesResult = await esaRequest(id, "ListSites", { SiteSearchType: "fuzzy", SiteName: "", PageNumber: "1", PageSize: "100" });
  const sites = arr(sitesResult, ["Sites"]);
  const period = esaRange(["today", "yesterday", "week", "month"].includes(range) ? range : "today");
  const fields = JSON.stringify([
    { FieldName: "Requests", Dimension: ["ALL"] },
    { FieldName: "Traffic", Dimension: ["ALL"] },
    { FieldName: "PageView", Dimension: ["ALL"] },
  ]);
  const base = {
    StartTime: period.start.toISOString().replace(/\.\d{3}Z$/, "Z"),
    EndTime: period.end.toISOString().replace(/\.\d{3}Z$/, "Z"),
    Interval: period.interval,
  };
  const siteParam = siteId ? { SiteId: siteId } : {};
  const [top, defence, trend] = await Promise.all([
    esaRequest(id, "DescribeSiteTopData", { ...base, AnalysisType: "1", Fields: fields, ...siteParam }, "POST"),
    esaRequest(id, "DescribeSiteStatisticsData", {
      ...base,
      Fields: JSON.stringify([{ FieldName: "Requests", Dimension: ["ALL"] }]),
      Filter: JSON.stringify({ where: { and: [[{ key: "MitigationType", operator: "in", value: ["WafMitigated"] }]] } }),
      ...siteParam,
    }, "POST"),
    esaRequest(id, "DescribeSiteStatisticsData", { ...base, Fields: fields, ...siteParam }, "POST"),
  ]);
  const toNumber = (value) => Number(value || 0) || 0;
  const trendMap = { traffic: [], requests: [], page_view: [] };
  for (const [fieldName, key] of [["Traffic", "traffic"], ["Requests", "requests"], ["PageView", "page_view"]]) {
    trendMap[key] = esaDetails(trend, fieldName).map((detail) => ({
      time: detail.Time || detail.Timestamp || detail.TimeStamp || detail.Date || "",
      value: toNumber(detail.Value),
    }));
  }
  return {
    traffic: toNumber(esaDetails(top, "Traffic")[0]?.Value),
    requests: toNumber(esaDetails(top, "Requests")[0]?.Value),
    defence_requests: toNumber(esaDetails(defence, "Requests")[0]?.Value),
    site_count: Number(sitesResult.TotalCount || sites.length),
    active_count: sites.filter((site) => String(site.Status || "").toLowerCase() === "active").length,
    range_label: period.label,
    trend: trendMap,
    site_options: sites.map((site) => ({ id: String(site.SiteId || ""), name: String(site.SiteName || site.DomainName || site.SiteId || "") })),
  };
}
async function syncCloudAssets(id, resourceTypes) {
  const account = database().prepare("SELECT cloud_type,enabled FROM cloud_accounts WHERE id=?").get(id);
  if (!account) throw new Error("云账号不存在");
  if (!account.enabled) throw new Error("云账号已停用");
  if (!["aliyun", "vultr", "tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud", "qiniu", "aws", "azure", "gcp", "jdcloud", "qingcloud", "ksyun"].includes(account.cloud_type)) throw new Error("当前云类型资源实时拉取尚未接入");
  const supportedTypes = ["ecs", "domain", "oss", "rds", "redis", "swas", "esa"];
  const availableTypes = account.cloud_type === "vultr" ? ["ecs", "domain", "oss", "rds", "block", "network", "firewall", "ip", "loadbalancer", "snapshot", "kubernetes"] : account.cloud_type === "qiniu" ? ["oss"] : account.cloud_type === "jdcloud" ? ["ecs", "domain", "swas", "rds", "redis", "oss"] : account.cloud_type === "qingcloud" ? ["ecs", "domain", "rds", "redis", "oss"] : account.cloud_type === "ksyun" ? ["ecs", "rds", "redis", "oss"] : ["huawei", "baidu", "ucloud", "aws", "azure", "gcp"].includes(account.cloud_type) ? ["ecs", "domain", "rds", "redis", "oss"] : account.cloud_type === "oracle" ? ["ecs", "domain", "rds", "oss"] : account.cloud_type === "ctyun" ? ["ecs", "domain", "rds", "redis", "oss"] : account.cloud_type === "volcengine" ? ["ecs", "domain", "swas", "rds", "redis", "oss", "esa"] : supportedTypes;
  const requestedTypes = resourceTypes.length ? resourceTypes : availableTypes;
  const types = requestedTypes.filter((type) => availableTypes.includes(type));
  const rows = [];
  const errors = requestedTypes.filter((type) => !availableTypes.includes(type)).map((type) => `${type}: 暂未接入此资源`);
  for (const type of types) {
    try {
      const response = await cloudResources(id, type);
      errors.push(...(response.errors || []).map((error) => `${type}: ${error}`));
      rows.push({ type, items: response.items || [], fetchedAt: Date.now() });
    } catch (error) { errors.push(`${type}: ${error.message}`); rows.push({ type, items: [], fetchedAt: Date.now() }); }
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
    db.exec("COMMIT"); db.close();
    return { fetched, counts, errors, fetched_at: Date.now() };
  } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
}
function localAssets(accountId, resourceType) {
  const db = database();
  const rows = db.prepare("SELECT account_id,resource_type,asset_key,region_id,payload_json,fetched_at FROM cloud_assets WHERE (? IS NULL OR account_id=?) AND (? IS NULL OR resource_type=?) ORDER BY resource_type,asset_key").all(accountId ?? null, accountId ?? null, resourceType ?? null, resourceType ?? null);
  db.close();
  return rows.map((row) => ({ account_id: row.account_id, resource_type: row.resource_type, asset_key: row.asset_key, region_id: row.region_id, payload: JSON.parse(row.payload_json), fetched_at: row.fetched_at }));
}
function updateCachedServerName(accountId, instanceId, instanceName) {
  const db = database();
  try {
    const row = db.prepare("SELECT payload_json FROM cloud_assets WHERE account_id=? AND resource_type='ecs' AND asset_key=?").get(accountId, instanceId);
    if (!row) return;
    const payload = JSON.parse(row.payload_json);
    payload.InstanceName = instanceName;
    db.prepare("UPDATE cloud_assets SET payload_json=? WHERE account_id=? AND resource_type='ecs' AND asset_key=?").run(JSON.stringify(payload), accountId, instanceId);
  } finally { db.close(); }
}
function accounts(keyword = "", includeSecret = false) {
  const db = database();
  const value = String(keyword || "").trim();
  const rows = db
    .prepare(
      `SELECT id,account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at
    FROM cloud_accounts WHERE ? = '' OR account_name LIKE ? OR access_key_id LIKE ? OR COALESCE(group_name,'') LIKE ? ORDER BY sort_order ASC, updated_at DESC`,
    )
    .all(value, `%${value}%`, `%${value}%`, `%${value}%`);
  db.close();
  return rows.map((row) => {
    const result = {
      id: row.id,
      account_name: row.account_name,
      cloud_type: row.cloud_type,
      group_name: row.group_name,
      access_key_id: row.access_key_id,
      credential_meta: row.credential_meta,
      region_id: row.region_id,
      sort_order: row.sort_order ?? 0,
      enabled: Boolean(row.enabled),
      remark: row.remark,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (includeSecret)
      result.access_key_secret = decryptSecret(row.secret_ciphertext);
    return result;
  });
}
function saveAccount(input) {
  if (!input || !String(input.account_name || "").trim() || !String(input.access_key_id || "").trim())
    throw new Error("账号名称和密钥 ID 不能为空");
  const allowedCloudTypes = new Set(["aliyun", "vultr", "tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud", "jdcloud", "qingcloud", "ksyun", "qiniu", "aws", "azure", "gcp", "other"]);
  const cloudType = allowedCloudTypes.has(input.cloud_type) ? input.cloud_type : "other";
  if (cloudType === "oracle") oracleMeta({ credential_meta: input.credential_meta });
  if (cloudType === "azure") azureMeta({ credential_meta: input.credential_meta });
  if (cloudType === "gcp") gcpMeta({ credential_meta: input.credential_meta });
  const accountId = Number(input.id);
  const isUpdate = Number.isInteger(accountId) && accountId > 0;
  const db = database();
  try {
    const old = isUpdate
      ? db.prepare("SELECT secret_ciphertext,credential_meta FROM cloud_accounts WHERE id=?").get(accountId)
      : null;
    if (isUpdate && !old) throw new Error("云账号不存在");
    const newSecret = cloudType === "oracle"
      ? serializeOciPrivateKey(input.access_key_secret)
      : String(input.access_key_secret || "").trim();
    const secret = newSecret ? encryptSecret(newSecret) : old?.secret_ciphertext;
    if (!secret) throw new Error("首次添加必须填写密钥 Secret");
    const now = Date.now();
    const values = [
      String(input.account_name).trim(), cloudType, input.group_name || null,
      String(input.access_key_id).trim(), secret, ["oracle", "azure", "gcp"].includes(cloudType) ? String(input.credential_meta || old?.credential_meta || "").trim() || null : null, input.region_id || null,
      Math.max(0, Number(input.sort_order) || 0), input.enabled === false ? 0 : 1,
      input.remark || null, now,
    ];
    let id = accountId;
    if (isUpdate) {
      db.prepare("UPDATE cloud_accounts SET account_name=?,cloud_type=?,group_name=?,access_key_id=?,secret_ciphertext=?,credential_meta=?,region_id=?,sort_order=?,enabled=?,remark=?,updated_at=? WHERE id=?")
        .run(...values, id);
    } else {
      db.prepare("INSERT INTO cloud_accounts(account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(...values, now);
      id = Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);
    }
    const row = db.prepare("SELECT id,account_name,cloud_type,group_name,access_key_id,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at FROM cloud_accounts WHERE id=?").get(id);
    return { ...row, enabled: Boolean(row.enabled) };
  } finally {
    db.close();
  }
}
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) reject(new Error("请求过大"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (req.method === "GET" && url.pathname === "/api/accounts")
      return send(
        res,
        200,
        accounts(url.searchParams.get("keyword") || "", false),
      );
    if (req.method === "POST" && url.pathname === "/api/accounts") {
      try {
        return send(res, 200, saveAccount(JSON.parse(await readBody(req))));
      } catch (error) {
        return send(res, 400, { error: error.message || "保存账号失败" });
      }
    }
    if (req.method === "DELETE" && url.pathname === "/api/accounts") {
      const id = Number(url.searchParams.get("id"));
      if (!Number.isInteger(id) || id <= 0) return send(res, 400, { error: "账号 ID 无效" });
      const db = database();
      try {
        const result = db.prepare("DELETE FROM cloud_accounts WHERE id=?").run(id);
        if (!result.changes) return send(res, 404, { error: "云账号不存在" });
        return send(res, 200, { ok: true });
      } finally { db.close(); }
    }
    if (req.method === "GET" && url.pathname === "/api/account-secret") {
      const row = database().prepare("SELECT secret_ciphertext FROM cloud_accounts WHERE id=?").get(Number(url.searchParams.get("id")));
      if (!row) return send(res, 404, { error: "账号不存在" });
      return send(res, 200, decryptSecret(row.secret_ciphertext));
    }
    if (req.method === "GET" && url.pathname === "/api/local-assets")
      return send(res, 200, localAssets(url.searchParams.has("account_id") ? Number(url.searchParams.get("account_id")) : null, url.searchParams.get("resource_type") || null));
    if (req.method === "GET" && url.pathname === "/api/api-logs") {
      const rows = database().prepare("SELECT l.id,l.account_id,a.account_name,l.endpoint,l.action,l.request_params,l.response_params,l.status,l.message,l.created_at FROM api_logs l LEFT JOIN cloud_accounts a ON a.id=l.account_id ORDER BY l.created_at DESC LIMIT 500").all();
      return send(res, 200, rows);
    }
    if (req.method === "DELETE" && url.pathname === "/api/api-logs") {
      const result = database().prepare("DELETE FROM api_logs").run();
      return send(res, 200, { deleted: Number(result.changes || 0) });
    }
    if (req.method === "DELETE" && url.pathname === "/api/operation-logs") {
      const result = database().prepare("DELETE FROM operation_logs").run();
      return send(res, 200, { deleted: Number(result.changes || 0) });
    }
    if (req.method === "POST" && url.pathname === "/api/sync-assets") {
      const payload = JSON.parse(await readBody(req));
      return send(res, 200, await syncCloudAssets(Number(payload.account_id), Array.isArray(payload.resource_types) ? payload.resource_types : []));
    }
    if (req.method === "POST" && url.pathname === "/api/verify-account") {
      try {
        const payload = JSON.parse(await readBody(req));
        const id = Number(payload.account_id);
        if (!Number.isInteger(id) || id <= 0) return send(res, 400, { error: "账号 ID 无效" });
        const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
        if (!account) return send(res, 404, { error: "云账号不存在" });
        if (account.cloud_type === "vultr") return send(res, 200, await verifyVultrAccount(id));
        if (account.cloud_type === "ctyun") return send(res, 200, await verifyCtyunAccount(id));
        if (account.cloud_type === "huawei") return send(res, 200, await verifyHuaweiAccount(id));
        if (account.cloud_type === "baidu") return send(res, 200, await verifyBaiduAccount(id));
        if (account.cloud_type === "ucloud") return send(res, 200, await verifyUcloudAccount(id));
        if (account.cloud_type === "qiniu") return send(res, 200, await verifyQiniuAccount(id));
        if (account.cloud_type === "aws") return send(res, 200, await verifyAwsAccount(id));
        if (account.cloud_type === "azure") return send(res, 200, await verifyAzureAccount(id));
        if (account.cloud_type === "gcp") return send(res, 200, await verifyGcpAccount(id));
        if (account.cloud_type === "jdcloud") return send(res, 200, await verifyJdcloudAccount(id));
        if (account.cloud_type === "qingcloud") return send(res, 200, await verifyQingcloudAccount(id));
        if (account.cloud_type === "ksyun") return send(res, 200, await verifyKsyunAccount(id));
        return send(res, 400, { error: "当前云类型的账号验证尚未接入" });
      } catch (error) { return send(res, 400, { error: error.message || "天翼云账号验证失败" }); }
    }
    if (req.method === "GET" && url.pathname === "/api/export") {
      const selectedIds = new Set(
        url.searchParams
          .getAll("id")
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0),
      );
      return send(res, 200, {
        format: "cloudhub-tools-account-export",
        version: 2,
        encryption: "plaintext",
        secret_exported: true,
        exported_at: new Date().toISOString(),
        accounts: accounts("", true).filter((account) => !selectedIds.size || selectedIds.has(account.id)),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/import") {
      const payload = JSON.parse(await readBody(req));
      const incoming = Array.isArray(payload) ? payload : payload.accounts;
      if (!Array.isArray(incoming))
        return send(res, 400, { error: "文件格式无效，需要 accounts 数组" });
      if (!incoming.length) return send(res, 400, { error: "导入文件中没有云账号" });
      const invalidIndex = incoming.findIndex((item) => !item?.account_name || !item?.access_key_id || !item?.access_key_secret);
      if (invalidIndex >= 0) return send(res, 400, { error: `第 ${invalidIndex + 1} 条账号缺少完整密钥信息` });
      const db = database();
      const now = Date.now();
      let imported = 0;
      const find = db.prepare(
        "SELECT id FROM cloud_accounts WHERE access_key_id=?",
      );
      const update = db.prepare(
        "UPDATE cloud_accounts SET account_name=?,cloud_type=?,group_name=?,secret_ciphertext=?,credential_meta=?,region_id=?,sort_order=?,enabled=?,remark=?,updated_at=? WHERE id=?",
      );
      const insert = db.prepare(
        "INSERT INTO cloud_accounts(account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const item of incoming) {
        const secret = encryptSecret(item.access_key_secret);
        const existing = find.get(item.access_key_id);
        if (existing)
          update.run(
            item.account_name,
            item.cloud_type || "aliyun",
            item.group_name || null,
            secret,
            ["oracle", "azure", "gcp"].includes(item.cloud_type) ? item.credential_meta || null : null,
            item.region_id || null,
            Math.max(0, Number(item.sort_order) || 0),
            item.enabled === false ? 0 : 1,
            item.remark || null,
            now,
            existing.id,
          );
        else
          insert.run(
            item.account_name,
            item.cloud_type || "aliyun",
            item.group_name || null,
            item.access_key_id,
            secret,
            ["oracle", "azure", "gcp"].includes(item.cloud_type) ? item.credential_meta || null : null,
            item.region_id || null,
            Math.max(0, Number(item.sort_order) || 0),
            item.enabled === false ? 0 : 1,
            item.remark || null,
            now,
            now,
          );
        imported++;
      }
      db.close();
      return send(res, 200, { imported });
    }
    if (req.method === "GET" && url.pathname === "/api/dns-records") {
      const type = url.searchParams.get("type") || "";
      const keyword = url.searchParams.get("keyword") || "";
      const page = url.searchParams.get("page") || "1";
      const pageSize = url.searchParams.get("pageSize") || "20";
      const id = Number(url.searchParams.get("id"));
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type === "tencent") {
        const limit = Math.min(100, Math.max(1, Number(pageSize) || 20));
        const data = await tencentRequest(id, "dnspod", "2021-03-23", "DescribeRecordList", {
          Domain: url.searchParams.get("domain") || "",
          Offset: Math.max(0, (Number(page) - 1) * limit),
          Limit: limit,
          ...(type ? { RecordType: type } : {}),
          ...(keyword ? { Keyword: keyword } : {}),
        });
        const items = arr(data, ["RecordList"]).map((item) => ({
          ...item,
          RecordId: item.RecordId,
          RR: item.Name || "@",
          Type: item.Type,
          Value: item.Value,
          TTL: item.TTL,
          Priority: item.MX || item.Priority,
          Line: item.Line || "默认",
          Status: item.Status,
        }));
        return send(res, 200, { items, total: tencentNumber(data.RecordCountInfo?.TotalCount || data.TotalCount) });
      }
      if (account.cloud_type === "ctyun") {
        const region = String(database().prepare("SELECT region_id FROM cloud_accounts WHERE id=?").get(id)?.region_id || "cn-huabei-9");
        const zones = await ctyunResources(id, "domain");
        const zone = zones.items.find((item) => String(item.DomainName || "").toLowerCase() === String(url.searchParams.get("domain") || "").toLowerCase());
        if (!zone?.ZoneId) return send(res, 200, { items: [], total: 0 });
        const data = await ctyunRequest(id, "ctvpc-global.ctapi.ctyun.cn", "GET", "/v4/private-zone-record/list", null, {
          regionID: String(zone._region_id || region), zoneID: String(zone.ZoneId), pageNo: page, pageSize,
          ...(keyword ? { zoneRecordName: keyword } : {}),
        });
        const items = arr(data, ["zoneRecords"]).filter((item) => !type || String(item.type || "").toUpperCase() === type.toUpperCase()).map((item) => ({
          ...item, RecordId: item.zoneRecordID || "", RR: item.name || "@", Type: item.type || "", Value: Array.isArray(item.value) ? item.value.join(", ") : item.value || "", TTL: item.TTL || 0, Priority: "", Line: "默认", Status: "ENABLE",
        }));
        return send(res, 200, { items, total: Number(data.totalCount || items.length) });
      }
      const data = await rpc(
        id,
        "alidns.aliyuncs.com",
        "2015-01-09",
        "DescribeDomainRecords",
        {
          DomainName: url.searchParams.get("domain") || "",
          PageNumber: page,
          PageSize: pageSize,
          ...(type ? { TypeKeyWord: type } : {}),
          ...(keyword ? { RRKeyWord: keyword } : {}),
        },
      );
      return send(res, 200, {
        items: arr(data, ["DomainRecords", "Record"]),
        total: data.TotalCount || 0,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/dns-records") {
      const payload = JSON.parse(await readBody(req));
      const params = {
        DomainName: payload.domain,
        RR: payload.rr,
        Type: payload.recordType,
        Value: payload.value,
        TTL: payload.ttl || 600,
        ...(payload.line && payload.line !== "default" ? { Line: payload.line } : {}),
      };
      if (payload.recordType === "MX" && payload.priority !== undefined) {
        params.Priority = payload.priority;
      }
      const data = await rpc(
        Number(payload.id),
        "alidns.aliyuncs.com",
        "2015-01-09",
        "AddDomainRecord",
        params,
      );
      return send(res, 200, data);
    }
    if (req.method === "PUT" && url.pathname === "/api/dns-records") {
      const payload = JSON.parse(await readBody(req));
      const params = {
        RecordId: payload.recordId,
        RR: payload.rr,
        Type: payload.recordType,
        Value: payload.value,
        TTL: payload.ttl,
        Line: payload.line,
      };
      if (payload.recordType === "MX" && payload.priority !== undefined) {
        params.Priority = payload.priority;
      }
      const data = await rpc(
        Number(payload.id),
        "alidns.aliyuncs.com",
        "2015-01-09",
        "UpdateDomainRecord",
        params,
      );
      return send(res, 200, data);
    }
    if (req.method === "PATCH" && url.pathname === "/api/dns-records") {
      const payload = JSON.parse(await readBody(req));
      const data = await rpc(
        Number(payload.id),
        "alidns.aliyuncs.com",
        "2015-01-09",
        "SetDomainRecordStatus",
        {
          RecordId: payload.recordId,
          Status: payload.status,
        },
      );
      return send(res, 200, data);
    }
    if (req.method === "DELETE" && url.pathname === "/api/dns-records") {
      const payload = JSON.parse(await readBody(req));
      const data = await rpc(
        Number(payload.id),
        "alidns.aliyuncs.com",
        "2015-01-09",
        "DeleteDomainRecord",
        { RecordId: payload.recordId },
      );
      return send(res, 200, data);
    }
    if (req.method === "GET" && url.pathname === "/api/rds-databases") {
      const id = Number(url.searchParams.get("id"));
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type === "tencent") {
        const data = await tencentRequest(id, "cdb", "2017-03-20", "DescribeDatabases", { InstanceId: url.searchParams.get("instance") || "" }, url.searchParams.get("region") || "");
        return send(res, 200, arr(data, ["Items"]).map((item) => ({ ...item, DBName: item.DatabaseName || item.DBName || "" })));
      }
      const data = await rpc(
        id,
        "rds.aliyuncs.com",
        "2014-08-15",
        "DescribeDatabases",
        {
          RegionId: url.searchParams.get("region") || "",
          DBInstanceId: url.searchParams.get("instance") || "",
        },
      );
      return send(res, 200, arr(data, ["Databases", "Database"]));
    }
    if (req.method === "GET" && url.pathname === "/api/rds-accounts") {
      const id = Number(url.searchParams.get("id"));
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type === "tencent") {
        const data = await tencentRequest(id, "cdb", "2017-03-20", "DescribeAccounts", { InstanceId: url.searchParams.get("instance") || "" }, url.searchParams.get("region") || "");
        return send(res, 200, arr(data, ["Items"]).map((item) => ({
          ...item,
          AccountName: item.AccountName || item.UserName || "",
          AccountType: item.AccountType || "Normal",
          AccountStatus: item.Status || "Available",
          AccountDescription: item.Description || "",
        })));
      }
      const data = await rpc(
        id,
        "rds.aliyuncs.com",
        "2014-08-15",
        "DescribeAccounts",
        {
          RegionId: url.searchParams.get("region") || "",
          DBInstanceId: url.searchParams.get("instance") || "",
        },
      );
      return send(res, 200, arr(data, ["Accounts", "DBInstanceAccount"]));
    }
    if (req.method === "GET" && url.pathname === "/api/redis-accounts") {
      const id = Number(url.searchParams.get("id"));
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type === "tencent") {
        const data = await tencentRequest(id, "redis", "2018-04-12", "DescribeInstanceAccount", { InstanceId: url.searchParams.get("instance") || "" }, url.searchParams.get("region") || "");
        return send(res, 200, arr(data, ["Accounts"]).map((item) => ({
          ...item,
          AccountName: item.AccountName || item.UserName || "",
          AccountType: item.AccountType || "Normal",
          AccountStatus: item.Status || "Available",
          AccountDescription: item.Description || "",
        })));
      }
      const data = await rpc(
        id,
        "r-kvstore.aliyuncs.com",
        "2015-01-01",
        "DescribeAccounts",
        {
          RegionId: url.searchParams.get("region") || "",
          InstanceId: url.searchParams.get("instance") || "",
        },
      );
      return send(res, 200, arr(data, ["Accounts", "Account"]));
    }
    if (req.method === "GET" && url.pathname === "/api/oss-objects") {
      return send(
        res,
        200,
        await ossObjects(
          Number(url.searchParams.get("id")),
          url.searchParams.get("bucket") || "",
          url.searchParams.get("location") || "",
          {
            prefix: url.searchParams.get("prefix") || "",
            marker: url.searchParams.get("marker") || "",
          },
        ),
      );
    }
    if (req.method === "GET" && url.pathname === "/api/instance-disks") {
      try {
        const id = Number(url.searchParams.get("id"));
        const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
        if (!account) return send(res, 404, { error: "云账号不存在" });
        const item = account.cloud_type === "oracle"
          ? await oracleInstanceDisks(id, url.searchParams.get("region") || "", url.searchParams.get("instance") || "", url.searchParams.get("compartment") || "")
          : account.cloud_type === "tencent"
          ? arr(await tencentRequest(id, "cbs", "2017-03-12", "DescribeDisks", { InstanceId: url.searchParams.get("instance") || "" }, url.searchParams.get("region") || ""), ["DiskSet"]).map((disk) => ({ ...disk, DiskId: disk.DiskId, DiskName: disk.DiskName || disk.DiskId, Category: disk.DiskType, Size: disk.DiskSize, Status: disk.DiskState }))
          : arr(await rpc(id, `ecs.${url.searchParams.get("region")}.aliyuncs.com`, "2014-05-26", "DescribeDisks", { RegionId: url.searchParams.get("region") || "", InstanceId: url.searchParams.get("instance") || "" }), ["Disks", "Disk"]);
        return send(res, 200, item);
      } catch (error) { return send(res, 200, []); }
    }
    if (req.method === "POST" && (url.pathname === "/api/swas-action" || url.pathname === "/api/lighthouse-action")) {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "");
      const instanceId = String(payload.instanceId || "");
      const action = String(payload.action || "");
      if (!region || !instanceId) return send(res, 400, { error: "缺少轻量服务器地域或实例 ID" });
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      const actionNames = account.cloud_type === "tencent"
        ? { start: "StartInstances", reboot: "RebootInstances", stop: "StopInstances" }
        : account.cloud_type === "aliyun"
          ? { start: "StartInstance", reboot: "RebootInstance", stop: "StopInstance" }
          : {};
      const actionName = actionNames[action];
      if (!actionName) return send(res, 400, { error: "不支持的轻量服务器操作" });
      if (account.cloud_type === "aliyun") {
        const forceReboot = action === "reboot" && Boolean(payload.forceStop);
        return send(res, 200, await rpc(id, `swas.${region}.aliyuncs.com`, "2020-06-01", forceReboot ? "RebootInstances" : actionName, forceReboot
          ? { RegionId: region, InstanceIds: JSON.stringify([instanceId]), ForceReboot: "true" }
          : { RegionId: region, InstanceId: instanceId }));
      }
      const request = { InstanceIds: [instanceId] };
      if (action === "reboot" && payload.forceStop) request.ForceStop = true;
      return send(res, 200, await tencentRequest(id, "lighthouse", "2020-03-24", actionName, request, region));
    }
    if (req.method === "POST" && url.pathname === "/api/cvm-action") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "");
      const instanceId = String(payload.instanceId || "");
      if (!region || !instanceId) return send(res, 400, { error: "缺少服务器地域或实例 ID" });
      const action = String(payload.action || "reboot");
      const actionNames = { start: "StartInstances", stop: "StopInstances", reboot: "RebootInstances" };
      const actionName = actionNames[action];
      if (!actionName) return send(res, 400, { error: "不支持的腾讯云服务器操作" });
      const request = { InstanceIds: [instanceId] };
      if (payload.forceStop && (action === "stop" || action === "reboot")) request.ForceStop = true;
      return send(res, 200, await tencentRequest(id, "cvm", "2017-03-12", actionName, request, region));
    }
    if (req.method === "POST" && url.pathname === "/api/ecs-action") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "");
      const instanceId = String(payload.instanceId || "");
      const action = String(payload.action || "");
      if (!region || !instanceId) return send(res, 400, { error: "缺少服务器地域或实例 ID" });
      const actionNames = { start: "StartInstance", stop: "StopInstance", reboot: "RebootInstance" };
      const actionName = actionNames[action];
      if (!actionName) return send(res, 400, { error: "不支持的阿里云服务器操作" });
      return send(res, 200, await rpc(id, `ecs.${region}.aliyuncs.com`, "2014-05-26", actionName, { RegionId: region, InstanceId: instanceId }));
    }
    if (req.method === "POST" && url.pathname === "/api/vultr-instance-action") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const instanceId = String(payload.instanceId || "").trim();
      const action = String(payload.action || "").trim();
      if (!instanceId) return send(res, 400, { error: "缺少 Vultr 实例 ID" });
      if (!new Set(["start", "stop", "reboot"]).has(action)) return send(res, 400, { error: "不支持的 Vultr 服务器操作" });
      const endpoint = action === "stop" ? "halt" : action;
      return send(res, 200, await vultrRequest(id, `instances/${encodeURIComponent(instanceId)}/${endpoint}`, {}, { method: "POST" }));
    }
    if (req.method === "POST" && url.pathname === "/api/vultr-instance-manage") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const instanceId = String(payload.instanceId || "").trim();
      const action = String(payload.action || "").trim();
      const value = String(payload.value || "").trim();
      if (!instanceId) return send(res, 400, { error: "缺少 Vultr 实例 ID" });
      const updatePath = `instances/${encodeURIComponent(instanceId)}`;
      const actions = {
        snapshot: { path: "snapshots", method: "POST", body: { instance_id: instanceId, description: value } },
        label: value ? { path: updatePath, method: "PATCH", body: { label: value } } : null,
        tags: { path: updatePath, method: "PATCH", body: { tags: value.split(",").map((tag) => tag.trim()).filter(Boolean) } },
        enable_backups: { path: updatePath, method: "PATCH", body: { backups: "enabled" } },
        disable_backups: { path: updatePath, method: "PATCH", body: { backups: "disabled" } },
        enable_ddos: { path: updatePath, method: "PATCH", body: { ddos_protection: true } },
        disable_ddos: { path: updatePath, method: "PATCH", body: { ddos_protection: false } },
        enable_ipv6: { path: updatePath, method: "PATCH", body: { enable_ipv6: true } },
        firewall: value ? { path: updatePath, method: "PATCH", body: { firewall_group_id: value } } : null,
      };
      const request = actions[action];
      if (!request) return send(res, 400, { error: "不支持的 Vultr 实例管理操作，或缺少必要参数" });
      return send(res, 200, await vultrRequest(id, request.path, {}, { method: request.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body) }));
    }
    if (req.method === "POST" && url.pathname === "/api/bcc-action") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "");
      const instanceId = String(payload.instanceId || "");
      const action = String(payload.action || "");
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type !== "baidu") return send(res, 400, { error: "当前账号不是百度智能云账号" });
      return send(res, 200, await baiduBccAction(id, region, instanceId, action, Boolean(payload.forceStop)));
    }
    if (req.method === "POST" && url.pathname === "/api/oracle-instance-action") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "");
      const instanceId = String(payload.instanceId || "");
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type !== "oracle") return send(res, 400, { error: "当前账号不是 Oracle Cloud 账号" });
      return send(res, 200, await oracleInstanceAction(id, region, instanceId, String(payload.action || "")));
    }
    if (req.method === "POST" && url.pathname === "/api/server-name") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "").trim();
      const instanceId = String(payload.instanceId || "").trim();
      const instanceName = String(payload.instanceName || "").trim();
      if (!region || !instanceId) return send(res, 400, { error: "缺少服务器地域或实例 ID" });
      if (!instanceName) return send(res, 400, { error: "服务器名称不能为空" });
      if (Buffer.byteLength(instanceName, "utf8") > 128) return send(res, 400, { error: "服务器名称不能超过 128 个字节" });
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      const data = account.cloud_type === "tencent"
        ? await tencentRequest(id, "cvm", "2017-03-12", "ModifyInstancesAttribute", { InstanceIds: [instanceId], InstanceName: instanceName }, region)
        : await rpc(id, `ecs.${region}.aliyuncs.com`, "2014-05-26", "ModifyInstanceAttribute", { RegionId: region, InstanceId: instanceId, InstanceName: instanceName });
      updateCachedServerName(id, instanceId, instanceName);
      return send(res, 200, data);
    }
    if (req.method === "GET" && url.pathname === "/api/oss-acl") {
      return send(res, 200, {
        acl: await ossAcl(
          Number(url.searchParams.get("id")),
          url.searchParams.get("bucket") || "",
          url.searchParams.get("location") || "",
        ),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/oss-detail") {
      return send(res, 200, await ossDetail(
        Number(url.searchParams.get("id")),
        url.searchParams.get("bucket") || "",
        url.searchParams.get("location") || "",
      ));
    }
    if (req.method === "POST" && url.pathname === "/api/oss-public-read") {
      await ossSetPublicRead(Number(url.searchParams.get("id")), url.searchParams.get("bucket") || "", url.searchParams.get("location") || "");
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/oss-cors") {
      await ossSetCors(Number(url.searchParams.get("id")), url.searchParams.get("bucket") || "", url.searchParams.get("location") || "", url.searchParams.get("origins") || "*");
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/oss-cname-token") {
      return send(res, 200, await ossCnameMutation(Number(url.searchParams.get("id")), url.searchParams.get("bucket") || "", url.searchParams.get("location") || "", "token", url.searchParams.get("domain") || ""));
    }
    if (req.method === "POST" && url.pathname === "/api/oss-cname") {
      return send(res, 200, await ossCnameMutation(Number(url.searchParams.get("id")), url.searchParams.get("bucket") || "", url.searchParams.get("location") || "", "bind", url.searchParams.get("domain") || ""));
    }
    if (req.method === "DELETE" && url.pathname === "/api/oss-cname") {
      return send(res, 200, await ossCnameMutation(Number(url.searchParams.get("id")), url.searchParams.get("bucket") || "", url.searchParams.get("location") || "", "delete", url.searchParams.get("domain") || ""));
    }
    if (req.method === "GET" && url.pathname === "/api/cloud-resources") {
      const type = url.searchParams.get("type") || "domain";
      const id = Number(url.searchParams.get("id"));
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      return send(res, 200, await cloudResources(id, type));
    }
    if (req.method === "GET" && url.pathname === "/api/esa-overview") {
      return send(res, 200, await esaOverview(
        Number(url.searchParams.get("id")),
        url.searchParams.get("range") || "today",
        url.searchParams.get("site_id") || "",
      ));
    }
    if (req.method === "GET" && url.pathname === "/api/cloud-summary") {
      const id = Number(url.searchParams.get("id"));
      const accountRow = database().prepare("SELECT access_key_id,cloud_type FROM cloud_accounts WHERE id=?").get(id);
      if (!accountRow) return send(res, 404, { error: "云账号不存在" });
      if (accountRow.cloud_type === "tencent") {
        const today = new Date().toISOString().slice(0, 10);
        const monthStart = `${today.slice(0, 8)}01`;
        const [cvmResult, domainResult, swasResult, rdsResult, redisResult, ossResult, esaResult, identityResult, balanceResult, billResult] = await Promise.allSettled([
          tencentResources(id, "ecs"),
          tencentResources(id, "domain"),
          tencentResources(id, "swas"),
          tencentResources(id, "rds"),
          tencentResources(id, "redis"),
          tencentResources(id, "oss"),
          tencentResources(id, "esa"),
          tencentRequest(id, "cam", "2019-01-16", "GetUserAppId"),
          tencentRequest(id, "billing", "2018-07-09", "DescribeAccountBalance"),
          tencentRequest(id, "billing", "2018-07-09", "DescribeBillSummaryByPayMode", { BeginTime: monthStart, EndTime: today }),
        ]);
        const cvm = cvmResult.status === "fulfilled" ? cvmResult.value.items : [];
        const domains = domainResult.status === "fulfilled" ? domainResult.value.items : [];
        const swas = swasResult.status === "fulfilled" ? swasResult.value.items : [];
        const rds = rdsResult.status === "fulfilled" ? rdsResult.value.items : [];
        const redis = redisResult.status === "fulfilled" ? redisResult.value.items : [];
        const oss = ossResult.status === "fulfilled" ? ossResult.value.items : [];
        const esa = esaResult.status === "fulfilled" ? esaResult.value.items : [];
        const identity = identityResult.status === "fulfilled" ? identityResult.value : {};
        const balance = balanceResult.status === "fulfilled" ? balanceResult.value : {};
        const bill = billResult.status === "fulfilled" ? billResult.value : {};
        const overview = bill.SummaryOverview || bill.SummarySet?.[0] || {};
        const monthlyTotal = tencentNumber(overview.RealTotalCost || overview.TotalCost || overview.CashPayAmount);
        return send(res, 200, {
          account_id: identity.AppId || identity.UserAppId || accountRow.access_key_id,
          account_type: "腾讯云账号",
          available_amount: tencentNumber(balance.Balance || balance.RealBalance) / 100,
          available_cash_amount: tencentNumber(balance.CashAccountBalance) / 100,
          credit_amount: tencentNumber(balance.PresentAccountBalance || balance.IncentiveAccountBalance || balance.VoucherBalance) / 100,
          month_consume: monthlyTotal,
          month_bill: monthlyTotal,
          ecs_count: cvm.length,
          domain_count: domains.length,
          dns_record_count: domains.reduce((sum, item) => sum + tencentNumber(item.RecordCount), 0),
          oss_count: oss.length, rds_count: rds.length, redis_count: redis.length, swas_count: swas.length, esa_count: esa.length,
        });
      }
      if (accountRow.cloud_type === "volcengine") {
        const [ecsResult, domainResult, swasResult, ossResult, rdsResult, redisResult, esaResult] = await Promise.allSettled([
          volcResources(id, "ecs"),
          volcResources(id, "domain"),
          volcResources(id, "swas"),
          volcResources(id, "oss"),
          volcResources(id, "rds"),
          volcResources(id, "redis"),
          volcResources(id, "esa"),
        ]);
        const itemCount = (result) => result.status === "fulfilled" ? result.value.items.length : 0;
        return send(res, 200, {
          account_id: accountRow.access_key_id,
          account_type: "火山引擎账号",
          available_amount: 0,
          available_cash_amount: 0,
          credit_amount: 0,
          month_consume: 0,
          month_bill: 0,
          ecs_count: itemCount(ecsResult),
          domain_count: itemCount(domainResult),
          dns_record_count: 0,
          oss_count: itemCount(ossResult),
          rds_count: itemCount(rdsResult),
          redis_count: itemCount(redisResult),
          swas_count: itemCount(swasResult),
          esa_count: itemCount(esaResult),
        });
      }
      if (accountRow.cloud_type === "ctyun") {
        const [ecs, domains, rds, redis, oss] = await Promise.all(["ecs", "domain", "rds", "redis", "oss"].map((type) => ctyunResources(id, type)));
        return send(res, 200, {
          account_id: accountRow.access_key_id,
          account_type: "天翼云账号",
          available_amount: 0,
          available_cash_amount: 0,
          credit_amount: 0,
          month_consume: 0,
          month_bill: 0,
          ecs_count: ecs.items.length,
          domain_count: domains.items.length,
          dns_record_count: domains.items.reduce((sum, item) => sum + Number(item.RecordCount || 0), 0),
          oss_count: oss.items.length,
          rds_count: rds.items.length,
          redis_count: redis.items.length,
          swas_count: 0,
          esa_count: 0,
        });
      }
      const accountIdText = accountRow?.access_key_id || "-";
      const [domainData, accountData, balanceData, billData] = await Promise.allSettled([
        rpc(id, "domain.aliyuncs.com", "2018-01-29", "QueryDomainList", { PageNum: "1", PageSize: "100" }),
        rpc(id, "bss.openapi.aliyuncs.com", "2017-12-14", "QueryAccountInfo", {}),
        rpc(id, "bss.openapi.aliyuncs.com", "2017-12-14", "QueryAccountBalance", {}),
        rpc(id, "bss.openapi.aliyuncs.com", "2017-12-14", "QueryBillOverview", { BillingCycle: new Date().toISOString().slice(0, 7) }),
      ]);
      const domains = domainData.status === "fulfilled" ? arr(domainData.value, ["Data", "Domain"]) : [];
      const resourceTypes = ["ecs", "oss", "rds", "redis", "swas", "esa"];
      const results = await Promise.allSettled(resourceTypes.map((type) => cloudResources(id, type)));
      const counts = Object.fromEntries(resourceTypes.map((type, index) => [type, results[index].status === "fulfilled" ? results[index].value.items.length : 0]));
      const dnsCount = domains.reduce((sum, d) => sum + Number(d.RecordCount || 0), 0);
      const accountInfo = accountData.status === "fulfilled" ? accountData.value.Data || {} : {};
      const balanceInfo = balanceData.status === "fulfilled" ? balanceData.value.Data || {} : {};
      const billInfo = billData.status === "fulfilled" ? billData.value.Data || {} : {};
      return send(res, 200, {
        account_id: accountInfo.AccountId || accountIdText,
        account_type: accountInfo.AccountType === "1" ? "主账号" : accountInfo.AccountType === "2" ? "子账号" : "-",
        available_amount: Number(balanceInfo.AvailableAmount || 0),
        available_cash_amount: Number(balanceInfo.AvailableCashAmount || 0),
        credit_amount: Number(balanceInfo.CreditAmount || 0),
        month_consume: Number(billInfo.PretaxAmount || 0),
        month_bill: Number(billInfo.PretaxAmount || 0),
        ecs_count: counts.ecs,
        domain_count: domains.length,
        dns_record_count: dnsCount,
        oss_count: counts.oss,
        rds_count: counts.rds,
        redis_count: counts.redis,
        swas_count: counts.swas,
        esa_count: counts.esa,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/domain-logs") {
      const page = url.searchParams.get("page") || "1";
      const pageSize = url.searchParams.get("pageSize") || "20";
      const data = await rpc(
        Number(url.searchParams.get("id")),
        "alidns.aliyuncs.com",
        "2015-01-09",
        "DescribeRecordLogs",
        {
          DomainName: url.searchParams.get("domain") || "",
          PageNumber: page,
          PageSize: pageSize,
        },
      );
      return send(res, 200, {
        items: arr(data, ["RecordLogs", "RecordLog"]),
        total: data.TotalCount || 0,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/whois") {
      const data = await rpc(
        Number(url.searchParams.get("id")),
        "domain.aliyuncs.com",
        "2018-01-29",
        "QueryDomainByDomainName",
        { DomainName: url.searchParams.get("domain") || "" },
      );
      const get = (key) => data[key] ?? "-";
      return send(
        res,
        200,
        `域名信息查询结果\n=====================================\n\n域名: ${get("DomainName")}\n域名持有者: ${get("ZhRegistrantOrganization") || get("RegistrantOrganization")}\n持有者类型: ${get("RegistrantType")}\n联系人: ${get("ZhRegistrantName") || get("RegistrantName")}\n联系邮箱: ${get("Email")}\n\n注册时间: ${get("RegistrationDate")}\n到期时间: ${get("ExpirationDate")}\n注册商: 阿里云\n\n实名认证: ${get("RealNameStatus")}\n域名状态: ${get("DomainStatus")}\nDNS服务器: ${JSON.stringify(get("DnsList"))}`,
      );
    }
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    return send(res, 500, { error: String(error?.message || error) });
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`CloudHub Tools Web API: http://127.0.0.1:${port}`),
);
