import { expect, test } from "@playwright/test";

for (const [provider, kind] of [["aliyun", "ecs"], ["tencent", "ecs"], ["baidu", "ecs"], ["volcengine", "ecs"], ["aliyun", "swas"], ["tencent", "swas"], ["jdcloud", "swas"], ["vultr", "ecs"]]) {
  test(`shared security group workbench ${provider} ${kind}`, async ({ page }) => {
    await page.addInitScript(({ provider, kind }) => {
      localStorage.setItem("cloudhub-tools-ui-theme", provider === "tencent" ? "dark" : "light");
      const rule = { Direction: "ingress", IpProtocol: "tcp", PortRange: "22/22", SourceCidrIp: "192.0.2.0/24", Policy: "accept", Priority: 5, Description: "SSH", NicType: "internet", SecurityGroupRuleId: "rule-one", RuleId: "rule-one", FirewallRule: { Protocol: "TCP" } };
      (window as any).securityCalls = [];
      (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
        if (command === "list_accounts") return [{ id: 7, account_name: "security-fixture", cloud_type: provider, enabled: true, created_at: 1 }];
        if (command === "list_local_assets") return [{ account_id: 7, resource_type: kind, asset_key: "i-example", region_id: "cn-beijing", payload: { InstanceId: "i-example", InstanceName: "example", Status: "Running", _region_id: "cn-beijing", FirewallGroupId: "sg-example" }, fetched_at: 1 }];
        if (command.startsWith("list_") && command.endsWith("security_groups")) {
          (window as any).securityListCalls = ((window as any).securityListCalls || 0) + 1;
          const firstRule = provider === "baidu" ? { ...rule, SecurityGroupRuleId: "", securityGroupRuleId: "rule-one" } : rule;
          (window as any).securityRules ??= [firstRule, { ...firstRule, SecurityGroupRuleId: "deny-one", SourceCidrIp: "198.51.100.0/24", Policy: "drop", Description: "Denied" }, { ...firstRule, SecurityGroupRuleId: "group-one", SourceCidrIp: "", SourceGroupId: "sg-other", IpProtocol: "all", PortRange: "-1/-1", Priority: 100, ReadOnly: !["volcengine", "aliyun", "baidu"].includes(provider) }, ...(provider === "volcengine" ? [{ ...firstRule, SecurityGroupRuleId: "ipv6-one", SourceCidrIp: "::/0", PortRange: "8888/8888" }] : []), ...(provider === "baidu" ? [{ ...firstRule, SecurityGroupRuleId: "icmp-one", IpProtocol: "icmp", PortRange: "-1/-1", SourceCidrIp: "0.0.0.0/0", Description: "Ping" }] : [])];
          return { groups: [{ SecurityGroupId: "sg-example", SecurityGroupName: "Default", NicType: "internet" }], selectedSecurityGroupId: "sg-example", rules: (window as any).securityRules, sgVersion: 9 };
        }
        if (["list_light_firewall_rules", "list_vultr_firewall_rules"].includes(command)) return { rules: provider === "tencent" && kind === "swas" ? [provider === "tencent" && kind === "swas" ? { ...rule, FirewallRule: { Protocol: "TCP", Port: "22", CidrBlock: "192.0.2.0/24", Ipv6CidrBlock: "", Action: "ACCEPT", FirewallRuleDescription: "SSH" } } : rule, { ...rule, SecurityGroupRuleId: "", RuleId: "", IpProtocol: "ALL", PortRange: "-1/-1", SourceCidrIp: "203.0.113.0/24", FirewallRule: { Protocol: "ALL", Port: "-1/-1", CidrBlock: "203.0.113.0/24", Action: "ACCEPT" } }, { ...rule, SecurityGroupRuleId: "", RuleId: "", IpProtocol: "ICMP", PortRange: "-1/-1", SourceCidrIp: "198.51.100.0/24", FirewallRule: { Protocol: "ICMP", Port: "-1/-1", CidrBlock: "198.51.100.0/24", Action: "ACCEPT" } }] : [rule], firewallVersion: 9 };
        if (command === "update_volc_security_group_rule") {
          if ((window as any).failSecurityUpdate) { (window as any).failSecurityUpdate = false; throw new Error("模拟权限不足"); }
          (window as any).securityCalls.push({ command, args }); return { AsyncTaskId: "task-example" };
        }
        if (command === "modify_aliyun_security_group_rule" || command === "modify_baidu_security_group_rule" || command === "modify_tencent_security_group_rule") { (window as any).securityCalls.push({ command, args }); return {}; }
        if (command === "update_light_firewall_rule_description" || command === "modify_light_firewall_rule") { (window as any).securityCalls.push({ command, args }); return {}; }
        if (/^(authorize_|revoke_|create_light_firewall|delete_light_firewall|create_vultr_firewall|delete_vultr_firewall)/.test(command)) {
          if ((window as any).failDuplicate) { (window as any).failDuplicate = false; throw new Error("该规则已存在：百度云不允许重复添加相同规则（协议、端口范围、来源一致即视为重复，备注也参与判重）。改一下描述或端口后重试；若刚提交过，刷新列表就能看到已有规则。"); } (window as any).securityCalls.push({ command, args });
          if (command.startsWith("authorize_") && (window as any).securityRules) {
            const created = (window as any).securityRules;
            // 阿里云轻量等接口把单端口返回成 80（不是 80/80）：这里模拟云端端口格式被改写的场景，验证置顶匹配能容错。
            const portRange = provider === "aliyun" ? String(args.portRange || "").replace(/^(\d+)\/\1$/, "$1") : args.portRange;
            created.push({ Direction: "ingress", IpProtocol: args.ipProtocol, PortRange: portRange, SourceCidrIp: args.sourceCidrIp, Policy: args.policy || "accept", Priority: args.priority ?? 1, Description: args.description || "", NicType: "internet", SecurityGroupRuleId: `created-${created.length}` });
          }
          return command === "create_light_firewall_rule" && provider === "jdcloud" ? "created-rule" : {}; }
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        return [];
      } };
    }, { provider, kind });
    await page.goto("/");
    await page.getByRole("button", { name: "账号管理", exact: true }).click();
    if (kind === "swas") await page.getByRole("button", { name: "更多 security-fixture 资产操作", exact: true }).click();
    await page.getByRole("button", { name: kind === "swas" ? /查看 security-fixture 轻量服务器资产/ : /查看 security-fixture .*服务器资产/ }).click();
    await page.locator(kind === "swas" ? ".swas-card" : ".server-card").getByRole("button", { name: "安全组", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "安全组", exact: true });
    await expect(dialog.getByRole("columnheader", { name: "优先级", exact: true })).toBeVisible();
    await expect(dialog).toContainText("192.0.2.0/24");
    if (provider === "tencent" && kind === "swas") {
      for (const source of ["192.0.2.0/24", "198.51.100.0/24"]) await expect(dialog.getByRole("row").filter({ hasText: source }).getByRole("button", { name: "复制", exact: true })).toBeEnabled();
      await dialog.getByRole("button", { name: "添加规则", exact: true }).click();
      const lightEditor = page.getByRole("dialog", { name: "添加入方向规则", exact: true });
      for (const protocol of ["UDP", "ICMP", "ICMPv6", "ALL"]) await expect(lightEditor.getByRole("button", { name: protocol, exact: true })).toBeEnabled();
      await expect(lightEditor.getByRole("button", { name: "GRE", exact: true })).toBeDisabled();
      await expect(lightEditor.getByRole("button", { name: "拒绝", exact: true })).toBeEnabled();
      await lightEditor.getByRole("button", { name: "取消", exact: true }).click();
    }
    if (provider === "volcengine" || (["aliyun", "tencent", "baidu"].includes(provider) && kind === "ecs") || (provider === "jdcloud" && kind === "swas") || (provider === "tencent" && kind === "swas") || (provider === "aliyun" && kind === "swas")) await expect(dialog.getByRole("button", { name: "修改", exact: true }).first()).toBeEnabled();
    else await expect(dialog.getByRole("button", { name: "修改", exact: true }).first()).toBeDisabled();
    await dialog.getByLabel("搜索安全组规则").fill("udp");
    await expect(dialog).toContainText("没有匹配的规则");
    await dialog.getByLabel("搜索安全组规则").fill("");
    if (kind === "ecs" && provider !== "vultr") {
      await expect(dialog).toContainText("拒绝");
      const denyCopy = dialog.getByRole("row").filter({ hasText: "Denied" }).getByRole("button", { name: "复制", exact: true });
      if (["volcengine", "aliyun", "tencent"].includes(provider)) {
        await denyCopy.click();
        const copyDeny = page.getByRole("dialog", { name: "复制入方向规则", exact: true });
        await expect(copyDeny.getByRole("button", { name: "拒绝", exact: true })).toHaveAttribute("aria-pressed", "true");
        await copyDeny.getByRole("button", { name: "取消", exact: true }).click();
      } else await expect(denyCopy).toBeDisabled();
      const groupCopy = dialog.getByRole("row").filter({ hasText: "sg-other" }).getByRole("button", { name: "复制", exact: true });
      if (["volcengine", "aliyun", "baidu"].includes(provider)) await expect(groupCopy).toBeEnabled();
      else await expect(groupCopy).toBeDisabled();
    }
    if (provider === "aliyun" && kind === "ecs") {
      const input = dialog.locator('input[type="file"]');
      await input.setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ direction: "ingress", rules: [{ protocol: "tcp", ports: "0", source: "0.0.0.0/0", description: "", policy: "accept", priority: 1 }] })) });
      await expect(dialog.getByRole("alert")).toContainText("端口");
      expect(await page.evaluate(() => (window as any).securityCalls.length)).toBe(0);
      await input.setInputFiles({ name: "valid.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ direction: "ingress", rules: [{ protocol: "tcp", ports: "8080", source: "192.0.2.0/24", description: "Web", policy: "accept", priority: 1 }] })) });
      const preview = page.getByRole("dialog", { name: "导入安全组规则", exact: true });
      await expect(preview).toContainText("8080");
      await preview.getByRole("button", { name: "取消", exact: true }).click();
      expect(await page.evaluate(() => (window as any).securityCalls.length)).toBe(0);
      const downloadEvent = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "导出", exact: true }).click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toBe("安全组规则.json");
    }
    if (["aliyun", "tencent"].includes(provider) && kind === "ecs") {
      const row = dialog.getByRole("row").filter({ hasText: "192.0.2.0/24" });
      await row.getByRole("button", { name: "修改", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "修改入方向规则", exact: true });
      await edit.getByLabel("端口范围", { exact: true }).fill("8081");
      await edit.getByRole("button", { name: "确定", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
      await expect(edit).toHaveCount(0);
      const update = await page.evaluate(() => (window as any).securityCalls.at(-1));
      expect(update.command).toBe(provider === "aliyun" ? "modify_aliyun_security_group_rule" : "modify_tencent_security_group_rule");
      if (provider === "aliyun") expect(update.args).toMatchObject({ securityGroupRuleId: "rule-one", updated: { ports: "8081/8081" } });
      else expect(update.args).toMatchObject({ priority: 5, portRange: "8081/8081" });
    }
    if (provider === "baidu" && kind === "ecs") {
      const row = dialog.getByRole("row").filter({ hasText: "192.0.2.0/24" });
      await row.getByRole("button", { name: "修改", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "修改入方向规则", exact: true });
      await expect(edit.getByRole("button", { name: "拒绝", exact: true })).toHaveCount(0);
      await expect(edit.locator(".security-fixed-value").last()).toContainText("仅支持允许策略");
      await expect(edit.getByLabel("优先级", { exact: true })).toHaveCount(0);
      await expect(edit.locator(".security-fixed-value").first()).toContainText("该云无优先级");
      for (const protocol of ["UDP", "ICMP", "ALL"]) await expect(edit.getByRole("button", { name: protocol, exact: true })).toBeEnabled();
      for (const protocol of ["ICMPv6", "GRE"]) await expect(edit.getByRole("button", { name: protocol, exact: true })).toBeDisabled();
      await edit.getByLabel("端口范围", { exact: true }).fill("8081");
      await edit.getByRole("button", { name: "确定", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
      await expect(edit).toHaveCount(0);
      const update = await page.evaluate(() => (window as any).securityCalls.at(-1));
      expect(update.command).toBe("modify_baidu_security_group_rule");
      expect(update.args).toMatchObject({ securityGroupRuleId: "rule-one", sgVersion: 9, original: { ports: "22/22", source: "192.0.2.0/24" }, updated: { ports: "8081/8081", source: "192.0.2.0/24" } });
      for (const source of ["0.0.0.0/0", "sg-other"]) await expect(dialog.getByRole("row").filter({ hasText: source }).getByRole("button", { name: "复制", exact: true })).toBeEnabled();
      const icmpRow = dialog.getByRole("row").filter({ hasText: "Ping" });
      await icmpRow.getByRole("button", { name: "修改", exact: true }).click();
      const icmpEdit = page.getByRole("dialog", { name: "修改入方向规则", exact: true });
      await expect(icmpEdit.getByLabel("端口范围", { exact: true })).toHaveValue("ALL");
      await icmpEdit.getByRole("button", { name: "ICMP", exact: true }).click();
      await icmpEdit.getByRole("button", { name: "确定", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
      await expect(icmpEdit).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).securityCalls.at(-1))).toMatchObject({ command: "modify_baidu_security_group_rule", args: { securityGroupRuleId: "icmp-one", original: { protocol: "icmp", ports: "-1/-1" }, updated: { protocol: "icmp", ports: "-1/-1" } } });

      // 判重失败要翻译成中文并回读列表，让用户看到已经存在的规则。
      await page.evaluate(() => { (window as any).failDuplicate = true; });
      const listCalls = await page.evaluate(() => (window as any).securityListCalls);
      await dialog.getByRole("button", { name: "添加规则", exact: true }).click();
      const duplicateEditor = page.getByRole("dialog", { name: "添加入方向规则", exact: true });
      await duplicateEditor.getByLabel("端口范围", { exact: true }).fill("9000");
      await duplicateEditor.getByRole("button", { name: "确定", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
      await expect(duplicateEditor.getByRole("alert")).toContainText("该规则已存在");
      expect(await page.evaluate(() => (window as any).securityListCalls)).toBe(listCalls + 1);
      await duplicateEditor.getByRole("button", { name: "取消", exact: true }).click();
    }
    if (provider === "aliyun" && kind === "ecs") {
      const groupRow = dialog.getByRole("row").filter({ hasText: "sg-other" });
      for (const name of ["修改", "复制", "删除"]) await expect(groupRow.getByRole("button", { name, exact: true })).toBeEnabled();
    }
    await dialog.getByRole("button", { name: "添加规则", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "添加入方向规则", exact: true });
    await editor.getByRole("button", { name: "优先级说明", exact: true }).click();
    await expect(page.getByRole("tooltip")).toContainText(provider === "baidu" ? "没有优先级" : "数字越小优先级越高");
    await editor.getByRole("button", { name: "全部端口开放", exact: true }).click();
    await expect(editor.getByLabel("端口范围", { exact: true })).toHaveValue((kind === "ecs" && provider !== "vultr") || (kind === "swas" && provider === "tencent") ? "ALL" : "1-65535");
    await editor.getByRole("button", { name: "Web HTTP 流量访问", exact: true }).click();
    await expect(editor.getByLabel("端口范围", { exact: true })).toHaveValue("80");
    await expect(editor.getByRole("button", { name: "常用端口", exact: true })).toHaveCount(0);
    await editor.getByRole("button", { name: "端口范围选项", exact: true }).click();
    const allPortsRow = editor.locator(".security-port-options > label").filter({ hasText: "全部端口" });
    await allPortsRow.click({ position: { x: (await allPortsRow.boundingBox())!.width - 12, y: 16 } });
    await expect(editor.getByRole("checkbox", { name: "全部端口（1-65535）", exact: true })).toBeChecked();
    await expect(editor.getByLabel("端口范围", { exact: true })).toHaveValue("1-65535");
    await editor.getByRole("checkbox", { name: "HTTP（80）", exact: true }).check();
    await expect(editor.getByLabel("端口范围", { exact: true })).toHaveValue("80");
    await editor.getByLabel("端口范围", { exact: true }).press("Escape");
    await expect(editor).toBeVisible();
    await expect(editor.getByRole("group", { name: "端口范围快捷选项", exact: true })).toHaveCount(0);
    await editor.getByLabel("源地址 1", { exact: true }).fill("192.0.2.0/24");
    const sourceRow = editor.locator(".security-port-options > label").filter({ hasText: "任何位置" });
    await sourceRow.click({ position: { x: (await sourceRow.boundingBox())!.width - 12, y: 16 } });
    await expect(editor.getByRole("checkbox", { name: "0.0.0.0/0（任何位置）", exact: true })).toBeChecked();
    await expect(editor.getByLabel("源地址 1", { exact: true })).toHaveValue("0.0.0.0/0");
    if (provider === "volcengine" || (["aliyun", "tencent"].includes(provider) && kind === "ecs") || (provider === "tencent" && kind === "swas")) {
      await editor.getByRole("button", { name: "拒绝", exact: true }).click();
      await expect(editor.getByRole("button", { name: "拒绝", exact: true })).toHaveAttribute("aria-pressed", "true");
    } else await expect(editor.getByRole("button", { name: "拒绝", exact: true })).toHaveCount(0);
    if (provider === "jdcloud") {
      for (const protocol of ["ICMP", "ALL", "ICMPv6", "GRE"]) await expect(editor.getByRole("button", { name: protocol, exact: true })).toBeDisabled();
    }
    await editor.getByRole("button", { name: "添加源地址", exact: true }).click();
    await editor.getByLabel("源地址 2", { exact: true }).fill("198.51.100.0/24");
    await expect(editor.getByLabel("源地址类型 1", { exact: true })).toHaveValue("IPv4");
    await expect(editor.getByLabel("源地址类型 2", { exact: true })).toHaveValue("IPv4");
    if (provider === "volcengine" || provider === "jdcloud") {
      await editor.getByLabel("源地址类型 2", { exact: true }).selectOption("IPv6");
      await editor.getByLabel("源地址 2", { exact: true }).fill("2001:db8::/64");
      await expect(editor.getByLabel("源地址类型 1", { exact: true })).toHaveValue("IPv4");
    }
    if (provider === "tencent" && kind === "swas") {
      await editor.getByLabel("源地址类型 1", { exact: true }).selectOption("IPv6");
      await editor.getByLabel("源地址 1", { exact: true }).fill("::/0");
      await editor.getByLabel("源地址类型 2", { exact: true }).selectOption("IPv6");
      await editor.getByLabel("源地址 2", { exact: true }).fill("2001:db8::/64");
    }
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 980 });
      expect(await editor.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await editor.locator(".modal-body").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const bounds = await editor.locator(".security-source-entry").evaluateAll(rows => rows.map(row => {
        const cells = Array.from(row.children).filter(el => el.tagName !== "DATALIST").map(el => el.getBoundingClientRect());
        return cells.every((cell, index) => index === 0 || cell.left >= cells[index - 1].right);
      }));
      expect(bounds.every(Boolean)).toBe(true);
    }
    const fieldAlignment = await editor.locator(".security-field-label").evaluateAll(labels => {
      const names = labels.map(el => el.querySelector("label, span")!.getBoundingClientRect().left);
      const helps = labels.map(el => el.querySelector(".shared-help-trigger")!.getBoundingClientRect().left);
      return Math.max(...names) - Math.min(...names) < 1 && Math.max(...helps) - Math.min(...helps) < 1;
    });
    expect(fieldAlignment).toBe(true);
    if (provider === "tencent" && kind === "swas") {
      await editor.getByRole("button", { name: "ICMPv6", exact: true }).click();
      await expect(editor.getByLabel("端口范围", { exact: true })).toHaveValue("ALL");
    }
    if (provider === "aliyun" && kind === "ecs") {
      await editor.getByRole("button", { name: "端口范围选项", exact: true }).click();
      const options = editor.getByRole("group", { name: "端口范围快捷选项", exact: true });
      const bounds = await options.evaluate(el => { const menu = el.getBoundingClientRect(); const body = el.closest(".modal-body")!.getBoundingClientRect(); return menu.top >= body.top && menu.bottom <= body.bottom; });
      expect(bounds).toBe(true);
      expect(await editor.getByLabel("端口范围", { exact: true }).evaluate(el => getComputedStyle(el).borderTopWidth)).toBe("0px");
      await editor.screenshot({ path: "test-results/security-rule-editor.png" });
      await editor.getByLabel("端口范围", { exact: true }).press("Escape");
    }
    await editor.getByRole("button", { name: "确定", exact: true }).click();
    if (provider === "volcengine") await expect(page.getByRole("alertdialog")).toContainText("拒绝 TCP 80");
    await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
    await expect(editor).toHaveCount(0);
    const calls = await page.evaluate(() => (window as any).securityCalls);
    expect(calls).toHaveLength(provider === "baidu" && kind === "ecs" ? 4 : ["aliyun", "tencent"].includes(provider) && kind === "ecs" ? 3 : 2);
    if (provider === "volcengine" || (["aliyun", "tencent"].includes(provider) && kind === "ecs")) expect(calls.filter((call: any) => call.command.startsWith("authorize_")).every((call: any) => call.args.policy === "drop")).toBe(true);
    if (provider === "tencent" && kind === "swas") expect(calls.filter((call: any) => call.command === "create_light_firewall_rule").every((call: any) => call.args.policy === "drop")).toBe(true);
    const createCallIndex = provider === "baidu" && kind === "ecs" ? 2 : (["aliyun", "tencent"].includes(provider) && kind === "ecs") || (provider === "aliyun" && kind === "swas") ? 1 : 0;
    expect(calls[createCallIndex].args).toMatchObject(provider === "vultr" ? { firewallGroupId: "sg-example", port: "80" } : provider === "tencent" && kind === "swas" ? { ipProtocol: "icmpv6", portRange: "-1/-1", sourceCidrIp: "::/0", policy: "drop" } : { portRange: "80/80" });
    if (provider === "aliyun" && kind === "ecs") expect(calls[createCallIndex].args.nicType).toBe("internet");
    if (kind === "swas") expect(calls[createCallIndex].args.firewallVersion).toBe(9);
    if (provider === "jdcloud") expect(calls[1]).toMatchObject({ command: "create_light_firewall_rule", args: { sourceCidrIp: "2001:db8::/64", ipProtocol: "tcp", portRange: "80/80" } });
    if (kind === "ecs" && provider !== "vultr") {
      await expect(dialog.getByRole("row").nth(1)).toContainText("0.0.0.0/0");
      await dialog.getByRole("button", { name: "刷新规则", exact: true }).click();
      await expect(dialog.getByRole("row").nth(1)).toContainText("0.0.0.0/0");
    }
    await dialog.getByRole("row").filter({ hasText: "192.0.2.0/24" }).getByRole("button", { name: "复制", exact: true }).click();
    const copy = page.getByRole("dialog", { name: "复制入方向规则", exact: true });
    await expect(copy.getByLabel("端口范围", { exact: true })).toHaveValue("22");
    await copy.getByRole("button", { name: "取消", exact: true }).click();
    if (provider === "jdcloud" && kind === "swas") {
      const row = dialog.getByRole("row").filter({ hasText: "192.0.2.0/24" });
      await expect(row.getByRole("button", { name: "修改", exact: true })).toBeEnabled();
      await row.getByRole("button", { name: "修改", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "修改入方向规则", exact: true });
      await expect(edit.getByRole("button", { name: "拒绝", exact: true })).toHaveCount(0);
      await edit.getByLabel("端口范围", { exact: true }).fill("8080");
      await edit.getByRole("button", { name: "确定", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
      await expect(edit).toHaveCount(0);
      const calls = await page.evaluate(() => (window as any).securityCalls);
      expect(calls.slice(-2).map((call: any) => call.command)).toEqual(["create_light_firewall_rule", "delete_light_firewall_rule"]);
      expect(calls.at(-2).args).toMatchObject({ portRange: "8080/8080", sourceCidrIp: "192.0.2.0/24" });
      expect(calls.at(-1).args.ruleId).toBe("rule-one");
    }
    if (provider === "aliyun" && kind === "swas") {
      const row = dialog.getByRole("row").filter({ hasText: "192.0.2.0/24" });
      await row.getByRole("button", { name: "修改", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "修改入方向规则", exact: true });
      await expect(edit.getByRole("button", { name: "拒绝", exact: true })).toHaveCount(0);
      await expect(edit.locator(".security-fixed-value").last()).toContainText("仅支持允许策略");
      await expect(edit.getByLabel("源地址 1", { exact: true })).toHaveValue("192.0.2.0/24");
      await edit.getByLabel("端口范围", { exact: true }).fill("8081");
      await edit.getByLabel("描述", { exact: true }).fill("Updated SWAS rule");
      await edit.getByRole("button", { name: "确定", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
      await expect(edit).toHaveCount(0);
      const update = await page.evaluate(() => (window as any).securityCalls.at(-1));
      expect(update.command).toBe("modify_light_firewall_rule");
      expect(update.args).toMatchObject({ ruleId: "rule-one", original: { ports: "22/22", source: "192.0.2.0/24" }, updated: { ports: "8081/8081", source: "192.0.2.0/24", description: "Updated SWAS rule" } });
    }
    if (provider === "tencent" && kind === "swas") {
      const row = dialog.getByRole("row").filter({ hasText: "192.0.2.0/24" });
      await expect(row.getByRole("button", { name: "修改", exact: true })).toBeEnabled();
      await row.getByRole("button", { name: "修改", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "修改入方向规则", exact: true });
      await expect(edit.getByRole("button", { name: "ICMPv6", exact: true })).toBeDisabled();
      await expect(edit.getByRole("button", { name: "拒绝", exact: true })).toBeDisabled();
      await expect(edit.getByLabel("端口范围", { exact: true })).toBeDisabled();
      await expect(edit.getByLabel("源地址 1", { exact: true })).toBeDisabled();
      await edit.getByLabel("描述", { exact: true }).fill("Updated Lighthouse description");
      await edit.getByRole("button", { name: "确定", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
      await expect(edit).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).securityCalls.at(-1))).toMatchObject({ command: "update_light_firewall_rule_description", args: { description: "Updated Lighthouse description", firewallVersion: 9, firewallRule: { Protocol: "TCP" } } });
      await row.getByRole("button", { name: "删除", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
      const removal = await page.evaluate(() => (window as any).securityCalls.at(-1));
      expect(removal.command).toBe("delete_light_firewall_rule");
      expect(removal.args.firewallRule).toMatchObject({ Protocol: "TCP", CidrBlock: "192.0.2.0/24" });
      expect(removal.args.firewallRule).not.toHaveProperty("Ipv6CidrBlock");
      await expect(row).toHaveCount(0);
      await expect(dialog).not.toContainText("Updated Lighthouse description");
    }
    if (provider === "volcengine") {
      const first = dialog.getByRole("row").filter({ hasText: "192.0.2.0/24" });
      await first.getByRole("button", { name: "修改", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "修改入方向规则", exact: true });
      await expect(edit.getByLabel("优先级", { exact: true })).toHaveValue("5");
      await expect(edit.getByLabel("源地址 1", { exact: true })).toHaveValue("192.0.2.0/24");
      await edit.getByLabel("端口范围", { exact: true }).fill("8080");
      await edit.getByLabel("优先级", { exact: true }).fill("42");
      await edit.getByRole("button", { name: "拒绝", exact: true }).click();
      await edit.getByRole("button", { name: "确定", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
      expect(await page.evaluate(() => (window as any).securityCalls.length)).toBe(2);
      await page.evaluate(() => { (window as any).failSecurityUpdate = true; });
      await edit.getByRole("button", { name: "确定", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
      await expect(edit.getByRole("alert")).toContainText("模拟权限不足");
      await expect(edit.getByLabel("端口范围", { exact: true })).toHaveValue("8080");
      await edit.getByRole("button", { name: "确定", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
      await expect(edit).toHaveCount(0);
      const calls = await page.evaluate(() => (window as any).securityCalls);
      expect(calls.at(-1)).toMatchObject({ command: "update_volc_security_group_rule", args: { instanceId: "i-example", securityGroupId: "sg-example", securityGroupRuleId: "rule-one", original: { ports: "22/22", policy: "accept", priority: 5 }, updated: { ports: "8080/8080", policy: "drop", priority: 42 } } });
      expect(calls).toHaveLength(3);
      for (const [source, family, priority] of [["::/0", "IPv6", 5], ["sg-other", "安全组", 100]] as const) {
        const row = dialog.getByRole("row").filter({ hasText: source });
        for (const name of ["修改", "复制", "删除"]) await expect(row.getByRole("button", { name, exact: true })).toBeEnabled();
        await row.getByRole("button", { name: "修改", exact: true }).click();
        const specialEdit = page.getByRole("dialog", { name: "修改入方向规则", exact: true });
        await expect(specialEdit.getByLabel("源地址类型 1", { exact: true })).toHaveValue(family);
        await expect(specialEdit.getByLabel("源地址 1", { exact: true })).toHaveValue(source);
        await specialEdit.getByLabel("描述", { exact: true }).fill("Updated rule");
        await specialEdit.getByRole("button", { name: "确定", exact: true }).click();
        if (family === "IPv6") await expect(page.getByRole("alertdialog")).toContainText("替换原规则");
        await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
        await expect(specialEdit).toHaveCount(0);
        expect(await page.evaluate(() => (window as any).securityCalls.at(-1))).toMatchObject({ command: "update_volc_security_group_rule", args: { original: { source, priority }, updated: { source, priority, description: "Updated rule" } } });
        await row.getByRole("button", { name: "复制", exact: true }).click();
        const specialCopy = page.getByRole("dialog", { name: "复制入方向规则", exact: true });
        await expect(specialCopy.getByLabel("源地址类型 1", { exact: true })).toHaveValue(family);
        await expect(specialCopy.getByLabel("优先级", { exact: true })).toHaveValue(String(priority));
        const copiedSource = family === "IPv6" ? "2001:db8:1::/64" : "sg-copy";
        await specialCopy.getByLabel("源地址 1", { exact: true }).fill(copiedSource);
        await specialCopy.getByRole("button", { name: "确定", exact: true }).click();
        await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
        await expect(specialCopy).toHaveCount(0);
        expect(await page.evaluate(() => (window as any).securityCalls.at(-1))).toMatchObject({ command: "authorize_volc_security_group_rule", args: { sourceCidrIp: copiedSource, priority } });
        await row.getByRole("button", { name: "删除", exact: true }).click();
        await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as any).securityCalls.filter((call: any) => call.command === "revoke_volc_security_group_rule").at(-1)?.args)).toMatchObject({ sourceCidrIp: source, priority });
      }
    }
    await dialog.getByRole("tab", { name: "出方向规则", exact: true }).click();
    await expect(dialog).toContainText("尚未接入出方向写操作");
    await expect(dialog.getByRole("button", { name: "添加规则", exact: true })).toBeDisabled();
    await dialog.getByRole("tab", { name: "入方向规则", exact: true }).click();
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 980 });
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    if (kind === "ecs" && ["aliyun", "tencent"].includes(provider)) await dialog.screenshot({ path: `test-results/security-rule-list-${provider}.png` });
  });
}
