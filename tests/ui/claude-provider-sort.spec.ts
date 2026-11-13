import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.addInitScript(() => {
    const providers = ["可见 Alpha", "隐藏 Beta", "可见 Gamma", "可见 Delta"].map((name, index) => ({ id: String(index + 1), name, description: "", websiteUrl: "", baseUrl: "https://example.com/anthropic", keyConfigured: false, apiKeyField: "auth_token", apiFormat: "anthropic", isFullUrl: true, models: {}, extraEnv: {}, isCurrent: false }));
    (window as any).sortActions = [];
    (window as any).failMove = 0;
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string, args: any) => {
        if (command === "list_client_preferences") return {};
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "claude_provider_list") {
          const order: string[] = JSON.parse(localStorage.getItem("fixture-claude-order") || '["1","2","3","4"]');
          return { providers: order.map(id => providers.find(provider => provider.id === id)), currentId: null, settingsPath: "C:/fixture/settings.json", settingsExists: true, hasBackup: false, backups: [], configurationStatus: "matched" };
        }
        if (command === "claude_provider_action") {
          (window as any).sortActions.push(args.action);
          if (args.action.type !== "move") throw new Error("排序只能调用已有移动接口");
          if ((window as any).failMove === (window as any).sortActions.length) throw new Error("保存排序失败（测试）");
          const order: string[] = JSON.parse(localStorage.getItem("fixture-claude-order") || '["1","2","3","4"]');
          const source = order.indexOf(args.action.id), target = source + args.action.offset;
          [order[source], order[target]] = [order[target], order[source]];
          localStorage.setItem("fixture-claude-order", JSON.stringify(order));
          return null;
        }
        if (["claude_provider_save", "claude_provider_switch", "claude_routing_save", "claude_routing_activate"].includes(command)) throw new Error("排序不应触发配置写入");
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Claude 管理", exact: true }).first().click();
  await expect(page.locator("[data-claude-provider-sort-id]")).toHaveCount(4);
}

const order = (page: Page) => page.locator("[data-claude-provider-sort-id]").evaluateAll(items => items.map(item => item.getAttribute("data-claude-provider-sort-id")));
async function drag(page: Page, source: number, target: number) {
  const rows = page.locator("[data-claude-provider-sort-id]");
  const from = (await rows.nth(source).locator(".claude-provider-drag-handle").boundingBox())!;
  const to = (await rows.nth(target).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, { steps: 12 });
  await expect(page.locator("[data-sortable-dragging]")).toHaveCount(1);
}

test("Claude 直连列表显式排序、保留勾选并通过已有接口持久化", async ({ page }) => {
  await fixture(page);
  await expect(page.locator(".claude-provider-drag-handle")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "选择 可见 Alpha", exact: true }).check();
  await page.getByRole("button", { name: "Claude 供应商排序", exact: true }).click();
  await expect(page.locator(".claude-provider-select")).toHaveCount(0);
  await drag(page, 0, 3);
  expect(await order(page)).toEqual(["1", "2", "3", "4"]);
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(["2", "3", "4", "1"]);
  await expect(page.getByText("供应商顺序已保存", { exact: true })).toBeVisible();
  const actions = await page.evaluate(() => (window as any).sortActions);
  expect(actions).toHaveLength(3);
  expect(actions.every((action: any) => action.type === "move" && action.offset === -1)).toBe(true);
  await page.getByRole("button", { name: "退出Claude 供应商排序", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "选择 可见 Alpha", exact: true })).toBeChecked();
  await page.reload();
  await page.getByRole("button", { name: "Claude 管理", exact: true }).first().click();
  await expect.poll(() => order(page)).toEqual(["2", "3", "4", "1"]);
  await expect(page.locator(".claude-provider-drag-handle")).toHaveCount(0);
});

test("筛选内排序保留隐藏供应商位置，Escape 不保存", async ({ page }) => {
  await fixture(page);
  await page.getByRole("searchbox", { name: "搜索供应商", exact: true }).fill("可见");
  await page.getByRole("button", { name: "Claude 供应商排序", exact: true }).click();
  await drag(page, 0, 2);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).sortActions)).toEqual([]);
  await expect.poll(() => page.locator("[data-claude-provider-sort-id]").evaluateAll(items => items.every(item => !item.getAnimations().length))).toBe(true);
  await drag(page, 0, 2);
  await page.mouse.up();
  await expect(page.getByText("供应商顺序已保存", { exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "搜索供应商", exact: true }).fill("");
  await expect.poll(() => order(page)).toEqual(["3", "2", "4", "1"]);
});

test("保存中途失败回读真实顺序并展示错误", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { (window as any).failMove = 2; });
  await page.getByRole("button", { name: "Claude 供应商排序", exact: true }).click();
  await drag(page, 0, 3);
  await page.mouse.up();
  await expect(page.getByText("保存排序失败（测试）", { exact: true })).toBeVisible();
  await expect.poll(() => order(page)).toEqual(["2", "1", "3", "4"]);
  await expect(page.getByText("供应商顺序已保存", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "退出Claude 供应商排序", exact: true })).toBeEnabled();
});
