import { expect, test } from "@playwright/test";

test("Volcengine server fields, power confirmations and shared security groups", async ({ page }) => {
  await page.addInitScript(() => {
    const payload = { InstanceId: "i-example", InstanceName: "volc-server", Status: "RUNNING", Cpu: 2, Memory: 4096, InstanceType: "ecs.example", PublicIpAddress: "192.0.2.10", PrivateIpAddress: "10.0.0.8", OSName: "Ubuntu 22.04", CreationTime: "2026-01-01T00:00:00Z", ExpiredTime: null, PaymentTiming: "Postpaid", InternetMaxBandwidthOut: 5, _region_id: "cn-guangzhou" };
    (window as any).volcCalls = [];
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        if (command === "list_accounts") return [{ id: 7, account_name: "volc-fixture", cloud_type: "volcengine", enabled: true, created_at: 1 }];
        if (command === "list_local_assets") return [{ account_id: 7, resource_type: "ecs", asset_key: "i-example", region_id: "cn-guangzhou", payload, fetched_at: 1 }];
        if (command === "list_cloud_resources") return { items: [payload], errors: [], resource_type: "ecs", fetched_at: 1 };
        if (command === "list_instance_disks") return [{ DiskId: "vol-example", DiskName: "系统盘", Category: "ESSD_PL0", Size: 40, Status: "attached" }];
        if (command === "list_volc_security_groups") return { groups: [{ SecurityGroupId: "sg-example", SecurityGroupName: "Web", Description: "", NicType: "intranet" }], selectedSecurityGroupId: "sg-example", rules: [{ Direction: "ingress", IpProtocol: "tcp", PortRange: "22/22", SourceCidrIp: "192.0.2.0/24", Policy: "accept", Priority: 5, Description: "SSH" }] };
        if (["volc_instance_action", "authorize_volc_security_group_rule", "revoke_volc_security_group_rule"].includes(command)) { (window as any).volcCalls.push({ command, args }); return {}; }
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "账号管理", exact: true }).click();
  await page.getByRole("button", { name: /查看 volc-fixture 服务器资产/ }).click();
  const card = page.locator(".server-card");
  for (const value of ["2核 / 4.0GB", "Ubuntu 22.04", "10.0.0.8", "5 Mbps", "按量付费", "40 GB"]) await expect(card).toContainText(value);
  await card.getByRole("button", { name: "重启", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => (window as any).volcCalls.length)).toBe(0);
  for (const [label, action, forceStop] of [["重启", "reboot", false], ["强制重启", "reboot", true], ["关机", "stop", false]] as const) {
    await card.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).volcCalls.at(-1))).toMatchObject({ command: "volc_instance_action", args: { id: 7, regionId: "cn-guangzhou", instanceId: "i-example", action, forceStop } });
  }
  await card.getByRole("button", { name: "安全组", exact: true }).click();
  const security = page.getByRole("dialog", { name: "安全组", exact: true });
  await expect(security).toContainText("192.0.2.0/24");
  await security.getByRole("button", { name: "添加规则", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "添加入方向规则", exact: true });
  await editor.getByLabel("端口范围", { exact: true }).fill("80");
  await editor.getByRole("button", { name: "确定", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).volcCalls.at(-1))).toMatchObject({ command: "authorize_volc_security_group_rule", args: { instanceId: "i-example", securityGroupId: "sg-example", portRange: "80/80" } });
  await security.locator(".security-rules-table tbody").getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).volcCalls.at(-1))).toMatchObject({ command: "revoke_volc_security_group_rule", args: { instanceId: "i-example", securityGroupId: "sg-example", priority: 5 } });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 980 });
    expect(await security.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await security.screenshot({ path: "test-results/volc-security-groups.png" });
});
