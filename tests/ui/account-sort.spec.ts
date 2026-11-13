import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.addInitScript(() => {
    (window as any).accountSaveCalls = 0;
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string, args: any) => {
        if (command === "list_accounts") return Array.from({ length: 12 }, (_, index) => ({ id: index + 1, account_name: `账号 ${index + 1}`, cloud_type: "aliyun", enabled: true, access_key_id: "", group_name: index === 11 ? "单个账号" : index % 2 === 0 ? "分组 A" : "分组 B", sort_order: index, created_at: 1, updated_at: 1 }));
        if (command === "list_client_preferences") return JSON.parse(localStorage.getItem("fixture-preferences") || "{}");
        if (command === "save_client_preference") {
          const preferences = JSON.parse(localStorage.getItem("fixture-preferences") || "{}");
          preferences[args.key] = args.value;
          localStorage.setItem("fixture-preferences", JSON.stringify(preferences));
          return;
        }
        if (command === "save_account") { (window as any).accountSaveCalls++; return; }
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "账号管理", exact: true }).first().click();
  await expect(page.locator("[data-account-sort-id]")).toHaveCount(10);
}

const order = (page: Page) => page.locator("[data-account-sort-id]").evaluateAll(rows => rows.map(row => Number(row.getAttribute("data-account-sort-id"))));
async function drag(page: Page, source: number, target: number) {
  const rows = page.locator("[data-account-sort-id]");
  const from = (await rows.nth(source).locator(".account-drag-handle").boundingBox())!;
  const to = (await rows.nth(target).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, { steps: 12 });
  await expect(page.locator("[data-sortable-dragging]")).toHaveCount(1);
}

test("点击排序后显示手柄，退出恢复勾选，刷新后保留账号顺序", async ({ page }) => {
  await fixture(page);
  await expect(page.locator(".account-drag-handle")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "选择账号 账号 1", exact: true }).check();
  await page.getByRole("button", { name: "账号排序", exact: true }).click();
  await expect(page.locator(".account-drag-handle")).toHaveCount(10);
  await drag(page, 0, 2);
  expect((await order(page))[0]).toBe(1);
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual([2, 3, 1, 4, 5, 6, 7, 8, 9, 10]);
  await page.getByRole("button", { name: "退出账号排序", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "选择账号 账号 1", exact: true })).toBeChecked();
  expect(await page.evaluate(() => (window as any).accountSaveCalls)).toBe(0);
  await page.reload();
  await page.getByRole("button", { name: "账号管理", exact: true }).first().click();
  await expect.poll(() => order(page)).toEqual([2, 3, 1, 4, 5, 6, 7, 8, 9, 10]);
  await expect(page.locator(".account-drag-handle")).toHaveCount(0);
});

test("筛选排序保留未显示账号的位置，筛选剩一项时仍可退出排序", async ({ page }) => {
  await fixture(page);
  await page.getByLabel("按分组筛选", { exact: true }).selectOption("分组 A");
  await page.getByRole("button", { name: "账号排序", exact: true }).click();
  await drag(page, 0, 2);
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual([3, 5, 1, 7, 9, 11]);
  await page.getByLabel("按分组筛选", { exact: true }).selectOption("");
  await expect.poll(() => order(page)).toEqual([3, 2, 5, 4, 1, 6, 7, 8, 9, 10]);
  await page.getByLabel("按分组筛选", { exact: true }).selectOption("单个账号");
  await expect(page.getByRole("button", { name: "退出账号排序", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "退出账号排序", exact: true }).click();
  await expect(page.getByRole("button", { name: "账号排序", exact: true })).toBeDisabled();
});

test("分页内可排序，Escape 取消并支持键盘调整", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "账号排序", exact: true }).click();
  await page.getByRole("button", { name: "第 2 页", exact: true }).click();
  await expect.poll(() => order(page)).toEqual([11, 12]);
  await drag(page, 0, 1);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await order(page)).toEqual([11, 12]);
  await page.locator(".account-drag-handle").first().press("ArrowDown");
  await expect.poll(() => order(page)).toEqual([12, 11]);
  await page.getByRole("button", { name: "第 1 页", exact: true }).click();
  expect(await order(page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
