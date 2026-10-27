import { isIP } from "node:net";
import { send, sendError, readBody } from "../core/http.mjs";

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
  const canonical = value => isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname : value;
  if (!data || data.feature !== "ip" || typeof data.found !== "boolean" || typeof data.target !== "string"
    || !isIP(data.target) || canonical(data.target) !== canonical(target)
    || (data.found && (!data.location || typeof data.location !== "object" || Array.isArray(data.location)))) {
    throw new Error("宝塔返回的归属地数据无效");
  }
  return data;
}

export async function handleIpLocationRoute(req, res, url) {
  if (req.method !== "POST" || url.pathname !== "/api/ip-location") return false;
  let input;
  try { input = JSON.parse(await readBody(req, 1024)); }
  catch { sendError(res, 400, "validation", "查询参数格式无效"); return true; }
  if (typeof input?.ip !== "string" || !isIP(input.ip.trim())) {
    sendError(res, 400, "validation", "请输入有效的 IP 地址"); return true;
  }
  try { send(res, 200, await queryIpLocation(input.ip)); }
  catch (error) { sendError(res, 502, "network", error.message); }
  return true;
}
