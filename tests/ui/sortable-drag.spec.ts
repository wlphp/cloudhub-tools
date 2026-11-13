import { expect, test, type Locator, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await page.addInitScript(() => {
    const assets = Array.from({ length: 8 }, (_, index) => ({ account_id: 1, resource_type: "domain", asset_key: `domain-${index}`, fetched_at: 1, payload: { DomainName: `domain-${index}.example`, RecordCount: 3 } }));
    localStorage.setItem("cloudhub-tools-favorite-assets", JSON.stringify(assets.map(asset => `1:domain:${asset.asset_key}`)));
    (window as any).sortCalls = [];
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string, args: any) => {
        if (command === "list_accounts") return [{ id: 1, account_name: "测试账户", cloud_type: "aliyun", enabled: true, created_at: 1 }];
        if (command === "list_local_assets") return assets;
        if (command === "list_client_preferences") return {};
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_panel_connections") return [1, 2, 3].map(id => ({ id, name: `测试面板 ${id}`, panel_url: `https://192.0.2.${id}:8888`, status: "unknown", group_name: "测试组", summary: {}, created_at: 1, updated_at: 1 }));
        if (command === "update_panel_connection_order") { (window as any).sortCalls.push(args.ids); return; }
        if (command === "codex_get_state") return { accounts: [], cliAvailable: true, desktopAvailable: true, currentAccountId: null, canRestore: false };
        if (command === "codex_gateway_state") return { running: false, accountIds: [], completed: 0, failed: 0, active: 0 };
        if (command === "codex_provider_list") return [1, 2, 3].map(id => ({ id: `provider-${id}`, version: 1, name: `测试供应商 ${id}`, baseUrl: "https://example.com/v1", wireApi: "responses", models: [], note: "", keys: [] }));
        if (command === "save_client_preference" && args.key === "codex.providers.order") { (window as any).sortCalls.push(JSON.parse(args.value)); return; }
        return [];
      },
    };
  });
  await page.goto("/");
}

async function beginDrag(page: Page, handle: Locator, target: Locator) {
  const from = (await handle.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + Math.min(30, to.width / 2), to.y + Math.min(30, to.height / 2), { steps: 12 });
  await expect(page.locator("[data-sortable-dragging]")).toHaveCount(1);
}

test("收藏卡片横向及跨行让位，保持清晰并在松手后保存", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "我的收藏", exact: true }).first().click();
  await page.getByRole("button", { name: "收藏排序", exact: true }).click();
  const cards = page.locator("[data-favorite-asset-key]");
  await expect(cards).toHaveCount(8);
  const order = () => cards.evaluateAll(elements => elements.map(element => element.getAttribute("data-favorite-asset-key")));
  const initial = await order();
  await beginDrag(page, cards.first().locator(".favorite-card-drag-handle"), cards.nth(3));
  expect(await order()).toEqual(initial);
  expect(await page.locator("[data-sortable-dragging]").evaluate(element => getComputedStyle(element).opacity)).toBe("1");
  await page.mouse.up();
  await expect(cards.nth(3)).toHaveAttribute("data-favorite-asset-key", initial[0]!);
  await expect.poll(() => cards.evaluateAll(elements => elements.every(element => element.getAnimations().length === 0))).toBe(true);
  await beginDrag(page, cards.nth(3).locator(".favorite-card-drag-handle"), cards.nth(4));
  await page.mouse.up();
  await expect(cards.nth(4)).toHaveAttribute("data-favorite-asset-key", initial[0]!);
  const saved = await order();
  await page.reload();
  await page.getByRole("button", { name: "我的收藏", exact: true }).first().click();
  await page.getByRole("button", { name: "收藏排序", exact: true }).click();
  await expect.poll(order).toEqual(saved);
});

