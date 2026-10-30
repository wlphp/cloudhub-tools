import crypto from "node:crypto";
import os from "node:os";

export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
export const previewConfigKey = "cloud.sync.preview.config";
export const defaults = {
  id: "default", name: "默认渠道",
  method: "webdav", provider: "custom", endpoint: "", username: "", password: "",
  accessKeyId: "", secretKey: "", bucket: "", region: "us-east-1", pathStyle: true,
  remoteRoot: "cloudhub-sync", profile: "default", autoSync: false, allowInsecure: false,
  passwordProtected: false, backupPassword: "",
  tables: null,
};
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => crypto.createHmac("sha256", key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const segment = value => typeof value === "string" && value.length > 0 && value.length <= 100 && value.trim() === value && ![".", ".."].includes(value) && /^[a-zA-Z0-9_ .-]+$/.test(value);
const channelIdValid = value => typeof value === "string" && /^(?:default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(value);
export class CloudSyncError extends Error {}
function connectionFailure(error) {
  const code = error?.cause?.code;
  if (error?.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return "云存储请求超时";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "云存储域名解析失败";
  if (code === "ECONNREFUSED") return "云存储拒绝连接，请检查服务和端口";
  if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code)) return "云存储证书校验失败，请检查证书有效期与信任链";
  if (["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"].includes(code)) return "云存储连接在请求过程中中断";
  return "云同步连接失败，请检查地址、网络与证书";
}
const fail = message => { throw new CloudSyncError(message); };

function endpoint(config) {
  let url;
  try { url = new URL(config.endpoint); } catch { fail("请输入有效的服务地址"); }
  if (!url.hostname || url.username || url.password || url.search || url.hash) fail("服务地址不能包含账号、密码、查询参数或片段");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && config.allowInsecure)) fail("请使用 HTTPS；内网 HTTP 服务需明确勾选允许 HTTP");
  return url;
}

export function mergeConfig(input, saved) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("云同步配置无效");
  const config = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    if (key === "tables") { config.tables = input.tables ?? null; continue; }
    if ((key === "id" || key === "name") && input[key] === undefined) { config[key] = fallback; continue; }
    if (typeof input[key] !== typeof fallback) fail("云同步配置字段无效");
    config[key] = input[key];
  }
  if (!channelIdValid(config.id)) fail("同步渠道无效");
  if (config.tables !== null && (!Array.isArray(config.tables) || !config.tables.length || config.tables.length > 32 || config.tables.some(table => typeof table !== "string" || !/^[a-z_]+$/.test(table)))) fail("请选择有效的备份范围");
  config.name = config.name.trim();
  if (!config.name || config.name.length > 80 || /[\x00-\x1f\x7f]/.test(config.name)) fail("请填写有效的渠道名称（最多 80 个字符）");
  config.endpoint = config.endpoint.trim().replace(/\/+$/, "");
  config.remoteRoot = config.remoteRoot.trim(); config.profile = config.profile.trim();
  const sameIdentity = saved && ["method", "endpoint", "username", "accessKeyId"].every(key => config[key] === saved[key]);
  if (sameIdentity) for (const key of ["password", "secretKey"]) config[key] ||= saved[key];
  config.lastEtag = sameIdentity && ["remoteRoot", "profile", "bucket", "region", "pathStyle"].every(key => config[key] === saved[key]) ? saved.lastEtag : null;
  if (!["webdav", "s3", "oss"].includes(config.method) || !["custom", "jianguoyun", "nextcloud", "alist"].includes(config.provider)) fail("同步方式或服务商无效");
  if (config.endpoint.length > 2048) fail("服务地址过长");
  endpoint(config);
  if (config.method === "oss" && !ossEndpoint(config)) fail("请填写阿里云 OSS 区域 Endpoint，例如 https://oss-cn-beijing.aliyuncs.com");
  if (config.remoteRoot.length > 240 || !config.remoteRoot.split("/").every(segment) || !segment(config.profile)) fail("根目录和配置名仅支持英文、数字、空格、横线和下划线；目录不能包含路径跳转");
  if ([config.username, config.accessKeyId, config.region, config.bucket].some(value => value.length > 256 || /[\x00-\x1f\x7f]/.test(value))) fail("云同步配置字段无效");
  if (config.method === "webdav") {
    if (!config.username.trim() || config.username.includes(":") || !config.password || config.password.length > 4096) fail("请填写 WebDAV 账号与应用密码");
    config.secretKey = "";
  } else {
    if (!config.accessKeyId.trim() || !config.secretKey || config.secretKey.length > 4096 || !/^[a-z0-9.-]{3,256}$/.test(config.bucket) || !/^[a-zA-Z0-9-]+$/.test(config.region)) fail("请填写有效的 S3 存储桶、区域、Access Key ID 和 Secret Access Key");
    config.password = "";
  }
  // Browser debugging transfers existing packages verbatim, without changing their encryption.
  config.autoSync = false; config.passwordProtected = false; config.backupPassword = "";
  return config;
}

