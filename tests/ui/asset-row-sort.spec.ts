import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.addInitScript(() => {
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string) => {
        if (command === "list_accounts") return [{ id: 1, account_name: "测试账户", cloud_type: "aliyun", enabled: true, created_at: 1 }];
        if (command === "list_local_assets") return ["alpha", "beta", "gamma", "delta"].map(name => ({ account_id: 1, resource_type: "domain", asset_key: name, fetched_at: 1, payload: { DomainName: `${name}.example`, RecordCount: 3 } }));
        if (command === "list_client_preferences") return {};
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "资产管理", exact: true }).first().click();
  await expect(page.locator("[data-asset-row-key]")).toHaveCount(4);
  await page.getByRole("button", { name: "资产排序", exact: true }).click();
}

const order = (page: Page) => page.locator("[data-asset-row-key]").evaluateAll(rows => rows.map(row => row.getAttribute("data-asset-row-key")));
async function drag(page: Page, source: number, target: number) {
  const rows = page.locator("[data-asset-row-key]");
  const handle = (await rows.nth(source).locator(".asset-drag-handle").boundingBox())!;
  const destination = (await rows.nth(target).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, destination.y + destination.height / 2, { steps: 10 });
  await expect(rows.nth(source)).toHaveClass(/is-asset-dragging/);
  await expect.poll(() => rows.nth(source).evaluate(el => el.style.transform)).not.toBe("");
}

test("拖动时平滑让位，松手提交顺序并复用原行节点，刷新后保留", async ({ page }) => {
  await fixture(page);
  await page.locator("[data-asset-row-key]").first().evaluate(el => { (window as any).originalAssetRow = el; });
  await drag(page, 0, 2);
  expect(await order(page)).toEqual(["1:domain:alpha", "1:domain:beta", "1:domain:gamma", "1:domain:delta"]);
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(["1:domain:beta", "1:domain:gamma", "1:domain:alpha", "1:domain:delta"]);
  expect(await page.locator('[data-asset-row-key="1:domain:alpha"]').evaluate(el => el === (window as any).originalAssetRow)).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "资产管理", exact: true }).first().click();
  await expect.poll(() => order(page)).toEqual(["1:domain:beta", "1:domain:gamma", "1:domain:alpha", "1:domain:delta"]);
});

test("Escape、指针取消与轻点不改变顺序，减少动态效果时不播放动画", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  const initial = await order(page);
  await drag(page, 2, 0);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await order(page)).toEqual(initial);
  await expect(page.locator(".is-asset-dragging")).toHaveCount(0);
  await drag(page, 0, 2);
  await page.locator(".asset-drag-handle").first().dispatchEvent("pointercancel");
  await page.mouse.up();
  expect(await order(page)).toEqual(initial);
  await page.locator(".asset-drag-handle").first().click();
  expect(await order(page)).toEqual(initial);
  expect(await page.locator("[data-asset-row-key]").evaluateAll(rows => rows.every(row => row.style.transform === "" && row.getAnimations().length === 0))).toBe(true);
});

test("域名操作保持单行、等高，双主题使用浅色底与深色文字", async ({ page }) => {
  await fixture(page);
  for (const light of [true, false]) {
    await page.evaluate(value => document.body.classList.toggle("theme-light", value), light);
    const buttons = page.locator(".domain-asset-actions").first().getByRole("button");
    const boxes = await buttons.evaluateAll(elements => elements.map(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { y: rect.y, height: rect.height, color: style.color, background: style.backgroundColor };
    }));
    expect(new Set(boxes.map(box => box.y)).size).toBe(1);
    expect(new Set(boxes.map(box => box.height)).size).toBe(1);
    expect(boxes.every(box => box.color !== "rgb(255, 255, 255)" && box.background !== "rgba(0, 0, 0, 0)")).toBe(true);
  }
});
