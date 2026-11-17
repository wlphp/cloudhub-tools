import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  test(`asset sync partial empty inventory remains readable in ${theme}`, async ({ page }) => {
    await page.addInitScript(({ theme }) => {
      localStorage.setItem("cloudhub-tools-ui-theme", theme);
      (window as any).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1, unregisterCallback: () => {},
        invoke: async (command: string) => {
          if (command === "list_accounts") return [{ id: 7, account_name: "volc-fixture", cloud_type: "volcengine", enabled: true, created_at: 1 }];
          if (command === "authenticator_status") return { configured: false, unlocked: false };
          if (command === "list_client_preferences") return {};
          if (command === "sync_cloud_assets") return { fetched: 0, counts: { ecs: 0, domain: 0, oss: 0, rds: 0, redis: 0 }, errors: ["rds: 云厂商权限不足，请检查账号权限"], fetched_at: 1 };
          return [];
        },
      };
    }, { theme });
    await page.goto("/");
    await page.getByRole("button", { name: "账号管理", exact: true }).click();
    await page.getByRole("button", { name: "获取 volc-fixture 资产", exact: true }).click();
    const dialog = page.locator(".asset-sync-modal");
    await expect(dialog.getByText("边缘安全加速", { exact: true })).toHaveCount(0);
    await expect(dialog).not.toContainText("CDN");
    await dialog.getByRole("button", { name: "开始获取并保存", exact: true }).click();
    const result = dialog.locator(".asset-sync-result");
    await expect(result).toContainText("部分资源获取失败");
    await expect(result.locator(".asset-result-counts > span").filter({ hasText: "服务器" })).toContainText("0 个");
    await expect(result.locator(".asset-result-counts > span").filter({ hasText: "云数据库" })).toContainText("未获取");
    await expect(dialog.getByText("轻量应用服务器", { exact: true })).toHaveCount(0);
    const colors = await result.evaluate(el => {
      const style = getComputedStyle(el);
      return [style.color, getComputedStyle(el.querySelector("strong")!).color, getComputedStyle(el.querySelector(".asset-sync-errors")!).color];
    });
    expect(new Set(colors).size).toBe(1);
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 980 });
      expect(await result.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await result.screenshot({ path: `test-results/asset-sync-${theme}.png` });
  });
}