test("收藏拖出区域或 Escape 取消，减少动画模式不播放落位动画", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  await page.getByRole("button", { name: "我的收藏", exact: true }).first().click();
  await page.getByRole("button", { name: "收藏排序", exact: true }).click();
  const cards = page.locator("[data-favorite-asset-key]");
  const initial = await cards.first().getAttribute("data-favorite-asset-key");
  for (const cancel of ["outside", "escape"]) {
    await beginDrag(page, cards.first().locator(".favorite-card-drag-handle"), cards.nth(2));
    if (cancel === "outside") await page.mouse.move(5, 100);
    else await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(cards.first()).toHaveAttribute("data-favorite-asset-key", initial!);
    await expect(page.locator("[data-sortable-dragging]")).toHaveCount(0);
    expect(await cards.evaluateAll(elements => elements.every(element => element.style.transform === "" && !element.getAnimations().length))).toBe(true);
  }
});

test("面板列表统一拖动并在落位时提交顺序", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "面板管理", exact: true }).first().click();
  await page.getByRole("button", { name: "面板排序", exact: true }).click();
  const rows = page.locator("[data-panel-id]");
  await expect(rows).toHaveCount(3);
  await beginDrag(page, rows.first().locator(".panel-drag-handle"), rows.nth(2));
  expect(await page.evaluate(() => (window as any).sortCalls.length)).toBe(0);
  await page.mouse.up();
  await expect(rows.nth(2)).toHaveAttribute("data-panel-id", "1");
  expect(await page.evaluate(() => (window as any).sortCalls)).toEqual([[2, 3, 1]]);
});

test("供应商使用同一跟手排序并保留上下方向键操作", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  await page.getByRole("tab", { name: "模型供应商", exact: true }).click();
  await page.getByRole("button", { name: "供应商排序", exact: true }).click();
  const rows = page.locator("[data-provider-sort-id]");
  await expect(rows).toHaveCount(3);
  const from = (await rows.first().locator(".codex-provider-reorder-handle").boundingBox())!;
  const to = (await rows.nth(2).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, { steps: 12 });
  await expect(page.locator("[data-sortable-dragging]")).toHaveCount(1);
  await page.mouse.up();
  await expect(rows.nth(2)).toHaveAttribute("data-provider-sort-id", "provider-1");
  await expect.poll(() => rows.evaluateAll(elements => elements.every(element => !element.getAnimations().length))).toBe(true);
  await rows.nth(2).locator(".codex-provider-reorder-handle").press("ArrowUp");
  await expect(rows.nth(1)).toHaveAttribute("data-provider-sort-id", "provider-1");
});

test("主导航分栏跟手调整并保存，Escape 和指针取消恢复原宽度", async ({ page }) => {
  await fixture(page);
  const handle = page.getByRole("separator", { name: "调整主导航宽度" });
  const position = () => handle.boundingBox();
  const initial = (await position())!;
  await page.mouse.move(initial.x + initial.width / 2, initial.y + 200);
  await page.mouse.down();
  await page.mouse.move(initial.x + initial.width / 2 + 40, initial.y + 200, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await position())!.x).toBeGreaterThan(initial.x + 30);
  const saved = (await position())!;
  const stored = await page.evaluate(() => localStorage.getItem("cloudhub-app-sidebar-width"));
  for (const cancel of ["escape", "pointercancel"]) {
    await page.mouse.move(saved.x + saved.width / 2, saved.y + 200);
    await page.mouse.down();
    await page.mouse.move(saved.x + saved.width / 2 + 35, saved.y + 200, { steps: 8 });
    if (cancel === "escape") await page.keyboard.press("Escape");
    else await handle.evaluate(element => element.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true })));
    await page.mouse.up();
    await expect.poll(async () => Math.abs((await position())!.x - saved.x)).toBeLessThan(1);
    expect(await page.evaluate(() => localStorage.getItem("cloudhub-app-sidebar-width"))).toBe(stored);
    expect(await page.evaluate(() => document.body.classList.contains("pane-resizing"))).toBe(false);
  }
});
