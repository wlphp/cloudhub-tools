import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

// Capture the real current UI with isolated, public demonstration data only.
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const desktopURL = process.env.CLOUDHUB_DESKTOP_URL ?? "http://127.0.0.1:1420";
const mobileURL = process.env.CLOUDHUB_MOBILE_URL ?? "http://127.0.0.1:4189";
for (const value of [desktopURL, mobileURL]) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("截图仅允许使用本机预览地址");
}
const timestamp = Date.parse("2026-10-30T09:30:00+08:00");
const accounts = [
  ["生产环境 · 阿里云", "aliyun", "生产环境", "cn-hangzhou"],
  ["业务平台 · 腾讯云", "tencent", "生产环境", "ap-shanghai"],
  ["海外节点 · AWS", "aws", "海外业务", "ap-southeast-1"],
  ["研发测试 · 华为云", "huawei", "研发测试", "cn-north-4"],
  ["边缘服务 · 火山引擎", "volcengine", "生产环境", "cn-beijing"],
].map(([account_name, cloud_type, group_name, region_id], i) => ({
  id: i + 1, account_name, cloud_type, group_name, region_id,
  access_key_id: "DEMO-ONLY", enabled: true, sort_order: i,
  remark: "公开演示数据", created_at: timestamp, updated_at: timestamp,
}));
const assets = [
  ...["web-prod-01", "api-prod-01", "worker-prod-01", "monitor-01"].map((name, i) => ({
    account_id: 1, resource_type: "ecs", asset_key: `i-demo-${i + 1}`, region_id: "cn-hangzhou",
    payload: { instanceId: `i-demo-${i + 1}`, instanceName: name, status: "Running", instanceType: "ecs.g7.large",
      cpu: 2, memory: 8192, osName: "Ubuntu 24.04 LTS", creationTime: "2026-01-01T00:00:00Z", expiredTime: "2027-12-31T00:00:00Z",
      publicIpAddress: { ipAddress: [`203.0.113.${10 + i}`] }, vpcAttributes: { privateIpAddress: { ipAddress: [`10.0.1.${10 + i}`] } } }, fetched_at: timestamp / 1000,
  })),
  ...["example.com", "cloudhub.example", "api.example.com"].map((name, i) => ({
    account_id: 1, resource_type: "domain", asset_key: name, region_id: "cn-hangzhou",
    payload: { DomainName: name, ExpirationDate: "2027-12-31", RegistrationDate: "2025-01-01", DomainStatus: "正常", InstanceId: `domain-demo-${i}` }, fetched_at: timestamp / 1000,
  })),
];
const hosts = assets.filter(a => a.resource_type === "ecs").map((a, i) => ({
  id: i + 1, name: a.payload.instanceName, host: `203.0.113.${10 + i}`, port: 22, username: "operator",
  platform: "linux", auth_method: "private_key", group_name: i < 2 ? "生产环境" : "基础服务",
  status: "online", password_saved: false, private_key_saved: true, metrics: {}, last_latency_ms: 18 + i,
  created_at: timestamp, updated_at: timestamp,
}));
const panels = hosts.slice(0, 3).map((h, i) => ({
  id: h.id, name: h.name, panel_url: `https://${h.host}:8888`, sort_order: i, allow_insecure_tls: false,
  group_name: h.group_name, api_key_saved: true, status: "online", last_checked_at: timestamp,
  summary: { version: "11.1.0", cpu: [12 + i * 7, 4], mem: { memTotal: 8192, memRealUsed: 2048 + i * 512 },
    disk: [{ path: "/", size: ["80 GB", "24 GB", "56 GB", "30%"] }], network: { up: 128, down: 512 }, load: { one: 0.21, five: 0.18, fifteen: 0.16 } },
  created_at: timestamp, updated_at: timestamp,
}));

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  await page.addInitScript(({ accounts, assets, hosts, panels, version }) => {
    localStorage.setItem("cloudhub-tools-ui-theme", "light");
    let outputDelivered = false;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command, args) => {
        if (command === "plugin:app|version") return version;
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        if (command === "list_accounts") return accounts;
        if (command === "list_local_assets") return assets.filter(a => (!args?.accountId || a.account_id === args.accountId) && (!args?.resourceType || a.resource_type === args.resourceType));
        if (command === "list_managed_hosts") return hosts;
        if (command === "list_panel_connections") return panels;
        if (command === "probe_managed_host") return hosts[0];
        if (command === "ssh_connect") return { sessionId: "public-demo-session" };
        if (command === "ssh_read") {
          if (outputDelivered) return "";
          outputDelivered = true;
          return "\u001b[32mWelcome to Ubuntu 24.04 LTS\u001b[0m\r\n\r\n System information · public demonstration\r\n\r\n  System load:  0.21          Processes:             126\r\n  Usage of /:   30% of 80GB  Memory usage:          25%\r\n  IPv4 address: 203.0.113.10 Uptime:                12 days\r\n\r\n\u001b[32moperator@web-prod-01\u001b[0m:~$ systemctl status nginx\r\n\u001b[32m●\u001b[0m nginx.service - A high performance web server\r\n     Loaded: loaded (/usr/lib/systemd/system/nginx.service; enabled)\r\n     Active: \u001b[32mactive (running)\u001b[0m\r\n\r\n\u001b[32moperator@web-prod-01\u001b[0m:~$ ";
        }
        if (command === "ssh_list_files") return { path: "/home/operator", entries: ["apps", "backups", "logs"].map(name => ({ name, path: `/home/operator/${name}`, isDir: true, isFile: false, size: 4096, mode: "755", owner: "operator", group: "operator", modified: "2026-10-30 09:30" })) };
        if (command === "notes_snapshot") return { notes: [], trashed: [], groups: [], reminders: [] };
        if (command === "claude_provider_list") return { providers: [
          { id: "claude-official", name: "Claude 官方", websiteUrl: "https://console.anthropic.com", baseUrl: "https://api.anthropic.com", keyConfigured: true, apiKeyField: "auth_token", apiFormat: "anthropic", isFullUrl: true, models: { sonnet: { model: "claude-sonnet-4-5" } }, extraEnv: {}, isCurrent: true },
          { id: "deepseek", name: "DeepSeek", websiteUrl: "https://platform.deepseek.com", baseUrl: "https://api.deepseek.com/anthropic", keyConfigured: false, apiKeyField: "auth_token", apiFormat: "anthropic", isFullUrl: true, models: { sonnet: { model: "deepseek-chat" } }, extraEnv: {}, isCurrent: false },
        ], currentId: "claude-official", settingsPath: "/home/demo/.claude/settings.json", settingsExists: true, hasBackup: true, backups: [], configurationStatus: "matched" };
        if (command === "claude_routing_state") return { mode: "direct", running: false, address: null, config: { port: 15721, routeProvider: "claude-official", defaultProvider: "claude-official", members: [], failover: false, queue: [], retries: 2, timeoutSecs: 600, firstByteSecs: 90, idleSecs: 180, failureThreshold: 8, cooldownSecs: 90, logging: true }, health: {}, logs: [], activeProvider: "", recoveryAvailable: false };
        if (command === "claude_workspace_state") return { project: null, settingsPath: "/home/demo/.claude/settings.json", mcpPath: "/home/demo/.claude.json", promptPath: "/home/demo/.claude/CLAUDE.md", mcp: [], prompts: [], activePrompt: null, skills: [], sessions: [], environmentConflicts: [] };
        return [];
      },
    };
  }, { accounts, assets, hosts, panels, version });
  page.on("pageerror", error => console.error("Desktop UI:", error.message));
  await page.goto(desktopURL, { waitUntil: "networkidle" });
  const capture = async name => {
    await page.locator("body.theme-light").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `docs/screenshots/${name}.png`, animations: "disabled" });
    console.log(`Captured ${name}`);
  };
  await page.getByRole("button", { name: "账号管理", exact: true }).waitFor();
  await capture("accounts");
  for (const [label, file] of [["资产管理", "resources"], ["面板管理", "panels"], ["终端管理", "terminal"], ["软件商店", "store"], ["Claude 管理", "claude"]]) {
    await page.getByRole("button", { name: label, exact: true }).first().click();
    if (file === "terminal") {
      await page.getByRole("button", { name: /选择服务器 web-prod-01/ }).dblclick();
      await page.locator(".xterm-rows").getByText("Welcome to Ubuntu 24.04 LTS", { exact: false }).waitFor();
    }
    if (file === "store") await page.getByRole("combobox", { name: "每页条数" }).selectOption("20");
    await capture(file);
  }
  await page.close();
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mobile.addInitScript(() => localStorage.setItem("cloudhub-tools-ui-theme", "light"));
  await mobile.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/accounts") return route.fulfill({ json: accounts });
    if (url.pathname === "/api/local-assets") return route.fulfill({ json: assets.filter(a => (!url.searchParams.get("resource_type") || a.resource_type === url.searchParams.get("resource_type")) && (!url.searchParams.get("account_id") || a.account_id === Number(url.searchParams.get("account_id")))) });
    return route.fulfill({ json: [] });
  });
  await mobile.goto(mobileURL, { waitUntil: "networkidle" });
  for (const [label, heading, file] of [[null, "云账号", "accounts"], ["服务器", "云服务器", "servers"], ["域名", "域名与 DNS", "domains"]]) {
    if (label) await mobile.getByRole("button", { name: label, exact: true }).click();
    await mobile.getByRole("heading", { name: heading, exact: true }).waitFor();
    await mobile.locator("body.theme-light").waitFor();
    await mobile.evaluate(() => document.fonts.ready);
    await mobile.screenshot({ path: `docs/screenshots/mobile-${file}.png`, animations: "disabled" });
    console.log(`Captured mobile-${file}`);
  }
} finally {
  await browser.close();
}
