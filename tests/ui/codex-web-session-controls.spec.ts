import { test, expect } from "@playwright/test";

test("Web Session accounts expose benefits, reset and API pool controls", async ({ page }) => {
  await page.addInitScript(() => {
    const account = {
      id: 1, label: "web-session@example.test", email: "web-session@example.test", accountId: "workspace-web", userId: "display-user", loginProvider: "openai", workspaceName: null,
      authMode: "chatgpt", isWebSession: true, plan: "plus", note: "", tags: [], lastError: null, updatedAt: 1, proxyUrl: null,
      quota: { fetchedAt: 1_791_620_000_000, windows: [{ name: "codex", usedPercent: 30, windowMinutes: 300, resetsAt: 1_791_700_000 }] },
      benefits: { expiresAt: null, resetCredits: null, resetExpiresAt: null, resetCards: [], fetchedAt: null, subscriptionError: null, creditsError: null },
    };
    let gateway = {
      running: false, address: null, accountIds: [], completed: 0, failed: 0, active: 0, supportsCustomKey: true, supportsModels: true, supportsRemoteModels: true,
      supportsPersistentConfig: true, supportsConfigSave: true, supportsKeyReveal: true, supportsAutoStart: true, supportsPoolPersistence: true,
      supportsLanAccess: true, supportsShareConfig: true, lanAddress: null, allowLan: false, listeningLan: false, supportsFunctionTools: true,
      supportsMultiProtocol: true, autoStart: false, startupAccountIds: [], startupError: null, configuredPort: 58169,
      settings: { loggingEnabled: false, strategy: "round_robin", cooldownSeconds: 60 },
    };
    const calls: string[] = [];
    Object.assign(window, { __webSessionCalls: calls, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {}, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: { id?: number; accountIds?: number[]; key?: string; port?: number; settings?: { loggingEnabled: boolean; strategy: string; cooldownSeconds: number } }) => {
        if (command === "list_client_preferences") return {};
        if (command === "list_codex_accounts") return [account];
        if (command === "codex_state") return { accounts: [account], cliAvailable: true, desktopAvailable: true, canOpenDefault: true, profileHome: "C:\\fixture\\.codex", currentAccountId: null, canRestore: false };
        if (command === "codex_get_state") return { accounts: [account], cliAvailable: true, desktopAvailable: true, canOpenDefault: true, profileHome: "C:\\fixture\\.codex", currentAccountId: null, canRestore: false };
        if (command === "codex_gateway_state") return gateway;
        if (command === "codex_refresh_quota") { calls.push(command); return account; }
        if (command === "codex_refresh_benefits") { calls.push(command); account.benefits = { expiresAt: 1893456000, resetCredits: 2, resetExpiresAt: 1893456000, resetCards: [], fetchedAt: Date.now(), subscriptionError: null, creditsError: null }; return account; }
        if (command === "codex_consume_reset") { calls.push(command); return account; }
        if (command === "codex_gateway_save_pool") { calls.push(command); gateway = { ...gateway, startupAccountIds: args.accountIds ?? [] }; return gateway; }
        if (command === "codex_gateway_configure") { gateway = { ...gateway, settings: args.settings ?? gateway.settings }; return gateway; }
        if (command === "codex_gateway_save_port") { gateway = { ...gateway, configuredPort: args.port ?? gateway.configuredPort }; return gateway; }
        if (command === "codex_gateway_models") return [];
        if (command === "codex_detect_proxies") return [];
        if (command === "codex_remote_logs" || command === "codex_gateway_logs") return { enabled: false, logs: [] };
        if (command === "codex_list_instances" || command === "list_codex_instances") return [];
        if (command === "codex_tunnel_state") return {};
        if (command === "plugin:app|version") return "0.1.91";
        if (command === "plugin:updater|check") return null;
        if (command === "plugin:event|listen") return 1;
        return [];
      },
    } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  const card = page.getByRole("article", { name: "Codex 账号 web-session@example.test", exact: true });
  await expect(card.getByRole("button", { name: "查看 web-session@example.test 重置次数" })).toHaveText("重置 未获取");
  await card.getByRole("button", { name: "刷新 web-session@example.test 额度" }).click();
  await expect(card.getByRole("button", { name: "查看 web-session@example.test 重置次数" })).toHaveText("重置 2");
  await expect(card.getByRole("button", { name: "添加至 API 服务" })).toBeVisible();
  await card.getByRole("button", { name: "查看 web-session@example.test 重置次数" }).click();
  const resetDialog = page.getByRole("dialog", { name: "主动重置额度", exact: true });
  await expect(resetDialog.getByText("官方可用主动重置次数：2")).toBeVisible();
  await resetDialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __webSessionCalls: string[] }).__webSessionCalls.filter(command => command === "codex_consume_reset").length)).toBe(0);
  await card.getByRole("button", { name: "添加至 API 服务" }).click();
  await page.getByRole("tab", { name: "API 反代服务", exact: true }).click();
  await page.getByRole("button", { name: "服务账号池", exact: true }).click();
  await expect(page.getByRole("group", { name: "API 反代服务账号" }).getByRole("checkbox", { name: "web-session@example.test" })).toBeEnabled();
});
