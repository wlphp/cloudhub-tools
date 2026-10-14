import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.addInitScript(() => {
    const calls: { command: string; args: any }[] = [];
    const accounts = [1, 2].map(id => ({ id, account_name: `云账号${id}`, cloud_type: "aliyun", enabled: true, sort_order: id, access_key_id: "", region_id: "cn-hangzhou", group_name: "测试", remark: "", secret_saved: true }));
    const hosts = [1, 2].map(id => ({ id, name: `服务器${id}`, host: `host${id}.example.test`, port: 22, username: "operator", platform: "linux", auth_method: "password", password_saved: true, private_key_saved: false, group_name: "测试", tags: "", status: "unknown", metrics: {}, remark: "" }));
    const panels = [1, 2].map(id => ({ id, name: `面板${id}`, panel_url: `https://panel${id}.example.test`, api_key_saved: true, allow_insecure_tls: false, group_name: "测试", sort_order: id }));
    (window as any).__exportCalls = calls;
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      // Keep migration passwords out of test artifacts.
      calls.push({ command, args: { ...args, ...(args.passphrase ? { passphrase: "[redacted]" } : {}), ...(args.password ? { password: "[redacted]" } : {}) } });
      if (command === "list_accounts") return accounts;
      if (command === "list_managed_hosts") return hosts;
      if (command === "list_panel_connections") return panels;
      if (command === "codex_get_state") return { accounts: [1, 2].map(id => ({ id, label: `Codex${id}`, authMode: "chatgpt", tags: [], note: "", quota: { fetchedAt: null, windows: [] }, lastError: null, updatedAt: 1 })), cliAvailable: true, desktopAvailable: true, currentAccountId: null, canRestore: false };
      if (command === "codex_gateway_state") return { running: false, accountIds: [], completed: 0, failed: 0, active: 0 };
      if (["codex_export_accounts_file", "codex_export_backup"].includes(command)) return true;
      if (["export_accounts_file", "export_managed_hosts_file", "export_panel_connections_file"].includes(command)) return "C:/fixture/export.json";
      if (command === "save_sync_account_bundle") return true;
      if (command === "preview_sync_account_bundle") return { accounts: [{ accountName: "云账号1" }], managedHosts: [], panels: [], deletions: [], conflicts: [], protocolVersion: 1 };
      if (command === "import_sync_account_bundle") return { accounts: 1, managedHosts: 0, panels: 0 };
      if (command === "plugin:app|version") return "0.1.52";
      if (command === "plugin:event|listen") return 1;
      if (command === "authenticator_status") return { initialized: false, unlocked: false, passwordRequired: false };
      return [];
    } };
  });
  await page.goto("/");
}

test("cloud exports require a choice and send only checked accounts", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "账号管理", exact: true }).first().click();
  await page.getByRole("button", { name: "导出账号", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "选择导出的云账号", exact: true });
  await expect(dialog.getByRole("button", { name: "导出所选（0）" })).toBeDisabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByLabel("选择账号 云账号2", { exact: true }).check();
  await page.getByRole("button", { name: "导出账号", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__exportCalls.find((call: any) => call.command === "export_accounts_file")?.args.accountIds)).toEqual([2]);
});

test("server export supports select all, clear, search, escape and a precise subset", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "终端管理", exact: true }).first().click();
  await page.getByRole("button", { name: "导出服务器", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "选择导出的服务器", exact: true });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().width <= innerWidth)).toBe(true);
  }
  await dialog.getByRole("button", { name: "全选", exact: true }).click();
  await expect(dialog.getByRole("checkbox")).toHaveCount(2);
  await dialog.getByRole("button", { name: "取消全选", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "导出所选（0）" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "导出服务器", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "选择导出的服务器", exact: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  const list = dialog.locator(".export-selection-list");
  const compactListHeight = (await list.boundingBox())!.height;
  await dialog.getByRole("button", { name: "最大化弹层", exact: true }).click();
  const expandedBox = await dialog.boundingBox();
  const expandedListBox = await list.boundingBox();
  expect(expandedBox!.height).toBeCloseTo(900 * .95, 0);
  expect(expandedListBox!.height).toBeGreaterThan(compactListHeight);
  expect(expandedBox!.y + expandedBox!.height - expandedListBox!.y - expandedListBox!.height).toBeLessThan(100);
  await dialog.screenshot({ path: "test-results/export-selection-maximized.png" });
  await dialog.getByRole("button", { name: "缩小弹层", exact: true }).click();
  expect((await list.boundingBox())!.height).toBeCloseTo(compactListHeight, 0);
  await dialog.getByLabel("搜索导出内容").fill("服务器2");
  await dialog.getByRole("checkbox", { name: /服务器2/ }).check();
  await dialog.screenshot({ path: "test-results/export-selection-server.png" });
  await dialog.getByRole("button", { name: "导出所选（1）" }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__exportCalls.find((call: any) => call.command === "export_managed_hosts_file")?.args.hostIds)).toEqual([2]);
});

