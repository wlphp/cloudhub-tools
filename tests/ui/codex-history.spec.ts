import { test, expect } from "@playwright/test";

test("shared history filters targets, confirms recovery, preserves selected backups and handles conflicts", async ({ page }) => {
  await page.addInitScript(() => {
    const home = "C:/fixture/.codex";
    let version = "v1";
    const targets = [{ id: null, name: "默认 Codex 客户端", home, version, pending: false }, { id: "instance-a", name: "测试实例", home: "C:/fixture/instance-a", version, pending: false }];
    let entries = [
      { id: "account-point", home, instanceId: null, createdAt: 1793050200000, migratedAt: null, source: "account", mode: "官方 OAuth", summary: "配置、登录、模型目录与目标绑定", complete: true, pinned: true, pending: false },
      { id: "provider-point", home: targets[1].home, instanceId: "instance-a", createdAt: 1793050100000, migratedAt: null, source: "provider", mode: "供应商 API Key", summary: "配置、登录、模型目录与目标绑定", complete: true, pinned: false, pending: false },
      { id: "legacy-point", home, instanceId: null, createdAt: null as number | null, migratedAt: 1793050000000 as number | null, source: "legacy_account", mode: "官方 OAuth", summary: "仅登录备份", complete: false, pinned: true, pending: false },
    ];
    const state = () => ({ entries, targets: targets.map(t => ({ ...t, version })) });
    Object.assign(window, { __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {}, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "codex_get_state") return { accounts: [], cliAvailable: true, desktopAvailable: true, profileHome: home, currentAccountId: null, canRestore: false };
        if (command === "codex_config_source") return { path: home + "/config.toml", workspace: null, exists: true };
        if (command === "codex_history_list") { if (localStorage.getItem("history-load-error")) throw { code: "codex-provider", message: "读取 Codex 备份状态失败" }; return state(); }
        if (command === "codex_history_action") {
          const calls = JSON.parse(localStorage.getItem("history-calls") ?? "[]"); calls.push(args); localStorage.setItem("history-calls", JSON.stringify(calls));
          await new Promise(resolve => setTimeout(resolve, 100));
          if (localStorage.getItem("history-conflict")) { version = "v2"; throw { code: "codex-provider", message: "目标配置已变更，请重新预览" }; }
          if (args.action === "manual" || args.action === "restore") entries = [{ ...entries[0], id: `new-${entries.length}`, createdAt: Date.now(), source: args.action === "manual" ? "manual" : "restore" }, ...entries];
          if (args.action === "pin") entries = entries.map(e => e.id === args.snapshotId ? { ...e, pinned: args.pinned as boolean } : e);
          if (args.action === "delete") entries = entries.filter(e => e.id !== args.snapshotId);
          return state();
        }
        if (command === "codex_gateway_state") return { running: false, accountIds: [], completed: 0, failed: 0, active: 0 };
        if (command === "list_client_preferences") return {};
        if (command === "app_is_development") return true;
        if (command === "plugin:app|version") return "0.1.96";
        if (command === "plugin:updater|check") return null;
        if (command === "plugin:event|listen") return 1;
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  const open = page.getByRole("button", { name: "备份与恢复", exact: true });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Codex 备份与恢复", exact: true });
  await expect(dialog.getByRole("row")).toHaveCount(4);
  await expect(dialog.getByRole("button", { name: "立即备份", exact: true })).toBeDisabled();
  await expect(dialog.getByText("旧版备份 · 原备份时间未知", { exact: true })).toBeVisible();
  await expect(dialog.locator("time").first()).toHaveAttribute("datetime", "2026-10-26T21:30:00.000Z");
  await page.mouse.click(1, 1);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("备份目标", { exact: true }).selectOption("instance-a");
  await expect(dialog.getByRole("row")).toHaveCount(2);
  await expect(dialog.getByText("供应商 API Key", { exact: true })).toBeVisible();
  await dialog.getByLabel("备份目标", { exact: true }).selectOption("default");
  await dialog.getByLabel("备份来源", { exact: true }).selectOption("account");
  await expect(dialog.getByRole("row")).toHaveCount(2);
  await dialog.getByRole("button", { name: "恢复", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "恢复所选 Codex 备份", exact: true });
  await expect(confirm).toContainText("当前状态会先自动备份");
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("history-calls"))).toBeNull();
  await dialog.getByRole("button", { name: "恢复", exact: true }).click();
  await page.evaluate(() => localStorage.setItem("history-conflict", "1"));
  await confirm.getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect(confirm.getByRole("alert")).toHaveText("目标配置已变更，请重新预览");
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await page.evaluate(() => localStorage.removeItem("history-conflict"));
  await dialog.getByRole("button", { name: "恢复", exact: true }).click();
  await confirm.getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect(dialog.getByText(/已恢复所选备份/)).toBeVisible();
  const calls = await page.evaluate(() => JSON.parse(localStorage.getItem("history-calls") ?? "[]"));
  expect(calls).toMatchObject([{ action: "restore", snapshotId: "account-point", target: null, version: "v1" }, { action: "restore", snapshotId: "account-point", target: null, version: "v2" }]);
  await dialog.getByLabel("备份来源", { exact: true }).selectOption("");
  await expect(dialog.getByRole("row")).toHaveCount(4);
  await dialog.getByRole("button", { name: "立即备份", exact: true }).click();
  await expect(dialog.getByText("当前配置与登录已加密备份", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("row")).toHaveCount(5);
  await dialog.getByRole("button", { name: "取消保留备份 account-point", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "保留备份 account-point", exact: true })).toHaveAttribute("aria-pressed", "false");
  await dialog.getByRole("button", { name: "删除备份 legacy-point", exact: true }).click();
  await page.getByRole("alertdialog", { name: "删除 Codex 备份", exact: true }).getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(dialog.getByRole("row")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.evaluate(() => localStorage.setItem("history-load-error", "1"));
  await open.click();
  await expect(dialog.getByRole("alert")).toHaveText("读取 Codex 备份状态失败");
  await page.evaluate(() => localStorage.removeItem("history-load-error"));
  await dialog.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(dialog.getByRole("row")).toHaveCount(5);
  for (const width of [375, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: "test-results/codex-history.png", fullPage: true });
});
