import { expect, test } from "@playwright/test";

test("main navigation collapse retains icon navigation and restores its saved state", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  await page.goto("/");
  const sidebar = page.locator(".app-main-sidebar");
  const toggleBox = (await page.getByRole("button", { name: "收缩主导航", exact: true }).boundingBox())!;
  const brandBox = (await sidebar.locator(".brand").boundingBox())!;
  expect(brandBox.y).toBeGreaterThanOrEqual(toggleBox.y + toggleBox.height + 4);
  await page.screenshot({ path: "test-results/navigation-expanded.png" });
  const originalWidth = (await sidebar.boundingBox())!.width;
  await page.getByRole("button", { name: "收缩主导航", exact: true }).click();
  await expect(page.getByRole("button", { name: "展开主导航", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(64);
  await expect(page.getByRole("separator", { name: "调整主导航宽度", exact: true })).toHaveCount(0);
  const terminal = sidebar.getByRole("button", { name: "终端管理", exact: true });
  await terminal.click();
  await expect(terminal).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(page.getByRole("button", { name: "展开主导航", exact: true })).toBeVisible();
  expect((await sidebar.boundingBox())!.width).toBe(64);
  await page.getByRole("button", { name: "展开主导航", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(originalWidth);
  await expect(page.getByRole("separator", { name: "调整主导航宽度", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "收缩主导航", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "收缩主导航", exact: true }).click();
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(64);
  for (const width of [768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await sidebar.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: "test-results/navigation-collapsed.png" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "展开主导航", exact: true }).click();
  expect(await sidebar.evaluate(element => parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThan(0.001);
  expect((await sidebar.boundingBox())!.width).toBe(originalWidth);
});
