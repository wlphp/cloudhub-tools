import { test, expect } from "@playwright/test";

test("FRP client settings stay discoverable and workspace fits supported widths", async ({ page }) => {
  await page.addInitScript(() => {
    const server = { id: 1, name: "test-frp", serverAddr: "127.0.0.1", serverPort: 7000, tokenSaved: false, panelUrl: null, panelUsername: null, panelPasswordSaved: false, adminPort: 7400, proxies: [{ id: 1, serverId: 1, name: "web", kind: "http", localIp: "127.0.0.1", localPort: 3000, customDomain: "web.example.test", enabled: true }], updatedAt: 0 };
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string) => {
          if (command === "list_frp_servers") return [server, { ...server, id: 2, name: "backup-frp", serverAddr: "frp.example.test", adminPort: 7401, proxies: [] }];
          if (command === "get_frp_global_settings") return { adminUser: "admin", adminPasswordSaved: false };
          if (command === "get_frpc_runtime") return [{ serverId: 1, installed: true, configPresent: true, configCurrent: true, running: false, connected: false, version: "0.71.0", proxies: [] }];
          if (command === "get_frp_local_paths") return new Promise((resolve) => { Object.assign(window, { __resolveLocalPaths: resolve }); });
          if (command === "plugin:app|version") return "0.1.91";
          if (command === "plugin:updater|check") return null;
          if (command === "plugin:event|listen") return 1;
          return [];
        },
      },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "内网穿透", exact: true }).first().click();
  await expect(page.getByLabel("FRP 客户端管理")).toBeHidden();
  await expect(page.getByText("首次连接前，请设置本机客户端面板账号。")).toBeVisible();
  await page.getByRole("button", { name: "设置面板账号" }).click();
  await expect(page.getByLabel("FRP 客户端管理")).toBeVisible();
  await expect(page.getByRole("heading", { name: "全局 frp 客户端面板设置" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "穿透规则 · test-frp" })).toBeVisible();
  await page.getByRole("button", { name: "收起客户端管理" }).click();
  await page.evaluate(() => (window as unknown as { __resolveLocalPaths: (value: unknown) => void }).__resolveLocalPaths({ installed: false, version: null, binaryPath: "frpc.exe", configPath: null }));
  await expect(page.getByLabel("FRP 客户端管理")).toBeHidden();

  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The detail pane must not inherit the outer application's main padding.
    await expect(page.locator(".frp-server-content")).toHaveCSS("padding", "0px");
    await expect(page.locator(".frp-server-content main")).toHaveCount(0);
  }

  const navigator = await page.getByLabel("FRP 服务端选择").boundingBox();
  const workspace = await page.locator(".frp-server-content").boundingBox();
  expect(navigator).not.toBeNull();
  expect(workspace).not.toBeNull();
  expect(workspace!.y).toBeGreaterThanOrEqual(navigator!.y + navigator!.height);
  expect(Math.abs(workspace!.x - navigator!.x)).toBeLessThan(2);
  expect(Math.abs(workspace!.width - navigator!.width)).toBeLessThan(2);
  const serverTabs = page.getByRole("tablist", { name: "服务端项" }).getByRole("tab");
  const firstServer = await serverTabs.nth(0).boundingBox();
  const secondServer = await serverTabs.nth(1).boundingBox();
  expect(Math.abs(firstServer!.y - secondServer!.y)).toBeLessThan(2);
  expect(secondServer!.x).toBeGreaterThan(firstServer!.x);
  // The selector should end just below the cards, without a stretched empty row.
  expect(navigator!.y + navigator!.height - firstServer!.y - firstServer!.height).toBeLessThan(20);
  expect(workspace!.y - navigator!.y - navigator!.height).toBeLessThan(2);
  await page.screenshot({ path: "test-results/frp-workspace.png", fullPage: true, animations: "disabled" });
  await page.evaluate(() => {
    document.body.classList.add("theme-light");
    document.querySelector(".app-shell")?.classList.add("theme-light");
  });
  await page.screenshot({ path: "test-results/frp-workspace-light.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "新增规则", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新增穿透规则" });
  await expect(editor).toBeVisible();
  const editorBounds = await editor.boundingBox();
  expect(editorBounds!.width).toBeLessThanOrEqual(560);
  expect(editorBounds!.height).toBeLessThan(620);
  const checkbox = await editor.getByRole("checkbox", { name: "启用规则" }).boundingBox();
  const enabledLabel = await editor.locator(".frp-editor-enabled>span").boundingBox();
  expect(checkbox!.width).toBeLessThanOrEqual(20);
  expect(checkbox!.x + checkbox!.width).toBeLessThan(enabledLabel!.x);
  await page.screenshot({ path: "test-results/frp-rule-editor-light.png", animations: "disabled" });
  await page.mouse.click(5, 5);
  await expect(editor).toBeVisible();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
});
