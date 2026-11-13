import { expect, test } from "@playwright/test";

test("账号总览排除供应商关联账号，保留独立 API Key，供应商仍可管理", async ({ page }) => {
  await page.addInitScript(() => {
    const accounts = [
      { id: 1, label: "订阅账号", authMode: "chatgpt", plan: "plus" },
      { id: 2, label: "供应商账号", authMode: "apikey", plan: null },
      { id: 3, label: "独立 API Key", authMode: "apikey", plan: null },
    ].map(account => ({ ...account, email: null, accountId: null, note: "", tags: [], quota: { windows: [], fetchedAt: null }, lastError: null, updatedAt: 1 }));
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string) => {
        if (command === "codex_get_state") return { accounts, providerAccountIds: [2], cliAvailable: true, desktopAvailable: true, profileHome: "C:/fixture", currentAccountId: null, canRestore: false };
        if (command === "list_client_preferences") return {};
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "codex_config_source") return { path: "C:/fixture/config.toml", workspace: null, exists: true };
        if (command === "codex_gateway_state") return { running: false, accountIds: [], startupAccountIds: [2], completed: 0, failed: 0, active: 0 };
        if (command === "codex_provider_list") return [{ id: "provider", version: 1, name: "供应商配置", baseUrl: "https://example.test/v1", wireApi: "responses", models: [], note: "", keys: [{ id: "key", name: "默认密钥" }] }];
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  const overview = page.getByRole("tabpanel", { name: "账号总览", exact: true });
  await expect(overview.locator('article[aria-label^="Codex 账号 "]')).toHaveCount(2);
  await expect(overview.getByRole("article", { name: "Codex 账号 供应商账号", exact: true })).toHaveCount(0);
  await expect(overview.getByRole("article", { name: "Codex 账号 独立 API Key", exact: true })).toBeVisible();
  await expect(overview.getByRole("group", { name: "账号分组" }).getByRole("button", { name: "全部 2", exact: true })).toBeVisible();
  await expect(page.getByLabel("API 服务概览", { exact: true })).toContainText("供应商账号");
  await overview.getByRole("button", { name: "表格视图", exact: true }).click();
  await expect(overview.getByText("供应商账号", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "模型供应商", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "模型供应商", exact: true })).toContainText("供应商配置");
});
