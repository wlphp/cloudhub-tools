import { expect, test, type Page } from "@playwright/test";
import { setupNativePage } from "./native-popout-fixture";

async function setup(page: Page, desktop = true) {
  await setupNativePage(page, desktop);
  await page.getByRole("button", { name: "终端管理", exact: true }).click();
}

test("whole workbench moves with its live search, survives parent navigation, and docks back", async ({ page }) => {
  await setup(page);
  await page.getByPlaceholder("搜索服务器 IP / 名称").fill("保留搜索");
  const ready = page.waitForEvent("popup");
  await page.getByRole("button", { name: "脱离父页面", exact: true }).click();
  const popup = await ready;
  await expect(popup.locator(".terminal-workbench")).toBeVisible();
  await expect(popup.getByPlaceholder("搜索服务器 IP / 名称")).toHaveValue("保留搜索");
  await expect(page.locator(".terminal-workbench")).toHaveCount(0);
  await page.getByRole("button", { name: "首页", exact: true }).first().click();
  await expect(popup.locator(".terminal-workbench")).toBeVisible();
  await popup.getByPlaceholder("搜索服务器 IP / 名称").fill("独立编辑");
  await page.getByRole("button", { name: "终端管理", exact: true }).click();
  await popup.getByRole("button", { name: "回到父页面", exact: true }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.getByPlaceholder("搜索服务器 IP / 名称")).toHaveValue("独立编辑");
});

test("both top blank areas detach on drag and a failed popup keeps the workbench", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).__blockPopup = true; });
  await page.getByRole("button", { name: "脱离父页面", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("无法创建独立窗口");
  await expect(page.locator(".terminal-workbench")).toBeVisible();
  await page.evaluate(() => { (window as any).__blockPopup = false; });
  for (const selector of [".terminal-host-title-row", ".terminal-session-header .terminal-tabs"]) {
    const bounds = await page.locator(selector).boundingBox();
    if (!bounds) throw new Error("Missing drag region");
    const ready = page.waitForEvent("popup");
    await page.mouse.move(bounds.x + bounds.width * .55, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .55 + 45, bounds.y + bounds.height / 2 + 25, { steps: 5 });
    await page.mouse.up();
    const popup = await ready;
    await expect(popup.locator(".terminal-workbench")).toBeVisible();
    await popup.getByRole("button", { name: "回到父页面", exact: true }).click();
    await expect.poll(() => popup.isClosed()).toBe(true);
  }
});

test("browser preview does not offer native workbench detachment", async ({ page }) => {
  await setup(page, false);
  await expect(page.getByRole("button", { name: "脱离父页面", exact: true })).toHaveCount(0);
});

test("native close restores the live workbench and popup resize uses its own document", async ({ page }) => {
  await setup(page);
  const ready = page.waitForEvent("popup");
  await page.getByRole("button", { name: "脱离父页面", exact: true }).click();
  const popup = await ready;
  const workbench = popup.locator(".terminal-workbench");
  await expect(workbench).toBeVisible();
  const sidebar = popup.getByRole("complementary", { name: "服务器列表" });
  const before = (await sidebar.boundingBox())!.width;
  const handle = (await popup.getByRole("separator", { name: "调整服务器列表宽度" }).boundingBox())!;
  await popup.mouse.move(handle.x + handle.width / 2, handle.y + 120);
  await popup.mouse.down();
  await popup.mouse.move(handle.x + handle.width / 2 + 45, handle.y + 120, { steps: 5 });
  await popup.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(before + 20);
  await popup.locator(".terminal-stage-empty").getByRole("button", { name: "添加服务器" }).click();
  await expect(popup.getByRole("dialog", { name: "添加服务器", exact: true })).toBeVisible();
  await popup.getByRole("button", { name: "关闭服务器配置", exact: true }).click();
  await page.evaluate(() => (window as any).__requestNativeClose());
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.locator(".terminal-workbench")).toBeVisible();
});
