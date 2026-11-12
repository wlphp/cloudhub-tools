import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, mode: "desktop" | "preview" | "phone" = "desktop") {
  await page.addInitScript(({ mode }) => {
    const state = window as any;
    state.__savedNotes = [];
    state.__popups = [];
    state.__nativeCalls = [];
    state.__listeners = [];
    const callbacks = new Map<number, Function>();
    let next = 0;
    state.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    state.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: (callback: Function) => { callbacks.set(++next, callback); return next; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command.startsWith("plugin:")) {
          if (command === "plugin:window|get_all_windows") return ["main", ...state.__popups.map((popup: Window) => popup.name)];
          if (command === "plugin:event|listen") { state.__listeners.push(args); return next; }
          state.__nativeCalls.push({ command, label: args.label });
          if (command === "plugin:window|destroy") state.__popups.find((popup: Window) => popup.name === args.label)?.close();
          return null;
        }
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        if (command === "notes_snapshot") return { notes: [], trashed: [], groups: ["公司"], reminders: [] };
        if (command === "notes_save") { state.__savedNotes.push(args); return 1; }
        return [];
      },
    };
    state.__requestNativeClose = async () => {
      const listener = state.__listeners.findLast((item: any) => item.event === "tauri://close-requested" && item.target?.label.startsWith("dialog-popout-"));
      await callbacks.get(listener.handler)?.({ event: "tauri://close-requested", id: 1, payload: null });
    };
    const original = window.open.bind(window);
    window.open = (...args) => {
      if (state.__blockPopup) return null;
      const popup = original(...args);
      if (popup) state.__popups.push(popup);
      return popup;
    };
    if (mode === "phone") Object.defineProperty(navigator, "userAgent", { value: "Android" });
    if (mode === "preview") delete state.__TAURI_INTERNALS__;
  }, { mode });
  if (mode === "preview") {
    await page.route("**/api/**", route => route.fulfill({ json: route.request().url().includes("/api/notes") ? { notes: [], trashed: [], groups: ["公司"], reminders: [] } : [] }));
  }
  await page.goto("/");
  await page.getByRole("button", { name: "备忘录", exact: true }).first().click();
  await page.getByRole("button", { name: "新建备忘录", exact: true }).first().click();
  return page.getByRole("dialog", { name: "新建备忘录", exact: true });
}

test("detaching keeps the live form, releases the parent and saves through the original owner", async ({ page }) => {
  const dialog = await fixture(page);
  await dialog.getByLabel("标题", { exact: true }).fill("分离前标题");
  await dialog.getByRole("textbox", { name: "正文", exact: true }).fill("分离前正文");
  const popupReady = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "移到独立窗口", exact: true }).click();
  const popup = await popupReady;
  const moved = popup.getByRole("dialog", { name: "新建备忘录", exact: true });
  await expect(moved).toBeVisible();
  await expect(page.locator("body > .modal-backdrop")).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("inert");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await expect(moved).toBeVisible();
  await expect(moved.getByLabel("标题", { exact: true })).toHaveValue("分离前标题");
  await expect(moved.getByRole("textbox", { name: "正文", exact: true })).toHaveValue("分离前正文");
  await moved.getByLabel("标题", { exact: true }).fill("独立窗口编辑");
  await moved.getByRole("textbox", { name: "正文", exact: true }).fill("独立窗口正文");
  await moved.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  expect(await page.evaluate(() => (window as any).__savedNotes[0].input)).toMatchObject({ title: "独立窗口编辑", body: "独立窗口正文" });
});

test("dragging past an edge detaches once, while an ordinary drag stays modal", async ({ page }) => {
  const dialog = await fixture(page);
  const head = await dialog.locator("header h2").boundingBox();
  if (!head) throw new Error("Missing dialog header");
  await page.mouse.move(head.x + 30, head.y + 8);
  await page.mouse.down();
  await page.mouse.move(head.x + 45, head.y + 8, { steps: 3 });
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).__popups.length)).toBe(0);
  const popupReady = page.waitForEvent("popup");
  const next = await dialog.locator("header h2").boundingBox();
  await page.mouse.move(next!.x + 30, next!.y + 8);
  await page.mouse.down();
  await page.mouse.move(1438, next!.y + 8, { steps: 12 });
  await page.mouse.up();
  const popup = await popupReady;
  await expect(popup.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__popups.length)).toBe(1);
  await popup.getByRole("button", { name: "关闭新建备忘录", exact: true }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
});

test("failed window creation preserves the draft and parent isolation, and can retry", async ({ page }) => {
  const dialog = await fixture(page);
  await dialog.getByLabel("标题", { exact: true }).fill("保留草稿");
  await page.evaluate(() => { (window as any).__blockPopup = true; });
  await dialog.getByRole("button", { name: "移到独立窗口", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("标题", { exact: true })).toHaveValue("保留草稿");
  await expect(page.locator("#root")).toHaveAttribute("inert");
  await page.evaluate(() => { (window as any).__blockPopup = false; });
  const popupReady = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "移到独立窗口", exact: true }).click();
  const popup = await popupReady;
  await expect(popup.getByRole("dialog")).toBeVisible();
  await popup.getByLabel("标题", { exact: true }).focus();
  await popup.keyboard.press("Escape").catch(error => { if (!popup.isClosed()) throw error; });
  await expect.poll(() => popup.isClosed()).toBe(true);
});

test("native close uses the shared close action", async ({ page }) => {
  const dialog = await fixture(page);
  const popupReady = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "移到独立窗口", exact: true }).click();
  const popup = await popupReady;
  await expect(popup.getByRole("dialog")).toBeVisible();
  await page.evaluate(() => (window as any).__requestNativeClose());
  await expect.poll(() => popup.isClosed()).toBe(true);
});

test("browser preview dialogs keep the in-page presentation", async ({ page }) => {
  const dialog = await fixture(page, "preview");
  await expect(dialog.getByRole("button", { name: "移到独立窗口", exact: true })).toHaveCount(0);
});
