import { expect, test, type Page } from "@playwright/test";

async function openCodex(page: Page) {
  await page.route("**/api/**", route => route.fulfill({ json: new URL(route.request().url()).pathname === "/api/member" ? null : [] }));
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "软件商店", exact: true }).click();
  await page.getByLabel("每页条数", { exact: true }).selectOption("50");
  await page.locator('[data-plugin-entry="cloudhub.codex"]').click();
}

test("多个模块的相同提示只显示一次，关闭后不再冒出副本", async ({ page }) => {
  await openCodex(page);
  const notices = page.locator(".app-toast-notice");
  await expect(notices).toHaveCount(1);
  await expect(notices).toContainText("原生客户端");
  for (const width of [320, 390, 519, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const notice = (await notices.boundingBox())!;
    const nav = (await page.locator(".mobile-tab-bar").boundingBox())!;
    expect(notice.y).toBeGreaterThan(422);
    expect(notice.y + notice.height).toBeLessThan(nav.y);
    expect(notice.x).toBeGreaterThanOrEqual(0);
    expect(notice.x + notice.width).toBeLessThanOrEqual(width);
  }
  await page.getByRole("button", { name: "关闭通知", exact: true }).click();
  await expect(notices).toHaveCount(0);
  await page.getByRole("button", { name: "重新读取账号列表", exact: true }).click();
  await expect(notices).toHaveCount(1);
  await page.getByRole("button", { name: "关闭通知", exact: true }).click();
  await expect(notices).toHaveCount(0);
});

test("重复提示自动消失后不会轮流显示，离开页面清理通知容器", async ({ page }) => {
  await page.clock.install();
  await openCodex(page);
  await expect(page.locator(".app-toast-notice")).toHaveCount(1);
  await page.clock.fastForward(5000);
  await expect(page.locator(".app-toast-notice")).toHaveCount(0);
  await page.getByRole("button", { name: "返回软件商店", exact: true }).click();
  await expect(page.locator("[data-toast-stack]")).toHaveCount(0);
});
