import { expect, test } from "@playwright/test";

for (const mode of ["nested-cache", "normalized", "missing"]) {
  test(`Aliyun lightweight asset configuration: ${mode}`, async ({ page }) => {
    await page.addInitScript(({ mode }) => {
      const base = { InstanceId: "f85d6858ccc84d818bbdd6c1f7468980", InstanceName: "aliyun-light-fixture", Status: "Running", PlanId: "swas.s.c2m2s40b1.linux", ImageId: "e9363571cf2444aba422b17470285465", RegionId: "cn-beijing", PublicIpAddress: "192.0.2.10", ExpiredTime: "2027-01-01T00:00:00Z" };
      const raw = { ...base, ResourceSpec: { Cpu: 2, Memory: 2, Bandwidth: 3, DiskSize: 40 }, InnerIpAddress: "10.0.0.8", CreationTime: "2026-01-01T00:00:00Z", Image: { ImageName: "Ubuntu 22.04", OsType: "linux" }, Disks: [{ DiskType: "data", Size: 100 }, { DiskType: "system", Size: 60 }] };
      const payload = mode === "missing" ? base : mode === "nested-cache" ? raw : { ...base, Cpu: 2, MemoryInGB: 2, Bandwidth: 3, SystemDiskSize: 60, PrivateIpAddress: raw.InnerIpAddress, CreateTime: raw.CreationTime, ImageName: raw.Image.ImageName, OSType: "linux" };
      (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
        if (command === "list_accounts") return [{ id: 7, account_name: "aliyun-fixture", cloud_type: "aliyun", access_key_id: "fixture-id", enabled: true, created_at: 1 }];
        if (command === "list_local_assets") return [{ account_id: 7, resource_type: "swas", asset_key: base.InstanceId, region_id: "cn-beijing", payload, fetched_at: 1 }];
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        return [];
      } };
    }, { mode });
    await page.goto("/");
    await page.getByRole("button", { name: "账号管理", exact: true }).click();
    await page.getByRole("button", { name: "更多 aliyun-fixture 资产操作", exact: true }).click();
    await page.getByRole("button", { name: /查看 aliyun-fixture 轻量服务器资产/ }).click();
    const card = page.locator(".swas-card");
    if (mode === "missing") {
      await expect(card).toContainText("未获取");
      await expect(card).not.toContainText("0 GiB");
    } else {
      for (const text of ["2 核 / 2 GiB / 3 Mbps", "60 GiB", "10.0.0.8", "Ubuntu 22.04", "2026", "linux"]) await expect(card).toContainText(text);
      await expect(card).not.toContainText("2 MB");
      await expect(card).not.toContainText("100 GiB");
    }
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 980 });
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
  });
}
