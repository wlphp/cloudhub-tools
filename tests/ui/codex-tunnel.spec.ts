import { test, expect } from "@playwright/test";

test("API tunnel is disabled by default and shares its managed state with FRP", async ({ page }) => {
  await page.addInitScript(() => {
    const calls: { command: string; args: any }[] = [];
    const config = { enabled: false, mode: "https", serverId: null, domain: "", publicPort: 443, certificatePath: "", privateKeyPath: "", trustedCaPath: "", tlsServerName: "", ruleName: "" };
    const tunnel = { config, installed: true, running: false, connected: false, localPort: 58169, publicUrl: null, error: null, logs: [] } as any;
    const account = { id: 1, label: "fixture", authMode: "chatgpt", plan: "plus", note: "", tags: [], quota: { windows: [], fetchedAt: null }, updatedAt: 1 };
    const gateway = { running: true, address: "http://127.0.0.1:58169/v1", accountIds: [1], startupAccountIds: [1], completed: 0, failed: 0, active: 0, configuredPort: 58169, supportsConfigSave: true, settings: { loggingEnabled: false, strategy: "round_robin", cooldownSeconds: 60 } };
    Object.assign(window, { __failTunnel: false, __tunnelCalls: calls, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {}, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: any = {}) => {
        calls.push({ command, args });
        if (command === "codex_get_state") return { accounts: [account], cliAvailable: true, desktopAvailable: true, profileHome: "fixture", currentAccountId: null, canRestore: false };
        if (command === "codex_gateway_state") return gateway;
        if (command === "codex_tunnel_state") return tunnel;
        if (command === "codex_tunnel_save") {
          if (args.config.enabled && args.config.mode === "https" && (!args.config.certificatePath || !args.config.privateKeyPath)) throw { code: "certificate", message: "请选择 HTTPS 证书和私钥文件" };
          Object.assign(config, args.config, { ruleName: "cloudhub-api-fixture" });
          const defaultPort = config.mode === "https" ? 443 : 80;
          Object.assign(tunnel, { running: config.enabled, connected: config.enabled, publicUrl: config.enabled ? `${config.mode === "https" ? "https" : "http"}://${config.domain || "frps.example.test"}${config.publicPort === defaultPort ? "" : `:${config.publicPort}`}/v1` : null }); return tunnel;
        }
        if (command === "codex_tunnel_retry") { const failed = (window as any).__failTunnel; Object.assign(tunnel, { error: failed ? "启动穿透失败" : null, connected: !failed, running: !failed }); return tunnel; }
        if (command === "list_frp_servers") return [{ id: 7, name: "测试 frps", serverAddr: "frps.example.test", serverPort: 7000, tokenSaved: true, proxies: [], adminPort: 7400 }];
        if (command === "get_frpc_runtime") return [];
        if (command === "get_frp_global_settings") return null;
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "plugin:updater|check") return null;
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  await page.getByRole("tab", { name: "API 反代服务", exact: true }).click();
  const panel = page.getByRole("region", { name: "API 内网穿透配置", exact: true });
  const toggle = panel.getByRole("switch", { name: "启用 API 内网穿透", exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(panel.getByLabel("API 穿透公网域名")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__tunnelCalls.filter((call: any) => call.command === "codex_tunnel_save").length)).toBe(0);
  await toggle.check();
  await panel.getByLabel("API 穿透 frps 连接").selectOption("7");
  await panel.getByLabel("API 穿透公网域名").fill("api.example.test");
  await panel.getByRole("button", { name: "保存穿透配置", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("请选择 HTTPS 证书和私钥文件");
  await panel.getByLabel("API 穿透证书路径").fill("C:\\fixture\\cert.pem");
  await panel.getByLabel("API 穿透私钥路径").fill("C:\\fixture\\key.pem");
  await panel.getByRole("button", { name: "保存穿透配置", exact: true }).click();
  await expect(panel).toContainText("https://api.example.test/v1");
  await expect(panel).toContainText("127.0.0.1:58169");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await panel.locator(".codex-tunnel-fields").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await panel.screenshot({ path: "test-results/codex-api-tunnel.png" });
  await panel.getByLabel("API 穿透模式").selectOption("http");
  await expect(panel.getByLabel("API 穿透证书路径")).toHaveCount(0);
  await expect(panel.getByLabel("API 穿透公网端口")).toHaveValue("80");
  await panel.getByLabel("API 穿透公网端口").fill("8080");
  await panel.getByRole("button", { name: "保存穿透配置", exact: true }).click();
  await expect(panel).toContainText("http://api.example.test:8080/v1");
  await panel.getByLabel("API 穿透模式").selectOption("tcp");
  await panel.getByLabel("API 穿透公网域名").fill("");
  await expect(panel).toContainText("TCP 远端端口");
  await panel.getByRole("button", { name: "保存穿透配置", exact: true }).click();
  await expect(panel).toContainText("http://frps.example.test:6000/v1");
  await panel.screenshot({ path: "test-results/codex-tunnel-tcp.png" });
  await panel.getByLabel("API 穿透模式").selectOption("https");
  await panel.getByLabel("API 穿透公网域名").fill("api.example.test");
  await expect(panel.getByLabel("API 穿透证书路径")).toHaveValue("C:\\fixture\\cert.pem");
  await panel.getByRole("button", { name: "保存穿透配置", exact: true }).click();
  await page.evaluate(() => { (window as any).__failTunnel = true; });
  await panel.getByRole("button", { name: "重试穿透", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("启动穿透失败");
  expect(await page.evaluate(() => (window as any).__tunnelCalls.filter((call: any) => call.command === "codex_gateway_stop").length)).toBe(0);
  await page.evaluate(() => { (window as any).__failTunnel = false; });
  await panel.getByRole("button", { name: "重试穿透", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "内网穿透", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Codex API 托管穿透", exact: true })).toContainText("https://api.example.test/v1");
  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  await page.getByRole("tab", { name: "API 反代服务", exact: true }).click();
  await toggle.uncheck();
  await expect(panel).toContainText("未开启");
});
