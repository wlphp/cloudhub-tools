import { expect, test } from "@playwright/test";

for (const width of [375, 768, 1024, 1440]) {
  test(`resource filters align and remain usable at ${width}px`, async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1, unregisterCallback: () => {},
        invoke: async (command: string) => {
          if (command === "authenticator_status") return { configured: false, unlocked: false };
          if (command === "list_client_preferences") return {};
          if (command === "ai_list_profiles") return [{ id: "fixture-ai", name: "测试服务", protocol: "openai_chat", model: "fixture", enabled: true, isDefault: true, visionStatus: "supported" }];
          if (command === "list_accounts") return [{ id: 1, account_name: "生产账号", cloud_type: "aliyun", group_name: "生产", access_key_id: "fixture-id", enabled: true, sort_order: 1 }];
          if (command === "list_local_assets") return [{ account_id: 1, resource_type: "domain", asset_key: "fixture.test", fetched_at: 1, payload: { DomainName: "fixture.test", ExpiredTime: Date.now() + 10 * 86400000 } }];
          return [];
        },
      };
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "资产管理", exact: true }).click();
    await page.setViewportSize({ width, height: 900 });
    const filters = page.getByRole("group", { name: "资源筛选", exact: true });
    await expect(filters.getByRole("button", { name: "AI 自然语言筛选", exact: true })).toBeVisible();
    const dimensions = await filters.evaluate(el => {
      const bounds = el.getBoundingClientRect();
      const controls = Array.from(el.querySelectorAll("input,select,button")).map(control => {
        const rect = control.getBoundingClientRect();
        return { height: rect.height, top: rect.top, left: rect.left, right: rect.right };
      });
      return { controls, left: bounds.left, right: bounds.right, overflow: el.scrollWidth > el.clientWidth };
    });
    expect(dimensions.overflow).toBe(false);
    for (const control of dimensions.controls) {
      expect(control.left).toBeGreaterThanOrEqual(dimensions.left);
      expect(control.right).toBeLessThanOrEqual(dimensions.right);
      expect(control.height).toBe(32);
    }
    if (width === 1440) expect(new Set(dimensions.controls.map(control => Math.round(control.top))).size).toBe(1);
    await page.getByLabel("按账号分组筛选").selectOption("生产");
    await page.getByLabel("未来到期天数").fill("5");
    await expect(page.locator(".local-assets-panel tbody tr")).toHaveCount(0);
    await filters.getByRole("button", { name: "清除资源筛选", exact: true }).click();
    await expect(page.getByLabel("未来到期天数")).toHaveValue("");
    await expect(page.getByLabel("按账号分组筛选")).toHaveValue("");
    await expect(page.locator(".local-assets-panel tbody tr")).toHaveCount(1);
    await filters.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/resource-filters-${width}.png` });
  });
}
