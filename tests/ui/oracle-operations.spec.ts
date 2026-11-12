import { expect, test } from "@playwright/test";

test("Oracle power actions display API results and instance logs paginate in shared dialogs", async ({ page }) => {
  await page.addInitScript(() => {
    const instanceId = "ocid1.instance.oc1.test.fixture";
    let calls = 0;
    let saves = 0;
    (window as any).detachedWindows = [];
    (window as any).oracleLogQueries = [];
    (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      if (command === "list_accounts") return [{ id: 7, account_name: "oracle-fixture", cloud_type: "oracle", access_key_id: "fixture-id", enabled: true, created_at: 1 }];
      if (command === "list_local_assets") return [{ account_id: 7, resource_type: "ecs", asset_key: instanceId, region_id: "me-dubai-1", payload: { InstanceId: instanceId, InstanceName: "oracle-server", PublicIpAddress: "192.0.2.10", PrivateIpAddress: "10.0.0.140", Cpu: 1, Memory: 1024, InstanceType: "VM.Standard.E2.1.Micro", OSName: "CentOS-8-Stream-2024.04.25-0", CreationTime: "2026-01-23T09:36:00Z", Status: "RUNNING", _region_id: "me-dubai-1" }, fetched_at: 1 }];
      if (command === "save_managed_host") {
        saves++;
        if (saves === 1) throw new Error("模拟保存失败");
        return { id: 99, name: "oracle-server", host: "192.0.2.10", port: 22, username: "root", platform: "linux", auth_method: "password", source_account_id: 7, source_asset_key: instanceId, group_name: "", status: "unknown" };
      }
      if (command === "plugin:webview|create_webview_window") { (window as any).detachedWindows.push(args.options); return; }
      if (command === "list_instance_disks") return [{ DiskId: "fixture-boot", DiskName: "oracle-server (Boot Volume)", Category: "启动卷", Size: 47, Status: "AVAILABLE" }];
      if (command === "oracle_instance_action") {
        calls++;
        if (calls === 3) throw new Error("OCI 请求超时，操作结果未知");
        return { success: calls === 1, httpStatus: calls === 1 ? 200 : 409, requestId: "fixture-request", response: calls === 1 ? { lifecycleState: "STOPPING" } : { code: "IncorrectState", message: "Instance is busy" } };
      }
      if (command === "list_api_logs") {
        if (!args.instanceId) return [];
        (window as any).oracleLogQueries.push(args);
        return Array.from({ length: 12 }, (_, i) => ({ id: i + 1, account_id: 7, action: "POST /20160918/instances", endpoint: "iaas.me-dubai-1.oraclecloud.com", request_params: JSON.stringify({ instanceId, action: "RESET" }), response_params: JSON.stringify({ success: true, httpStatus: 200, requestId: `request-${i + 1}` }), status: "成功", created_at: i + 1 })).slice(args.offset, args.offset + args.limit);
      }
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      if (command === "list_client_preferences") return {};
      return [];
    } };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "账号管理", exact: true }).click();
  await page.getByRole("button", { name: /查看 oracle-fixture 服务器资产/ }).click();
  const resource = page.locator(".resource-modal");
  await expect(resource.locator(".server-card")).toHaveCount(1);
  await resource.getByRole("button", { name: "SSH 登录", exact: true }).click();
  const config = page.getByRole("dialog", { name: "配置 SSH 连接", exact: true });
  await expect(config).toBeVisible();
  await expect(config.getByLabel("主机 / IP")).toHaveValue("192.0.2.10");
  await config.getByRole("button", { name: "取消", exact: true }).click();
  await expect(config).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).detachedWindows)).toHaveLength(0);
  await resource.getByRole("button", { name: "SSH 登录", exact: true }).click();
  // 只验证前端交接，模拟保存不包含任何凭据；真实表单仍保留必填验证。
  await config.locator("form").evaluate(el => el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await expect(config.getByRole("alert")).toContainText("模拟保存失败");
  await config.locator("form").evaluate(el => el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await expect(config).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).detachedWindows.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).detachedWindows[0])).toMatchObject({ url: expect.stringContaining("detachedTerminalHostId=99"), title: "SSH 终端 · oracle-server" });
  await resource.getByRole("button", { name: "SSH 登录", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).detachedWindows.length)).toBe(2);
  await expect(config).toHaveCount(0);
  await page.setViewportSize({ width: 1180, height: 980 });
  await expect(resource.locator(".disk-info")).toContainText("47 GB");
  await resource.screenshot({ path: "test-results/oracle-server-compact.png" });
  await page.evaluate(() => { document.body.classList.remove("theme-light"); document.body.classList.add("theme-dark"); });
  await resource.screenshot({ path: "test-results/oracle-server-compact-dark.png" });
  await page.evaluate(() => { document.body.classList.remove("theme-dark"); document.body.classList.add("theme-light"); });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 980 });
    expect(await resource.locator(".server-card").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1180, height: 980 });
  for (const [index, label] of ["重启", "强制重启", "关机"].entries()) {
    await resource.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
    const result = page.getByRole("dialog", { name: `${label} · API ${index === 0 ? "成功" : "失败"}`, exact: true });
    await expect(result).toBeVisible();
    await expect(result).toContainText(index === 0 ? "STOPPING" : index === 1 ? "IncorrectState" : "操作结果未知");
    await expect(result).toContainText(index < 2 ? "fixture-request" : "未收到");
    await page.keyboard.press("Escape");
    await expect(result).toHaveCount(0);
  }
  await resource.getByRole("button", { name: "API 操作记录", exact: true }).click();
  const logs = page.getByRole("dialog", { name: "API 操作记录", exact: true });
  await expect(logs.locator("details")).toHaveCount(10);
  await logs.getByRole("button", { name: "下一页" }).click();
  await expect(logs.locator("details")).toHaveCount(2);
  await expect(logs.getByRole("button", { name: "下一页" })).toBeDisabled();
  await logs.locator("summary").first().click();
  await expect(logs).toContainText("request-11");
  expect(await page.evaluate(() => (window as any).oracleLogQueries.at(-1))).toMatchObject({ accountId: 7, instanceId: "ocid1.instance.oc1.test.fixture", offset: 10, limit: 11 });
  await page.mouse.click(2, 2);
  await expect(logs).toBeVisible();
  await logs.screenshot({ path: "test-results/oracle-operation-logs.png" });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await logs.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await logs.locator(".modal-actions").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(logs).toHaveCount(0);
  await expect(resource).toBeVisible();
});

