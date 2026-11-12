import { expect, test } from "@playwright/test";

for (const mode of ["legacy", "normalized", "missing"]) {
  test(`Baidu BCC asset fields: ${mode}`, async ({ page }) => {
    await page.addInitScript(({ mode }) => {
      const raw = { id: "i-fixture", cpuCount: 2, memoryCapacityInGB: 2, osName: "Ubuntu", osVersion: "22.04", imageId: "m-fixture", networkCapacityInMbps: 5, createTime: "2026-01-01T00:00:00Z", expireTime: "2027-01-01T00:00:00Z", volumes: [{ volumeId: "v-system", isSystemVolume: true, diskSizeInGB: 40 }, { volumeId: "v-data", isSystemVolume: false, diskSizeInGB: 100 }] };
      const base = { InstanceId: "i-fixture", InstanceName: "bcc-fixture", Status: "Running", InstanceType: "bcc.g5.c2m2", PublicIpAddress: "192.0.2.10", PrivateIpAddress: "10.0.0.8", _region_id: "bd" };
      const payload = mode === "legacy" ? { ...base, _raw: raw } : mode === "missing" ? { ...base, PaymentTiming: "Postpaid", _detail_error: "实例详情读取失败，请检查权限或稍后重试" } : { ...base, Cpu: 2, Memory: 2048, MemoryInGB: 2, OSName: "Ubuntu 22.04", InternetMaxBandwidthOut: 5, CreationTime: raw.createTime, ExpiredTime: raw.expireTime, Disks: [{ DiskId: "v-system", DiskName: "系统盘", Size: 40 }, { DiskId: "v-data", DiskName: "数据盘", Size: 100 }] };
      (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
        if (command === "list_accounts") return [{ id: 7, account_name: "baidu-fixture", cloud_type: "baidu", access_key_id: "fixture-id", enabled: true, created_at: 1 }];
        if (command === "list_local_assets") return [{ account_id: 7, resource_type: "ecs", asset_key: "i-fixture", region_id: "bd", payload, fetched_at: 1 }];
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        return [];
      } };
    }, { mode });
    await page.goto("/");
    await page.getByRole("button", { name: "账号管理", exact: true }).click();
    await page.getByRole("button", { name: /查看 baidu-fixture 服务器资产/ }).click();
    const card = page.locator(".server-card");
    if (mode === "missing") {
      await expect(card).toContainText("未获取");
      await expect(card).toContainText("按量付费");
      await expect(card).toContainText("实例详情读取失败");
      await expect(card).not.toContainText("0M入");
    } else {
      for (const text of ["2核 / 2.0GB", "Ubuntu 22.04", "5 Mbps", "2026", "2027", "系统盘", "数据盘", "40 GB", "100 GB"]) await expect(card).toContainText(text);
      await expect(card).not.toContainText("磁盘详情暂未接入");
    }
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 980 });
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
  });
}
