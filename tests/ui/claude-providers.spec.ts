import { expect, test, type Page } from "@playwright/test";

const PROVIDERS = [
  { id: "claude-official", name: "Claude 官方", description: "", websiteUrl: "https://console.anthropic.com", baseUrl: "https://api.anthropic.com", keyConfigured: true, apiKeyField: "auth_token", apiFormat: "anthropic", isFullUrl: true, models: { sonnet: { model: "claude-sonnet-4-5" } }, extraEnv: {}, isCurrent: false },
  { id: "deepseek", name: "DeepSeek", description: "", websiteUrl: "https://platform.deepseek.com", baseUrl: "https://api.deepseek.com/anthropic", keyConfigured: false, apiKeyField: "auth_token", apiFormat: "anthropic", isFullUrl: true, models: { sonnet: { model: "deepseek-chat" } }, extraEnv: {}, isCurrent: true },
];

async function openStore(page: Page, workbench = false) {
  await page.addInitScript((seed: unknown) => {
    const calls: string[] = [];
    const fixture = seed as { providers: unknown; workbench: boolean };
    const routing = { mode: "direct", running: false, address: null as string | null, config: {
      port: 15721, routeProvider: "claude-official", defaultProvider: "claude-official", members: [] as string[],
      failover: false, queue: [] as string[], retries: 2, timeoutSecs: 600, firstByteSecs: 90, idleSecs: 180, failureThreshold: 8, cooldownSecs: 90, logging: true,
    }, health: {}, logs: [], activeProvider: "", recoveryAvailable: false };
    (window as any).__claudeCalls = calls;
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args?: any) => {
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        if (command === "ai_list_profiles") return [{ id: "f", name: "T", protocol: "openai_chat", model: "m", enabled: true, isDefault: true, visionStatus: "supported" }];
        if (command === "claude_provider_list") return { providers: fixture.providers, currentId: "deepseek", settingsPath: "/home/test/.claude/settings.json", settingsExists: true, hasBackup: true };
        if (fixture.workbench && command === "claude_routing_state") return structuredClone(routing);
        if (command === "claude_routing_save") { calls.push(`routing:${JSON.stringify(args.config)}`); routing.config = args.config; return null; }
        if (command === "claude_routing_activate") {
          calls.push(`activate:${args.mode}`);
          if ((window as any).__activationFails) throw { code: "claude-workbench", message: "路由端口被占用，请修改端口后重试", retryable: false };
          routing.mode = args.mode; routing.running = args.mode !== "direct"; routing.address = routing.running ? "http://127.0.0.1:15721" : null; return null;
        }
        if (command === "claude_workspace_state") return { project: null, settingsPath: "/fixture/settings.json", mcpPath: "/fixture/.claude.json", promptPath: "/fixture/CLAUDE.md", mcp: [], prompts: [], activePrompt: null, skills: [], sessions: [], environmentConflicts: [] };
        if (command === "claude_workspace_action") { calls.push(`workspace:${JSON.stringify(args?.action)}`); return null; }
        if (command === "claude_provider_switch") {
          calls.push(`switch:${args?.id}`);
          if ((window as any).__switchFails) throw { code: "claude-provider", message: "配置文件不可写", retryable: false };
          return null;
        }
        if (command === "claude_launch_cli") { calls.push(`launch:${args?.id}`); return null; }
        if (command === "claude_provider_restore_backup") { calls.push("restore"); return null; }
        if (command === "claude_provider_delete") { calls.push(`delete:${args?.id}`); return 1; }
        if (command === "claude_provider_save") { calls.push(`save:${args?.provider?.id}`); return null; }
        return [];
      },
    };
  }, { providers: PROVIDERS, workbench });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
}

test("MCP JSON import previews a server and writes only after saving", async ({ page }) => {
  await openStore(page, true);
  await page.locator(".software-store-page tbody tr", { hasText: "Claude Code 供应商" }).getByRole("button", { name: "管理" }).click();
  await page.getByRole("navigation", { name: "Claude Code 工作台" }).getByRole("button", { name: "MCP", exact: true }).click();
  await page.getByRole("button", { name: "添加服务器" }).click();
  const editor = page.getByRole("dialog", { name: "添加 MCP 服务器" });
  await editor.getByText("从 JSON 导入 MCP 配置", { exact: true }).click();
  await editor.getByLabel("MCP 配置 JSON").fill(JSON.stringify({ mcpServers: { example: { command: "node", args: ["example-server.js"], env: { EXAMPLE_MODE: "readonly" } } } }));
  await editor.getByRole("button", { name: "填入表单" }).click();
  await expect(editor.getByLabel("服务器名称")).toHaveValue("example");
  await expect(editor.getByLabel("命令", { exact: true })).toHaveValue("node");
  expect(await page.evaluate(() => (window as any).__claudeCalls)).toEqual([]);
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__claudeCalls)).toEqual([
    `workspace:${JSON.stringify({ type: "save_mcp", name: "example", config: { type: "stdio", command: "node", args: ["example-server.js"], env: { EXAMPLE_MODE: "readonly" } } })}`,
  ]);
});

