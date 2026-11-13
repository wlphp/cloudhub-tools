import { expect, test, type Page } from "@playwright/test";
import { setupNativePage } from "./native-popout-fixture";

async function detach(page: Page) {
  const ready = page.waitForEvent("popup");
  await page.getByRole("button", { name: "脱离父页面", exact: true }).click();
  const popup = await ready;
  await expect(popup.getByRole("button", { name: "回到父页面", exact: true })).toBeVisible();
  return popup;
}

test("eligible navigation pages have one top-right control and authenticator docks without a second page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await setupNativePage(page);
  for (const name of ["首页", "监控预警", "账号管理", "资产管理", "我的收藏", "面板管理", "身份验证器", "备忘录", "软件商店", "操作日志", "API日志"]) {
    await page.getByRole("button", { name, exact: true }).first().click();
    await expect(page.getByRole("button", { name: "脱离父页面", exact: true }), `${name}: ${errors.join("; ")}`).toHaveCount(1);
    const bounds = (await page.locator(".page-detach-tools").filter({ visible: true }).boundingBox())!;
    expect(bounds.x).toBeGreaterThan(1100);
    expect(bounds.y).toBeLessThan(80);
  }
  await page.getByRole("button", { name: "身份验证器", exact: true }).first().click();
  await page.getByPlaceholder("搜索服务商、账户或备注").fill("保留验证器筛选");
  await page.screenshot({ path: test.info().outputPath("parent-page.png") });
  const popup = await detach(page);
  await expect(popup.getByPlaceholder("搜索服务商、账户或备注")).toHaveValue("保留验证器筛选");
  await popup.screenshot({ path: test.info().outputPath("detached-page.png") });
  await expect(popup.locator('[data-detachable-page="authenticator"]')).toBeVisible();
  await expect(page.locator('[data-detachable-page="authenticator"]')).toHaveCount(0);
  await page.getByRole("button", { name: "首页", exact: true }).first().click();
  await expect(popup.locator('[data-detachable-page="authenticator"]')).toBeVisible();
  await page.getByRole("button", { name: "身份验证器", exact: true }).first().click();
  await page.getByRole("button", { name: "回到父页面", exact: true }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.getByRole("button", { name: "脱离父页面", exact: true })).toBeVisible();
});

test("page-owned forms stay in the detached window and existing dialog detachment still works", async ({ page }) => {
  await setupNativePage(page);
  await page.getByRole("button", { name: "备忘录", exact: true }).first().click();
  const popup = await detach(page);
  await popup.getByRole("button", { name: "新建备忘录", exact: true }).first().click();
  const dialog = popup.getByRole("dialog", { name: "新建备忘录", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(popup.locator("body > .workspace-popout")).toHaveAttribute("inert");
  await dialog.getByLabel("标题", { exact: true }).fill("独立页面草稿");
  const ready = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "移到独立窗口", exact: true }).click();
  const formWindow = await ready;
  await expect(formWindow.getByLabel("标题", { exact: true })).toHaveValue("独立页面草稿");
  await page.getByRole("button", { name: "首页", exact: true }).first().click();
  await expect(popup.locator('[data-detachable-page="notes"]')).toBeVisible();
  await formWindow.getByRole("button", { name: "关闭新建备忘录", exact: true }).click();
  await expect.poll(() => formWindow.isClosed()).toBe(true);
  await popup.getByRole("button", { name: "回到父页面", exact: true }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
});

test("detached software store and sidebar software keep separate owners", async ({ page }) => {
  await setupNativePage(page);
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await page.getByPlaceholder("搜索应用名称、开发商或说明").fill("网络测速");
  const store = await detach(page);
  await page.getByRole("button", { name: "指纹浏览器", exact: true }).first().click();
  const browser = await detach(page);
  await expect(browser.getByRole("region", { name: "指纹浏览器 页面" })).toBeVisible();
  await expect(store.getByPlaceholder("搜索应用名称、开发商或说明")).toHaveValue("网络测速");
  await store.locator('[data-plugin-entry="cloudhub.network-speed"]').click();
  await expect(store.getByRole("region", { name: "网络测速 页面" })).toBeVisible();
  await expect(browser.getByRole("region", { name: "指纹浏览器 页面" })).toBeVisible();
  await store.getByRole("button", { name: "返回软件商店", exact: true }).click();
  await expect(store.getByPlaceholder("搜索应用名称、开发商或说明")).toHaveValue("网络测速");
  await browser.getByRole("button", { name: "回到父页面", exact: true }).click();
  await expect.poll(() => browser.isClosed()).toBe(true);
  await expect(store.getByRole("button", { name: "回到父页面", exact: true })).toBeVisible();
});

test("preview pages keep the existing in-page layout", async ({ page }) => {
  await setupNativePage(page, false);
  await expect(page.getByRole("button", { name: "脱离父页面", exact: true })).toHaveCount(0);
});

test("closing a page window returns its open editor and preserves the draft", async ({ page }) => {
  await setupNativePage(page);
  await page.getByRole("button", { name: "备忘录", exact: true }).first().click();
  const popup = await detach(page);
  await popup.getByRole("button", { name: "新建备忘录", exact: true }).first().click();
  await popup.getByLabel("标题", { exact: true }).fill("关闭页面窗口后保留");
  await page.evaluate(() => (window as any).__requestNativeClose());
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.getByRole("dialog", { name: "新建备忘录", exact: true })).toBeVisible();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("关闭页面窗口后保留");
  await page.getByLabel("标题", { exact: true }).press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
