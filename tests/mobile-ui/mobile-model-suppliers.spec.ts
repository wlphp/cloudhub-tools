import { expect, test } from "@playwright/test";
import { exerciseSuppliers, openSuppliers, supplierFixture } from "../model-suppliers-fixture";

test.use({ userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36" });

test("手机从软件商店管理模型供应商，支持分页及CRUD和辅助入口跳转", async ({ page }) => {
  await supplierFixture(page);
  await openSuppliers(page, true);
  await exerciseSuppliers(page);
  for (const width of [320, 375, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.locator(".ai-supplier-manager").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("搜索模型供应商", { exact: true }).fill("");
  await page.screenshot({ path: "test-results/model-suppliers-mobile.png" });
  await page.getByRole("button", { name: "返回软件商店", exact: true }).click();
  await expect(page.locator(".software-store-page")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("cloudhub-ai-settings")));
  await expect(page.locator(".ai-supplier-manager")).toBeVisible();
});

test("手机 Claude 添加供应商保留共享库导入", async ({ page }) => {
  await supplierFixture(page);
  await openSuppliers(page, true);
  expect(await page.evaluate(() => (window as any).supplierReveals)).toBe(0);
  await page.getByRole("button", { name: "返回软件商店", exact: true }).click();
  await page.getByRole("searchbox").fill("Claude 管理");
  await page.locator('[data-plugin-entry="cloudhub.claude-providers"]').click();
  await page.getByRole("button", { name: "添加供应商", exact: true }).first().click();
  const importer = page.getByRole("dialog", { name: "添加供应商", exact: true }).locator(".ai-supplier-import");
  await importer.getByLabel("选择模型供应商").selectOption("supplier-11");
  await importer.getByRole("button", { name: "导入配置", exact: true }).click();
  await expect(page.getByLabel("供应商名称", { exact: true })).toHaveValue("供应商 11");
  expect(await page.evaluate(() => (window as any).supplierReveals)).toBe(1);
});
