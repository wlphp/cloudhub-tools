import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, legacy = false) {
  page.on("pageerror", error => console.error(error.message));
  await page.addInitScript(({ legacy }) => {
    const accounts = [
      { id: 1, account_name: "百度测试", cloud_type: "baidu" },
      { id: 2, account_name: "阿里测试", cloud_type: "aliyun" },
      { id: 3, account_name: "腾讯测试", cloud_type: "tencent" },
    ].map(account => ({ ...account, enabled: true, created_at: 1 }));
    const assets = [
      { account_id: 1, resource_type: "ecs", asset_key: "bcc", payload: legacy
        ? { _raw: { volumes: [{ volumeId: "boot", isSystemVolume: true, diskSizeInGB: 40 }] } }
        : { Disks: [{ DiskId: "boot", DiskName: "系统盘", Size: 40 }] } },
      { account_id: 2, resource_type: "swas", asset_key: "swas", payload: { ResourceSpec: { Cpu: 2, Memory: 2, DiskSize: 60 } } },
      { account_id: 2, resource_type: "swas", asset_key: "swas-two", payload: { Disks: [{ DiskType: "system", Size: 80 }] } },
      { account_id: 2, resource_type: "ecs", asset_key: "ecs", payload: {} },
      { account_id: 3, resource_type: "swas", asset_key: "lighthouse", payload: { SystemDisk: { DiskSize: 50, DiskType: "CLOUD_SSD" } } },
    ].map(asset => ({ ...asset, region_id: "test-region", fetched_at: 1, payload: { ...asset.payload, InstanceId: asset.asset_key, InstanceName: asset.asset_key, Status: "Running" } }));
    localStorage.setItem("cloudhub-tools-favorite-assets", JSON.stringify(assets.map(asset => `${asset.account_id}:${asset.resource_type}:${asset.asset_key}`)));
    const state = window as any;
    state.syncCalls = [];
    state.diskCalls = [];
    state.syncResolvers = {};
    state.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: any) => {
        if (command === "list_accounts") return accounts;
        if (command === "list_local_assets") return assets;
        if (command === "list_client_preferences") return {};
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_instance_disks") { state.diskCalls.push(args); return [{ Type: "system", Size: 100 }]; }
        if (command === "sync_cloud_assets") {
          state.syncCalls.push(args);
          return await new Promise((resolve, reject) => { state.syncResolvers[`${args.id}:${args.resourceTypes[0]}`] = (fail = false) => fail ? reject(new Error("测试刷新失败")) : resolve({ fetched: 1, counts: {}, errors: [] }); });
        }
        return [];
      },
    };
  }, { legacy });
  await page.goto("/");
  await page.getByRole("button", { name: "我的收藏", exact: true }).first().click();
}

test("收藏卡片独立刷新、同账号合并和排队、失败后可重试", async ({ page }) => {
  await fixture(page);
  const card = (key: string) => page.locator(`[data-favorite-asset-key="${key}"]`);
  const refresh = (key: string) => card(key).locator(".favorite-status-refresh");
  await refresh("1:ecs:bcc").click();
  await expect(refresh("1:ecs:bcc")).toHaveClass(/is-refreshing/);
  await expect(refresh("1:ecs:bcc")).toHaveAttribute("aria-busy", "true");
  expect(await refresh("1:ecs:bcc").evaluate(el => getComputedStyle(el).opacity)).toBe("1");
  await refresh("2:swas:swas").click();
  await refresh("2:swas:swas-two").click();
  await refresh("2:ecs:ecs").click();
  await expect.poll(() => page.evaluate(() => (window as any).syncCalls.length)).toBe(2);
  await page.evaluate(() => (window as any).syncResolvers["2:swas"]());
  await expect.poll(() => page.evaluate(() => (window as any).syncCalls.length)).toBe(3);
  await expect(refresh("2:swas:swas")).toBeEnabled();
  await expect(refresh("2:swas:swas-two")).toBeEnabled();
  await expect(refresh("1:ecs:bcc")).toBeDisabled();
  await page.evaluate(() => { (window as any).syncResolvers["1:ecs"](true); (window as any).syncResolvers["2:ecs"](); });
  await expect(refresh("1:ecs:bcc")).toBeEnabled();
  await refresh("1:ecs:bcc").click();
  await expect.poll(() => page.evaluate(() => (window as any).syncCalls.length)).toBe(4);
  await page.evaluate(() => (window as any).syncResolvers["1:ecs"]());
  await expect(refresh("1:ecs:bcc")).toBeEnabled();
});

for (const legacy of [false, true]) {
  test(`收藏磁盘按云厂商和资源类型读取（旧缓存=${legacy}）`, async ({ page }) => {
    await fixture(page, legacy);
    for (const [key, size] of [["1:ecs:bcc", 40], ["2:swas:swas", 60], ["2:swas:swas-two", 80], ["3:swas:lighthouse", 50]]) {
      const chips = page.locator(`[data-favorite-asset-key="${key}"] .favorite-disk-chip.system`);
      await expect(chips).toContainText(`${size} GB`);
    }
    await expect.poll(() => page.evaluate(() => (window as any).diskCalls.length)).toBe(1);
    expect(await page.evaluate(() => (window as any).diskCalls[0].instanceId)).toBe("ecs");
  });
}
