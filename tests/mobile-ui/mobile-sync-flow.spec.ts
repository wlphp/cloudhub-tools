import { expect, test } from "@playwright/test";

test("QR import reviews Flow caches, handles permission and network failures, and imports only selected connections", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 Android CloudHub" });
    const fixture = { permissions: 0, fetches: 0, calls: [] as Array<{ command: string; args: any }> };
    (window as any).syncFixture = fixture;
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        fixture.calls.push({ command, args });
        if (command.endsWith("|request_permissions")) return { camera: fixture.permissions++ === 0 ? "denied" : "granted" };
        if (command.endsWith("|scan")) return { content: "http://192.168.1.2:1234/sync/fixture", format: "QR_CODE" };
        if (command === "fetch_sync_transfer") {
          if (fixture.fetches++ === 0) throw new Error("网络连接失败，请重新扫码");
          return { sessionId: "fixture-session", sourceDeviceId: "fixture-pc", sourcePublicKeyFingerprint: "fixture-fingerprint", preview: {
            protocolVersion: 2, accounts: [], managedHosts: [], panels: [], deletions: [], conflicts: [],
            flowConnections: [
              { syncId: "flow-one", name: "生产流水线", edition: "central", organizationId: "fixture-org", pipelineCount: 8 },
              { syncId: "flow-two", name: "测试流水线", edition: "region", organizationId: null, pipelineCount: 2 },
            ],
          } };
        }
        if (command === "confirm_sync_transfer_import") return { accounts: 0, managedHosts: 0, panels: 0, flowConnections: 1, added: 1, updated: 0, deleted: 0 };
        return [];
      },
    };
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
  await page.locator(".mobile-more-feature").filter({ hasText: "系统设置" }).click();
  await page.getByRole("button", { name: /导入数据/ }).click();
  const scan = page.getByRole("button", { name: "扫码从电脑迁移（免口令）" });
  await scan.click();
  await expect(page.getByRole("alert")).toContainText("相机权限未开启");
  await scan.click();
  await expect(page.getByRole("alert")).toContainText("网络或云服务暂时不可用");
  await scan.click();
  await expect(page.getByText("云效 · 8 条已缓存流水线 · 含连接令牌", { exact: true })).toBeVisible();
  const confirm = page.getByRole("button", { name: "确认导入所选配置" });
  await page.getByRole("checkbox", { name: "导入云效连接 生产流水线" }).uncheck();
  await page.getByRole("checkbox", { name: "导入云效连接 测试流水线" }).uncheck();
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox", { name: "导入云效连接 生产流水线" }).check();
  await expect(page.locator(".sync-transfer-preview h3")).toContainText("1 个云效连接");
  expect(await page.locator(".mobile-content").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
  await page.screenshot({ path: "test-results/mobile-sync-flow.png" });
  await confirm.click();
  await expect(page.getByRole("status")).toContainText("云效连接 1");
  const selection = await page.evaluate(() => (window as any).syncFixture.calls.find((item: any) => item.command === "confirm_sync_transfer_import").args.selection);
  expect(selection.flowConnectionSyncIds).toEqual(["flow-one"]);
  expect(selection.accountSyncIds).toEqual([]);
});