// One encrypted collection; legacy single-channel configuration is read in place.
export function createCloudSyncChannels({ load, persist, fetchRemote }) {
  const services = new Map();
  let busy = false;
  function configs() {
    const stored = load();
    return stored ? (Array.isArray(stored.channels) ? stored.channels : [{ ...stored, id: "default", name: "默认渠道" }]) : [];
  }
  function channel(id = "default") {
    if (!channelIdValid(id)) fail("同步渠道无效");
    if (!services.has(id)) services.set(id, createCloudSyncService({
      load: () => configs().find(config => config.id === id) ?? null,
      persist(config) {
        if (config.id !== id) fail("同步渠道不匹配");
        const all = configs(), index = all.findIndex(item => item.id === id);
        if (index < 0) {
          if (all.length >= 50) fail("同步渠道最多可添加 50 条");
          all.push(config);
        } else all[index] = config;
        persist({ channels: all });
      },
      ...(fetchRemote ? { fetchRemote } : {}),
    }));
    return services.get(id);
  }
  return {
    channel,
    list: () => configs().map(config => channel(config.id).state()),
    async run(action) {
      if (busy) fail("云同步正在执行，请稍后重试");
      busy = true;
      try { return await action(); } finally { busy = false; }
    },
    remove(id) {
      channel(id);
      const all = configs();
      if (!all.some(config => config.id === id)) fail("同步渠道不存在，请刷新列表");
      persist({ channels: all.filter(config => config.id !== id) });
      services.delete(id);
    },
  };
}

function ossEndpoint(config) {
  return ["s3", "oss"].includes(config.method) && !!config.endpoint && /(?:^|\.)oss-[a-z0-9-]+\.aliyuncs\.com$/.test(endpoint(config).hostname);
}

export function targetUrl(config, artifact = true) {
  const url = endpoint(config);
  const oss = ossEndpoint(config), hasBucket = oss && url.hostname.startsWith(`${config.bucket}.`);
  if ((oss || (config.method === "s3" && !config.pathStyle)) && !hasBucket) url.hostname = `${config.bucket}.${url.hostname}`;
  const parts = config.method === "s3" && config.pathStyle && !oss ? [config.bucket] : [];
  if (artifact) parts.push(...config.remoteRoot.split("/"), "v1", config.profile, "database.chdb");
  url.pathname = url.pathname.replace(/\/$/, "") + (parts.length ? "/" + parts.map(encode).join("/") : "");
  return url;
}

function namedUrl(config, name) {
  const url = targetUrl(config);
  url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) + encode(name);
  return url;
}
function selectedVersion(id = "database.chdb") {
  if (typeof id !== "string" || (id !== "database.chdb" && !/^backup-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.chdb$/.test(id))) fail("备份版本无效，请刷新版本列表");
  return id;
}