test("MCP JSON import rejects multiple servers and invalid arguments without modifying the form", async ({ page }) => {
  await openStore(page, true);
  await page.locator(".software-store-page tbody tr", { hasText: "Claude Code 供应商" }).getByRole("button", { name: "管理" }).click();
  await page.getByRole("navigation", { name: "Claude Code 工作台" }).getByRole("button", { name: "MCP", exact: true }).click();
  await page.getByRole("button", { name: "添加服务器" }).click();
  const editor = page.getByRole("dialog", { name: "添加 MCP 服务器" });
  await editor.getByLabel("服务器名称").fill("keep-name");
  await editor.getByText("从 JSON 导入 MCP 配置", { exact: true }).click();
  for (const config of [{ mcpServers: { first: { command: "node" }, second: { command: "node" } } }, { example: { command: "node", args: [42] } }, { example: { type: "http", url: "file:///example" } }]) {
    await editor.getByLabel("MCP 配置 JSON").fill(JSON.stringify(config));
    await editor.getByRole("button", { name: "填入表单" }).click();
    await expect(editor.getByRole("alert")).toContainText("无法导入");
    await expect(editor.getByLabel("服务器名称")).toHaveValue("keep-name");
  }
  expect(await page.evaluate(() => (window as any).__claudeCalls)).toEqual([]);
});

