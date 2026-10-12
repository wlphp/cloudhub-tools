import { test, expect } from "@playwright/test";

test("certificate shortcuts fill full domain names and follow the selected DNS zone", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string) => {
        if (command === "list_accounts") return [{ id: 7, account_name: "Fixture DNS", cloud_type: "aliyun", access_key_id: "test-only-id", sort_order: 0, enabled: true, group_name: "", created_at: 1, updated_at: 1 }];
        if (command === "list_local_assets") return ["example.test", "second.test"].map(name => ({ account_id: 7, resource_type: "domain", asset_key: name, payload: { DomainName: name }, fetched_at: 1 }));
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "HTTPS 证书", exact: true }).first().click();
  await page.getByRole("button", { name: "申请证书", exact: true }).click();
  const presets = page.getByRole("group", { name: "证书域名快捷填充", exact: true });
  const domains = page.locator(".certificate-dialog textarea");
  for (const [label, value] of [["主域名 @", "example.test"], ["www", "www.example.test"], ["泛域名 *", "*.example.test"], ["@ + www", "example.test\nwww.example.test"], ["@ + *", "example.test\n*.example.test"]]) {
    await presets.getByRole("button", { name: label, exact: true }).click();
    await expect(domains).toHaveValue(value);
    await expect(presets.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByLabel(/DNS 区域/).selectOption("second.test");
  await expect(domains).toHaveValue("second.test\n*.second.test");
  await domains.fill("api.second.test");
  await expect(presets.locator('button[aria-pressed="true"]')).toHaveCount(0);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(presets).toBeVisible();
    expect(await presets.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await presets.screenshot({ path: "test-results/certificate-domain-presets.png" });
});