export function signedHeaders(config, method, url, body = Buffer.alloc(0), time = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), extraHeaders = {}) {
  if (config.method === "webdav") return { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}` };
  if (ossEndpoint(config)) {
    const date = new Date(`${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}T${time.slice(9, 11)}:${time.slice(11, 13)}:${time.slice(13, 15)}Z`).toUTCString();
    const mime = method === "PUT" ? (url.pathname.endsWith(".json") ? "application/json" : "application/octet-stream") : "";
    const resource = `/${config.bucket}${decodeURIComponent(url.pathname)}`;
    const canonicalHeaders = extraHeaders["x-oss-forbid-overwrite"] === "true" ? "x-oss-forbid-overwrite:true\n" : "";
    const signature = crypto.createHmac("sha1", config.secretKey).update(`${method}\n\n${mime}\n${date}\n${canonicalHeaders}${resource}`).digest("base64");
    return { Authorization: `OSS ${config.accessKeyId}:${signature}`, Date: date };
  }
  const date = time.slice(0, 8), digest = hash(body);
  const names = "host;x-amz-content-sha256;x-amz-date";
  const headers = `host:${url.host}\nx-amz-content-sha256:${digest}\nx-amz-date:${time}\n`;
  const uri = url.pathname.split("/").map(part => encode(decodeURIComponent(part))).join("/");
  const canonical = `${method}\n${uri}\n\n${headers}\n${names}\n${digest}`;
  const scope = `${date}/${config.region}/s3/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretKey}`, date), config.region), "s3"), "aws4_request");
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${hmac(signingKey, `AWS4-HMAC-SHA256\n${time}\n${scope}\n${hash(canonical)}`).toString("hex")}`,
    "x-amz-date": time, "x-amz-content-sha256": digest,
  };
}

function check(response) {
  if (response.ok) return;
  const messages = { 401: "认证失败或权限不足，请检查账号、应用密码或存储策略", 403: "认证失败或权限不足，请检查账号、应用密码或存储策略", 404: "远端目录、存储桶或备份不存在", 409: "远端目录冲突，请检查远程根目录", 412: "云端备份已发生变化，请先下载检查后再上传", 429: "远端请求过于频繁，请稍后重试" };
  const message = messages[response.status] || (response.status >= 300 && response.status < 400 ? "服务器要求重定向，请填写最终服务地址（不会转发凭据）" : "云同步请求失败，请检查服务状态与配置");
  fail(`${message}（HTTP ${response.status}）`);
}

function ossError(status, stage, bytes) {
  // Only fixed codes may leave the transport; raw OSS XML can contain signing material.
  const hints = new Map([
    ["SignatureDoesNotMatch", "请求签名不匹配"], ["InvalidAccessKeyId", "AccessKey ID 无效或已停用"],
    ["AccessDenied", "存储桶策略或账号权限拒绝访问"], ["RequestTimeTooSkewed", "本机时间与云端偏差过大，请同步系统时间"],
    ["InvalidArgument", "OSS 不接受当前请求参数"], ["InvalidRequest", "OSS 不接受当前请求格式或签名版本"],
    ["SignatureVersionNotSupported", "存储桶不支持当前签名版本"], ["UnsupportedSignatureVersion", "存储桶不支持当前签名版本"],
    ["AuthorizationHeaderMalformed", "认证头或区域配置不正确"], ["PermanentRedirect", "Endpoint 与存储桶所在区域不一致"],
    ["NoSuchBucket", "存储桶不存在，请核对 Bucket 和 Endpoint"], ["InvalidBucketName", "存储桶名称无效"],
    ["MissingContentLength", "请求缺少有效的文件长度"], ["NotImplemented", "OSS 不支持当前请求头或传输方式"],
    ["FileAlreadyExists", "同名备份已存在，已阻止覆盖"],
    ["InvalidDigest", "请求内容校验值无效"], ["BadDigest", "请求内容与校验值不一致"], ["RequestTimeout", "OSS 接收请求超时"],
  ]);
  const candidate = /<Code>([\s\S]*?)<\/Code>/.exec(bytes.toString("utf8"))?.[1];
  const code = hints.has(candidate) ? candidate : "Unknown";
  return `阿里云 OSS ${stage}失败：${hints.get(code) || "未识别的 OSS 错误，请检查 Endpoint、签名与请求参数"}（HTTP ${status}，OSS ${code}）`;
}
function etag(response) {
  const value = response.headers.get("etag");
  return value && value.length <= 256 && /^"[^\x00-\x1f\x7f]*"$/.test(value) ? value : null;
}

