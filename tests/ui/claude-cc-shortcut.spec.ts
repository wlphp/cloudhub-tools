import { expect, test } from "@playwright/test";

test("cc shortcut applies, restores, reports failure and fits narrow layouts", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    let installed = false;
    (window as any).__ccActions = [];
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args?: any) => {
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        if (command === "claude_provider_list") return { providers: [], currentId: null, backups: [] };
        if (command === "claude_routing_state") return { mode: "direct", running: false, config: {}, health: {}, logs: [] };
        if (command === "claude_workspace_state") return { mcp: [], prompts: [], skills: [], sessions: [], environmentConflicts: [], ccShortcut: { installed, recoveryAvailable: installed, paths: ["C:/fixture/.local/bin/cc.bat"] } };
        if (command === "claude_workspace_action") {
          (window as any).__ccActions.push(args.action);
          if ((window as any).__ccFail) throw new Error("cc.bat 已被外部修改，未删除");
          installed = args.action.enabled;
          return null;
        }
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Claude 管理", exact: true }).first().click();
  await page.getByRole("button", { name: "配置", exact: true }).click();
  const area = page.locator(".claude-cc-shortcut");
  const apply = area.getByRole("button", { name: "一键配置 cc" });
  const restore = area.getByRole("button", { name: "恢复", exact: true });
  await expect(restore).toBeDisabled();
  await apply.click();
  await expect(area.getByRole("status")).toHaveText("已配置");
  await expect(apply).toBeDisabled();
  await page.evaluate(() => { (window as any).__ccFail = true; });
  await restore.click();
  await expect(page.getByText("cc.bat 已被外部修改，未删除", { exact: true })).toBeVisible();
  await expect(area.getByRole("status")).toHaveText("已配置");
  await page.evaluate(() => { (window as any).__ccFail = false; });
  await restore.click();
  await expect(area.getByRole("status")).toHaveText("未配置");
  await expect.poll(() => page.evaluate(() => (window as any).__ccActions)).toEqual([
    { type: "cc_shortcut", enabled: true }, { type: "cc_shortcut", enabled: false }, { type: "cc_shortcut", enabled: false },
  ]);
  await area.getByText("使用方法与恢复说明", { exact: true }).click();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(area).toBeVisible();
    expect(await area.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("cc-config.png"), fullPage: true });
});
