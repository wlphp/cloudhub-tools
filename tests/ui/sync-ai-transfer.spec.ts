import { expect, test } from "@playwright/test";

test("desktop migration selects AI configurations with native-only keys", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).aiMigrationCalls = [];
    (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      (window as any).aiMigrationCalls.push({ command, args });
      if (command === "ai_list_profiles") return ["one", "two"].map(id => ({ id, name: id, protocol: "claude", baseUrl: "https://example.test", model: "model-a", models: ["model-a", "model-b"], enabled: true, isDefault: id === "one", hasKey: true, timeoutSeconds: 60, maxOutputTokens: 512, allowLoopbackHttp: false, updatedAt: 1, visionStatus: "unknown" }));
      if (command === "start_sync_transfer") return { pairingUrl: "http://192.168.1.2:1234/sync/fixture", sourceDeviceId: "fixture-pc", sourcePublicKeyFingerprint: "fixture-key" };
      if (command === "plugin:event|listen") return 1;
      if (command === "list_client_preferences") return {};
      if (command === "plugin:app|version") return "0.1.57";
      return [];
    } };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "系统设置", exact: true }).first().click();
  await page.getByRole("tab", { name: "数据管理" }).click();
  await page.getByRole("button", { name: "开始迁移", exact: true }).click();
  await page.getByRole("tab", { name: /AI配置/ }).click();
  await expect(page.getByRole("tab", { name: /AI配置/ })).toContainText("2/2");
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await expect(page.getByRole("button", { name: "显示手机迁移二维码（免口令）" })).toBeDisabled();
  await page.getByRole("button", { name: "全选", exact: true }).click();
  await page.getByRole("checkbox", { name: "迁移AI配置 two", exact: true }).uncheck();
  await page.getByRole("button", { name: "显示手机迁移二维码（免口令）" }).click();
  await expect(page.getByRole("dialog", { name: "手机迁移二维码", exact: true })).toBeVisible();
  const args = await page.evaluate(() => (window as any).aiMigrationCalls.find((call: any) => call.command === "start_sync_transfer").args);
  expect(args.aiProfileIds).toEqual(["one"]);
  expect(args.accountIds).toEqual([]);
  expect(JSON.stringify(args)).not.toContain("apiKey");
});
