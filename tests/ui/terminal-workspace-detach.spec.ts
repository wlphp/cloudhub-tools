import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page, desktop = true) {
  await page.addInitScript(({ desktop }) => {
    const state = window as any;
    state.__popups = [];
    const callbacks = new Map<number, Function>();
    let next = 0;
    state.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    if (desktop) state.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: (callback: Function) => { callbacks.set(++next, callback); return next; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === "plugin:window|get_all_windows") return ["main", ...state.__popups.map((popup: Window) => popup.name)];
        if (command === "plugin:window|destroy") state.__popups.find((popup: Window) => popup.name === args.label)?.close();
        if (command === "plugin:event|listen") return ++next;
        if (command.startsWith("plugin:")) return null;
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        return [];
      },
    };
    const original = window.open.bind(window);
    window.open = (...args) => {
      if (state.__blockPopup) return null;
      const popup = original(...args);
      if (popup) state.__popups.push(popup);
      return popup;
    };
  }, { desktop });
  if (!desktop) await page.route("**/api/**", route => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "终端管理", exact: true }).click();
}

test("whole workbench moves with its live search, survives parent navigation, and docks back", async ({ page }) => {
  await setup(page);
  await page.getByPlaceholder("搜索服务器 IP / 名称").fill("保留搜索");
  const ready = page.waitForEvent("popup");
  await page.getByRole("button", { name: "独立窗口", exact: true }).click();
  const popup = await ready;
  await expect(popup.locator(".terminal-workbench")).toBeVisible();
  await expect(popup.getByPlaceholder("搜索服务器 IP / 名称")).toHaveValue("保留搜索");
  await expect(page.locator(".terminal-workbench")).toHaveCount(0);
  await page.getByRole("button", { name: "首页", exact: true }).first().click();
  await expect(popup.locator(".terminal-workbench")).toBeVisible();
  await popup.getByPlaceholder("搜索服务器 IP / 名称").fill("独立编辑");
  await page.getByRole("button", { name: "终端管理", exact: true }).click();
  await popup.getByRole("button", { name: "回到父页面", exact: true }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.getByPlaceholder("搜索服务器 IP / 名称")).toHaveValue("独立编辑");
});

test("both top blank areas detach on drag and a failed popup keeps the workbench", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).__blockPopup = true; });
  await page.getByRole("button", { name: "独立窗口", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("无法创建独立窗口");
  await expect(page.locator(".terminal-workbench")).toBeVisible();
  await page.evaluate(() => { (window as any).__blockPopup = false; });
  for (const selector of [".terminal-host-title-row", ".terminal-session-header .terminal-tabs"]) {
    const bounds = await page.locator(selector).boundingBox();
    if (!bounds) throw new Error("Missing drag region");
    const ready = page.waitForEvent("popup");
    await page.mouse.move(bounds.x + bounds.width * .55, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .55 + 45, bounds.y + bounds.height / 2 + 25, { steps: 5 });
    await page.mouse.up();
    const popup = await ready;
    await expect(popup.locator(".terminal-workbench")).toBeVisible();
    await popup.getByRole("button", { name: "回到父页面", exact: true }).click();
    await expect.poll(() => popup.isClosed()).toBe(true);
  }
});

test("browser preview does not offer native workbench detachment", async ({ page }) => {
  await setup(page, false);
  await expect(page.getByRole("button", { name: "独立窗口", exact: true })).toHaveCount(0);
});
