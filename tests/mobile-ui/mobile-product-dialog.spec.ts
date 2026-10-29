import { expect, test } from "@playwright/test";

for (const { width, height, theme } of [{ width: 375, height: 844, theme: "light" }, { width: 375, height: 844, theme: "dark" }, { width: 768, height: 844, theme: "light" }, { width: 844, height: 390, theme: "dark" }]) {
  test(`account products open scoped operation dialogs at ${width}px in ${theme}`, async ({ page }, testInfo) => {
    page.on("pageerror", error => { throw error; });
    await page.setViewportSize({ width, height });
    await page.addInitScript(value => localStorage.setItem("cloudhub-tools-ui-theme", value), theme);
    const accounts = [12, 13].map(id => ({ id, account_name: `account-${id}`, cloud_type: "aliyun", enabled: true, sort_order: id }));
    const assets = [12, 13].flatMap(account_id => [
      { account_id, resource_type: "domain", asset_key: `domain-${account_id}`, payload: { DomainName: `example-${account_id}.test` }, fetched_at: 1700000000 },
      { account_id, resource_type: "ecs", asset_key: `server-${account_id}`, payload: { InstanceName: `server-${account_id}`, InstanceId: `i-${account_id}`, Status: "Running" }, fetched_at: 1700000000 },
      { account_id, resource_type: "esa", asset_key: `site-${account_id}`, payload: { SiteName: `site-${account_id}.test`, SiteId: account_id }, fetched_at: 1700000000 },
    ]);
    await page.route("**/api/**", route => route.fulfill({ json: [] }));
    await page.route("**/api/accounts**", route => route.fulfill({ json: accounts }));
    await page.route("**/api/local-assets**", route => {
      const type = new URL(route.request().url()).searchParams.get("resource_type");
      return route.fulfill({ json: assets.filter(asset => !type || asset.resource_type === type) });
    });
    await page.route("**/api/dns-records**", route => route.fulfill({ json: { items: [] } }));
    await page.goto("/");
    await page.getByLabel("account-13 产品详情", { exact: true }).click();
    const products = page.getByLabel("account-13 全部产品统计", { exact: true });
    const domainOpener = products.getByRole("button", { name: "域名（1）", exact: true });
    await domainOpener.click();
    const domainDialog = page.getByRole("dialog", { name: "域名", exact: true });
    await expect(domainDialog).toBeVisible();
    await expect(domainDialog.getByText("example-13.test", { exact: true })).toBeVisible();
    await expect(domainDialog.getByText("example-12.test", { exact: true })).toHaveCount(0);
    expect(await domainDialog.evaluate(element => element.parentElement?.parentElement === document.body)).toBe(true);
    await page.mouse.click(1, 1);
    await expect(domainDialog).toBeVisible();
    await domainDialog.getByRole("button", { name: /example-13.test/ }).click();
    await domainDialog.getByRole("button", { name: "新增记录" }).click();
    const editor = page.getByRole("dialog").last();
    await expect(editor.getByLabel("记录值", { exact: true })).toBeEditable();
    await page.keyboard.press("Escape");
    await expect(domainDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(domainDialog).toHaveCount(0);
    await expect(domainOpener).toBeFocused();
    await products.getByRole("button", { name: "服务器（1）", exact: true }).click();
    const serverDialog = page.getByRole("dialog", { name: "服务器", exact: true });
    await expect(serverDialog.getByText("server-13", { exact: true })).toBeVisible();
    await expect(serverDialog.getByText("server-12", { exact: true })).toHaveCount(0);
    await serverDialog.getByText("详情与操作", { exact: true }).click();
    await expect(serverDialog.getByRole("button", { name: "停止", exact: true })).toBeEnabled();
    const box = await serverDialog.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= width).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath("product-server-dialog.png") });
    await serverDialog.getByRole("button", { name: "关闭服务器", exact: true }).click();
    await products.getByRole("button", { name: "边缘安全加速（1）", exact: true }).click();
    const esaDialog = page.getByRole("dialog", { name: "边缘安全加速", exact: true });
    await expect(esaDialog.getByText("site-13.test", { exact: true })).toBeVisible();
    await expect(esaDialog.getByText("site-12.test", { exact: true })).toHaveCount(0);
    await expect(esaDialog.getByRole("button", { name: "证书管理" })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
