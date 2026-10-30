import { expect, type Page } from "@playwright/test";
export async function transferFixture(page: Page, table: string, label: string, mobile = false) {
  await page.addInitScript(({ table, label, mobile }) => {
    if (mobile) Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 Android CloudHub" });
    const categories = [{ table, label, count: 2 }, { table: "memo_notes", label: "备忘录", count: 1 }];
    (window as any).transferCalls = [];
    (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      (window as any).transferCalls.push({ command, args });
      if (command === "database_transfer_catalog") return categories;
      if (command === "plugin:event|listen") return 1;
      if (command === "plugin:app|version") return "0.1.97";
      if (command === "list_client_preferences") return {};
      if (command.endsWith("|request_permissions")) return { camera: "granted" };
      if (command.endsWith("|scan")) return { content: "http://192.168.1.2:1234/sync/fixture", format: "QR_CODE" };
      if (command === "start_sync_transfer") return { pairingUrl: "http://192.168.1.2:1234/sync/fixture", sourceDeviceId: "fixture", sourcePublicKeyFingerprint: "fixture" };
      if (command === "fetch_sync_transfer") return { sessionId: "fixture-session", preview: { protocolVersion: 5, categories, accounts: [], managedHosts: [], panels: [], flowConnections: [], certificates: [], deletions: [], conflicts: [], authenticators: [], aiProfiles: [] } };
      if (command === "confirm_sync_transfer_import") return { added: 2, updated: 0 };
      return [];
    } };
  }, { table, label, mobile });
  await page.goto("/");
  if (mobile) {
    await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
    await page.locator(".mobile-more-feature").filter({ hasText: "系统设置" }).click();
    await page.getByRole("button", { name: /导入数据/ }).click();
    await page.getByRole("button", { name: "扫码接收电脑配置" }).click();
  } else {
    await page.getByRole("button", { name: "系统设置", exact: true }).first().click();
    await page.getByRole("tab", { name: "数据管理" }).click();
    await page.getByRole("button", { name: "开始迁移", exact: true }).click();
    await page.locator("details.sync-transfer-scope-details > summary").click();
  }
  const scope = page.getByRole("group", { name: "数据范围", exact: true });
  await expect(scope.getByRole("checkbox", { name: label + "（2 条）", exact: true })).toBeChecked();
  await scope.getByRole("checkbox", { name: "选择全部数据", exact: true }).uncheck();
  const action = page.getByRole("button", { name: mobile ? "确认导入所选配置" : "生成迁移二维码", exact: true });
  await expect(action).toBeDisabled();
  await scope.getByRole("checkbox", { name: label + "（2 条）", exact: true }).check();
  if (!mobile) await page.getByRole("checkbox", { name: "包含回收站（默认关闭）" }).check();
  await action.click();
  const calls = await page.evaluate(() => (window as any).transferCalls);
  const args = calls.find((item: any) => item.command === (mobile ? "confirm_sync_transfer_import" : "start_sync_transfer")).args;
  expect(mobile ? args.selection.transferTables : args.transferTables).toEqual([table]);
  expect(JSON.stringify(args)).not.toContain("ciphertext");
  expect(JSON.stringify(args)).not.toContain("secret");
  if (mobile) await expect(page.getByRole("status")).toContainText("迁移完成");
  else {
    expect(args.includeTrash).toBe(true);
    const qr = page.getByRole("dialog", { name: "手机迁移二维码", exact: true });
    await expect(qr).toBeVisible();
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await qr.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await qr.screenshot({ path: "test-results/transfer-" + table + ".png" });
    await page.mouse.click(2, 2); await expect(qr).toBeVisible();
    await qr.getByRole("button", { name: "取消本次迁移" }).click();
    await expect(qr).toBeHidden();
  }
}
