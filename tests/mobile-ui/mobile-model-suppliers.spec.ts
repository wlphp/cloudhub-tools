import { expect, test } from "@playwright/test";
import { exerciseSuppliers, openSuppliers, supplierFixture } from "../model-suppliers-fixture";

test.use({ userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36" });

test("手机从软件商店管理模型供应商，支持分页及CRUD和辅助入口跳转", async ({ page }) => {
  await supplierFixture(page);
  await openSuppliers(page, true);
  await exerciseSuppliers(page);
  for (const width of [320, 375, 390, 519, 768]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.locator(".ai-supplier-manager").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const buttons = page.locator(".ai-supplier-operations .ai-actions button");
    for (const button of await buttons.all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await button.evaluate(element => getComputedStyle(element).borderTopWidth)).toBe("1px");
      expect(await button.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    }
  }
  await page.setViewportSize({ width: 519, height: 838 });
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

test("移动删除确认框分层展示后果，取消和遮罩不会删除数据", async ({ page }) => {
  await supplierFixture(page);
  await openSuppliers(page, true);
  const remove = page.getByRole("button", { name: "删除模型供应商 供应商 1", exact: true });
  await remove.click();
  const dialog = page.getByRole("alertdialog", { name: "删除模型供应商", exact: true });
  await expect(dialog).toHaveClass(/is-danger/);
  await expect(dialog.locator(".confirm-detail")).toContainText("独立配置会保留");
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => document.body.classList.toggle("theme-light", value === "light"), theme);
    for (const width of [320, 390, 519, 768]) {
      await page.setViewportSize({ width, height: 838 });
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const buttons = dialog.locator(".modal-actions > button");
      const first = (await buttons.nth(0).boundingBox())!;
      const second = (await buttons.nth(1).boundingBox())!;
      expect(first.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(first.width - second.width)).toBeLessThan(1);
    }
    await page.setViewportSize({ width: 390, height: 838 });
    await dialog.screenshot({ path: `test-results/confirm-delete-${theme}.png`, animations: "disabled" });
  }
  await page.locator(".shared-dialog-backdrop").last().click({ position: { x: 1, y: 1 }, force: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeVisible();
  await remove.click();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(remove).toBeVisible();
  await remove.click();
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(remove).toHaveCount(0);
});

test("供应商分页和折叠说明在窄屏对齐，翻页及键盘展开正常", async ({ page }) => {
  await supplierFixture(page);
  await openSuppliers(page, true);
  const manager = page.locator(".ai-supplier-manager");
  const pagination = manager.locator(".pagination-bar");
  const help = manager.locator(".ai-supplier-help");
  await expect(help).not.toHaveAttribute("open", "");
  await pagination.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(manager.locator(".ai-profile")).toHaveCount(1);
  await expect(pagination.getByRole("button", { name: "第 2 页", exact: true })).toHaveAttribute("aria-current", "page");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => document.body.classList.toggle("theme-light", value === "light"), theme);
    for (const width of [320, 390, 519, 768]) {
      await page.setViewportSize({ width, height: 838 });
      expect(await pagination.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await help.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect((await help.locator("summary").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.setViewportSize({ width: 519, height: 838 });
    await help.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/supplier-footer-${theme}.png`, animations: "disabled" });
  }
  await help.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(help).toHaveAttribute("open", "");
  await expect(help.locator("p")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(help.locator("p")).toBeHidden();
  await pagination.getByLabel("跳转页码", { exact: true }).fill("1");
  await pagination.getByRole("button", { name: "确定", exact: true }).click();
  await expect(manager.locator(".ai-profile")).toHaveCount(10);
  await pagination.getByLabel("每页条数", { exact: true }).selectOption("50");
  await expect(manager.locator(".ai-profile")).toHaveCount(11);
  await expect(pagination.locator(".pagination-jump")).toBeHidden();
});
