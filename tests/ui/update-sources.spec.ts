import { test, expect } from "@playwright/test";

test("update sources persist, probe on request, and pin the selected version during installation", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const fixture = { calls: [] as { command: string; source?: string; version?: string }[], finish: null as null | (() => void) };
    (window as any).__updateFixture = fixture;
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        fixture.calls.push({ command, source: args.source, version: args.expectedVersion });
        if (command === "app_is_development") return false;
        if (command === "plugin:app|version") return "0.1.146";
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return { "app.update.source": localStorage.getItem("test-update-source") || "auto" };
        if (command === "save_client_preference") { localStorage.setItem("test-update-source", args.value); return; }
        if (command === "app_update_check") return { version: "99.1.0", notes: "测试发布", route: args.source === "direct" ? "direct" : "accelerated" };
        if (command === "app_update_probe") return { route: args.route, available: args.route === "accelerated", responseMs: 100, bytesPerSecond: 102400, message: "直连不可用" };
        if (command === "app_update_install") {
          args.onProgress.onmessage({ downloaded: 50, total: 100, route: "direct", message: "正在通过 GitHub 官方直连重新下载同一版本" });
          return new Promise<void>(resolve => { fixture.finish = resolve; });
        }
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("tab", { name: "关于", exact: true }).click();
  const source = page.getByRole("combobox", { name: "更新下载线路" });
  await expect(source).toHaveValue("auto");
  expect(await page.evaluate(() => (window as any).__updateFixture.calls.filter((c: any) => c.command === "app_update_probe"))).toEqual([]);
  await page.getByRole("button", { name: "测速 / 切换" }).click();
  const dialog = page.getByRole("dialog", { name: "软件更新 · 选择下载线路" });
  await dialog.getByRole("button", { name: "重新测速" }).click();
  await expect(dialog.getByText("测速完成", { exact: true })).toBeVisible();
  await expect(dialog.getByText("100 ms · 100.0 KiB/s")).toBeVisible();
  await dialog.locator(".update-source-node").filter({ hasText: "GitHub 官方直连" }).getByRole("button", { name: "使用此线路" }).click();
  await expect(dialog.getByText("当前选择：GitHub 官方直连")).toBeVisible();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("update-sources.png") });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(source).toHaveValue("direct");
  await page.getByRole("button", { name: "更新到 v99.1.0" }).click();
  await expect(source).toBeDisabled();
  await expect(page.getByText(/正在通过 GitHub 官方直连重新下载同一版本/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__updateFixture.calls.find((c: any) => c.command === "app_update_install"))).toMatchObject({ source: "direct", version: "99.1.0" });
  await page.evaluate(() => (window as any).__updateFixture.finish());
  await expect.poll(() => page.evaluate(() => (window as any).__updateFixture.calls.some((c: any) => c.command === "plugin:process|restart"))).toBe(true);
});
