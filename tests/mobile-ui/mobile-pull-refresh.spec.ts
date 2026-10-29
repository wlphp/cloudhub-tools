import { expect, test, type Page } from "@playwright/test";

const accounts = [{ id: 12, account_name: "pull-fixture", cloud_type: "aliyun", enabled: true, sort_order: 1 }];

async function touch(page: Page, type: "touchstart" | "touchmove" | "touchend" | "touchcancel", x = 180, y = 180, selector = ".mobile-account-list-heading", fingers = 1) {
  await page.locator(selector).evaluate((target, data) => {
    const contacts = Array.from({ length: data.fingers }, (_, id) => new Touch({ identifier: id, target, clientX: data.x + id * 10, clientY: data.y }));
    target.dispatchEvent(new TouchEvent(data.type, { bubbles: true, cancelable: true, touches: data.type === "touchend" || data.type === "touchcancel" ? [] : contacts, changedTouches: contacts }));
  }, { type, x, y, fingers });
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => { throw error; });
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  await page.route("**/api/accounts**", route => route.fulfill({ json: accounts }));
});

test("native touch follows smoothly, refreshes once and settles without changing layout", async ({ page, context }, testInfo) => {
  let requests = 0;
  let finishRefresh = () => {};
  const pending = new Promise<void>(resolve => { finishRefresh = resolve; });
  await page.route("**/api/accounts**", async route => {
    requests++;
    if (requests > 1) await pending;
    await route.fulfill({ json: accounts });
  });
  await page.goto("/");
  await expect(page.getByText("pull-fixture", { exact: true })).toBeVisible();
  const surface = page.locator(".mobile-refresh-content");
  const baseline = await surface.evaluate(element => element.offsetHeight);
  const cdp = await context.newCDPSession(page);
  const area = await page.locator(".mobile-account-list-heading").boundingBox();
  const y = area!.y + 10;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 180, y }] });
  for (const delta of [12, 30, 65, 100, 145, 185]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 180, y: y + delta }] });
  }
  await expect(surface).toHaveAttribute("data-pull-phase", "ready");
  expect(await surface.evaluate(element => element.offsetHeight)).toBe(baseline);
  await expect(page.locator(".mobile-pull-refresh")).toContainText("松开刷新");
  await page.screenshot({ path: testInfo.outputPath("pull-ready.png") });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(surface).toHaveAttribute("data-pull-phase", "refreshing");
  await expect.poll(() => requests).toBe(2);
  await touch(page, "touchstart");
  await touch(page, "touchmove", 180, 400);
  await touch(page, "touchend");
  expect(requests).toBe(2);
  finishRefresh();
  await expect(surface).toHaveAttribute("data-pull-phase", "idle");
  await expect(surface).toHaveCSS("transform", "none");
  await expect(page.locator(".mobile-pull-refresh")).toHaveAttribute("aria-hidden", "true");
  expect(await surface.evaluate(element => element.offsetHeight)).toBe(baseline);
  await cdp.detach();
});

test("short pulls, horizontal swipes, multitouch, editors and cancellation do not refresh", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/accounts**", route => { requests++; return route.fulfill({ json: accounts }); });
  await page.goto("/");
  await expect(page.getByText("pull-fixture", { exact: true })).toBeVisible();
  const surface = page.locator(".mobile-refresh-content");
  await touch(page, "touchstart");
  await touch(page, "touchmove", 180, 220);
  await expect(surface).toHaveAttribute("data-pull-phase", "pulling");
  await touch(page, "touchend");
  await expect(surface).toHaveAttribute("data-pull-phase", "idle");
  await touch(page, "touchstart");
  await touch(page, "touchmove", 260, 190);
  await touch(page, "touchmove", 260, 400);
  await touch(page, "touchend");
  await expect(surface).toHaveAttribute("data-pull-phase", "idle");
  for (const cancel of ["touchcancel", "multitouch"] as const) {
    await touch(page, "touchstart");
    await touch(page, "touchmove", 180, 400);
    await expect(surface).toHaveAttribute("data-pull-phase", "ready");
    await touch(page, cancel === "touchcancel" ? "touchcancel" : "touchmove", 180, 400, ".mobile-account-list-heading", 2);
    await touch(page, "touchend");
    await expect(surface).toHaveAttribute("data-pull-phase", "idle");
  }
  await touch(page, "touchstart", 180, 180, 'input[aria-label="搜索云账号"]');
  await touch(page, "touchmove", 180, 400, 'input[aria-label="搜索云账号"]');
  await touch(page, "touchend", 180, 400, 'input[aria-label="搜索云账号"]');
  await expect(surface).toHaveAttribute("data-pull-phase", "idle");
  expect(requests).toBe(1);
});

test("failed refresh settles and allows retry with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let requests = 0;
  await page.route("**/api/accounts**", route => {
    requests++;
    return requests === 2 ? route.fulfill({ status: 500, json: { error: "刷新暂时失败" } }) : route.fulfill({ json: accounts });
  });
  await page.goto("/");
  await expect(page.getByText("pull-fixture", { exact: true })).toBeVisible();
  const surface = page.locator(".mobile-refresh-content");
  await touch(page, "touchstart");
  await touch(page, "touchmove", 180, 400);
  await touch(page, "touchend");
  await expect(page.locator(".mobile-notice")).toBeVisible();
  await expect(surface).toHaveAttribute("data-pull-phase", "idle");
  await touch(page, "touchstart");
  await touch(page, "touchmove", 180, 400);
  await touch(page, "touchend");
  await expect.poll(() => requests).toBe(3);
  await expect(surface).toHaveAttribute("data-pull-phase", "idle");
  await expect(page.locator(".mobile-notice")).toHaveCount(0);
});

test("changing pages clears an unfinished gesture and a pending refresh", async ({ page }) => {
  let requests = 0;
  let finishRefresh = () => {};
  const pending = new Promise<void>(resolve => { finishRefresh = resolve; });
  await page.route("**/api/accounts**", async route => {
    requests++;
    if (requests > 1) await pending;
    await route.fulfill({ json: accounts });
  });
  await page.goto("/");
  await expect(page.getByText("pull-fixture", { exact: true })).toBeVisible();
  await touch(page, "touchstart");
  await touch(page, "touchmove", 180, 400);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "更多" }).click();
  const surface = page.locator(".mobile-refresh-content");
  await expect(surface).toHaveAttribute("data-pull-phase", "idle");
  expect(requests).toBe(1);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "账号", exact: true }).click();
  await touch(page, "touchstart");
  await touch(page, "touchmove", 180, 400);
  await touch(page, "touchend");
  await expect.poll(() => requests).toBe(2);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "更多" }).click();
  await expect(surface).toHaveAttribute("data-pull-phase", "idle");
  finishRefresh();
  await expect(page.getByRole("heading", { name: "更多管理" })).toBeVisible();
  await expect(surface).toHaveCSS("transform", "none");
});
