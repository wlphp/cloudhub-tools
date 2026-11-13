import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await page.addInitScript(() => {
    const assets = Array.from({ length: 12 }, (_, index) => ({ account_id: 1, resource_type: "domain", asset_key: `domain-${index}`, fetched_at: 1, payload: { DomainName: `domain-${index}.example` } }));
    localStorage.setItem("cloudhub-tools-favorite-assets", JSON.stringify(assets.map(asset => `1:domain:${asset.asset_key}`)));
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string) => {
        if (command === "list_accounts") return [1, 2, 3].map(id => ({ id, account_name: `测试账号 ${id}`, cloud_type: "aliyun", enabled: true, access_key_id: "", created_at: 1 }));
        if (command === "list_local_assets") return assets;
        if (command === "list_client_preferences") return {};
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_panel_connections") return [1, 2, 3].map(id => ({ id, name: `测试面板 ${id}`, panel_url: `https://192.0.2.${id}:8888`, status: "unknown", summary: {}, created_at: 1 }));
        if (command === "list_managed_hosts") return [1, 2, 3, 4].map(id => ({ id, name: `测试主机 ${id}`, host: `192.0.2.${id}`, platform: "linux", username: "operator", port: 22, group_name: id < 3 ? "分组 A" : "分组 B", status: "unknown" }));
        if (command === "codex_get_state") return { accounts: [], cliAvailable: true, desktopAvailable: true, currentAccountId: null, canRestore: false };
        if (command === "codex_gateway_state") return { running: false, accountIds: [], completed: 0, failed: 0, active: 0 };
        if (command === "codex_provider_list") return [1, 2, 3].map(id => ({ id: `provider-${id}`, version: 1, name: `测试供应商 ${id}`, baseUrl: "https://example.com/v1", wireApi: "responses", models: [], note: "", keys: [] }));
        return [];
      },
    };
  });
  await page.goto("/");
}

for (const entry of [
  { page: "账号管理", label: "账号", rows: "[data-account-sort-id]", check: ".account-select input", all: "全选当前页账号", handles: ".account-drag-handle" },
  { page: "资产管理", label: "资产", rows: "[data-asset-row-key]", check: ".asset-order-cell input", all: "全选当前页资产", handles: ".asset-drag-handle" },
  { page: "我的收藏", label: "收藏", rows: "[data-favorite-asset-key]", check: ".favorite-card-account input", all: "全选当前页收藏", handles: ".favorite-card-drag-handle" },
  { page: "面板管理", label: "面板", rows: "[data-panel-id]", check: ".panel-row-order input", all: "全选当前页面板", handles: ".panel-drag-handle" },
]) {
  test(`${entry.page} 默认勾选与全选，显式排序后才显示手柄并保留选择`, async ({ page }) => {
    await fixture(page);
    await page.getByRole("button", { name: entry.page, exact: true }).first().click();
    const rows = page.locator(entry.rows);
    const checks = rows.locator(entry.check);
    const all = page.getByRole("checkbox", { name: entry.all, exact: true });
    await expect(checks.first()).toBeVisible();
    await expect(page.locator(entry.handles)).toHaveCount(0);
    const initialOrder = await rows.evaluateAll(elements => elements.map(element => element.textContent));
    await checks.first().check();
    await expect(all).toHaveJSProperty("indeterminate", true);
    await all.check();
    expect(await checks.evaluateAll(elements => elements.every(element => (element as HTMLInputElement).checked))).toBe(true);
    await page.getByRole("button", { name: `${entry.label}排序`, exact: true }).click();
    await expect(checks).toHaveCount(0);
    await expect(page.locator(entry.handles)).toHaveCount(await rows.count());
    await page.getByRole("button", { name: `退出${entry.label}排序`, exact: true }).click();
    await expect(page.locator(entry.handles)).toHaveCount(0);
    expect(await checks.evaluateAll(elements => elements.every(element => (element as HTMLInputElement).checked))).toBe(true);
    expect(await rows.evaluateAll(elements => elements.map(element => element.textContent))).toEqual(initialOrder);
    await all.uncheck();
    expect(await checks.evaluateAll(elements => elements.every(element => !(element as HTMLInputElement).checked))).toBe(true);
  });
}

test("资产全选只影响当前页，筛选与分页保留其他页的勾选", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "资产管理", exact: true }).first().click();
  const all = page.getByRole("checkbox", { name: "全选当前页资产", exact: true });
  await all.check();
  await page.getByRole("button", { name: "第 2 页", exact: true }).click();
  const checks = page.locator(".asset-order-cell input");
  await expect(checks).toHaveCount(2);
  await expect(checks.first()).not.toBeChecked();
  await checks.first().check();
  await page.getByRole("button", { name: "第 1 页", exact: true }).click();
  await expect(all).toBeChecked();
  await page.getByRole("textbox", { name: "搜索资产", exact: true }).fill("domain-0");
  await all.uncheck();
  await page.getByRole("textbox", { name: "搜索资产", exact: true }).fill("");
  await expect(all).toHaveJSProperty("indeterminate", true);
  await expect(page.locator('[data-asset-row-key="1:domain:domain-1"] input')).toBeChecked();
  await page.getByRole("button", { name: "第 2 页", exact: true }).click();
  await expect(checks.first()).toBeChecked();
  await expect(checks.nth(1)).not.toBeChecked();
});

test("终端管理不显示复选框，排序模式显示主机及分组手柄", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "终端管理", exact: true }).first().click();
  await expect(page.locator(".terminal-host-drag-handle,.terminal-group-drag-handle")).toHaveCount(0);
  await expect(page.locator(".terminal-selection-bar input[type=checkbox], .terminal-host-tree input[type=checkbox]")).toHaveCount(0);
  await page.getByRole("button", { name: "服务器排序", exact: true }).click();
  await expect(page.locator(".terminal-host-drag-handle")).toHaveCount(4);
  await expect(page.locator(".terminal-group-drag-handle")).toHaveCount(2);
  await expect(page.locator(".terminal-host-tree input[type=checkbox]")).toHaveCount(0);
  await page.getByRole("button", { name: "退出服务器排序", exact: true }).click();
  await expect(page.locator(".terminal-selection-bar input[type=checkbox], .terminal-host-tree input[type=checkbox]")).toHaveCount(0);
});

test("供应商默认选择导出与全选，退出排序后恢复选择", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  await page.getByRole("tab", { name: "模型供应商", exact: true }).click();
  const checks = page.locator(".codex-provider-row > input[type=checkbox]");
  await expect(checks).toHaveCount(3);
  await expect(page.locator(".codex-provider-reorder-handle")).toHaveCount(0);
  const all = page.getByRole("checkbox", { name: "全选当前结果供应商", exact: true });
  await checks.first().check();
  await expect(all).toHaveJSProperty("indeterminate", true);
  await all.check();
  await page.getByRole("button", { name: "供应商排序", exact: true }).click();
  await expect(checks).toHaveCount(0);
  await expect(page.locator(".codex-provider-reorder-handle")).toHaveCount(3);
  await page.getByRole("button", { name: "退出供应商排序", exact: true }).click();
  expect(await checks.evaluateAll(elements => elements.every(element => (element as HTMLInputElement).checked))).toBe(true);
  await expect(page.getByRole("button", { name: "导出选中（3）", exact: true })).toBeEnabled();
});
