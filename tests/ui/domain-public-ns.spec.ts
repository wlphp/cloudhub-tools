import { expect, test } from "@playwright/test";

test("domain DNS uses public NS, never the stale provider zone, including failed refresh", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).failPublicNs = false;
    (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
      if (command === "list_accounts") return [{ id: 7, account_name: "fixture-domain-account", cloud_type: "aliyun", access_key_id: "fixture-id", enabled: true, created_at: 1 }];
      if (command === "list_local_assets") return [{ account_id: 7, resource_type: "domain", asset_key: "example.test", region_id: "", payload: { DomainName: "example.test", DnsServers: { DnsServer: ["dns23.hichina.com", "dns24.hichina.com"] }, RecordCount: 3, VersionCode: "mianfei" }, fetched_at: 1 }];
      if (command === "resolve_domain_nameservers") {
        if ((window as any).failPublicNs) throw new Error("模拟公网 NS 查询失败");
        return ["ashley.ns.cloudflare.com", "cleo.ns.cloudflare.com"];
      }
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      if (command === "list_client_preferences") return {};
      return [];
    } };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "账号管理", exact: true }).click();
  await page.getByRole("button", { name: /查看 fixture-domain-account 域名资产/ }).click();
  const card = page.locator(".domain-card");
  await expect(card.locator(".dns-tag").first()).toHaveText("Cloudflare DNS");
  await expect(card).toContainText("ashley.ns.cloudflare.com, cleo.ns.cloudflare.com");
  await expect(card).not.toContainText("hichina.com");
  await expect(card).toContainText("阿里云记录数：");
  await expect(card.getByRole("button", { name: "阿里云解析配置", exact: true })).toBeVisible();
  await card.screenshot({ path: "test-results/domain-public-ns.png" });
  await page.evaluate(() => { (window as any).failPublicNs = true; });
  await card.getByRole("button", { name: "刷新公网 NS", exact: true }).click();
  await expect(card).toContainText("DNS 未确认");
  await expect(card).toContainText("查询失败，未确认");
  await expect(card).not.toContainText("hichina.com");
  await expect(card).not.toContainText("ashley.ns.cloudflare.com");
  await page.evaluate(() => { (window as any).failPublicNs = false; });
  await card.getByRole("button", { name: "刷新公网 NS", exact: true }).click();
  await expect(card.locator(".dns-tag").first()).toHaveText("Cloudflare DNS");
});
