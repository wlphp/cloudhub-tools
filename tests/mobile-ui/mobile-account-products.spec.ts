import { expect, test } from "@playwright/test";

test("account product counts show at most three nonempty products and hide on narrow screens", async ({ page }, testInfo) => {
  const accounts = [12, 13].map(id => ({
    id, account_name: `product-fixture-${id}`, cloud_type: "aliyun", enabled: true,
    sort_order: id, created_at: 1700000000000, updated_at: 1700000000000,
  }));
  const assets = Object.entries({ ecs: 5, domain: 4, oss: 3, rds: 2, unsupported: 10 })
    .flatMap(([resource_type, count]) => Array.from({ length: count }, (_, index) => ({
      account_id: 12, resource_type, asset_key: `${resource_type}-${index}`, payload: {}, fetched_at: 1700000000,
    })));
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  await page.route("**/api/accounts**", route => route.fulfill({ json: accounts }));
  await page.route("**/api/local-assets**", route => route.fulfill({ json: assets }));
  await page.setViewportSize({ width: 1080, height: 844 });
  await page.goto("/");
  const products = page.getByRole("group", { name: "product-fixture-12 产品统计" });
  await expect(products).toBeVisible();
  await expect(products.locator(".mobile-account-product")).toHaveText(["服务器5", "域名4", "对象存储3"]);
  await expect(page.locator('[aria-label="product-fixture-13 产品统计"]')).toHaveCount(0);

  const detailToggle = page.getByLabel("product-fixture-12 产品详情", { exact: true });
  const allProducts = page.locator('[aria-label="product-fixture-12 全部产品统计"]');
  await expect(allProducts).toBeHidden();
  await detailToggle.click();
  await expect(allProducts.locator("dt")).toHaveText(["服务器", "域名", "对象存储", "云数据库"]);
  await expect(allProducts.locator("dd")).toHaveText(["5", "4", "3", "2"]);

  for (const width of [600, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(products).toBeHidden();
    await expect(allProducts).toBeVisible();
    const menu = page.getByRole("button", { name: "展开 product-fixture-12 操作" });
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(page.getByRole("button", { name: "编辑本机账号 product-fixture-12" })).toBeVisible();
    const popup = page.getByRole("group", { name: "product-fixture-12 操作", exact: true });
    const triggerBox = await page.getByRole("button", { name: "收起 product-fixture-12 操作" }).boundingBox();
    const popupBox = await popup.boundingBox();
    expect(triggerBox && popupBox && Math.abs(popupBox.y - triggerBox.y - triggerBox.height - 4) < 1).toBe(true);
    await expect(popup.getByRole("button", { name: "删除本机账号 product-fixture-12" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    if (width === 390) await page.screenshot({ path: testInfo.outputPath("account-actions.png") });
    await page.getByRole("button", { name: "收起 product-fixture-12 操作" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1080, height: 844 });
  await expect(products).toBeVisible();
  await detailToggle.focus();
  await page.keyboard.press("Enter");
  await expect(allProducts).toBeHidden();
  await page.getByLabel("product-fixture-13 产品详情", { exact: true }).click();
  await expect(page.getByText("暂无缓存产品，请通过“获取资产”同步。", { exact: true })).toBeVisible();
});
