import { expect, type Page } from "@playwright/test";

export async function supplierFixture(page: Page) {
  await page.addInitScript(() => {
    let profiles = Array.from({ length: 11 }, (_, index) => ({
      id: `supplier-${index + 1}`, name: `供应商 ${index + 1}`, protocol: index === 10 ? "claude" : "openai_chat",
      baseUrl: "https://example.test/v1", model: `model-${index + 1}`, models: [`model-${index + 1}`], enabled: true, isDefault: index === 0,
      timeoutSeconds: 60, maxOutputTokens: 2048, allowLoopbackHttp: false, hasKey: true, updatedAt: 1, visionStatus: "unknown",
    }));
    const state = window as any;
    state.supplierReveals = 0;
    state.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string, args: any = {}) => {
        if (command === "member_me") return null;
        if (command === "monitor_alerts_snapshot") return { alerts: [], checkedAt: 0, lastError: null };
        if (command === "plugin:event|listen") return 1;
        if (command === "plugin:app|version") return "0.1.137";
        if (command === "list_client_preferences") return {};
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "ai_list_profiles") return structuredClone(profiles);
        if (command === "ai_save_profile") {
          if (state.supplierSaveFails) throw new Error("保存失败，请重试");
          const { apiKey: _secret, ...input } = args.input;
          const result = { ...input, id: input.id || "supplier-new", hasKey: true, updatedAt: 2, visionStatus: "unknown" };
          profiles = [...profiles.filter(profile => profile.id !== result.id), result];
          return result;
        }
        if (command === "ai_delete_profile") {
          if (state.supplierDeleteFails) throw new Error("删除失败，请重试");
          profiles = profiles.filter(profile => profile.id !== args.id);
          return;
        }
        if (command === "ai_run") {
          if (state.supplierTest404) throw { code: "ai", message: "AI接口不存在（HTTP 404），请检查服务地址和接口协议" };
          return { requestId: args.input.requestId, draft: { summary: "连接可用", fields: {}, items: [], warnings: [], evidence: [] }, inputTokens: 1, outputTokens: 1 };
        }
        if (command === "ai_reveal_key") { state.supplierReveals++; return crypto.randomUUID(); }
        if (command === "codex_get_state") return { accounts: [], cliAvailable: true, desktopAvailable: true, profileHome: "C:/fixture", currentAccountId: null, canRestore: false };
        if (command === "codex_gateway_state") return { running: false, accountIds: [], startupAccountIds: [], completed: 0, failed: 0, active: 0 };
        if (command === "codex_config_source") return { path: "C:/fixture/config.toml", workspace: null, exists: true };
        if (command === "claude_provider_list") return { providers: [], currentId: null, settingsPath: "C:/fixture/settings.json", settingsExists: false, hasBackup: false, backups: [] };
        if (command === "claude_workspace_state") return { project: null, settingsPath: "C:/fixture/settings.json", mcpPath: "C:/fixture/.claude.json", promptPath: "C:/fixture/CLAUDE.md", mcp: [], prompts: [], skills: [], sessions: [], environmentConflicts: [] };
        return [];
      },
    };
  });
}

export async function openSuppliers(page: Page, mobile = false) {
  await page.goto("/");
  await (mobile ? page.locator(".mobile-tab-bar") : page).getByRole("button", { name: "软件商店", exact: true }).first().click();
  await page.getByRole("searchbox").fill("模型供应商");
  await page.locator('[data-plugin-entry="cloudhub.model-suppliers"]').click();
  await expect(page.locator(".ai-supplier-manager")).toBeVisible();
}

export async function exerciseSuppliers(page: Page) {
  const manager = page.locator(".ai-supplier-manager");
  await expect(manager.locator(".ai-profile")).toHaveCount(10);
  await manager.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(manager.locator(".ai-profile")).toHaveCount(1);
  await manager.getByRole("row", { name: "模型供应商 供应商 11", exact: true }).getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑模型供应商", exact: true });
  await editor.getByLabel("配置名称").fill("手机与桌面共用供应商");
  await expect(editor.getByLabel("API Key", { exact: true })).toHaveValue("");
  await page.evaluate(() => { (window as any).supplierSaveFails = true; });
  await editor.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(editor).toContainText("保存失败");
  await page.evaluate(() => { (window as any).supplierSaveFails = false; });
  await editor.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await manager.getByLabel("搜索模型供应商", { exact: true }).fill("共用供应商");
  await expect(manager.locator(".ai-profile")).toHaveCount(1);
  await manager.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(manager.getByRole("status")).toContainText("测试通过");
  await manager.getByRole("button", { name: "删除模型供应商 手机与桌面共用供应商", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "删除模型供应商", exact: true });
  await page.evaluate(() => { (window as any).supplierDeleteFails = true; });
  await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toContainText("删除失败");
  await page.evaluate(() => { (window as any).supplierDeleteFails = false; });
  await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(manager).toContainText("没有匹配的模型供应商");
  await manager.getByLabel("搜索模型供应商", { exact: true }).fill("");
  await manager.getByLabel("筛选模型供应商协议").selectOption("claude");
  await expect(manager.locator(".ai-profile")).toHaveCount(0);
  await manager.getByLabel("筛选模型供应商协议").selectOption("");
  await expect(manager.locator(".ai-profile")).toHaveCount(10);
  await manager.getByRole("button", { name: "添加模型供应商", exact: true }).click();
  const add = page.getByRole("dialog", { name: "添加模型供应商", exact: true });
  await add.getByLabel("配置名称").fill("新增供应商");
  await add.getByLabel("API Key", { exact: true }).fill(crypto.randomUUID());
  await add.getByLabel("模型名称", { exact: true }).fill("model-new");
  await add.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(add).toHaveCount(0);
  await manager.getByLabel("搜索模型供应商", { exact: true }).fill("新增供应商");
  await expect(manager.locator(".ai-profile")).toHaveCount(1);
}
