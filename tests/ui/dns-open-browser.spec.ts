import { expect, test } from "@playwright/test";
import { dnsBrowserUrl } from "../../src/features/domains/dnsHost";

test("DNS browser links open the host through the native opener without editing records", async ({ page }) => {
  expect(dnsBrowserUrl("@", "example.test")).toBe("https://example.test/");
  expect(dnsBrowserUrl("www", "example.test")).toBe("https://www.example.test/");
  expect(dnsBrowserUrl("*.api", "example.test")).toBeNull();
  expect(dnsBrowserUrl("_acme-challenge", "example.test")).toBeNull();
  expect(dnsBrowserUrl("evil.test/path", "example.test")).toBeNull();
  await page.addInitScript(() => {
    const calls: Array<{ command: string; args: any }> = [];
    (window as any).browserCalls = calls;
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: any) => {
        calls.push({ command, args });
        if (command === "list_accounts") return [{ id: 7, account_name: "测试DNS", cloud_type: "aliyun", access_key_id: "test-only-id", enabled: true }];
        if (command === "list_local_assets") return [{ account_id: 7, resource_type: "domain", asset_key: "example.test", payload: { DomainName: "example.test" }, fetched_at: 1 }];
        if (command === "list_dns_records") return { items: [
          { RecordId: "1", RR: "www", Type: "A", Value: "192.0.2.1", TTL: 600 },
          { RecordId: "2", RR: "@", Type: "A", Value: "192.0.2.1", TTL: 600 },
          { RecordId: "3", RR: "*", Type: "A", Value: "192.0.2.1", TTL: 600 },
        ], total: 3 };
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "资产管理", exact: true }).click();
  await page.getByRole("button", { name: "解析管理", exact: true }).click();
  const manager = page.locator(".domain-tool-modal");
  await expect(manager).toHaveClass(/is-maximized/);
  await expect.poll(async () => manager.evaluate(el => {
    const box=el.getBoundingClientRect();
    return {width:Math.round(box.width),height:Math.round(box.height)};
  })).toEqual({width:Math.round(1280*.99),height:Math.round(720*.99)});
  const dnsHeaders = manager.locator(".dns-table-wrap thead th");
  await expect(dnsHeaders.nth(3)).toBeVisible();
  await expect(dnsHeaders.nth(4)).toBeVisible();
  await expect(dnsHeaders.nth(5)).toBeVisible();
  await page.setViewportSize({ width: 800, height: 720 });
  await expect(dnsHeaders.nth(3)).toBeHidden();
  await expect(dnsHeaders.nth(4)).toBeHidden();
  await expect(dnsHeaders.nth(5)).toBeHidden();
  await expect(dnsHeaders.nth(6)).toBeVisible();
  await expect(dnsHeaders.nth(7)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  await manager.getByRole("button",{name:"还原",exact:true}).click();
  await expect(manager).not.toHaveClass(/is-maximized/);
  const link = manager.getByRole("link", { name: "在浏览器中打开 https://www.example.test/", exact: true });
  await link.click();
  await expect(manager.locator(".cell-input")).toHaveCount(0);
  await expect(manager.getByRole("button", { name: "泛域名不能直接打开，请使用具体主机名", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).browserCalls.filter((call: any) => call.command === "plugin:opener|open_url").map((call: any) => call.args.url))).toEqual(["https://www.example.test/"]);
  await manager.locator(".close-detail").click();
  for(const label of ["操作日志","WHOIS","解析管理"]){
    await page.locator(".local-assets-panel").getByRole("button",{name:label,exact:true}).click();
    await expect(manager).toHaveClass(/is-maximized/);
    await expect(manager.getByRole("button",{name:"还原",exact:true})).toBeVisible();
    if(label==="解析管理")await page.screenshot({path:"test-results/domain-default-maximized.png"});
    await manager.locator(".close-detail").click();
  }
});
