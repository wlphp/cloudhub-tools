import { expect, test, type Page } from "@playwright/test";

async function serverFixture(page: Page, cloudType: string, resourceType: string) {
  await page.addInitScript(({ cloudType, resourceType }) => {
    const account = { id: 12, account_name: "server-fixture", cloud_type: cloudType, enabled: true, region_id: "fixture-region", sort_order: 0 };
    const asset = { account_id: 12, resource_type: resourceType, asset_key: "fixture-server", region_id: "fixture-region", fetched_at: 1700000000, payload: {
      InstanceId: "fixture-server", InstanceName: "配置测试服务器", Status: "Running", Cpu: 2,
      Memory: cloudType === "tencent" ? 4 : 4096, InstanceType: "fixture.small",
      OSName: "Debian 12", SystemDisk: { Size: 40 }, Bandwidth: 5,
      PublicIpAddress: ["192.0.2.10"], PrivateIpAddress: { IpAddress: ["10.0.0.10"] },
      ExpiredTime: "2030-12-31T12:00:00Z", CreationTime: 1700000000,
    } };
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    Object.assign(window, { serverCalls: calls, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "list_accounts") return [account];
        if (command === "list_local_assets") return !args.resourceType || args.resourceType === resourceType ? [asset] : [];
        if (["reboot_instance", "cvm_instance_reboot", "swas_instance_action"].includes(command)) {
          calls.push({ command, args });
          return null;
        }
        return [];
      },
    } });
  }, { cloudType, resourceType });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "服务器", exact: true }).click();
}

for (const cloudType of ["aliyun", "tencent"]) {
  for (const resourceType of ["ecs", "swas"]) {
    test(`${cloudType} ${resourceType} shows configuration and submits the selected reboot mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 375, height: 844 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await serverFixture(page, cloudType, resourceType);
      const card = page.locator(".mobile-server-card-featured");
      await expect(card.locator(".mobile-server-expiry")).toContainText("2030/12/31");
      await card.getByText("详情与操作", { exact: true }).click();
      const config = card.locator('[aria-label="服务器配置"]');
      for (const text of ["2 核", "4 GB", "fixture.small", "Debian 12", "40 GB", "5 Mbps", "192.0.2.10", "10.0.0.10"]) {
        await expect(config).toContainText(text);
      }
      await expect(config.getByRole("region")).toHaveCount(3);
      const cpu = await config.getByText("2 核", { exact: true }).boundingBox();
      const memory = await config.getByText("4 GB", { exact: true }).boundingBox();
      expect(cpu && memory && Math.abs(cpu.y - memory.y) < 1 && cpu.x < memory.x).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("server-details.png"), fullPage: true });

      await card.getByRole("button", { name: "重启", exact: true }).click();
      const dialog = page.getByRole("alertdialog", { name: "确认服务器操作" });
      await expect(dialog.getByLabel("重启方式")).toHaveValue("force");
      await expect(dialog).toContainText("可能导致未保存的数据丢失");
      await page.locator(".modal-backdrop").click({ position: { x: 1, y: 1 }, force: true });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      expect(await page.evaluate(() => (window as any).serverCalls)).toHaveLength(0);

      for (const mode of ["force", "normal"]) {
        await card.getByRole("button", { name: "重启", exact: true }).click();
        await expect(dialog.getByLabel("重启方式")).toHaveValue("force");
        if (mode === "normal") await dialog.getByLabel("重启方式").selectOption(mode);
        await dialog.getByRole("button", { name: "确认操作", exact: true }).click();
        await expect(page.getByText(`已提交${mode === "force" ? "强制" : "普通"}重启请求，云厂商状态可能需要片刻更新`, { exact: true })).toBeVisible();
        const calls = await page.evaluate(() => (window as any).serverCalls);
        expect(calls.at(-1)).toEqual({
          command: resourceType === "swas" ? "swas_instance_action" : cloudType === "aliyun" ? "reboot_instance" : "cvm_instance_reboot",
          args: { id: 12, regionId: "fixture-region", instanceId: "fixture-server", forceStop: mode === "force", ...(resourceType === "swas" || cloudType === "tencent" ? { action: "reboot" } : {}) },
        });
      }
      expect(await page.evaluate(() => (window as any).serverCalls)).toHaveLength(2);
      for (const width of [320, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      }
    });
  }
}

test("servers with missing cached fields show an explicit expiry fallback", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  await page.route("**/api/accounts**", route => route.fulfill({ json: [{ id: 12, account_name: "empty-fixture", cloud_type: "aliyun", enabled: true }] }));
  await page.route("**/api/local-assets**", route => route.fulfill({ json: new URL(route.request().url()).searchParams.get("resource_type") === "swas" ? [] : [{ account_id: 12, resource_type: "ecs", asset_key: "empty", payload: { InstanceId: "empty", InstanceName: "empty", Status: "Running" }, fetched_at: 1700000000 }] }));
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "服务器", exact: true }).click();
  const card = page.locator(".mobile-server-card-featured");
  await expect(card.locator(".mobile-server-expiry")).toHaveText("到期时间：未获取");
  await card.getByText("详情与操作", { exact: true }).click();
  await expect(card.locator('[aria-label="服务器配置"]')).not.toContainText("NaN");
});
