import { test, expect } from "@playwright/test";

test("edits legacy rules and saves multi-domain HTTPS to HTTP plugin settings", async ({ page }) => {
  await page.addInitScript(() => {
    let certificateSelections = 0;
    let server = { id: 1, name: "fixture-frp", serverAddr: "127.0.0.1", serverPort: 7000, tokenSaved: false, panelUrl: null, panelUsername: null, panelPasswordSaved: false, adminPort: 7400, updatedAt: 0, proxies: [{ id: 1, serverId: 1, name: "legacy", kind: "https", localIp: "127.0.0.1", localPort: 443, customDomain: "legacy.example.test", enabled: true }] as Record<string, unknown>[] };
    Object.assign(window, {
      __frpSavedProxies: () => server.proxies,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string, args: { kind?: string; input?: { proxies: Record<string, unknown>[] } }) => {
          if (command === "select_frp_tls_file") {
            if (args.kind === "certificate") return certificateSelections++ === 0 ? "C:\\ssl\\fullchain.pem" : null;
            return "C:\\ssl\\privkey.key";
          }
          if (command === "list_frp_servers") return [server];
          if (command === "get_frp_global_settings") return { adminUser: "admin", adminPasswordSaved: true };
          if (command === "get_frpc_runtime") return [{ serverId: 1, installed: true, configPresent: true, configCurrent: true, running: false, connected: false, version: "0.71.0", proxies: [] }];
          if (command === "get_frp_local_paths") return { installed: true, version: "0.71.0", binaryPath: "frpc.exe", configPath: "frpc.toml" };
          if (command === "save_frp_server") { server = { ...server, proxies: args.input!.proxies.map((proxy, index) => ({ ...proxy, id: index + 1 })) }; return server; }
          if (command === "plugin:app|version") return "0.1.35";
          if (command === "plugin:updater|check") return null;
          if (command === "plugin:event|listen") return 1;
          return [];
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "内网穿透", exact: true }).first().click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByLabel("访问域名（可多个）")).toHaveValue("legacy.example.test");
  await expect(page.getByLabel("客户端插件")).toHaveValue("none");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "新增规则", exact: true }).click();
  await page.getByLabel("规则名称").fill("jenkins_https2http");
  await page.getByLabel("协议类型").selectOption("https");
  await page.getByLabel("本地端口", { exact: true }).fill("5012");
  await page.getByLabel("访问域名（可多个）").fill("one.example.test, two.example.test");
  await page.getByLabel("客户端插件").selectOption("https2http");
  await expect(page.getByLabel("插件 HTTP 后端地址")).toHaveValue("127.0.0.1:5012");
  await page.getByRole("button", { name: "选择证书文件", exact: true }).click();
  await expect(page.getByLabel("证书文件路径（crtPath）")).toHaveValue("C:\\ssl\\fullchain.pem");
  await page.getByRole("button", { name: "选择私钥文件", exact: true }).click();
  await expect(page.getByLabel("私钥文件路径（keyPath）")).toHaveValue("C:\\ssl\\privkey.key");
  await page.getByRole("button", { name: "选择证书文件", exact: true }).click();
  await expect(page.getByRole("button", { name: "选择证书文件", exact: true })).toBeEnabled();
  await expect(page.getByLabel("证书文件路径（crtPath）")).toHaveValue("C:\\ssl\\fullchain.pem");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const bounds = await page.getByRole("dialog").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.width).toBeLessThanOrEqual(width);
  }
  await page.screenshot({ path: "test-results/frp-https2http-editor.png" });
  await page.getByRole("button", { name: "保存规则", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const saved = await page.evaluate(() => (window as unknown as { __frpSavedProxies: () => Record<string, unknown>[] }).__frpSavedProxies());
  expect(saved[1].customDomains).toEqual(["one.example.test", "two.example.test"]);
  expect(saved[1].plugin).toEqual({ type: "https2http", localAddr: "127.0.0.1:5012", crtPath: "C:\\ssl\\fullchain.pem", keyPath: "C:\\ssl\\privkey.key" });
  expect(saved[0].customDomain).toBe("legacy.example.test");
  await page.getByRole("button", { name: "编辑", exact: true }).nth(1).click();
  await expect(page.getByLabel("访问域名（可多个）")).toHaveValue("one.example.test, two.example.test");
  await expect(page.getByLabel("私钥文件路径（keyPath）")).toHaveValue("C:\\ssl\\privkey.key");
  await page.getByLabel("协议类型").selectOption("http");
  await expect(page.getByLabel("客户端插件")).toHaveCount(0);
  await page.getByLabel("访问域名（可多个）").fill("three.example.test");
  await page.getByRole("button", { name: "保存规则", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const switched = await page.evaluate(() => (window as unknown as { __frpSavedProxies: () => Record<string, unknown>[] }).__frpSavedProxies());
  expect(switched[1].plugin).toBeNull();
});