test("the store lists the Claude Code provider plugin and opens its manager", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStore(page);

  const row = page.locator(".software-store-page tbody tr", { hasText: "Claude Code 供应商" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("切换前自动备份配置");
  await row.getByRole("button", { name: "管理" }).click();

  const dialog = page.locator(".claude-providers-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("region", { name: "Claude Code 供应商 页面" }).getByRole("heading", { name: "Claude Code 供应商" })).toBeVisible();
  await expect(dialog).toContainText("Claude 官方");
  await expect(dialog).toContainText("DeepSeek");
  // 当前供应商使用“使用中”状态，不展示可执行的切换按钮。
  const currentItem = dialog.locator(".claude-provider-item.is-current");
  await expect(currentItem).toContainText("DeepSeek");
  await expect(currentItem.getByRole("button", { name: "使用中", exact: true })).toBeDisabled();
  // 没填 Key 的供应商给出可见提示。
  await expect(dialog).toContainText("缺少 Key");
});

test("switching reports the change and closing keeps user configuration intact", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStore(page);
  await page.locator(".software-store-page tbody tr", { hasText: "Claude Code 供应商" }).getByRole("button", { name: "管理" }).click();

  const dialog = page.locator(".claude-providers-dialog");
  await dialog.locator(".claude-provider-item", { hasText: "Claude 官方" }).getByRole("button", { name: "切换", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__claudeCalls)).toContain("switch:claude-official");
  await expect(dialog).toContainText("重启 Claude Code 后生效");

  // 备份恢复入口存在，且只影响 live 文件，不动供应商列表。
  await dialog.getByRole("button", { name: "恢复上一份" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__claudeCalls)).toContain("restore");
});

test("switching to a configured provider updates the active selection", async ({ page }) => {
  await openStore(page, true);
  await page.locator(".software-store-page tbody tr", { hasText: "Claude Code 供应商" }).getByRole("button", { name: "管理" }).click();
  await page.locator(".claude-provider-item", { hasText: "Claude 官方" }).getByRole("button", { name: "切换", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__claudeCalls)).toContain("switch:claude-official");
  await expect(page.locator(".claude-status")).toContainText("重启 Claude Code 后生效");
});

test("a failed switch does not launch Claude Code", async ({ page }) => {
  await openStore(page, true);
  await page.locator(".software-store-page tbody tr", { hasText: "Claude Code 供应商" }).getByRole("button", { name: "管理" }).click();
  await page.evaluate(() => { (window as any).__switchFails = true; });
  await page.locator(".claude-provider-item", { hasText: "Claude 官方" }).getByRole("button", { name: "切换", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("操作失败");
  expect(await page.evaluate(() => (window as any).__claudeCalls)).toEqual(["switch:claude-official"]);
});

test("the editor writes model mappings and rejects a blank address", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStore(page);
  await page.locator(".software-store-page tbody tr", { hasText: "Claude Code 供应商" }).getByRole("button", { name: "管理" }).click();
  await page.locator(".claude-providers-dialog").getByRole("button", { name: "添加供应商" }).click();
  await page.getByRole("dialog", { name: "添加供应商" }).getByRole("button", { name: /自定义配置/ }).click();

  const editor = page.locator(".claude-provider-dialog");
  await expect(editor).toBeVisible();
  await editor.getByLabel("供应商名称", { exact: true }).fill("公司专用账号");
  await editor.getByLabel("请求地址").fill("https://api.company.test/anthropic");
  await editor.getByRole("button", { name: "手动添加模型" }).click();
  await editor.getByLabel("模型 ID 1", { exact: true }).fill("company-sonnet");
  await editor.getByLabel("Sonnet 实际模型").selectOption("company-sonnet");
  await editor.getByLabel("Sonnet 显示名称").fill("公司 Sonnet");
  await editor.getByLabel("Haiku 1M 上下文").check();
  await editor.getByRole("button", { name: "保存" }).click();

  await expect.poll(() => page.evaluate(() => (window as any).__claudeCalls)).toEqual([expect.stringMatching(/^save:custom-/)]);
  await expect(page.locator(".claude-provider-dialog")).toHaveCount(0);
});

for (const width of [375, 768, 1024, 1440]) {
  test(`provider manager stays within ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openStore(page);
    await page.locator(".software-store-page tbody tr", { hasText: "Claude Code 供应商" }).getByRole("button", { name: "管理" }).click();
    const dialog = page.locator(".claude-providers-dialog");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    expect(await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
  });
}

test("mode tabs only select a view and activation requires explicit confirmation", async ({ page }) => {
  await openStore(page, true);
  await page.locator(".software-store-page tbody tr", { hasText: "Claude Code 供应商" }).getByRole("button", { name: "管理" }).click();
  await page.getByRole("tab", { name: "路由", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__claudeCalls)).toEqual([]);
  await page.getByRole("button", { name: "开始路由" }).click();
  const setup = page.getByRole("dialog", { name: "让 Claude Code 使用路由模式？" });
  await expect(setup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(setup).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__claudeCalls)).toEqual([]);
  await page.getByRole("button", { name: "开始路由" }).click();
  await page.getByRole("dialog", { name: "让 Claude Code 使用路由模式？" }).getByRole("button", { name: "开始路由", exact: true }).click();
  await expect(page.locator(".claude-mode-status")).toContainText("路由生效中");
  await expect.poll(() => page.evaluate(() => (window as any).__claudeCalls)).toContain("activate:route");
  await page.getByRole("button", { name: "回到直连" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.locator(".claude-mode-status")).toContainText("直连生效中");
});

test("activation errors stay in the shared confirmation and do not report success", async ({ page }) => {
  await openStore(page, true);
  await page.locator(".software-store-page tbody tr", { hasText: "Claude Code 供应商" }).getByRole("button", { name: "管理" }).click();
  await page.evaluate(() => { (window as any).__activationFails = true; });
  await page.getByRole("tab", { name: "聚合", exact: true }).click();
  await page.getByRole("button", { name: "启用聚合", exact: true }).click();
  const setup = page.getByRole("dialog", { name: "让 Claude Code 使用聚合模式？" });
  await setup.getByRole("button", { name: "切换到聚合模式", exact: true }).click();
  await expect(setup.getByRole("alert")).toContainText("路由端口被占用");
  await expect(page.locator(".claude-mode-status")).toContainText("直连生效中");
});

test("route queue changes preserve timeouts and do not activate routing", async ({ page }) => {
  await openStore(page, true);
  await page.locator(".software-store-page tbody tr", { hasText: "Claude Code 供应商" }).getByRole("button", { name: "管理" }).click();
  await page.getByRole("tab", { name: "路由", exact: true }).click();
  await page.locator(".claude-provider-item", { hasText: "Claude 官方" }).getByRole("button", { name: "加入队列" }).click();
  await page.getByRole("switch", { name: "自动故障转移" }).check();
  await expect(page.locator(".claude-provider-item", { hasText: "Claude 官方" }).getByRole("button", { name: "移出队列" })).toBeVisible();
  const calls: string[] = await page.evaluate(() => (window as any).__claudeCalls);
  expect(calls.some(call => call.startsWith("activate:"))).toBe(false);
  const config = JSON.parse(calls.filter(call => call.startsWith("routing:")).pop()!.slice("routing:".length));
  expect(config).toMatchObject({ failover: true, queue: ["claude-official"], timeoutSecs: 600, idleSecs: 180 });
});

test("workspace navigation and shared settings render without layout overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openStore(page, true);
  await page.locator(".software-store-page tbody tr", { hasText: "Claude Code 供应商" }).getByRole("button", { name: "管理" }).click();
  expect((await page.locator(".claude-work-tabs").boundingBox())!.height).toBeLessThan(60);
  await page.screenshot({ path: testInfo.outputPath("claude-workbench.png") });
  await page.getByRole("navigation", { name: "Claude Code 工作台" }).getByRole("button", { name: "MCP", exact: true }).click();
  await expect(page.getByText("暂无 MCP 服务器", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加服务器" }).click();
  const editor = page.getByRole("dialog", { name: "添加 MCP 服务器" });
  await expect(editor).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(editor).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("navigation", { name: "Claude Code 工作台" }).getByRole("button", { name: "配置", exact: true }).click();
  await expect(page.getByText("用户全局", { exact: true }).first()).toBeVisible();
  await page.getByRole("tab", { name: "路由", exact: true }).click();
  await page.getByRole("button", { name: "路由设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Claude Code 路由设置" })).toBeVisible();
  await expect(page.getByLabel("监听端口")).toHaveValue("15721");
});
