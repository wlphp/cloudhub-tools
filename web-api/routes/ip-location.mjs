import { isIP } from "node:net";
import { send, sendError, readBody } from "../core/http.mjs";
import { database } from "../core/database.mjs";

const pending = new Map();
const canonical = value => isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;

export async function cachedIpLocation(ip, db = database()) {
  if (typeof ip !== "string" || !isIP(ip.trim())) throw new Error("请输入有效的 IP 地址");
  const target = canonical(ip.trim());
  const cached = db.prepare("SELECT result_json FROM ip_location_cache WHERE ip=?").get(target);
  if (cached) return JSON.parse(cached.result_json);
  if (pending.has(target)) return pending.get(target);
  const task = queryIpLocation(target).then(data => {
    data.target = target;
    db.prepare("INSERT INTO ip_location_cache(ip,result_json) VALUES(?,?)").run(target, JSON.stringify(data));
    return data;
  });
  pending.set(target, task);
  try { return await task; } finally { pending.delete(target); }
}

export async function deleteCachedIpLocation(ip, db = database()) {
  if (typeof ip !== "string" || !isIP(ip.trim())) throw new Error("请输入有效的 IP 地址");
  const target = canonical(ip.trim());
  try { await pending.get(target); } catch { /* Failed queries have no cached record. */ }
  db.prepare("DELETE FROM ip_location_cache WHERE ip=?").run(target);
}

export async function queryIpLocation(ip) {
  if (typeof ip !== "string" || !isIP(ip.trim())) throw new Error("请输入有效的 IP 地址");
  const target = ip.trim();
  let response;
  try {
    response = await fetch("https://t.bt.cn/api/v3/ip-lookup", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target }),
    });
  } catch { throw new Error("归属地查询连接失败或超时，请重试"); }
  if (!response.ok) throw new Error("宝塔查询服务暂不可用，请稍后重试");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 65_536) throw new Error("归属地响应过大");
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("宝塔返回的数据格式无效"); }
  // IPv6 may be normalized by the provider; compare parsed URL host forms.
  if (!data || data.feature !== "ip" || typeof data.found !== "boolean" || typeof data.target !== "string"
    || !isIP(data.target) || canonical(data.target) !== canonical(target)
    || (data.found && (!data.location || typeof data.location !== "object" || Array.isArray(data.location)))) {
    throw new Error("宝塔返回的归属地数据无效");
  }
  return data;
}

export async function handleIpLocationRoute(req, res, url) {
  if (url.pathname !== "/api/ip-location" || !["GET", "POST", "DELETE"].includes(req.method)) return false;
  if (req.method === "GET") {
    try { send(res, 200, database().prepare("SELECT result_json FROM ip_location_cache").all().map(row => JSON.parse(row.result_json))); }
    catch { sendError(res, 500, "storage", "读取归属地缓存失败"); }
    return true;
  }
  let input;
  try { input = JSON.parse(await readBody(req, 1024)); }
  catch { sendError(res, 400, "validation", "查询参数格式无效"); return true; }
  if (typeof input?.ip !== "string" || !isIP(input.ip.trim())) {
    sendError(res, 400, "validation", "请输入有效的 IP 地址"); return true;
  }
  if (req.method === "DELETE") {
    try {
      await deleteCachedIpLocation(input.ip);
      send(res, 200, null);
    } catch { sendError(res, 500, "storage", "删除归属地缓存失败"); }
    return true;
  }
  try { send(res, 200, await cachedIpLocation(input.ip)); }
  catch (error) { sendError(res, 502, "network", error.message); }
  return true;
}
