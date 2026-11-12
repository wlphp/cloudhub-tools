import { isIP } from "node:net";
import { decryptSecret } from "../core/crypto.mjs";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";
import { writeApiLog } from "../core/database.mjs";

export function identifier(value) {
  if (typeof value !== "string" || !/^[a-f\d]{32}$/i.test(value)) throw new Error("Cloudflare ID 必须为 32 位十六进制字符");
  return value;
}
function name(value) {
  if (typeof value !== "string" || !/^[\w-]{1,63}$/.test(value)) throw new Error("资源名称无效");
  return value;
}
export function project(row, fields) {
  return Object.fromEntries(fields.filter(key => row[key] == null || ["string", "boolean", "number"].includes(typeof row[key])).map(key => [key, row[key] ?? null]));
}
function credentials(id) {
  const row = getAccountSecretRecord(id);
  if (!row || !row.enabled || row.cloud_type !== "cloudflare") throw new Error("Cloudflare 账号不存在或已停用");
  return { account: identifier(row.access_key_id), token: decryptSecret(row.secret_ciphertext).trim() };
}
export function responseError(status, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "Cloudflare 返回格式无效";
  if (status >= 200 && status < 300 && data.success === true) return null;
  const codes = (Array.isArray(data.errors) ? data.errors : []).map(e => e?.code).filter(Number.isInteger).join(",");
  return `Cloudflare HTTP ${status}（错误码 ${codes}）；请检查 Token 权限、Account ID、资源状态或请求参数`;
}
export async function request(id, method, path, query = {}, body) {
  const { token } = credentials(id);
  const url = new URL(`https://api.cloudflare.com/client/v4/${path}`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
  let response;
  try { response = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch { throw new Error("Cloudflare 网络请求失败或超时"); }
  const data = await response.json().catch(() => { throw new Error("Cloudflare 返回格式无效"); });
  const message = responseError(response.status, data);
  if (message) {
    writeApiLog(id, "api.cloudflare.com", `${method} ${path}`, {}, null, "失败", message);
    throw new Error(message);
  }
  writeApiLog(id, "api.cloudflare.com", `${method} ${path}`, {}, { success: true }, "成功");
  return data;
}
export async function pages(fetchPage, { single = false, buckets = false } = {}) {
  const items = [];
  let cursor = "";
  for (let page = 1; page <= 1000; page++) {
    const data = await fetchPage(buckets ? (cursor ? { cursor } : {}) : single ? {} : { page, per_page: 50 });
    const rows = buckets ? data.result?.buckets : data.result;
    if (!Array.isArray(rows)) throw new Error("Cloudflare 资源列表格式无效");
    items.push(...rows);
    if (buckets) {
      const next = data.result_info?.cursor;
      if (!next) return items;
      if (typeof next !== "string" || next === cursor) throw new Error("Cloudflare 分页游标未推进");
      cursor = next;
    } else {
      const total = data.result_info?.total_pages;
      if (single || !rows.length || (Number.isFinite(total) ? page >= total : rows.length < 50)) return items;
    }
  }
  throw new Error("Cloudflare 资源超过分页上限，请缩小 Token 的资源范围");
}
export async function resources(id, type) {
  try {
    const { account } = credentials(id);
    const config = {
      domain: ["zones", { "account.id": account }, ["id", "name", "status", "paused", "type", "created_on", "modified_on"]],
      workers: [`accounts/${account}/workers/scripts`, {}, ["id", "created_on", "modified_on", "compatibility_date", "usage_model"]],
      oss: [`accounts/${account}/r2/buckets`, {}, ["name", "creation_date", "location", "jurisdiction", "storage_class"]],
      pages: [`accounts/${account}/pages/projects`, {}, ["id", "name", "subdomain", "created_on", "production_branch"]],
      tunnel: [`accounts/${account}/cfd_tunnel`, { is_deleted: false }, ["id", "name", "status", "created_at", "deleted_at", "remote_config"]],
    }[type];
    if (!config) throw new Error("Cloudflare 不支持该资源类型");
    const [path, query, fields] = config;
    const rows = await pages(q => request(id, "GET", path, { ...query, ...q }), { single: type === "workers", buckets: type === "oss" });
    const items = rows.map(row => ({ ...project(row, fields), Id: type === "oss" ? row.name : row.id, Name: row.name || row.id, Status: row.status ?? null, ...(type === "domain" ? { DomainName: row.name } : {}), _region_id: "global" }));
    return { resource_type: type, items, errors: [], fetched_at: Date.now() };
  } catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; }
}
export function dnsBody(input) {
  const { type, name: host, content, ttl, proxied, priority } = input;
  if (!["A", "AAAA", "CNAME", "TXT", "MX", "NS"].includes(type)) throw new Error("该记录类型请在 Cloudflare 控制台管理");
  if (typeof host !== "string" || !/^[\w.*-]{1,253}$/.test(host)) throw new Error("DNS 名称无效，请填写完整域名");
  if (typeof content !== "string" || !content.length || content.length > 4096 || /[\0\r\n]/.test(content)) throw new Error("DNS 内容无效");
  if ((type === "A" && isIP(content) !== 4) || (type === "AAAA" && isIP(content) !== 6)) throw new Error("IP 地址无效");
  if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 60 || ttl > 86400))) throw new Error("TTL 必须为 1（自动）或 60–86400 秒");
  if (typeof proxied !== "boolean" || (proxied && !["A", "AAAA", "CNAME"].includes(type))) throw new Error("代理状态无效");
  if (type === "MX" && (!Number.isInteger(priority) || priority < 0 || priority > 65535)) throw new Error("MX 优先级无效");
  return { type, name: host, content, ttl: proxied ? 1 : ttl, proxied, ...(type === "MX" ? { priority } : {}) };
}
export async function manage(id, action, input = {}) {
  const { account } = credentials(id);
  if (action === "verify") { await request(id, "GET", `accounts/${account}`); return { verified: true }; }
  if (action.startsWith("dns_") || ["purge_cache", "ssl_get", "ssl_set"].includes(action)) {
    const zone = identifier(input.zoneId);
    const detail = await request(id, "GET", `zones/${zone}`);
    if (detail.result?.account?.id !== account) throw new Error("站点不属于当前 Cloudflare Account ID");
    if (action === "ssl_get") {
      const settings = await request(id, "GET", `zones/${zone}/settings/ssl`);
      const mode = settings.result?.value;
      if (!["off", "flexible", "full", "strict"].includes(mode)) throw new Error("SSL 设置格式无效");
      return { mode };
    }
    const base = `zones/${zone}/dns_records`;
    if (action === "dns_list") {
      const rows = await pages(q => request(id, "GET", base, q));
      return { items: rows.map(row => project(row, ["id", "name", "type", "content", "ttl", "priority", "proxied", "proxiable", "comment"])) };
    }
    if (action === "dns_save") await request(id, input.recordId ? "PATCH" : "POST", input.recordId ? `${base}/${identifier(input.recordId)}` : base, {}, dnsBody(input));
    else if (action === "dns_delete") await request(id, "DELETE", `${base}/${identifier(input.recordId)}`);
    else if (action === "dns_proxy") { if (typeof input.proxied !== "boolean") throw new Error("代理状态无效"); await request(id, "PATCH", `${base}/${identifier(input.recordId)}`, {}, { proxied: input.proxied }); }
    else if (action === "purge_cache") await request(id, "POST", `zones/${zone}/purge_cache`, {}, { purge_everything: true });
    else if (action === "ssl_set") { if (!["off", "flexible", "full", "strict"].includes(input.mode)) throw new Error("SSL 模式无效"); await request(id, "PATCH", `zones/${zone}/settings/ssl`, {}, { value: input.mode }); }
    else throw new Error("不支持的 Cloudflare 操作");
  } else if (action === "r2_create") {
    if (typeof input.name !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.name)) throw new Error("R2 桶名称须为 3–63 位小写字母、数字或连字符，且首尾不能为连字符");
    await request(id, "POST", `accounts/${account}/r2/buckets`, {}, { name: input.name });
  } else if (action === "delete_resource") {
    let suffix;
    if (input.kind === "workers") suffix = `workers/scripts/${name(input.resourceId)}`;
    else if (input.kind === "pages") suffix = `pages/projects/${name(input.resourceId)}`;
    else if (input.kind === "oss") suffix = `r2/buckets/${name(input.resourceId)}`;
    else if (input.kind === "tunnel" && /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(input.resourceId)) suffix = `cfd_tunnel/${input.resourceId}`;
    else throw new Error("不支持删除此类资源或资源 ID 无效");
    await request(id, "DELETE", `accounts/${account}/${suffix}`);
  } else throw new Error("不支持的 Cloudflare 操作");
  return { success: true };
}
