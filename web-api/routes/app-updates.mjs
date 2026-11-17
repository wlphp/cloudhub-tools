import { send, sendError } from "../core/http.mjs";
const API = "https://api.github.com/repos/wlphp/cloudhub-tools/releases/latest";
const hosts = new Set(["github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "gh-proxy.com", "github.705810.xyz"]);
export function routes(source) {
  if (source === "auto") return ["accelerated", "mirror705810", "direct"];
  if (["accelerated", "mirror705810", "direct"].includes(source)) return [source];
  throw new Error("更新线路无效");
}
export function routedUrl(original, route) {
  routes(route);
  const u = new URL(original);
  if (u.protocol !== "https:" || u.port || u.username || u.password || u.search || u.hash || !(original === API || (u.hostname === "github.com" && u.pathname.startsWith("/wlphp/cloudhub-tools/releases/download/")))) throw new Error("更新地址无效");
  return route === "accelerated" ? `https://gh-proxy.com/${original}` : route === "mirror705810" ? `https://github.705810.xyz/${original}` : original;
}
async function request(original, route, headers = {}, fetcher = fetch) {
  let url = routedUrl(original, route);
  const signal = AbortSignal.timeout(12000);
  for (let count = 0; count < 6; count++) {
    const response = await fetcher(url, { headers: { "User-Agent": "CloudHub-Preview-Updater", ...headers }, signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.get("location"), url);
      await response.body?.cancel();
      if (next.protocol !== "https:" || next.username || next.password || !hosts.has(next.hostname)) throw new Error("更新节点重定向无效");
      url = next.href; continue;
    }
    if (!response.ok || response.headers.get("content-type")?.includes("text/html")) { await response.body?.cancel(); throw new Error("节点返回错误或网页"); }
    return response;
  }
  throw new Error("更新节点重定向过多");
}
async function read(response, max, stopAtLimit = false) {
  if (!response.body) throw new Error("节点返回空数据");
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      if (!stopAtLimit && size + value.length > max) throw new Error("版本信息超过限制");
      const chunk = value.subarray(0, max - size); chunks.push(chunk); size += chunk.length;
      if (size >= max && stopAtLimit) break;
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
async function release(route, fetcher) {
  const response = await request(API, route, { Accept: "application/vnd.github+json" }, fetcher);
  const value = JSON.parse((await read(response, 1048576)).toString("utf8"));
  if (!/^v?\d+\.\d+\.\d+$/.test(value.tag_name) || value.draft !== false || value.prerelease !== false) throw new Error("不是有效的稳定版本");
  return value;
}
export async function updateInfo(source, fetcher = fetch) {
  const errors = [];
  for (const route of routes(source)) {
    try {
      const value = await release(route, fetcher);
      return { version: value.tag_name.replace(/^v/, ""), notes: String(value.body || "").slice(0, 8000), route };
    } catch { errors.push(`${route === "accelerated" ? "gh-proxy.com" : route === "mirror705810" ? "github.705810.xyz" : "GitHub 官方直连"} 不可用`); }
  }
  throw new Error(errors.join("；"));
}
export async function probe(route, fetcher = fetch) {
  if (!["accelerated", "mirror705810", "direct"].includes(route)) throw new Error("测速线路无效");
  const start = performance.now();
  try {
    const value = await release(route, fetcher);
    const asset = value.assets?.find(a => typeof a.browser_download_url === "string" && /\.(apk|exe|tar\.gz)$/.test(a.browser_download_url));
    if (!asset) throw new Error("没有可测速的发布附件");
    const send = performance.now();
    const response = await request(asset.browser_download_url, route, { Range: "bytes=0-262143" }, fetcher);
    const responseMs = Math.round(performance.now() - send);
    const readStart = performance.now();
    const bytes = await read(response, 262144, true);
    if (!bytes.length) throw new Error("测速未收到数据");
    return { route, available: true, responseMs, bytesPerSecond: Math.round(bytes.length / Math.max((performance.now() - readStart) / 1000, 0.001)), message: "抽样测速完成" };
  } catch { return { route, available: false, responseMs: Math.round(performance.now() - start), bytesPerSecond: 0, message: "线路不可用或测速超时" }; }
}
export async function handleAppUpdateRoute(req, res, url) {
  if (!["/api/app-update-info", "/api/app-update-probe"].includes(url.pathname)) return false;
  if (req.method !== "GET") { sendError(res, 405, "validation", "仅支持 GET 请求"); return true; }
  try {
    const result = url.pathname.endsWith("probe") ? await probe(url.searchParams.get("route")) : await updateInfo(url.searchParams.get("source") || "auto");
    send(res, 200, result);
  } catch (error) { sendError(res, 400, "validation", error.message); }
  return true;
}