export async function readLimited(source, maxBytes = MAX_BACKUP_BYTES, onProgress = () => {}) {
  const chunks = []; let total = 0;
  for await (const chunk of source) {
    const bytes = Buffer.from(chunk); total += bytes.length;
    if (total > maxBytes) fail("备份超过 256 MB 限制");
    chunks.push(bytes);
    onProgress(total);
  }
  return Buffer.concat(chunks);
}

export function validatePackage(bytes) {
  if (bytes.length > MAX_BACKUP_BYTES || bytes.length < 56) fail("请选择有效的 CloudHub .chdb 备份（最大 256 MB）");
  const magic = bytes.subarray(0, 8).toString();
  if (magic === "CHDBENC2") return; // Password verification is performed by the native restore flow.
  if (magic !== "CHDBMIG1") fail("请选择 CloudHub .chdb 备份文件");
  const length = bytes.readUInt32LE(8);
  if (!length || length > 1024 * 1024 || 24 + length > bytes.length) fail("备份信息长度无效");
  let manifest;
  try { manifest = JSON.parse(bytes.subarray(12, 12 + length).toString("utf8")); } catch { fail("备份信息无效"); }
  const size = Number(bytes.readBigUInt64LE(12 + length));
  const keySize = bytes.readUInt32LE(20 + length), start = 24 + length;
  if (manifest?.format !== "cloudhub-tools-database-migration" || manifest.version !== 1 || !Number.isSafeInteger(size) || size <= 0 || keySize !== 32 || start + size + keySize !== bytes.length) fail("备份格式或长度无效");
  if (hash(bytes.subarray(start, start + size)) !== manifest.database_sha256 || hash(bytes.subarray(start + size)) !== manifest.key_sha256) fail("备份校验失败，文件可能已损坏");
}

