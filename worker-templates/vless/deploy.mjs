import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const source = await readFile(new URL("./worker.mjs", import.meta.url), "utf8");
export function validateConfig(input) {
  if (!/^[a-f\d]{32}$/i.test(input.accountId || "") || !/^[a-f\d]{32}$/i.test(input.zoneId || "")) throw new Error("Account ID 或 Zone ID 无效");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.workerName || "")) throw new Error("Worker 名称无效");
  if (typeof input.hostname !== "string" || input.hostname.length > 253 || !input.hostname.includes(".") || !input.hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error("完整子域名无效");
  if (typeof input.thirdParty !== "boolean") throw new Error("第三方地址选项无效");
}

// send(method, path, body?, query?) 由应用或 CLI 提供；不接受 Dashboard Cookie。
export async function deployVless(input, send) {
  validateConfig(input);
  const { accountId: account, zoneId: zone, hostname, workerName: worker, thirdParty } = input;
  const detail = await send("GET", `zones/${zone}`);
  const zoneName = detail.result?.name;
  if (detail.result?.account?.id !== account || detail.result?.status !== "active" || typeof zoneName !== "string" || !hostname.endsWith(`.${zoneName}`)) throw new Error("请选择当前账号已激活域名下的子域名");
  const scripts = await send("GET", `accounts/${account}/workers/scripts`);
  if (!Array.isArray(scripts.result)) throw new Error("Workers 列表格式无效");
  if (scripts.result.some(row => row.id === worker)) throw new Error("同名 Worker 已存在，请更换名称");
  const records = await send("GET", `zones/${zone}/dns_records`, undefined, { name: hostname, per_page: 1 });
  if (!Array.isArray(records.result)) throw new Error("DNS 列表格式无效");
  if (records.result.length) throw new Error("该子域名已有 DNS 记录，请更换一个未使用的子域名");
  const domains = await send("GET", `accounts/${account}/workers/domains`);
  if (!Array.isArray(domains.result)) throw new Error("Worker 域名列表格式无效");
  if (domains.result.some(row => row.hostname === hostname)) throw new Error("子域名已经绑定 Worker，请更换子域名");
  const subToken = randomBytes(16).toString("hex");
  const bindings = [
    { type: "secret_text", name: "UUID", text: randomUUID() },
    { type: "secret_text", name: "SUB_TOKEN", text: subToken },
    { type: "plain_text", name: "THIRD_PARTY", text: String(thirdParty) },
  ];
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify({ main_module: "worker.mjs", compatibility_date: "2026-11-13", bindings })], { type: "application/json" }));
  form.set("worker.mjs", new Blob([source], { type: "application/javascript+module" }), "worker.mjs");
  await send("PUT", `accounts/${account}/workers/scripts/${worker}`, form);
  const subscriptionPath = `/sub/${subToken}`;
  try {
    await send("PUT", `accounts/${account}/workers/domains`, { hostname, service: worker, zone_id: zone, enabled: true, previews_enabled: false });
    return { success: true, name: worker, url: `https://${hostname}`, subscriptionUrl: `https://${hostname}${subscriptionPath}` };
  } catch {
    return { success: true, name: worker, subscriptionPath, warning: "Worker 代码已部署，但域名绑定未完成。请在控制台为此 Worker 绑定所选域名，并保存下面的订阅路径；不要重复创建。" };
  }
}

async function main(args) {
  if (args.includes("--help")) { console.log("用法：设置 CLOUDFLARE_API_TOKEN 环境变量，然后运行 node deploy.mjs --account-id <ID> --zone-id <ID> --hostname <子域名> --worker-name <名称> [--third-party]\n输出订阅地址包含访问凭据，请妥善保存。"); return; }
  const values = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--third-party") { values.thirdParty = true; continue; }
    if (!["--account-id", "--zone-id", "--hostname", "--worker-name"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("参数无效，运行 --help 查看用法");
    values[args[i]] = args[++i];
  }
  const input = { accountId: values["--account-id"], zoneId: values["--zone-id"], hostname: values["--hostname"], workerName: values["--worker-name"], thirdParty: values.thirdParty === true };
  validateConfig(input);
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new Error("请设置 CLOUDFLARE_API_TOKEN 环境变量");
  const result = await deployVless(input, async (method, endpoint, body, query = {}) => {
    const url = new URL(`https://api.cloudflare.com/client/v4/${endpoint}`);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const multipart = body instanceof FormData;
    let response;
    try { response = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}`, ...(!multipart ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : multipart ? body : JSON.stringify(body) }); }
    catch { throw new Error("Cloudflare 网络请求失败或超时；请先检查云端状态再重试"); }
    const data = await response.json().catch(() => { throw new Error("Cloudflare 返回格式无效"); });
    if (!response.ok || data.success !== true) throw new Error(`Cloudflare HTTP ${response.status}；请检查 Token 权限和资源状态`);
    return data;
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
