import { expect, test } from "@playwright/test";

test("phone migration can select AI configurations and restore their state", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 Android CloudHub" });
    (window as any).aiMigrationSelection = null;
    const profile = { id: "one", name: "AI服务一", protocol: "claude", baseUrl: "https://example.test", model: "model-a", enabled: true, isDefault: true, hasKey: true, timeoutSeconds: 60, maxOutputTokens: 512, allowLoopbackHttp: false, updatedAt: 1, visionStatus: "unknown" };
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      if (command.endsWith("|request_permissions")) return { camera: "granted" };
      if (command.endsWith("|scan")) return { content: "http://192.168.1.2:1234/sync/fixture", format: "QR_CODE" };
      if (command === "fetch_sync_transfer") return { sessionId: "fixture-session", sourceDeviceId: "fixture-pc", sourcePublicKeyFingerprint: "fixture-key", preview: { protocolVersion: 4, accounts: [], managedHosts: [], panels: [], flowConnections: [], certificates: [], deletions: [], conflicts: [], authenticators: [], aiProfiles: [profile, { ...profile, id: "two", name: "AI服务二", enabled: false, isDefault: false }] } };
      if (command === "confirm_sync_transfer_import") { (window as any).aiMigrationSelection = args.selection; return { accounts: 0, managedHosts: 0, panels: 0, aiProfiles: 1, added: 1, updated: 0, deleted: 0 }; }
      return [];
    } };
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
  await page.locator(".mobile-more-feature").filter({ hasText: "系统设置" }).click();
  await page.getByRole("button", { name: /导入数据/ }).click();
  await page.getByRole("button", { name: "扫码从电脑迁移（免口令）" }).click();
  await expect(page.getByText(/model-a · 已启用 · 默认配置 · 含密钥/)).toBeVisible();
  const confirm = page.getByRole("button", { name: "确认导入所选配置" });
  await page.getByRole("checkbox", { name: "导入AI配置 AI服务一", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "导入AI配置 AI服务二", exact: true }).uncheck();
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox", { name: "导入AI配置 AI服务一", exact: true }).check();
  await confirm.click();
  await expect(page.getByRole("status")).toContainText("AI配置 1");
  expect(await page.evaluate(() => (window as any).aiMigrationSelection)).toMatchObject({ accountSyncIds: [], aiProfileIds: ["one"] });
});
