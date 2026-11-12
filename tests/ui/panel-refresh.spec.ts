import { expect, test } from "@playwright/test";

test("panel refreshes are independent and batch refresh shares pending requests", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("aliyun-panel-refresh-seconds", "0");
    const panels = [1, 2, 3].map(id => ({ id, name: `测试面板 ${id}`, panel_url: `https://192.0.2.${id}:8888`, sort_order: id, api_key_saved: true, status: "offline", summary: {}, created_at: 1, updated_at: 1 }));
    const calls: number[] = [];
    const pending = new Map<number, { resolve: (panel: unknown) => void; reject: (reason: Error) => void }>();
    Object.assign(window, {
      __refreshCalls: calls,
      __finishPanel: (id: number, fail = false) => {
        const request = pending.get(id)!;
        pending.delete(id);
        if (fail) request.reject(new Error("测试连接失败"));
        else request.resolve({ ...panels.find(panel => panel.id === id), status: "online" });
      },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string, args: { id: number }) => {
          if (command === "list_panel_connections") return panels;
          if (command === "refresh_panel_connection") {
            calls.push(args.id);
            return new Promise((resolve, reject) => pending.set(args.id, { resolve, reject }));
          }
          if (command === "authenticator_status") return { configured: false, unlocked: false };
          if (command === "list_client_preferences") return {};
          return [];
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "面板管理", exact: true }).first().click();
  const first = page.getByRole("button", { name: "刷新 测试面板 1 状态", exact: true });
  const second = page.getByRole("button", { name: "刷新 测试面板 2 状态", exact: true });
  const third = page.getByRole("button", { name: "刷新 测试面板 3 状态", exact: true });
  const batch = page.getByTitle("刷新所有面板状态", { exact: true });
  await first.click();
  await expect(first).toBeDisabled();
  await expect(second).toBeEnabled();
  await expect(batch).toBeEnabled();
  await second.click();
  await expect(second).toBeDisabled();
  await expect(third).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__refreshCalls)).toEqual([1, 2]);
  await page.evaluate(() => (window as any).__finishPanel(2));
  await expect(second).toBeEnabled();
  await expect(first).toBeDisabled();
  await page.evaluate(() => (window as any).__finishPanel(1, true));
  await expect(first).toBeEnabled();

  // Retry and start a batch while that retry is pending: the first request is shared.
  await first.click();
  await batch.click();
  await expect(batch).toBeDisabled();
  await expect(second).toBeEnabled();
  await expect(third).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__refreshCalls)).toEqual([1, 2, 1]);
  await page.evaluate(() => (window as any).__finishPanel(1));
  await expect(second).toBeDisabled();
  await expect(first).toBeEnabled();
  await expect(third).toBeEnabled();
  await page.evaluate(() => (window as any).__finishPanel(2));
  await expect(third).toBeDisabled();
  await page.evaluate(() => (window as any).__finishPanel(3));
  await expect(batch).toBeEnabled();
  await expect(third).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__refreshCalls)).toEqual([1, 2, 1, 2, 3]);

  // The timer uses the same visible per-panel feedback as a manual refresh.
  const idleColor = await first.evaluate(button => getComputedStyle(button).color);
  await page.getByLabel("监控资源刷新间隔").selectOption("5");
  await expect(first).toHaveAttribute("aria-busy", "true", { timeout: 8000 });
  await expect(first).toHaveClass(/is-refreshing/);
  await expect(first.locator("svg")).toHaveCSS("animation-name", "spin");
  await expect(first).toHaveCSS("opacity", "1");
  expect(await first.evaluate(button => getComputedStyle(button).color)).not.toBe(idleColor);
  await expect(second).toBeEnabled();
  await page.evaluate(() => (window as any).__finishPanel(1));
  await expect(first).toHaveAttribute("aria-busy", "false");
  await expect(first).toHaveCSS("color", idleColor);
  await expect(second).toHaveAttribute("aria-busy", "true");
  await expect(second.locator("svg")).toHaveCSS("animation-name", "spin");
  await page.evaluate(() => (window as any).__finishPanel(2));
  await expect(third).toHaveAttribute("aria-busy", "true");
  await page.getByLabel("监控资源刷新间隔").selectOption("0");
  await page.evaluate(() => (window as any).__finishPanel(3));
  await expect(third).toHaveAttribute("aria-busy", "false");
  await expect(batch).toBeEnabled();
});
