import { test, expect } from "@playwright/test";

for (const theme of ["light", "dark"] as const) test(`launch settings remain readable while configuration loads in ${theme} mode`, async ({ page }) => {
  await page.addInitScript(theme => {
    localStorage.setItem("cloudhub-tools-ui-theme", theme);
    const account = { id: 1, label: "layout@example.test", email: "layout@example.test", accountId: "fixture-account", authMode: "chatgpt", plan: "free", note: "", tags: [], updatedAt: 1, lastError: null,
      quota: { fetchedAt: Date.now(), windows: [{ name: "monthly", usedPercent: 1, windowMinutes: 43200, resetsAt: Date.now() / 1000 + 86400 }] } };
    Object.assign(window, { __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string) => {
        if (command === "list_client_preferences") return {};
        if (command === "codex_get_state") return { accounts: [account], currentAccountId: 1, cliAvailable: true, desktopAvailable: true, canOpenDefault: true, profileHome: "C:\\fixture\\.codex", canRestore: false };
        if (command === "codex_auth_metadata") return { userId: "fixture-user", hasRefreshToken: true };
        if (command === "codex_launch_config") {
          await new Promise<void>(resolve => Object.assign(window, { releaseLaunchConfig: resolve }));
          return { version: "fixture", model: "fixture-model", contextWindow: 200000, compactLimit: 180000 };
        }
        if (command === "codex_gateway_state") return { running: false, accountIds: [], startupAccountIds: [], settings: {} };
        if (command === "plugin:app|version") return "0.1.91";
        if (command === "plugin:event|listen") return 1;
        return [];
      },
    } });
  }, theme);
  await page.goto("/");
  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  await page.getByRole("button", { name: "启动预览 layout@example.test", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Codex 启动预览", exact: true });
  await expect(dialog.getByText("正在读取目标实例配置…", { exact: true })).toBeAttached();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 650 });
    const settings = dialog.locator(".codex-launch-settings");
    await settings.scrollIntoViewIfNeeded();
    expect(await settings.evaluate(element => {
      const card = element.getBoundingClientRect();
      const rows = [...element.children].map(row => row.getBoundingClientRect());
      return element.scrollHeight <= element.clientHeight + 1 && rows.every(row => row.top >= card.top && row.bottom <= card.bottom) && rows[0].bottom <= rows[1].top;
    }), `settings must not collapse at ${width}px`).toBe(true);
    await expect(dialog.getByRole("button", { name: "切换并启动", exact: true })).toBeInViewport();
  }
  const settings = dialog.locator(".codex-launch-settings");
  const before = await settings.boundingBox();
  await page.screenshot({ path: `test-results/codex-launch-loading-${theme}.png` });
  await page.evaluate(() => (window as unknown as { releaseLaunchConfig: () => void }).releaseLaunchConfig());
  await expect(dialog.getByRole("button", { name: "配置上下文", exact: true })).toBeEnabled();
  await expect(dialog.getByText("正在读取目标实例配置…", { exact: true })).toHaveCount(0);
  const after = await settings.boundingBox();
  expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  await dialog.getByRole("button", { name: "配置上下文", exact: true }).click();
  await expect(dialog.getByLabel("上下文窗口", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
