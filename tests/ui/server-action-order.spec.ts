import { expect, test } from "@playwright/test";

// 各云服务器卡片的操作按钮顺序必须完全一致：
// SSH 登录 → 安全组 → 重启 → 强制重启 → 关机/开机 → （云的附加菜单）→ 刷新状态 → API 操作记录。
const cases = [
  { provider: "aliyun", kind: "ecs", expected: ["SSH 登录", "安全组", "重启", "强制重启", "关机", "刷新状态", "API 操作记录"] },
  { provider: "aliyun", kind: "swas", expected: ["SSH 登录", "安全组", "重启", "强制重启", "关机", "刷新状态", "API 操作记录"] },
  { provider: "tencent", kind: "swas", expected: ["SSH 登录", "安全组", "重启", "强制重启", "关机", "刷新状态", "API 操作记录"] },
  { provider: "jdcloud", kind: "swas", expected: ["SSH 登录", "安全组", "重启", "关机", "刷新状态", "API 操作记录"] },
  { provider: "volcengine", kind: "ecs", expected: ["SSH 登录", "安全组", "重启", "强制重启", "关机", "刷新状态", "API 操作记录"] },
  { provider: "vultr", kind: "ecs", expected: ["SSH 登录", "安全组", "重启", "关机", "更多操作", "刷新状态", "API 操作记录"] },
] as const;

for (const { provider, kind, expected } of cases) {
  test(`server action order ${provider} ${kind}`, async ({ page }) => {
    await page.addInitScript(({ provider, kind }) => {
      localStorage.setItem("cloudhub-tools-ui-theme", "light");
      const payload = { InstanceId: "i-example", InstanceName: "order-fixture", Status: kind === "swas" ? "Running" : "RUNNING", Cpu: 2, Memory: 4096, InstanceType: "ecs.example", PublicIpAddress: "192.0.2.10", PrivateIpAddress: "10.0.0.8", OSName: "Ubuntu 22.04", CreationTime: "2026-01-01T00:00:00Z", ExpiredTime: "2027-01-01T00:00:00Z", PaymentTiming: "Prepaid", _region_id: "cn-beijing", FirewallGroupId: "sg-example" };
      (window as any).logQueries = [];
      (window as any).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {},
        invoke: async (command: string, args: any = {}) => {
          if (command === "list_accounts") return [{ id: 7, account_name: "order-fixture", cloud_type: provider, enabled: true, created_at: 1 }];
          if (command === "list_local_assets") return [{ account_id: 7, resource_type: kind, asset_key: "i-example", region_id: "cn-beijing", payload, fetched_at: 1 }];
          if (command === "list_cloud_resources") return { items: [payload], errors: [], resource_type: kind, fetched_at: 1 };
          if (command === "list_instance_disks") return [];
          if (command === "list_api_logs") {
            (window as any).logQueries.push(args);
            return [{ id: 1, account_id: 7, endpoint: "ecs.cn-beijing.aliyuncs.com", action: "RebootInstance", request_params: JSON.stringify({ InstanceId: "i-example", RegionId: "cn-beijing" }), response_params: JSON.stringify({ RequestId: "req-1" }), status: "成功", created_at: 1 }];
          }
          if (command === "authenticator_status") return { configured: false, unlocked: false };
          if (command === "list_client_preferences") return {};
          return [];
        },
      };
    }, { provider, kind });
    await page.goto("/");
    await page.getByRole("button", { name: "账号管理", exact: true }).click();
    if (kind === "swas") await page.getByRole("button", { name: "更多 order-fixture 资产操作", exact: true }).click();
    await page.getByRole("button", { name: kind === "swas" ? /查看 order-fixture 轻量服务器资产/ : /查看 order-fixture .*服务器资产/ }).click();
    const card = page.locator(kind === "swas" ? ".swas-card" : ".server-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    const actions = card.locator(".server-actions");
    await expect(actions).toBeVisible({ timeout: 20_000 });
    expect(await actions.locator("button").evaluateAll(nodes => nodes.map(node => (node.textContent || "").trim()))).toEqual(expected);
    // 「API 操作记录」永远排在最后：后面不能再冒出别的按钮。
    await expect(actions.locator("button").last()).toHaveText("API 操作记录");
    await actions.screenshot({ path: `test-results/action-order-${provider}-${kind}.png` });
    await actions.getByRole("button", { name: "API 操作记录", exact: true }).click();
    const logs = page.getByRole("dialog", { name: "API 操作记录", exact: true });
    await expect(logs).toBeVisible();
    await expect(logs).toContainText("重启");
    await expect(logs).toContainText("req-1");
    expect(await page.evaluate(() => (window as any).logQueries.at(-1))).toMatchObject({ accountId: 7, instanceId: "i-example" });
    await page.keyboard.press("Escape");
    await expect(logs).toHaveCount(0);
  });
}
