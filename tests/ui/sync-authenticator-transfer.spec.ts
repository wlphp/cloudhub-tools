import { expect, test } from "@playwright/test";

test("desktop QR migration can contain selected authenticator entries only", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).authMigrationCalls = [];
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      (window as any).authMigrationCalls.push({ command, args });
      if (command === "authenticator_status") return { initialized: true, unlocked: true, passwordRequired: false };
      if (command === "authenticator_list") return ["one", "two"].map(id => ({ id, issuer: "Example", account: `${id}@example.test`, kind: "totp", algorithm: "SHA1", digits: 6, period: 30, counter: "0", group: "", note: "", pinned: false, order: 0 }));
      if (command === "start_sync_transfer") return { pairingUrl: "http://192.168.1.2:1234/sync/fixture", sourceDeviceId: "fixture-pc", sourcePublicKeyFingerprint: "fixture-key" };
      if (command === "plugin:event|listen") return 1;
      if (command === "plugin:app|version") return "0.1.43";
      return [];
    } };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "手机扫码迁移", exact: true }).first().click();
  await page.getByRole("tab", { name: /验证器/ }).click();
  await page.getByRole("checkbox", { name: "迁移验证码 Example two@example.test" }).uncheck();
  await page.getByRole("button", { name: "显示手机迁移二维码（免口令）" }).click();
  await expect(page.getByText(/电脑正在等待手机扫码/)).toBeVisible();
  const args = await page.evaluate(() => (window as any).authMigrationCalls.find((call: any) => call.command === "start_sync_transfer").args);
  expect(args.authenticatorIds).toEqual(["one"]);
  expect(args.accountIds).toEqual([]);
});
