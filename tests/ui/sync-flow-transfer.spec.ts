import { expect, test } from "@playwright/test";

test("desktop QR selection can transfer only Flow connections", async ({ page }) => {
  await page.addInitScript(() => {
    const calls: Array<{ command: string; args: any }> = [];
    (window as any).syncCalls = calls;
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        calls.push({ command, args });
        if (command === "list_flow_connections") return [
          { id: 7, name: "生产构建", edition: "central", organizationId: "fixture-org", tokenSaved: true },
          { id: 8, name: "测试构建", edition: "region", tokenSaved: true },
        ];
        if (command === "start_sync_transfer") return { pairingUrl: "http://192.168.1.2:1234/sync/fixture", sourceDeviceId: "fixture-pc", sourcePublicKeyFingerprint: "fixture-fingerprint" };
        if (command === "plugin:app|version") return "0.1.43";
        if (command === "plugin:event|listen") return 1;
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "手机扫码迁移", exact: true }).first().click();
  await page.getByRole("tab", { name: /流水线/ }).click();
  await expect(page.getByText("含令牌及已缓存流水线", { exact: false }).first()).toBeVisible();
  await page.locator(".sync-transfer-account").filter({ hasText: "测试构建" }).getByRole("checkbox").uncheck();
  await page.getByRole("button", { name: "显示手机迁移二维码（免口令）" }).click();
  await expect(page.getByText(/电脑正在等待手机扫码/)).toBeVisible();
  const args = await page.evaluate(() => (window as any).syncCalls.find((item: any) => item.command === "start_sync_transfer").args);
  expect(args.flowConnectionIds).toEqual([7]);
  expect(args.accountIds).toEqual([]);
  expect(args.managedHostIds).toEqual([]);
  expect(args.panelIds).toEqual([]);
});