export function createCloudSyncService({ load, persist, fetchRemote = fetch }) {
  const status = { busy: false, paused: false, lastUpload: null, lastDownload: null, error: null, progress: null };
  const progress = (phase, transferred = 0, total = null) => { status.progress = { phase, transferred, total }; };
  function view() {
    const saved = load();
    const { password, secretKey, backupPassword, lastEtag: _etag, ...config } = saved || defaults;
    return { configured: !!saved, config: { ...config, hasPassword: !!password, hasSecretKey: !!secretKey, hasBackupPassword: !!backupPassword }, status: { ...status, progress: status.progress ? { ...status.progress } : null } };
  }
  async function exclusive(action) {
    if (status.busy) fail("云同步正在执行，请稍后重试");
    status.busy = true; status.error = null; status.progress = null;
    try { return await action(); }
    catch (error) {
      status.error = error instanceof CloudSyncError ? error.message : "云备份操作失败，请检查本地调试服务与配置";
      throw new CloudSyncError(status.error);
    }
    finally { status.busy = false; status.progress = null; }
  }
  async function request(config, method, url, body = Buffer.alloc(0), condition = {}) {
    let response;
    const metadata = method === "PUT" && url.pathname.endsWith(".json");
    if (ossEndpoint(config) && method === "PUT" && Object.keys(condition).length) {
      if (Object.keys(condition).length !== 1 || condition["If-None-Match"] !== "*") fail("OSS 不支持条件更新版本目录，请使用独立版本记录");
      condition = { "x-oss-forbid-overwrite": "true" };
    }
    async function* uploadChunks() {
      progress("uploading", 0, body.length);
      for (let offset = 0; offset < body.length; offset += 64 * 1024) {
        const chunk = body.subarray(offset, offset + 64 * 1024);
        yield chunk;
        progress("uploading", offset + chunk.length, body.length);
      }
      progress("confirming", body.length, body.length);
    }
    try {
      response = await fetchRemote(url, {
        method, headers: { ...signedHeaders(config, method, url, body, undefined, condition), ...condition, ...(method === "PROPFIND" ? { Depth: "0" } : {}), ...(method === "PUT" ? { "Content-Type": metadata ? "application/json" : "application/octet-stream", "Content-Length": String(body.length) } : {}) },
        ...(method === "PUT" ? metadata ? { body } : { body: uploadChunks(), duplex: "half" } : {}), redirect: "manual", signal: AbortSignal.timeout(180_000),
      });
    } catch (error) { fail(`${method === "PUT" ? metadata ? "写入版本目录失败：" : "上传备份文件失败：" : ""}${connectionFailure(error)}`); }
    if (ossEndpoint(config) && !response.ok && response.status !== 412 && !(response.status === 404 && ["GET", "HEAD", "DELETE"].includes(method))) {
      const chunks = []; let size = 0;
      try {
        for await (const chunk of response.body || []) {
          const bytes = Buffer.from(chunk).subarray(0, 16 * 1024 - size);
          chunks.push(bytes); size += bytes.length;
          if (size >= 16 * 1024) break;
        }
      } catch { /* A partial error body must not hide the HTTP failure. */ }
      const stage = method === "PUT" ? metadata ? "登记版本" : "上传文件" : method === "GET" ? "读取版本或备份" : "检查备份";
      fail(ossError(response.status, stage, Buffer.concat(chunks)));
    }
    return response;
  }
  function savedConfig() {
    const config = load();
    if (!config) fail("请先保存云同步配置");
    return mergeConfig(config, config);
  }
  function validateVersion(item, id = item?.id) {
    if (item?.passwordProtected != null && typeof item.passwordProtected !== "boolean") fail("备份密码状态无效");
    if (!item || item.id !== id || item.id === "database.chdb" || typeof item.machineName !== "string" || Buffer.byteLength(item.machineName) > 400 || /[\x00-\x1f\x7f]/.test(item.machineName) || typeof item.uploadedAt !== "string" || !Number.isFinite(Date.parse(item.uploadedAt))) fail("备份版本目录无效");
    selectedVersion(item.id);
  }
  async function legacyVersionIndex(config) {
    const response = await request(config, "GET", namedUrl(config, "versions.json"));
    try {
      if (response.status === 404) return { versions: [], tag: null };
      check(response);
      const tag = etag(response);
      if (!tag && !ossEndpoint(config)) fail("服务未提供版本目录 ETag，无法安全维护多版本备份");
      const bytes = await readLimited(response.body, 4 * 1024 * 1024);
      let versions;
      try { versions = JSON.parse(bytes.toString("utf8")); } catch { fail("备份版本目录无效"); }
      if (!Array.isArray(versions) || versions.length > 10000) fail("备份版本目录无效");
      for (const item of versions) validateVersion(item);
      return { versions, tag };
    } finally { if (!response.bodyUsed) await response.body?.cancel(); }
  }
  async function versionIndex(config) {
    const legacy = await legacyVersionIndex(config);
    if (!ossEndpoint(config)) return legacy;
    // OSS cannot compare-and-swap a shared PutObject index. Each backup owns
    // its own immutable JSON record; ListObjects discovers records across devices.
    const result = new Map(legacy.versions.map(item => [item.id, item]));
    const discovered = new Set();
    const prefix = decodeURIComponent(namedUrl(config, "backup-").pathname.slice(1));
    let marker = "", count = 0;
    const field = (xml, tag) => {
      const value = xml.split(`<${tag}>`)[1]?.split(`</${tag}>`);
      if (!value || value.length < 2) fail("OSS 版本列表格式无效");
      return value[0];
    };
    const decodeKey = value => {
      if (value.length > 3072 || /[<>&]/.test(value)) fail("OSS 版本路径无效");
      let key;
      try { key = decodeURIComponent(value); } catch { fail("OSS 版本路径无效"); }
      if (Buffer.byteLength(key) > 1024 || /[\x00-\x1f\x7f]/.test(key)) fail("OSS 版本路径无效");
      return key;
    };
    while (true) {
      const url = targetUrl(config, false); url.pathname = "/";
      url.search = new URLSearchParams({ prefix, "encoding-type": "url", "max-keys": "1000", marker }).toString();
      const response = await request(config, "GET", url);
      let xml;
      try { check(response); xml = (await readLimited(response.body, 2 * 1024 * 1024)).toString("utf8"); }
      finally { if (!response.bodyUsed) await response.body?.cancel(); }
      if (!xml.includes("<ListBucketResult") || xml.includes("<!") || field(xml, "EncodingType") !== "url") fail("OSS 版本列表格式无效");
      const blocks = xml.split("<Contents>").slice(1);
      if (blocks.length > 1000 || (count += blocks.length) > 20000) fail("备份版本过多，请更换同步配置名");
      let previous = marker;
      for (const content of blocks) {
        const parts = content.split("</Contents>");
        if (parts.length < 2) fail("OSS 版本列表格式无效");
        const key = decodeKey(field(parts[0], "Key"));
        if (!key.startsWith(prefix) || key <= previous) fail("OSS 版本路径或分页顺序无效");
        previous = key;
        if (key.endsWith(".chdb")) discovered.add(key.split("/").at(-1));
        if (!key.endsWith(".json")) continue;
        const id = key.slice(0, -5).split("/").at(-1);
        selectedVersion(id);
        if (id === "database.chdb" || key !== `${prefix}${id.slice("backup-".length)}.json`) fail("OSS 版本路径无效");
        const recordResponse = await request(config, "GET", namedUrl(config, `${id}.json`));
        try {
          if (recordResponse.status === 404) continue;
          check(recordResponse);
          let item;
          const bytes = await readLimited(recordResponse.body, 4096);
          try { item = JSON.parse(bytes.toString("utf8")); } catch { fail("OSS 备份版本信息无效"); }
          validateVersion(item, id); result.set(id, item); discovered.add(id);
          if (result.size > 10000) fail("备份版本过多，请更换同步配置名");
        } finally { if (!recordResponse.bodyUsed) await recordResponse.body?.cancel(); }
      }
      const truncated = field(xml, "IsTruncated");
      if (truncated === "false") break;
      if (truncated !== "true") fail("OSS 版本列表格式无效");
      const next = decodeKey(field(xml, "NextMarker"));
      if (!blocks.length || !next.startsWith(prefix) || next <= marker || next < previous) fail("OSS 版本分页无效");
      marker = next;
    }
    // A legacy shared index is read-only on OSS. Listing its actual objects
    // prevents deleted legacy backups from reappearing without rewriting it.
    return { versions: [...result.values()].filter(item => discovered.has(item.id)), tag: null };
  }
  async function registerVersion(config, version) {
    if (ossEndpoint(config)) {
      const target = namedUrl(config, `${version.id}.json`), body = Buffer.from(JSON.stringify(version));
      try {
        const response = await request(config, "PUT", target, body, { "If-None-Match": "*" });
        try { check(response); return; } finally { await response.body?.cancel(); }
      } catch (error) {
        // Confirm a lost acknowledgement against this exact immutable record.
        let response;
        try {
          response = await request(config, "GET", target); check(response);
          if ((await readLimited(response.body, 4096)).equals(body)) return;
        } catch { /* Keep the original, safe upload error. */ }
        finally { if (response && !response.bodyUsed) await response.body?.cancel(); }
        throw error;
      }
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const { versions, tag } = await versionIndex(config);
      if (versions.some(item => item.id === version.id)) return;
      if (versions.length >= 10000) fail("备份版本已达一万条，请更换同步配置名");
      versions.push(version);
      versions.sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt));
      let response;
      try {
        response = await request(config, "PUT", namedUrl(config, "versions.json"), Buffer.from(JSON.stringify(versions)), tag ? { "If-Match": tag } : { "If-None-Match": "*" });
      } catch (error) {
        // A lost acknowledgement can occur after the server has committed the PUT.
        // Confirm our exact id instead of uploading another snapshot or assuming success.
        const confirmed = await versionIndex(config).catch(() => null);
        if (confirmed?.versions.some(item => item.id === version.id)) return;
        throw error;
      }
      try {
        if (response.status === 412) continue;
        check(response); return;
      } finally { await response.body?.cancel(); }
    }
    fail("其他设备正在上传，版本登记未完成，请稍后重试上传");
  }
  return {
    state: view,
    deleteVersion: versionId => exclusive(async () => {
      if (typeof versionId !== "string") fail("备份版本参数无效");
      const id = selectedVersion(versionId), config = savedConfig();
      async function remove(name) {
        const response = await request(config, "DELETE", namedUrl(config, name));
        try { if (response.status !== 404) check(response); }
        finally { await response.body?.cancel(); }
      }
      await remove(id);
      if (id === "database.chdb") return;
      if (ossEndpoint(config)) { await remove(`${id}.json`); return; }
      for (let attempt = 0; attempt < 5; attempt++) {
        const { versions, tag } = await legacyVersionIndex(config);
        if (!versions.some(item => item.id === id)) return;
        const response = await request(config, "PUT", namedUrl(config, "versions.json"), Buffer.from(JSON.stringify(versions.filter(item => item.id !== id))), { "If-Match": tag });
        try { if (response.status === 412) continue; check(response); return; }
        finally { await response.body?.cancel(); }
      }
      fail("备份文件已删除，但其他设备正在更新版本目录，请重试删除以完成清理");
    }),
    save: input => exclusive(async () => { persist(mergeConfig(input, load())); return view(); }).then(() => view()),
    test: input => exclusive(async () => {
      const config = mergeConfig(input, load());
      const response = await request(config, config.method === "webdav" ? "PROPFIND" : "HEAD", targetUrl(config, false));
      try { check(response); } finally { await response.body?.cancel(); }
    }),
    reveal(input, field) {
      const saved = savedConfig();
      if (!["password", "secretKey"].includes(field) || !["method", "username", "accessKeyId"].every(key => input?.[key] === saved[key]) || String(input?.endpoint).trim().replace(/\/+$/, "") !== saved.endpoint || !saved[field]) fail("当前配置没有可查看的已保存凭据");
      return saved[field];
    },
    versions: () => exclusive(async () => {
      const config = savedConfig();
      const { versions } = await versionIndex(config);
      versions.sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt) || a.id.localeCompare(b.id));
      const response = await request(config, "HEAD", targetUrl(config));
      try {
        if (response.status !== 404) {
          check(response);
          versions.push({ id: "database.chdb", machineName: "旧版备份（机器名称未知）", uploadedAt: null });
        }
      } finally { await response.body?.cancel(); }
      return versions;
    }),
    upload: source => exclusive(async () => {
      progress("preparing");
      const config = savedConfig();
      const bytes = typeof source === "function" ? await source() : source;
      validatePackage(bytes);
      progress("connecting");
      const version = { id: `backup-${crypto.randomUUID()}.chdb`, machineName: `${os.hostname().replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100) || os.platform()}-dev`, uploadedAt: new Date().toISOString(), passwordProtected: bytes.subarray(0, 8).toString() === "CHDBENC2" };
      const target = namedUrl(config, version.id);
      if (config.method === "webdav") {
        const directory = endpoint(config);
        for (const part of [...config.remoteRoot.split("/"), "v1", config.profile]) {
          directory.pathname = directory.pathname.replace(/\/$/, "") + "/" + encode(part) + "/";
          const response = await request(config, "MKCOL", directory);
          try { if (response.status !== 405) check(response); } finally { await response.body?.cancel(); }
        }
      }
      const response = await request(config, "PUT", target, bytes, { "If-None-Match": "*" });
      try { check(response); progress("finishing"); config.lastEtag = etag(response); }
      finally { await response.body?.cancel(); }
      try { await registerVersion(config, version); }
      catch (error) { fail(`备份文件已上传，但版本目录登记失败：${error instanceof CloudSyncError ? error.message : "请检查云存储状态"}`); }
      persist(config); status.lastUpload = new Date().toISOString();
    }).then(() => view()),
    download: versionId => exclusive(async () => {
      progress("connecting");
      const config = savedConfig(); const response = await request(config, "GET", namedUrl(config, selectedVersion(versionId)));
      try {
        check(response);
        if (Number(response.headers.get("content-length")) > MAX_BACKUP_BYTES) fail("备份超过 256 MB 限制");
        const length = Number(response.headers.get("content-length"));
        const total = Number.isSafeInteger(length) && length > 0 ? length : null;
        progress("downloading", 0, total);
        const bytes = await readLimited(response.body, MAX_BACKUP_BYTES, transferred => progress("downloading", transferred, total));
        progress("verifying");
        validatePackage(bytes);
        config.lastEtag = etag(response); persist(config); status.lastDownload = new Date().toISOString();
        return bytes;
      } finally { if (!response.bodyUsed) await response.body?.cancel(); }
    }),
  };
}
