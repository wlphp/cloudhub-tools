import { expect, test } from "@playwright/test";

test("Oracle power actions display API results and instance logs paginate in shared dialogs", async ({ page }) => {
  await page.addInitScript(() => {
    const instanceId = "ocid1.instance.oc1.test.fixture";
    let calls = 0;
    let saves = 0;
    (window as any).detachedWindows = [];
    (window as any).oracleLogQueries = [];
    (window as any).securityCalls = [];
    (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      if (command === "list_accounts") return [{ id: 7, account_name: "oracle-fixture", cloud_type: "oracle", access_key_id: "fixture-id", enabled: true, created_at: 1 }];
      if (command === "list_local_assets") return [{ account_id: 7, resource_type: "ecs", asset_key: instanceId, region_id: "me-dubai-1", payload: { InstanceId: instanceId, InstanceName: "oracle-server", PublicIpAddress: "192.0.2.10", PrivateIpAddress: "10.0.0.140", Cpu: 1, Memory: 1024, InstanceType: "VM.Standard.E2.1.Micro", OSName: "CentOS-8-Stream-2024.04.25-0", CreationTime: "2026-01-23T09:36:00Z", Status: "RUNNING", _region_id: "me-dubai-1", _compartment_ocid: "ocid1.compartment.oc1..fixture" }, fetched_at: 1 }];
      if (command === "save_managed_host") {
        saves++;
        if (saves === 1) throw new Error("模拟保存失败");
        return { id: 99, name: "oracle-server", host: "192.0.2.10", port: 22, username: "root", platform: "linux", auth_method: "password", source_account_id: 7, source_asset_key: instanceId, group_name: "", status: "unknown" };
      }
      if (command === "plugin:webview|create_webview_window") { (window as any).detachedWindows.push(args.options); return; }
      if (command === "list_instance_disks") return [{ DiskId: "fixture-boot", DiskName: "oracle-server (Boot Volume)", Category: "启动卷", Size: 47, Status: "AVAILABLE" }];
      if (command === "list_oracle_security_groups") {
        const securityList = args.securityGroupId === "sl:ocid1.securitylist.oc1..fixture";
        return {
          groups: [
            { SecurityGroupId: "ocid1.networksecuritygroup.oc1..fixture", SecurityGroupName: "web-nsg", Description: "网络安全组 · VCN ocid1.vcn.fixture" },
            { SecurityGroupId: "sl:ocid1.securitylist.oc1..fixture", SecurityGroupName: "安全列表 · subnet-a", Description: "安全列表由子网共享，此处只读" },
          ],
          selectedSecurityGroupId: args.securityGroupId || "ocid1.networksecuritygroup.oc1..fixture",
          rules: securityList
            ? [{ RuleId: "", RuleIndex: 0, Direction: "ingress", IpProtocol: "tcp", PortRange: "22/22", SourceCidrIp: "10.0.0.0/8", Policy: "accept", Description: "SSH from VCN", IsStateless: false }]
            : [
              { RuleId: "ocid1.securityrule.oc1..one", RuleIndex: 0, Direction: "ingress", IpProtocol: "tcp", PortRange: "22/22", SourceCidrIp: "192.0.2.0/24", Policy: "accept", Description: "SSH", IsStateless: false },
              { RuleId: "ocid1.securityrule.oc1..two", RuleIndex: 1, Direction: "ingress", IpProtocol: "all", PortRange: "-1/-1", SourceCidrIp: "", SourceGroupId: "ocid1.networksecuritygroup.oc1..other", Policy: "accept", Description: "Group ref", ReadOnly: true },
            ],
        };
      }
      if (["authorize_oracle_security_group_rule", "modify_oracle_security_group_rule", "revoke_oracle_security_group_rule"].includes(command)) { (window as any).securityCalls.push({ command, args }); return ""; }
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
  await resource.getByRole("button", { name: "安全组", exact: true }).click();
  const security = page.getByRole("dialog", { name: "安全组", exact: true });
  await expect(security).toContainText("web-nsg");
  await expect(security).toContainText("192.0.2.0/24");
  await expect(security).toContainText("ocid1.networksecuritygroup.oc1..other");
  await security.getByRole("button", { name: "添加规则", exact: true }).click();
  const ruleEditor = page.getByRole("dialog", { name: "添加入方向规则", exact: true });
  // 网络安全组只有允许规则、没有优先级：不渲染点不亮的灰按钮，改只读说明。
  await expect(ruleEditor.getByRole("button", { name: "拒绝", exact: true })).toHaveCount(0);
  await expect(ruleEditor.locator(".security-fixed-value").first()).toContainText("该云无优先级");
  await expect(ruleEditor.getByRole("button", { name: "GRE", exact: true })).toBeDisabled();
  await expect(ruleEditor.getByRole("button", { name: "ALL", exact: true })).toBeEnabled();
  await ruleEditor.getByLabel("端口范围", { exact: true }).fill("8080");
  await ruleEditor.getByRole("button", { name: "确定", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
  await expect(ruleEditor).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).securityCalls.at(-1))).toMatchObject({
    command: "authorize_oracle_security_group_rule",
    args: { compartmentId: "ocid1.compartment.oc1..fixture", securityGroupId: "ocid1.networksecuritygroup.oc1..fixture", ipProtocol: "tcp", portRange: "8080/8080", sourceCidrIp: "0.0.0.0/0" },
  });
  // 子网安全列表同样可编辑：规则没有 OCID，用下标 + 内容校验定位。
  await security.getByLabel("安全组", { exact: true }).selectOption("sl:ocid1.securitylist.oc1..fixture");
  await expect(security).toContainText("10.0.0.0/8");
  await expect(security.getByRole("button", { name: "添加规则", exact: true })).toBeEnabled();
  await expect(security.getByRole("button", { name: "导入", exact: true })).toBeEnabled();
  const listRow = security.getByRole("row").filter({ hasText: "10.0.0.0/8" });
  await expect(listRow.getByRole("button", { name: "修改", exact: true })).toBeEnabled();
  await listRow.getByRole("button", { name: "修改", exact: true }).click();
  const listEditor = page.getByRole("dialog", { name: "修改入方向规则", exact: true });
  await listEditor.getByLabel("端口范围", { exact: true }).fill("2222");
  await listEditor.getByRole("button", { name: "确定", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
  await expect(listEditor).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).securityCalls.at(-1))).toMatchObject({
    command: "modify_oracle_security_group_rule",
    args: { securityGroupId: "sl:ocid1.securitylist.oc1..fixture", ruleIndex: 0, original: { protocol: "tcp", ports: "22/22", source: "10.0.0.0/8", description: "SSH from VCN" }, updated: { ports: "2222/2222" } },
  });
  await security.getByRole("button", { name: "关闭安全组", exact: true }).click();
  await expect(security).toHaveCount(0);
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

