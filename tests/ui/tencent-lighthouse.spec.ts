import { expect, test } from "@playwright/test";

for (const rawCache of [true, false]) {
  test(`Tencent Lighthouse configuration from ${rawCache ? "legacy" : "normalized"} cache`, async ({ page }) => {
    await page.addInitScript(({ rawCache }) => {
      const raw = { InstanceId: "lhins-fixture", InstanceName: "lighthouse-fixture", InstanceState: "RUNNING", CPU: 2, Memory: 2, SystemDisk: { DiskSize: 40 }, InternetAccessible: { InternetMaxBandwidthOut: 30 }, PublicAddresses: ["192.0.2.10"], PrivateAddresses: ["10.0.0.8"], CreatedTime: "2026-01-01T00:00:00Z", ExpiredTime: "2027-01-01T00:00:00Z", Zone: "ap-singapore-1", BlueprintId: "lhbp-fixture", BundleId: "bundle-fixture", _region_id: "ap-singapore" };
      const payload = rawCache ? raw : { ...raw, Cpu: 2, MemoryInGB: 2, SystemDiskSize: 40, Bandwidth: 30, PrivateIpAddress: raw.PrivateAddresses, PublicIpAddress: raw.PublicAddresses, CreateTime: raw.CreatedTime, PlanId: raw.BundleId, ImageName: raw.BlueprintId, Status: "Running" };
      (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
        if (command === "list_accounts") return [{ id: 7, account_name: "tencent-fixture", cloud_type: "tencent", access_key_id: "fixture-id", enabled: true, created_at: 1 }];
        if (command === "list_local_assets") return [{ account_id: 7, resource_type: "swas", asset_key: raw.InstanceId, region_id: "ap-singapore", payload, fetched_at: 1 }];
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        return [];
      } };
    }, { rawCache });
    await page.goto("/");
    await page.getByRole("button", { name: "账号管理", exact: true }).click();
    await page.getByRole("button", { name: "更多 tencent-fixture 资产操作", exact: true }).click();
    await page.getByRole("button", { name: /查看 tencent-fixture 轻量服务器资产/ }).click();
    const card = page.locator(".swas-card");
    for (const text of ["2 核 / 2 GB / 30 Mbps", "40 GB", "10.0.0.8", "192.0.2.10", "ap-singapore-1", "bundle-fixture", "lhbp-fixture", "运行中"]) await expect(card).toContainText(text);
    await expect(card).not.toContainText("2 MB");
    const created = card.locator(".swas-info > div").filter({ hasText: "创建时间：" });
    await expect(created).toContainText("2026");
    await expect(created).not.toContainText("T00:00:00Z");
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 980 });
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await card.screenshot({ path: `test-results/tencent-lighthouse-${rawCache ? "legacy" : "normalized"}.png` });
  });
}
