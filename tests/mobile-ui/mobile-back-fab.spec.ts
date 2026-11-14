import { expect, test } from "@playwright/test";

test("mobile floating back button can be dragged, remembers its position, and still responds to tap", async ({ page, context }) => {
  await page.route("**/api/accounts**", route => route.fulfill({ json: [] }));
  await page.route("**/api/local-assets**", route => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的" }).click();
  await page.locator(".mobile-more-shortcuts").getByRole("button", { name: /我的账号/ }).click();

  const back = page.locator(".mobile-back-fab");
  await expect(back).toBeVisible();
  await expect(back).toHaveCSS("touch-action", "none");
  const start = await back.boundingBox();
  expect(start).not.toBeNull();
  if (!start) return;

  const session = await context.newCDPSession(page);
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 54, y: y - 42, id: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await back.boundingBox())?.x).toBeGreaterThan(start.x + 30);
  await expect(page.locator(".mobile-account-overview")).toBeVisible();

  const moved = await back.boundingBox();
  expect(moved).not.toBeNull();
  if (!moved) return;
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("cloudhub-tools-back-fab-position") || "null"));
  expect(saved).toMatchObject({ right: expect.any(Number), bottom: expect.any(Number) });

  await page.reload();
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的" }).click();
  await page.locator(".mobile-more-shortcuts").getByRole("button", { name: /我的账号/ }).click();
  const restored = await page.locator(".mobile-back-fab").boundingBox();
  expect(restored?.x).toBeCloseTo(moved.x, 0);

  await page.locator(".mobile-back-fab").click();
  await expect(page.locator(".mobile-more-shortcuts")).toBeVisible();
});
