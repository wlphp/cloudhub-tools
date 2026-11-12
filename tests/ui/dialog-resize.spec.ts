import { expect, test, type Locator, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.addInitScript(() => {
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        if (command === "list_accounts") return [7, 8].map(id => ({ id, account_name: `account-${id}`, cloud_type: "aliyun", access_key_id: "fixture-id", enabled: true }));
        if (command === "list_local_assets") return [...[7, 8].map(id => ({ account_id: id, resource_type: "oss", asset_key: `bucket-${id}`, fetched_at: 1, payload: { Name: `bucket-${id}`, Location: "oss-cn-beijing" } })), { account_id: 7, resource_type: "domain", asset_key: "example.test", fetched_at: 1, payload: { DomainName: "example.test" } }];
        if (command === "query_whois") return "Domain Name: EXAMPLE.TEST\nRegistrar: Fixture Registrar";
        if (command === "get_oss_acl") return "private";
        if (command === "list_oss_objects") return { prefixes: args.prefix ? [] : ["documents/", ...Array.from({ length: 35 }, (_, index) => `folder-${index}/`)], objects: [], isTruncated: false, nextMarker: "" };
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "资产管理", exact: true }).click();
}
async function openFiles(page: Page, id = 7) {
  await page.getByRole("row").filter({ has: page.getByText(`bucket-${id}`, { exact: true }).first() }).getByRole("button", { name: "文件列表", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "文件列表", exact: true });
  await expect(dialog.getByRole("button", { name: "documents", exact: true })).toBeVisible();
  return dialog;
}
async function size(dialog: Locator) {
  return dialog.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: Math.round(r.width), height: Math.round(r.height), right: r.right, bottom: r.bottom }; });
}
async function drag(page: Page, dialog: Locator, direction: string, dx: number, dy: number) {
  const box = await dialog.locator(`.dialog-resize-${direction}`).boundingBox();
  if (!box) throw new Error(`Missing ${direction} resize handle`);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}
async function closeFiles(page: Page) {
  await page.getByRole("dialog", { name: "文件列表", exact: true }).getByRole("button", { name: "关闭文件列表", exact: true }).click();
  await page.getByRole("dialog", { name: "对象存储", exact: true }).getByRole("button", { name: "关闭对象存储", exact: true }).click();
}

test("all four edges and corners resize, anchoring the opposite edge", async ({ page }) => {
  await fixture(page);
  const dialog = await openFiles(page);
  await expect(dialog.locator(".dialog-resize-handle")).toHaveCount(8);
  for (const direction of ["e", "w", "n", "s", "ne", "nw", "se", "sw"]) {
    const before = await size(dialog);
    const dx = direction.includes("e") ? -20 : direction.includes("w") ? 20 : 0;
    const dy = direction.includes("s") ? -20 : direction.includes("n") ? 20 : 0;
    await drag(page, dialog, direction, dx, dy);
    const after = await size(dialog);
    expect(after.width).toBe(before.width - Math.abs(dx));
    expect(after.height).toBe(before.height - Math.abs(dy));
    expect(Math.abs((direction.includes("w") ? after.right - before.right : after.x - before.x))).toBeLessThan(1);
    expect(Math.abs((direction.includes("n") ? after.bottom - before.bottom : after.y - before.y))).toBeLessThan(1);
    expect(await page.evaluate(() => [document.body.style.cursor, document.body.style.userSelect])).toEqual(["", ""]);
  }
  for (const direction of ["e", "w", "n", "s", "ne", "nw", "se", "sw"]) {
    const before = await size(dialog);
    const dx = direction.includes("e") ? 10 : direction.includes("w") ? -10 : 0;
    const dy = direction.includes("s") ? 10 : direction.includes("n") ? -10 : 0;
    await drag(page, dialog, direction, dx, dy);
    const after = await size(dialog);
    expect(after.width).toBe(before.width + Math.abs(dx));
    expect(after.height).toBe(before.height + Math.abs(dy));
  }
  const chosen = await size(dialog);
  const key = await dialog.getAttribute("data-dialog-size-key");
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(`cloudhub.dialogSize.${key}`)!), key)).toEqual({ width: chosen.width, height: chosen.height });
  await dialog.getByRole("button", { name: "documents", exact: true }).click();
  await expect(dialog.getByText("此目录暂无对象", { exact: true })).toBeVisible();
  expect(await size(dialog)).toEqual(chosen);
});

