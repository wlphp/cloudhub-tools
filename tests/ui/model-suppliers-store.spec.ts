import { expect, test } from "@playwright/test";
import { exerciseSuppliers, openSuppliers, supplierFixture } from "../model-suppliers-fixture";

test("连接测试404提示包含供应商并去除内部错误类名前缀", async ({ page }) => {
  await supplierFixture(page);
  await openSuppliers(page);
  await page.evaluate(() => { (window as any).supplierTest404 = true; });
  await page.getByRole("row", { name: "模型供应商 供应商 1", exact: true }).getByRole("button", { name: "测试连接", exact: true }).click();
  const feedback = page.locator(".app-toast-notice");
  await expect(feedback).toContainText("“供应商 1”连接测试失败");
  await expect(feedback).toContainText("HTTP 404");
  await expect(feedback).not.toContainText("PlatformError");
  await expect(page.getByRole("row", { name: "模型供应商 供应商 1", exact: true })).toContainText("Chat Completions");
});

test("共享模型供应商从商店管理，支持分页搜索和CRUD，设置入口已迁出", async ({ page }) => {
  await supplierFixture(page);
  await openSuppliers(page);
  await exerciseSuppliers(page);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.locator(".ai-supplier-manager").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.getByLabel("搜索模型供应商", { exact: true }).fill("");
  await expect(page.getByRole("columnheader", { name: "服务地址", exact: true })).toBeVisible();
  expect(await page.locator(".ai-profile").first().evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(64);
  await page.screenshot({ path: "test-results/model-suppliers-desktop.png" });
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await expect(page.getByRole("tab", { name: "模型供应商", exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("cloudhub-ai-settings")));
  await expect(page.locator(".ai-supplier-manager")).toBeVisible();
});

test("Codex 和 Claude 添加供应商时继续从共享库导入草稿，浏览列表不读取密钥", async ({ page }) => {
  await supplierFixture(page);
  await openSuppliers(page);
  expect(await page.evaluate(() => (window as any).supplierReveals)).toBe(0);
  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  await page.getByRole("tab", { name: "模型供应商", exact: true }).click();
  await page.getByRole("button", { name: "添加供应商", exact: true }).first().click();
  const importer = page.locator(".ai-supplier-import");
  await importer.getByLabel("选择模型供应商").selectOption("supplier-2");
  await importer.getByRole("button", { name: "导入配置", exact: true }).click();
  const codexEditor = page.getByRole("dialog").filter({ has: page.locator(".codex-provider-editor-models") });
  await expect(codexEditor.getByLabel("名称", { exact: true })).toHaveValue("供应商 2");
  await expect(codexEditor.getByLabel("API 地址", { exact: true })).toHaveValue("https://example.test/v1");
  expect(await page.evaluate(() => (window as any).supplierReveals)).toBe(1);
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog", { name: "放弃未保存的修改", exact: true }).getByRole("button", { name: "放弃修改", exact: true }).click();
  await page.getByRole("button", { name: "Claude 管理", exact: true }).first().click();
  await page.getByRole("button", { name: "添加供应商", exact: true }).first().click();
  const claudeImporter = page.getByRole("dialog", { name: "添加供应商", exact: true }).locator(".ai-supplier-import");
  await claudeImporter.getByLabel("选择模型供应商").selectOption("supplier-11");
  await claudeImporter.getByRole("button", { name: "导入配置", exact: true }).click();
  await expect(page.getByLabel("供应商名称", { exact: true })).toHaveValue("供应商 11");
  expect(await page.evaluate(() => (window as any).supplierReveals)).toBe(2);
});
