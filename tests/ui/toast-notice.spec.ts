import { expect, test } from "@playwright/test";
import { openSuppliers, supplierFixture } from "../model-suppliers-fixture";

test("临时反馈浮在右上角且自动消失，不改变列表位置", async ({ page }) => {
  await supplierFixture(page);
  await openSuppliers(page);
  await page.clock.install();
  const row = page.getByRole("row", { name: "模型供应商 供应商 1", exact: true });
  const before = await row.boundingBox();
  await row.getByRole("button", { name: "测试连接", exact: true }).click();
  const toast = page.locator(".app-toast-notice");
  await expect(toast).toContainText("测试通过");
  await expect(toast).toHaveCount(1);
  const box = (await toast.boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(1400);
  expect(box.y).toBeLessThan(80);
  expect((await row.boundingBox())!.y).toBe(before!.y);
  await page.mouse.move(0, 850);
  await page.clock.fastForward(4600);
  await expect(toast).toHaveCount(0);
  await row.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "关闭通知" }).click();
  await expect(toast).toHaveCount(0);
});

test("错误通知可暂停计时并适配窄屏", async ({ page }) => {
  await supplierFixture(page);
  await openSuppliers(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.clock.install();
  await page.evaluate(() => { (window as any).supplierTest404 = true; });
  await page.getByRole("row", { name: "模型供应商 供应商 1", exact: true }).getByRole("button", { name: "测试连接", exact: true }).click();
  const toast = page.locator(".app-toast-notice.is-error");
  await expect(toast).toHaveAttribute("role", "alert");
  await toast.hover();
  await page.clock.fastForward(6000);
  await expect(toast).toBeVisible();
  const box = (await toast.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  await page.screenshot({ path: "test-results/toast-notice-mobile.png" });
  await page.mouse.move(0, 800);
  await page.clock.fastForward(4600);
  await expect(toast).toHaveCount(0);
});