test("saved type dimensions survive reopen, another account and application reload", async ({ page }) => {
  await fixture(page);
  let dialog = await openFiles(page);
  await drag(page, dialog, "se", -180, -220);
  const chosen = await size(dialog);
  await dialog.getByRole("button", { name: "最大化弹层", exact: true }).click();
  await expect(dialog).toHaveClass(/dialog-size-expanded/);
  await expect(dialog.locator(".dialog-resize-e")).toBeHidden();
  await dialog.getByRole("button", { name: "缩小弹层", exact: true }).click();
  await expect.poll(async () => (await size(dialog)).width).toBe(chosen.width);
  await closeFiles(page);
  dialog = await openFiles(page, 8);
  expect(await size(dialog)).toMatchObject({ width: chosen.width, height: chosen.height });
  await closeFiles(page);
  const parent = await page.getByRole("row").filter({ hasText: "bucket-7" }).getByRole("button", { name: "容量统计", exact: true });
  await parent.click();
  const stat = page.getByRole("dialog", { name: "容量统计", exact: true });
  expect(await stat.getAttribute("data-dialog-size-key")).toBe("storage:aliyun:stat");
  await expect(stat).not.toHaveClass(/dialog-user-size/);
  await page.reload();
  await page.getByRole("button", { name: "资产管理", exact: true }).click();
  dialog = await openFiles(page);
  expect(await size(dialog)).toMatchObject({ width: chosen.width, height: chosen.height });
});

test("restored dimensions and subsequent drags stay inside the viewport", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => localStorage.setItem("cloudhub.dialogSize.storage:aliyun:files", JSON.stringify({ width: 1800, height: 1100 })));
  const dialog = await openFiles(page);
  await drag(page, dialog, "nw", 120, 120);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => { const r = await size(dialog); return r.right <= 1264 && r.bottom <= 784; }).toBe(true);
  await dialog.getByRole("button", { name: "最大化弹层", exact: true }).click();
  await page.setViewportSize({ width: 375, height: 600 });
  await dialog.getByRole("button", { name: "缩小弹层", exact: true }).click();
  await expect.poll(async () => {
    const r = await size(dialog);
    return r.x >= 15 && r.y >= 15 && r.right <= 360 && r.bottom <= 585;
  }).toBe(true);
  await drag(page, dialog, "se", 1000, 1000);
  const r = await size(dialog);
  expect(r.right).toBeLessThanOrEqual(360);
  expect(r.bottom).toBeLessThanOrEqual(585);
  await page.screenshot({ path: "test-results/dialog-resize-small-viewport.png" });
  await drag(page, dialog, "se", -1000, -1000);
  expect(await size(dialog)).toMatchObject({ width: 320, height: 180 });
});

test("malformed storage and unavailable storage do not break resize or close", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => localStorage.setItem("cloudhub.dialogSize.storage:aliyun:files", '{"width":-1,"height":null}'));
  const dialog = await openFiles(page);
  await expect(dialog).not.toHaveClass(/dialog-user-size/);
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith("cloudhub.dialogSize.")) throw new Error("Storage unavailable"); return set.call(this, key, value); };
  });
  const before = await size(dialog);
  await drag(page, dialog, "e", -100, 0);
  expect((await size(dialog)).width).toBe(before.width - 100);
  const handle = dialog.locator(".dialog-resize-s");
  const box = await handle.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await handle.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  expect(await page.evaluate(() => document.body.style.cursor)).toBe("");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("saved dimensions take precedence over a default maximized product dialog", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => localStorage.setItem("cloudhub.dialogSize.domain-tool:aliyun:whois", JSON.stringify({ width: 880, height: 520 })));
  await page.getByRole("button", { name: "WHOIS", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "【example.test】WHOIS", exact: true });
  await expect(dialog).toContainText("Fixture Registrar");
  await expect(dialog).not.toHaveClass(/dialog-size-expanded/);
  expect(await size(dialog)).toMatchObject({ width: 880, height: 520 });
  await dialog.getByRole("button", { name: "最大化弹层", exact: true }).click();
  await expect(dialog).toHaveClass(/dialog-size-expanded/);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "WHOIS", exact: true }).click();
  await expect(dialog).not.toHaveClass(/dialog-size-expanded/);
  expect(await size(dialog)).toMatchObject({ width: 880, height: 520 });
});

test("a compact saved height is restored exactly without applying drag minimums", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => localStorage.setItem("cloudhub.dialogSize.storage:aliyun:files", JSON.stringify({ width: 760, height: 160 })));
  const dialog = await openFiles(page);
  expect(await size(dialog)).toMatchObject({ width: 760, height: 160 });
});
