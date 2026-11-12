import { expect, test } from "@playwright/test";

test("Cloudflare account assets, DNS proxy, and guarded cloud deletion", async ({ page }) => {
  await page.addInitScript(() => {
    const account = { id: 97, account_name: "fixture-cloudflare", cloud_type: "cloudflare", access_key_id: "a".repeat(32), enabled: true, sort_order: 0, created_at: 1, updated_at: 1 };
    const assets = [
      { account_id: 97, resource_type: "domain", asset_key: "example.test", payload: { Id: "b".repeat(32), id: "b".repeat(32), Name: "example.test", name: "example.test", DomainName: "example.test", Status: "active", status: "active", _region_id: "global", paused: false, type: "full", created_on: "2026-03-29T11:32:04Z", modified_on: "2026-03-29T12:11:10Z", metadata: { source: "fixture" } }, fetched_at: 1 },
      { account_id: 97, resource_type: "workers", asset_key: "demo-worker", payload: { Id: "demo-worker", Name: "demo-worker" }, fetched_at: 1 },
      { account_id: 97, resource_type: "oss", asset_key: "demo-bucket", payload: { Id: "demo-bucket", Name: "demo-bucket" }, fetched_at: 1 },
      { account_id: 97, resource_type: "pages", asset_key: "demo-page", payload: { Id: "c".repeat(32), Name: "demo-page" }, fetched_at: 1 },
      { account_id: 97, resource_type: "tunnel", asset_key: "demo-tunnel", payload: { Id: "00000000-0000-4000-8000-000000000001", Name: "demo-tunnel", Status: "down" }, fetched_at: 1 },
    ];
    (window as any).cfCalls = [];
    (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any) => {
      (window as any).cfCalls.push({ command, args });
      if (command === "list_accounts") return [account];
      if (command === "list_local_assets") return assets;
      if (command === "list_client_preferences") return {};
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      if (command === "sync_cloud_assets") return { fetched: 5, errors: [], counts: {} };
      if (command === "cloudflare_manage") {
        if (args.action === "dns_list") return { items: [{ id: "d".repeat(32), type: "A", name: "example.test", content: "192.0.2.1", ttl: 1, proxied: false, proxiable: true }] };
        return { success: true };
      }
      return [];
    } };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "账号管理", exact: true }).click();
  await page.getByRole("button", { name: "添加云账号", exact: true }).click();
  const add = page.getByRole("dialog").last();
  await add.getByRole("combobox", { name: "云类型", exact: true }).selectOption("cloudflare");
  await expect(add.getByLabel("Account ID", { exact: true })).toBeVisible();
  await expect(add.getByRole("link", { name: /创建 Cloudflare API Token/ })).toBeVisible();
  await add.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "打开 fixture-cloudflare 资产汇总", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "fixture-cloudflare · Cloudflare 资产管理", exact: true });
  await expect(manager).toContainText("example.test");
  await page.mouse.click(1, 1);
  await expect(manager).toBeVisible();
  await manager.getByRole("button", { name: "详情", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Cloudflare 资产详情", exact: true });
  await expect(detail.getByRole("heading", { name: "example.test", exact: true })).toBeVisible();
  await expect(detail).toContainText("正常");
  await expect(detail.locator("dd").filter({ hasText: /^b{32}$/ })).toHaveCount(1);
  await expect(detail).toContainText("完整接入");
  await expect(detail.getByText("metadata", { exact: true })).toBeHidden();
  await detail.locator("summary").click();
  await expect(detail).toContainText('"source": "fixture"');
  await detail.locator("summary").click();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await detail.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    const box = await detail.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    expect(box!.width).toBeLessThanOrEqual(720);
  }
  await detail.screenshot({ path: "test-results/cloudflare-asset-detail.png" });
  await page.mouse.click(1, 1);
  await expect(detail).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await manager.getByRole("button", { name: "DNS 管理", exact: true }).click();
  const dns = page.getByRole("dialog", { name: "example.test · DNS 管理", exact: true });
  await expect(dns).toContainText("192.0.2.1");
  await dns.getByRole("button", { name: "开启代理", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => (window as any).cfCalls.some((c: any) => c.args?.action === "dns_proxy"))).toBe(false);
  await dns.getByRole("button", { name: "添加记录", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "添加 DNS 记录", exact: true });
  await editor.getByLabel("内容", { exact: true }).fill("192.0.2.2");
  await editor.getByRole("button", { name: "保存到 Cloudflare", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
  await expect(editor).toBeHidden();
  expect(await page.evaluate(() => (window as any).cfCalls.find((c: any) => c.args?.action === "dns_save").args.input.content)).toBe("192.0.2.2");
  await dns.getByRole("button", { name: "关闭", exact: false }).first().click();
  await manager.getByRole("button", { name: "Workers (1)", exact: true }).click();
  await manager.getByRole("button", { name: "删除云端资源", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("无法通过本地回收站恢复");
  await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => (window as any).cfCalls.some((c: any) => c.args?.action === "delete_resource"))).toBe(false);
  await expect(manager.getByRole("textbox", { name: "搜索 Cloudflare 资产" })).toHaveCSS("border-top-width", "0px");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await manager.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    await expect(manager.getByRole("button", { name: "同步全部资产", exact: true })).toBeVisible();
  }
  await manager.screenshot({ path: "test-results/cloudflare-manager.png" });
});
