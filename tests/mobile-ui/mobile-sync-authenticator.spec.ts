import { expect, test } from "@playwright/test";

test("phone QR migration selects authenticator entries independently of cloud accounts", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 Android CloudHub" });
    (window as any).authSelection = null;
    const entry = { id: "fixture-one", issuer: "Example", account: "demo@example.test", kind: "totp", algorithm: "SHA1", digits: 6, period: 30, counter: "0", group: "", note: "", pinned: false, order: 0 };
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      if (command.endsWith("|request_permissions")) return { camera: "granted" };
      if (command.endsWith("|scan")) return { content: "http://192.168.1.2:1234/sync/fixture", format: "QR_CODE" };
      if (command === "fetch_sync_transfer") return { sessionId: "fixture-session", sourceDeviceId: "fixture-pc", sourcePublicKeyFingerprint: "fixture-key", preview: { protocolVersion: 3, accounts: [], managedHosts: [], panels: [], flowConnections: [], certificates: [], deletions: [], conflicts: [], authenticators: [entry, { ...entry, id: "fixture-two", account: "other@example.test" }] } };
      if (command === "confirm_sync_transfer_import") { (window as any).authSelection = args.selection; return { accounts: 0, managedHosts: 0, panels: 0, authenticators: 1, added: 1, updated: 0, deleted: 0 }; }
      return [];
    } };
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
  await page.locator(".mobile-more-feature").filter({ hasText: "系统设置" }).click();
  await page.getByRole("button", { name: /导入数据/ }).click();
  await page.getByRole("button", { name: "扫码从电脑迁移（免口令）" }).click();
  const confirm = page.getByRole("button", { name: "确认导入所选配置" });
  await page.getByRole("checkbox", { name: "导入验证码 Example demo@example.test" }).uncheck();
  await page.getByRole("checkbox", { name: "导入验证码 Example other@example.test" }).uncheck();
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox", { name: "导入验证码 Example demo@example.test" }).check();
  await confirm.click();
  await expect(page.getByRole("status")).toContainText("验证码 1");
  expect(await page.evaluate(() => (window as any).authSelection)).toMatchObject({ accountSyncIds: [], authenticatorIds: ["fixture-one"] });
});
