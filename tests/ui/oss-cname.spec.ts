import { expect, test } from "@playwright/test";

for (const width of [375, 768, 1024, 1440]) {
  test(`native OSS cname workflow at ${width}px`, async ({ page }) => {
    await page.addInitScript(() => {
      let bound = false;
      let attempts = 0;
      (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      (window as any).cnameCalls = [];
      (window as any).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1, unregisterCallback: () => {},
        invoke: async (command: string, args: any) => {
          if (command === "authenticator_status") return { configured: false, unlocked: false };
          if (command === "list_client_preferences") return {};
          if (command === "list_accounts") return [{ id: 7, account_name: "测试账号", cloud_type: "aliyun", access_key_id: "fixture-id", group_name: "测试", enabled: true, sort_order: 0 }];
          if (command === "list_local_assets") return [{ account_id: 7, resource_type: "oss", asset_key: "fixture-bucket", fetched_at: 1, payload: { Name: "fixture-bucket", Location: "oss-cn-beijing" } }];
          if (command === "get_oss_acl") return "private";
          if (command === "get_oss_cnames") return bound ? [{ Domain: "img.sub.example.com", Status: "Enabled" }] : [];
          if (["create_oss_cname_token", "bind_oss_cname", "delete_oss_cname"].includes(command)) {
            (window as any).cnameCalls.push({ command, args });
            if (command === "create_oss_cname_token") return { domain: args.domain, token: "fixture-verification" };
            if (command === "bind_oss_cname") {
              if (attempts++ === 0) throw { code: "oss-cname", message: "请先获取验证 Token，并配置 TXT 记录；等待 DNS 生效后重试绑定" };
              bound = true;
            }
            if (command === "delete_oss_cname") bound = false;
            return;
          }
          return [];
        },
      };
    });
    await page.goto("/");
    await page.getByRole("button", { name: "资产管理", exact: true }).click();
    await page.getByRole("button", { name: "文件列表", exact: true }).click();
    await page.locator(".oss-object-dialog").getByRole("button", { name: /^关闭/ }).click();
    await page.getByRole("button", { name: "添加域名", exact: true }).click();
    await page.setViewportSize({ width, height: 900 });
    const dialog = page.getByRole("dialog", { name: "添加自定义域名", exact: true });
    await dialog.getByRole("textbox").fill("*.sub.example.com");
    await dialog.getByRole("button", { name: "获取验证 Token" }).click();
    await expect(dialog.getByRole("status")).toContainText("不能填写泛域名");
    expect(await page.evaluate(() => (window as any).cnameCalls)).toEqual([]);
    await dialog.getByRole("textbox").fill("img.sub.example.com");
    await dialog.getByRole("button", { name: "获取验证 Token" }).click();
    await expect(dialog.getByText("fixture-verification", { exact: true })).toBeVisible();
    await expect(dialog.getByText("_dnsauth.img.sub.example.com", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "绑定域名", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("等待 DNS 生效");
    await dialog.getByRole("button", { name: "绑定域名", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("域名已绑定");
    const calls = await page.evaluate(() => (window as any).cnameCalls);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ command: "create_oss_cname_token", args: { id: 7, bucket: "fixture-bucket", location: "oss-cn-beijing", domain: "img.sub.example.com" } });
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/oss-cname-${width}.png` });
    await page.mouse.click(2, 2);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator(".bucket-cname")).toContainText("img.sub.example.com");
  });
}
