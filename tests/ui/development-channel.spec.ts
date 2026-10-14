import { expect, test } from "@playwright/test";

for (const development of [true, false]) {
  test(`${development ? "开发版禁用" : "正式版保留"}更新渠道`, async ({ page }) => {
    await page.addInitScript((development) => {
      const calls: string[] = [];
      Object.assign(window, { channelCalls: calls, __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string) => {
          calls.push(command);
          if (command === "app_is_development") return development;
          if (command === "plugin:app|version") return "0.1.53";
          if (command === "plugin:updater|check") return null;
          if (command === "authenticator_status") return { configured: false, unlocked: false };
          return [];
        },
      } });
    }, development);
    await page.goto("/");
    await page.locator("button:visible").filter({ hasText: "设置" }).last().click();
    const check = page.getByRole("button", { name: "检查更新", exact: true });
    if (development) {
      await expect(page.locator(".ide-topbar-brand")).toContainText("开发版");
      await expect(page.getByText(/独立数据目录 · 正式版更新已禁用/)).toBeVisible();
      await expect(page.getByText("系统应用数据目录 / CloudHubTools-Dev / cloudhub_tools.sqlite3", { exact: true })).toBeVisible();
      await expect(check).toBeDisabled();
      expect(await page.evaluate(() => (window as any).channelCalls.filter((call: string) => call.startsWith("plugin:updater|")))).toEqual([]);
      await page.screenshot({ path: "test-results/development-channel.png" });
    } else {
      await expect(page.locator(".ide-topbar-brand")).not.toContainText("开发版");
      await expect(check).toBeEnabled();
      await check.click();
      await expect.poll(() => page.evaluate(() => (window as any).channelCalls.filter((call: string) => call === "plugin:updater|check").length)).toBeGreaterThanOrEqual(2);
    }
  });
}
