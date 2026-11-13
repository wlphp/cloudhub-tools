import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
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
        if (args.action === "worker_template_deploy") {
          assets.push({ account_id: 97, resource_type: "workers", asset_key: args.input.name, payload: { Id: args.input.name, Name: args.input.name }, fetched_at: 1 });
          return { success: true, url: `https://${args.input.hostname}`, subscriptionUrl: `https://${args.input.hostname}/sub/test-fixture-path` };
        }
        if (args.action === "worker_create") {
          if (args.input.name === "old-backend") throw new Error("不支持的 Cloudflare 操作");
          if (args.input.name === "demo-worker") throw new Error("同名 Worker 已存在");
          if (args.input.name === "fail-worker") throw new Error("Cloudflare HTTP 403");
          assets.push({ account_id: 97, resource_type: "workers", asset_key: args.input.name, payload: { Id: args.input.name, Name: args.input.name }, fetched_at: 1 });
          return args.input.name === "partial-worker" ? { success: true, warning: "代码已部署，但 workers.dev 地址未就绪" } : { success: true, url: `https://${args.input.name}.example.workers.dev` };
        }
        if (args.action === "dns_list") return { items: [{ id: "d".repeat(32), type: "A", name: "example.test", content: "192.0.2.1", ttl: 1, proxied: false, proxiable: true }] };
        return { success: true };
      }
      return [];
    } };
  });
});

test("VLESS template requires domain selection and sends dynamic config without source or credentials", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "账号管理", exact: true }).click();
  await page.getByRole("button", { name: "打开 fixture-cloudflare 资产汇总", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "fixture-cloudflare · Cloudflare 资产管理", exact: true });
  await manager.getByRole("button", { name: "Workers (1)", exact: true }).click();
  await manager.getByRole("button", { name: "新建 Worker", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新建 Worker", exact: true });
  await editor.getByRole("combobox", { name: "部署模板", exact: true }).selectOption("vless");
  await expect(editor.getByRole("textbox", { name: "JavaScript 模块代码", exact: true })).toBeHidden();
  await expect(editor.getByLabel("子域名前缀", { exact: true })).toBeDisabled();
  await editor.getByRole("button", { name: "创建并部署", exact: true }).click();
  expect(await page.evaluate(() => (window as any).cfCalls.some((c: any) => c.args?.action === "worker_template_deploy"))).toBe(false);
  await editor.getByRole("combobox", { name: "选择域名", exact: true }).selectOption("b".repeat(32));
  await editor.getByLabel("子域名前缀", { exact: true }).fill("my-node");
  await editor.getByLabel("Worker 名称", { exact: true }).fill("my-vless");
  const thirdParty = editor.getByRole("checkbox");
  await expect(thirdParty).not.toBeChecked();
  await expect(editor).toContainText("https://my-node.example.test");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await editor.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await editor.screenshot({ path: "test-results/cloudflare-vless-template.png" });
  await editor.getByRole("button", { name: "创建并部署", exact: true }).click();
  await expect(editor.getByLabel("Clash / Mihomo 订阅地址", { exact: true })).toHaveValue("https://my-node.example.test/sub/test-fixture-path");
  const payload = await page.evaluate(() => (window as any).cfCalls.find((c: any) => c.args?.action === "worker_template_deploy").args.input);
  expect(payload).toEqual({ template: "vless", name: "my-vless", zoneId: "b".repeat(32), hostname: "my-node.example.test", thirdParty: false });
  await editor.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(manager).toContainText("my-vless");
});

test("Cloudflare account assets, DNS proxy, and guarded cloud deletion", async ({ page }) => {
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

test("Worker creation preserves drafts on failure and refreshes after deployment", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "账号管理", exact: true }).click();
  await page.getByRole("button", { name: "打开 fixture-cloudflare 资产汇总", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "fixture-cloudflare · Cloudflare 资产管理", exact: true });
  await manager.getByRole("button", { name: "Workers (1)", exact: true }).click();
  await manager.getByRole("button", { name: "新建 Worker", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新建 Worker", exact: true });
  await page.mouse.click(1, 1);
  await expect(editor).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  expect(await page.evaluate(() => (window as any).cfCalls.some((c: any) => c.args?.action === "worker_create"))).toBe(false);
  await manager.getByRole("button", { name: "新建 Worker", exact: true }).click();
  const name = editor.getByLabel("Worker 名称", { exact: true });
  const code = editor.getByRole("textbox", { name: "JavaScript 模块代码", exact: true });
  await name.fill("old-backend");
  await editor.getByRole("button", { name: "创建并部署", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("重新编译并重启");
  await expect(editor.getByRole("alert")).not.toContainText("确认云端状态");
  await name.fill("demo-worker");
  await editor.getByRole("button", { name: "创建并部署", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("同名");
  await expect(code).toHaveValue(/export default/);
  await name.fill("fail-worker");
  await editor.getByRole("button", { name: "创建并部署", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("403");
  await expect(editor.getByRole("alert")).not.toContainText("确认云端状态");
  await expect(code).toHaveValue(/export default/);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await editor.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await editor.screenshot({ path: "test-results/cloudflare-worker-create.png" });
  await name.fill("new-worker");
  await editor.getByRole("button", { name: "创建并部署", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("已创建并部署");
  await expect(editor.getByLabel("Worker 访问地址")).toHaveValue("https://new-worker.example.workers.dev");
  await expect(editor.getByRole("button", { name: "创建并部署", exact: true })).toBeHidden();
  await editor.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(manager).toContainText("new-worker");
  await manager.getByRole("button", { name: "新建 Worker", exact: true }).click();
  await editor.getByLabel("Worker 名称", { exact: true }).fill("partial-worker");
  await editor.getByRole("button", { name: "创建并部署", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("地址未就绪");
  await expect(editor.getByRole("button", { name: "创建并部署", exact: true })).toBeHidden();
});
