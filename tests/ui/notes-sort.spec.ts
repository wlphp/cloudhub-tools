import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await page.addInitScript(() => {
    let notes = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, title: `测试备忘录 ${index + 1}`, body: "示例正文", group: index % 2 === 0 ? "A" : "B", tags: [], account: "", password: "", pinned: index < 2, remindAt: null, remindRepeat: "none", remindDoneAt: null, createdAt: 1, updatedAt: 1, deletedAt: null }));
    (window as any).noteOrderWrites = [];
    (window as any).noteWrites = 0;
    (window as any).failOrderSave = false;
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string, args: any) => {
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return JSON.parse(localStorage.getItem("fixture-note-preferences") || "{}");
        if (command === "save_client_preference") {
          if (args.key === "cloudhub.notes.order") {
            if ((window as any).failOrderSave) throw new Error("fixture save failed");
            (window as any).noteOrderWrites.push(JSON.parse(args.value));
          }
          const values = JSON.parse(localStorage.getItem("fixture-note-preferences") || "{}");
          values[args.key] = args.value;
          localStorage.setItem("fixture-note-preferences", JSON.stringify(values));
          return;
        }
        if (command === "notes_snapshot") return { notes, groups: ["A", "B"], reminders: [], trashed: [] };
        if (command === "notes_save") { (window as any).noteWrites++; notes = notes.map(note => note.id === args.input.id ? { ...note, ...args.input } : note); return args.input.id; }
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "备忘录", exact: true }).first().click();
  await expect(page.locator("[data-note-sort-id]")).toHaveCount(6);
}

const order = (page: Page) => page.locator("[data-note-sort-id]").evaluateAll(items => items.map(item => Number(item.getAttribute("data-note-sort-id"))));
async function drag(page: Page, source: number, target: number) {
  const from = (await page.locator(`[data-note-sort-id="${source}"] .notes-drag-handle`).boundingBox())!;
  const to = (await page.locator(`[data-note-sort-id="${target}"]`).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + 20, { steps: 12 });
  await expect(page.locator("[data-sortable-dragging]")).toHaveCount(1);
}

test("备忘录默认选择与全选，显式排序后跨行移动并持久保存", async ({ page }) => {
  await fixture(page);
  await expect(page.locator(".notes-drag-handle")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "全选当前结果备忘录", exact: true }).check();
  await page.getByRole("button", { name: "备忘录排序", exact: true }).click();
  await expect(page.locator(".notes-card input[type=checkbox]")).toHaveCount(0);
  await drag(page, 3, 6);
  expect(await order(page)).toEqual([1, 2, 3, 4, 5, 6]);
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual([1, 2, 4, 5, 6, 3]);
  await expect(page.getByText("备忘录顺序已保存", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).noteWrites)).toBe(0);
  expect(await page.evaluate(() => (window as any).noteOrderWrites)).toEqual([["1", "2", "4", "5", "6", "3"]]);
  await page.getByRole("button", { name: "退出备忘录排序", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "全选当前结果备忘录", exact: true })).toBeChecked();
  await expect(page.locator(".notes-panel")).toHaveClass(/notes-privacy/);
  await page.reload();
  await page.getByRole("button", { name: "备忘录", exact: true }).first().click();
  await expect.poll(() => order(page)).toEqual([1, 2, 4, 5, 6, 3]);
  await expect(page.locator(".notes-drag-handle")).toHaveCount(0);
});

test("置顶区域保留优先级，不能拖入另一类，置顶与取消置顶正常", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "备忘录排序", exact: true }).click();
  await drag(page, 1, 4);
  await page.mouse.up();
  expect(await order(page)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(await page.evaluate(() => (window as any).noteOrderWrites)).toEqual([]);
  await expect.poll(() => page.locator("[data-note-sort-id]").evaluateAll(items => items.every(item => !item.getAnimations().length))).toBe(true);
  await drag(page, 1, 2);
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual([2, 1, 3, 4, 5, 6]);
  await page.getByRole("button", { name: "退出备忘录排序", exact: true }).click();
  await page.getByRole("button", { name: "置顶 测试备忘录 3", exact: true }).click();
  await expect(page.locator('[data-note-sort-id="3"]')).toHaveClass(/is-pinned/);
  await page.getByRole("button", { name: "取消置顶 测试备忘录 1", exact: true }).click();
  await expect.poll(() => order(page)).toEqual([2, 3, 1, 4, 5, 6]);
});

test("分组筛选只改变当前同类卡片，Escape 取消不保存", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  await page.getByRole("group", { name: "按分组筛选", exact: true }).getByRole("button", { name: /^A / }).click();
  await page.getByRole("button", { name: "备忘录排序", exact: true }).click();
  await drag(page, 3, 5);
  await page.keyboard.press("Escape"); await page.mouse.up();
  expect(await page.evaluate(() => (window as any).noteOrderWrites)).toEqual([]);
  await drag(page, 3, 5); await page.mouse.up();
  await expect(page.getByText("备忘录顺序已保存", { exact: true })).toBeVisible();
  await page.getByRole("group", { name: "按分组筛选", exact: true }).getByRole("button", { name: /^全部 / }).click();
  await expect.poll(() => order(page)).toEqual([1, 2, 5, 4, 3, 6]);
});

test("排序保存失败回滚顺序与缓存，并提示错误", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { (window as any).failOrderSave = true; });
  await page.getByRole("button", { name: "备忘录排序", exact: true }).click();
  await drag(page, 3, 6); await page.mouse.up();
  await expect(page.getByRole("alert")).toContainText("保存备忘录排序失败");
  await expect.poll(() => order(page)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(await page.evaluate(() => localStorage.getItem("cloudhub.notes.order"))).toBe("[]");
});
