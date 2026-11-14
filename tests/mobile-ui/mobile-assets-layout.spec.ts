import { expect, test } from "@playwright/test";

test("资产卡片紧凑排列，筛选、收藏和操作入口正常", async ({ page }) => {
  const accounts = [{ id: 1, account_name: "演示阿里云", cloud_type: "aliyun", enabled: true, sort_order: 0 }, { id: 2, account_name: "演示腾讯云", cloud_type: "tencent", enabled: true, sort_order: 1 }];
  const name = "esa-site-a-long-resource-name-for-mobile-layout-check";
  const assets = [{ account_id: 1, resource_type: "esa", asset_key: name, region_id: "", payload: { SiteName: name, Status: "active" }, fetched_at: 1700000000 }, { account_id: 2, resource_type: "esa", asset_key: "demo-edge-site", region_id: "ap-shanghai", payload: { SiteName: "演示边缘站点", Status: "unknown" }, fetched_at: 1700000000 }, { account_id: 1, resource_type: "ecs", asset_key: "demo-server", region_id: "cn-beijing", payload: { InstanceName: "演示服务器", Status: "Running" }, fetched_at: 1700000000 }];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: url.pathname === "/api/member" ? null : url.pathname === "/api/accounts" ? accounts : url.pathname === "/api/local-assets" ? assets.filter(asset => !url.searchParams.get("resource_type") || asset.resource_type === url.searchParams.get("resource_type")) : url.pathname === "/api/preferences" ? {} : [] });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /我的资产/ }).click();
  await expect(page.locator(".mobile-asset-card")).toHaveCount(3);
  await page.getByLabel("筛选资产类型", { exact: true }).selectOption("esa");
  await expect(page.locator(".mobile-asset-card")).toHaveCount(2);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => document.body.classList.toggle("theme-light", value === "light"), theme);
    for (const width of [320, 390, 450, 768]) {
      await page.setViewportSize({ width, height: 838 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const card = page.locator(".mobile-asset-card").first();
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const buttons = card.locator(".mobile-asset-card-actions button");
      const first = (await buttons.nth(0).boundingBox())!;
      const second = (await buttons.nth(1).boundingBox())!;
      expect(Math.abs(first.y - second.y)).toBeLessThan(1);
      expect(first.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(first.width - second.width)).toBeLessThan(1);
    }
    await page.setViewportSize({ width: 450, height: 838 });
    await page.locator(".mobile-content").evaluate(el => el.scrollTo(0, 0));
    await page.screenshot({ path: `test-results/mobile-assets-refined-${theme}.png`, animations: "disabled" });
  }
  await page.getByLabel("筛选云账号", { exact: true }).selectOption("1");
  await expect(page.locator(".mobile-asset-card")).toHaveCount(1);
  await page.getByRole("button", { name: `收藏 ${name}`, exact: true }).click();
  await page.getByRole("tab", { name: /我的收藏/ }).click();
  await expect(page.locator(".mobile-asset-card")).toHaveCount(1);
  await page.getByRole("button", { name: `取消收藏 ${name}`, exact: true }).click();
  await expect(page.locator(".mobile-asset-card")).toHaveCount(0);
  await page.getByRole("tab", { name: "全部资产", exact: true }).click();
  await page.getByLabel("筛选资产类型", { exact: true }).selectOption("ecs");
  await page.getByRole("button", { name: "操作", exact: true }).click();
  await expect(page.getByRole("heading", { name: "云服务器", exact: true })).toBeVisible();
});
