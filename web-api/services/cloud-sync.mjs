import crypto from "node:crypto";

export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
export const previewConfigKey = "cloud.sync.preview.config";
export const defaults = {
  method: "webdav", provider: "custom", endpoint: "", username: "", password: "",
  accessKeyId: "", secretKey: "", bucket: "", region: "us-east-1", pathStyle: true,
  remoteRoot: "cloudhub-sync", profile: "default", autoSync: false, allowInsecure: false,
  passwordProtected: false, backupPassword: "",
};
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => crypto.createHmac("sha256", key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const segment = value => typeof value === "string" && value.length > 0 && value.length <= 100 && value.trim() === value && ![".", ".."].includes(value) && /^[a-zA-Z0-9_ .-]+$/.test(value);
export class CloudSyncError extends Error {}
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
    if (typeof input[key] !== typeof fallback) fail("云同步配置字段无效");
    config[key] = input[key];
  }
  config.endpoint = config.endpoint.trim().replace(/\/+$/, "");
  config.remoteRoot = config.remoteRoot.trim(); config.profile = config.profile.trim();
  const sameIdentity = saved && ["method", "endpoint", "username", "accessKeyId"].every(key => config[key] === saved[key]);
  if (sameIdentity) for (const key of ["password", "secretKey"]) config[key] ||= saved[key];
  config.lastEtag = sameIdentity && ["remoteRoot", "profile", "bucket", "region", "pathStyle"].every(key => config[key] === saved[key]) ? saved.lastEtag : null;
  if (!["webdav", "s3"].includes(config.method) || !["custom", "jianguoyun", "nextcloud", "alist"].includes(config.provider)) fail("同步方式或服务商无效");
  if (config.endpoint.length > 2048) fail("服务地址过长");
  endpoint(config);
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

export function targetUrl(config, artifact = true) {
  const url = endpoint(config);
  if (config.method === "s3" && !config.pathStyle) url.hostname = `${config.bucket}.${url.hostname}`;
  const parts = config.method === "s3" && config.pathStyle ? [config.bucket] : [];
  if (artifact) parts.push(...config.remoteRoot.split("/"), "v1", config.profile, "database.chdb");
  url.pathname = url.pathname.replace(/\/$/, "") + (parts.length ? "/" + parts.map(encode).join("/") : "");
  return url;
}

export function signedHeaders(config, method, url, body = Buffer.alloc(0), time = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")) {
  if (config.method === "webdav") return { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}` };
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
  fail(messages[response.status] || (response.status >= 300 && response.status < 400 ? "服务器要求重定向，请填写最终服务地址（不会转发凭据）" : "云同步请求失败，请检查服务状态与配置"));
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
        method, headers: { ...signedHeaders(config, method, url, body), ...condition, ...(method === "PROPFIND" ? { Depth: "0" } : {}), ...(method === "PUT" ? { "Content-Type": "application/octet-stream", "Content-Length": String(body.length) } : {}) },
        ...(method === "PUT" ? { body: uploadChunks(), duplex: "half" } : {}), redirect: "manual", signal: AbortSignal.timeout(180_000),
      });
    } catch { fail("云同步连接失败，请检查地址、网络与证书"); }
    return response;
  }
  function savedConfig() {
    const config = load();
    if (!config) fail("请先保存云同步配置");
    return mergeConfig(config, config);
  }
  return {
    state: view,
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
    upload: source => exclusive(async () => {
      progress("preparing");
      const config = savedConfig();
      const bytes = typeof source === "function" ? await source() : source;
      validatePackage(bytes);
      progress("connecting");
      const target = targetUrl(config);
      if (config.method === "webdav") {
        const directory = endpoint(config);
        for (const part of [...config.remoteRoot.split("/"), "v1", config.profile]) {
          directory.pathname = directory.pathname.replace(/\/$/, "") + "/" + encode(part) + "/";
          const response = await request(config, "MKCOL", directory);
          try { if (response.status !== 405) check(response); } finally { await response.body?.cancel(); }
        }
      }
      const head = await request(config, "HEAD", target);
      let condition;
      try {
        if (head.status === 404) condition = { "If-None-Match": "*" };
        else {
          check(head);
          const current = etag(head);
          if (!config.lastEtag || current !== config.lastEtag) fail("云端已有备份或已发生变化，请先下载检查后再上传");
          condition = { "If-Match": config.lastEtag };
        }
      } finally { await head.body?.cancel(); }
      const response = await request(config, "PUT", target, bytes, condition);
      try { check(response); progress("finishing"); config.lastEtag = etag(response); persist(config); status.lastUpload = new Date().toISOString(); }
      finally { await response.body?.cancel(); }
    }).then(() => view()),
    download: () => exclusive(async () => {
      progress("connecting");
      const config = savedConfig(); const response = await request(config, "GET", targetUrl(config));
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