test("settings selection exports encrypted configuration and previews its import", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "系统设置", exact: true }).first().click();
  await page.getByRole("button", { name: "选择导出", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "选择数据导出范围", exact: true });
  await dialog.getByRole("checkbox", { name: "云账号 · 云账号1", exact: true }).check();
  await dialog.getByLabel("迁移口令", { exact: true }).fill("public-fixture-passphrase");
  await dialog.getByLabel("确认迁移口令", { exact: true }).fill("public-fixture-passphrase");
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await dialog.screenshot({ path: "test-results/export-selection-data.png" });
  await dialog.getByRole("button", { name: "选择位置并导出", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("所选配置已导出");
  const exported = await page.evaluate(() => (window as any).__exportCalls.find((call: any) => call.command === "save_sync_account_bundle").args);
  expect(exported).toMatchObject({ accountIds: [1], managedHostIds: [], panelIds: [], includeDeletions: false });
  await dialog.getByLabel("导出范围").selectOption("import");
  await dialog.getByLabel("配置迁移文件", { exact: true }).setInputFiles({ name: "fixture.chsync.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ciphertext: "public-fixture", salt: "public-fixture" })) });
  await dialog.getByLabel("迁移口令", { exact: true }).fill("public-fixture-passphrase");
  await dialog.getByRole("button", { name: "预览迁移文件", exact: true }).click();
  await expect(dialog).toContainText("将新增或更新 1 个云账号");
  await dialog.getByRole("button", { name: "确认导入配置", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("配置已导入");
});

test("panel export follows page selection instead of exporting all panels", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "面板管理", exact: true }).first().click();
  await page.getByLabel("选择面板 面板2", { exact: true }).check();
  await page.getByRole("button", { name: "导出 (1)", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__exportCalls.find((call: any) => call.command === "export_panel_connections_file")?.args.panelIds)).toEqual([2]);
});

test("Codex JSON and encrypted backup honor the checked account subset", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  await page.getByLabel("选择 Codex2", { exact: true }).check();
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
  const json = page.getByRole("dialog", { name: "导出 Codex 账号 JSON", exact: true });
  await expect(json.getByRole("checkbox", { name: "Codex2", exact: true })).toBeChecked();
  await expect(json.getByRole("checkbox", { name: "Codex1", exact: true })).not.toBeChecked();
  await json.getByRole("button", { name: "选择保存文件", exact: true }).click();
  await page.getByRole("button", { name: "加密备份", exact: true }).click();
  const backup = page.getByRole("dialog", { name: "加密备份 Codex 登录", exact: true });
  await backup.getByLabel("迁移口令", { exact: true }).fill("public-fixture-passphrase");
  await backup.getByLabel("确认迁移口令", { exact: true }).fill("public-fixture-passphrase");
  await backup.getByRole("button", { name: "选择备份文件", exact: true }).click();
  const calls = await page.evaluate(() => (window as any).__exportCalls.filter((call: any) => ["codex_export_accounts_file", "codex_export_backup"].includes(call.command)));
  expect(calls).toHaveLength(2);
  for (const call of calls) expect(call.args.accountIds).toEqual([2]);
  await page.getByLabel("选择 Codex2", { exact: true }).uncheck();
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
  await expect(json.getByRole("button", { name: "选择保存文件", exact: true })).toBeDisabled();
  await json.getByRole("button", { name: "全选", exact: true }).click();
  await expect(json.getByRole("button", { name: "选择保存文件", exact: true })).toBeEnabled();
});
