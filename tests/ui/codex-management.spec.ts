import { test, expect } from "@playwright/test";
import { quotaPresentation, quotaResetTime, remainingPercent } from "../../src/features/codex/quotaPresentation";
import type { CodexAccount } from "../../src/platform/clients/codex";

test("Codex quota presentation treats stale, reset, invalid and failed data as unknown availability", () => {
  const reset = new Date(2026, 9, 12, 13, 49).getTime();
  expect(quotaResetTime(reset / 1000, reset - 240000)).toBe("4分钟（10/12 13:49）");
  expect(quotaResetTime(reset / 1000, reset - (5 * 1440 + 23 * 60 + 59) * 60000)).toBe("5天 23小时 59分钟（10/12 13:49）");
  expect(quotaResetTime(reset / 1000, reset - 1)).toBe("1分钟（10/12 13:49）");
  expect(quotaResetTime(reset / 1000, reset)).toBe("已到重置时间，待刷新（10/12 13:49）");
  expect(quotaResetTime(null, reset)).toBe("重置时间未知");
  expect(quotaResetTime(NaN, reset)).toBe("重置时间未知");
  const account: CodexAccount = {id:1,label:"fixture",email:null,accountId:null,authMode:"chatgpt",plan:"plus",note:"",tags:[],lastError:null,updatedAt:1,quota:{fetchedAt:1000000,windows:[{name:"five-hour",usedPercent:30,windowMinutes:300,resetsAt:2000},{name:"weekly",usedPercent:90,windowMinutes:10080,resetsAt:null}]}};
  expect(quotaPresentation(account,1000000)).toEqual({status:"low",remaining:10});
  expect(quotaPresentation(account,1900001)).toEqual({status:"stale",remaining:null});
  account.quota.windows[0].resetsAt=1000;
  expect(quotaPresentation(account,1000000).status).toBe("stale");
  account.quota.windows[0].resetsAt=null;
  account.quota.windows[1].usedPercent=100;
  expect(quotaPresentation(account,1000000)).toEqual({status:"exhausted",remaining:0});
  account.quota.windows[1].usedPercent=20;
  expect(quotaPresentation(account,1000000)).toEqual({status:"ready",remaining:70});
  account.lastError="fixture failure";
  expect(quotaPresentation(account,1000000)).toEqual({status:"error",remaining:null});
  account.lastError=null;
  account.quota.windows[0].usedPercent=110;
  expect(remainingPercent(account.quota.windows[0])).toBeNull();
  expect(quotaPresentation(account,1000000).status).toBe("unknown");
  account.authMode="apikey";
  expect(quotaPresentation(account,1000000)).toEqual({status:"billing",remaining:null});
});

test("Codex preview clearly excludes native account access", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "请在桌面客户端中使用" })).toBeVisible();
  await expect(page.getByRole("button", { name: "导入本机登录" })).toHaveCount(0);
});

test("Codex account filters, metadata, quota errors and confirmed switching", async ({ page }) => {
  test.setTimeout(120000); // Full multi-dialog journey includes responsive screenshots on slower CI runners.
  await page.addInitScript(() => {
    const calls: { command: string; args: unknown }[] = [];
    let accounts = [{ id: 1, label: "alice@example.test", email: "alice@example.test", accountId: "workspace-a", userId: "display-user-a", loginProvider: "google", workspaceName: null, authMode: "chatgpt", plan: "plus", note: "开发账号", tags: ["工作"], quota: { fetchedAt: 1791620000000, windows: [{ name: "codex", usedPercent: 30, windowMinutes: 300, resetsAt: 1791700000 }] }, lastError: null as string | null, updatedAt: 1, proxyUrl: null as string | null, benefits: { expiresAt: null as number | null, resetCredits: null as number | null, resetExpiresAt: null as number | null, fetchedAt: null as number | null, subscriptionError: null as string | null, creditsError: null as string | null } }, { id: 2, label: "second@example.test", email: "second@example.test", accountId: "workspace-b", authMode: "chatgpt", plan: "free", note: "", tags: [], quota: { fetchedAt: null as number | null, windows: [] as { name: string; usedPercent: number; windowMinutes: number; resetsAt: number }[] }, lastError: null as string | null, updatedAt: 1, proxyUrl: null as string | null, benefits: { expiresAt: null as number | null, resetCredits: null as number | null, resetExpiresAt: null as number | null, fetchedAt: null as number | null, subscriptionError: null as string | null, creditsError: null as string | null } }];
    let currentAccountId = 1;
    let pendingSwitchId = 2;
    let loginPolls = 0; let loginApproved = false;
    let trashed: typeof accounts = [];
    let consumedResets = 0;
    let gateway = { running: false, address: null as string | null, accountIds: [] as number[], completed: 0, failed: 0, active: 0, supportsCustomKey: true, supportsModels: true, supportsRemoteModels: true, supportsPersistentConfig: true, supportsConfigSave: true, supportsKeyReveal: true, supportsAutoStart: true, supportsPoolPersistence: true, supportsLanAccess: true, supportsShareConfig: true, lanAddress: null as string | null, allowLan: false, listeningLan: false, supportsFunctionTools: true, supportsMultiProtocol: true, autoStart: false, startupAccountIds: JSON.parse(sessionStorage.getItem("fixtureGatewayPool") || "[]") as number[], startupError: null as string | null, configuredPort: 58169, settings: { loggingEnabled: false, strategy: "round_robin", cooldownSeconds: 60 } };
    let logs: { id: string; timestamp: number; endpoint: string; model: string; accountId: number; status: number; upstreamStatus: number; outcome: string; streaming: boolean; durationMs: number; inputTokens: number; outputTokens: number }[] = [];
    let instances: { id: string; accountId: number; name: string; workDir: string; kind: "cli" | "desktop"; running: boolean; lastError: null }[] = [];
    let remoteEnabled=false;
    let remoteLogs: { id: string; timestamp: number; accountId: number; transport: string; method: string; url: string; status: number; outcome: string; durationMs: number; proxyMode: string; proxyUrl: string }[]=[];
    const state = () => ({ accounts, cliAvailable: true, desktopAvailable: true, canOpenDefault: true, supportsRemoteLogs: true, profileHome: "C:\\fixture\\.codex", currentAccountId, canRestore: false });
    Object.assign(window, {
      __codexCalls: calls,
      __holdBenefits: false,
      __releaseBenefits: () => {},
      __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string, args: { key?: string; value?: string; ids?: number[]; enabled?: boolean; accountIds?: number[]; port?: number; url?: string; settings?: { loggingEnabled: boolean; strategy: string; cooldownSeconds: number }; id?: number; token?: string; kind?: "cli" | "desktop"; input?: { id: number; label: string; note: string; tags: string[] } }) => {
          if (command === "list_client_preferences") return JSON.parse(sessionStorage.getItem("fixturePreferences") || "{}");
          if (command === "save_client_preference") { const values = JSON.parse(sessionStorage.getItem("fixturePreferences") || "{}"); values[args.key!] = args.value; sessionStorage.setItem("fixturePreferences", JSON.stringify(values)); return; }
          if (command.startsWith("codex_")) calls.push({ command, args });
          if (command === "trash_list") return { groups: [{ kind: "codex_accounts", label: "Codex 账号", items: trashed.map(account => ({kind: "codex_accounts", id: String(account.id), title: account.label, deletedAt: Date.now()})) }], scrubDays: 30, scrubbedNow: 0 };
          if (command === "trash_restore") { const restored = trashed.filter(account => args.ids!.map(String).includes(String(account.id))); accounts = [...accounts, ...restored]; trashed = trashed.filter(account => !restored.includes(account)); return restored.length; }
          if (command === "trash_purge") { const removed = trashed.filter(account => args.ids!.map(String).includes(String(account.id))); trashed = trashed.filter(account => !removed.includes(account)); return removed.length; }
          if (command === "codex_remote_logs") return {enabled:remoteEnabled,logs:remoteLogs};
          if (command === "codex_remote_logs_configure") { remoteEnabled=args.enabled!; if(remoteEnabled)remoteLogs=[{id:"remote-fixture",timestamp:Date.now(),accountId:1,transport:"http",method:"POST",url:"https://chatgpt.com/backend-api/codex/responses",status:200,outcome:"completed",durationMs:123,proxyMode:"account",proxyUrl:"http://127.0.0.1:10808/"}]; return {enabled:remoteEnabled,logs:remoteLogs}; }
          if (command === "codex_remote_logs_clear") {remoteLogs=[];return {enabled:remoteEnabled,logs:remoteLogs};}
          if (command === "codex_remote_log_detail") return {request:{headers:{authorization:"[凭据或身份已隐藏]","content-type":"application/json"},body:{model:"fixture-model",input:"hello"},proxyUrl:"http://127.0.0.1:10808/"},response:{headers:{"x-request-id":"fixture-request","set-cookie":"[凭据或身份已隐藏]"},body:{status:"completed",output:[{text:"fixture answer"}]}},events:[{type:"response.completed"}],eventCount:1,truncated:false};
          if (command === "codex_detect_proxies") {
            const mode = (window as unknown as { __proxyMode?: string }).__proxyMode;
            if (mode === "empty") return [];
            if (mode === "error") throw { code: "codex-proxy", message: "读取本机代理配置失败，请手动填写代理地址" };
            if (mode === "unsafe") throw { code: "codex-proxy", message: "upstream token=test-secret" };
            return [{ url: "http://127.0.0.1:10808/", source: "Windows 系统代理", enabled: false }];
          }
          if (command === "codex_save_proxies") {
            if (args.url === "http://127.0.0.1:7891/") throw { code: "codex-proxy", message: "所选账号中有服务、实例或唤醒任务运行，请先停止后批量设置代理；未修改任何账号" };
            const changed = accounts.filter(account => args.ids?.includes(account.id));
            changed.forEach(account => { account.proxyUrl = args.url || null; });
            return changed;
          }
          if (command === "codex_save_proxy") { const account=accounts.find(v=>v.id===args.id)!; if (args.url === "http://127.0.0.1:7891/") throw { code: "codex-proxy", message: "请先停止该账号的服务或实例，再修改代理" }; account.proxyUrl=args.url || null; return account; }
          if (command === "codex_refresh_benefits") { const control=window as unknown as {__holdBenefits:boolean;__releaseBenefits:()=>void}; if(control.__holdBenefits && args.id === 1) await new Promise<void>(resolve=>{control.__releaseBenefits=resolve;}); const account=accounts.find(v=>v.id===args.id)!; account.benefits={expiresAt:1893456000,resetCredits:3-consumedResets,resetExpiresAt:1893456000,fetchedAt:Date.now(),subscriptionError:null,creditsError:null}; return account; }
          if (command === "codex_consume_reset") { consumedResets++; const account=accounts.find(v=>v.id===args.id)!; account.benefits={expiresAt:null,resetCredits:null,resetExpiresAt:null,fetchedAt:null,subscriptionError:null,creditsError:null}; return account; }
          if (command === "codex_export_accounts_file") return true;
          if (command === "codex_import_text") {
            const content = (args as { content?: string }).content;
            if (content === "invalid-input") throw { code: "codex-import", message: "输入的 JSON 格式无效，请检查后重试" };
            return state();
          }
          if (command === "codex_open_default") { if ((window as unknown as { __failLaunch?: boolean }).__failLaunch) throw new Error("fixture-start-failure"); return; }
          if (command === "codex_open_default_cli") return;
          if (command === "codex_start_login") { loginPolls = 0; loginApproved = false; return { token: "login-fixture", authUrl: "https://auth.openai.com/oauth/authorize?state=test-only-state" }; }
          if (command === "codex_copy_login_url") return;
          if (command === "codex_open_login_url") { loginApproved = true; return; }
          if (command === "codex_poll_login") return { status: ++loginPolls > 1 && loginApproved ? "completed" : "pending" };
          if (command === "codex_cancel_login") return;
          if (command === "codex_gateway_configure") { gateway.settings = args.settings!; if (gateway.settings.loggingEnabled && !logs.length) logs = [{ id: "log-fixture", timestamp: Date.now(), endpoint: "/v1/responses", model: "fixture-model", accountId: 1, status: 200, upstreamStatus: 200, outcome: "completed", streaming: true, durationMs: 250, inputTokens: 12, outputTokens: 4 }]; return gateway; }
          if (command === "codex_gateway_log_detail") return { request: { model: "fixture-model", input: [{ role: "user", content: "[内容已隐藏]" }], stream: true, max_output_tokens: 100 }, forwarded: { model: "fixture-model", stream: true, store: false }, response: { status: "completed", usage: { input_tokens: 12, output_tokens: 4 } }, events: [{ type: "response.completed" }], eventCount: 1, truncated: false };
          if (command === "codex_gateway_logs") return logs;
          if (command === "codex_gateway_clear_logs") { logs = []; return; }
          if (command === "codex_gateway_lan_interfaces") return [{ip:"192.168.1.23",adapter:"Wi-Fi",network:"Home Wi-Fi"},{ip:"172.18.0.1",adapter:"vEthernet",network:"Virtual switch"}];
          if (command === "codex_gateway_models") return ["fixture-model", "fixture-model-two"];
          if (command === "codex_test_account") { if (args.id === 2) throw new Error("fixture-failure"); return { text: "<!doctype html><html><body><svg><text>fixture result</text></svg></body></html>", durationMs: 250, inputTokens: 12, outputTokens: 4 }; }
          if (command === "codex_gateway_set_allow_lan") { gateway = { ...gateway, allowLan: !!args.enabled, lanAddress: args.enabled ? "http://192.168.1.23:58169/v1" : null }; return gateway; }
          if (command === "codex_gateway_state") return gateway;
          if (command === "codex_gateway_start") { gateway = { ...gateway, running: true, listeningLan: gateway.allowLan, address: "http://127.0.0.1:58169/v1", accountIds: [1] }; return gateway; }
          if (command === "codex_gateway_stop") { gateway = { ...gateway, running: false, address: null }; return gateway; }
          if (command === "codex_gateway_copy_key" || command === "codex_gateway_copy_share_config") return;
          if (command === "codex_gateway_save_pool") { sessionStorage.setItem("fixtureGatewayPool", JSON.stringify(args.accountIds)); gateway = { ...gateway, startupAccountIds: args.accountIds! }; return gateway; }
          if (command === "codex_gateway_set_auto_start") { gateway = { ...gateway, autoStart: !!args.enabled, startupAccountIds: args.enabled ? args.accountIds! : gateway.startupAccountIds }; return gateway; }
          if (command === "codex_gateway_reveal_key") return "test-only-display-value";
          if (command === "codex_gateway_save_port") {
            if (args.port === 58171) throw new Error("本地 API 端口被占用或无法监听，请选择其他端口");
            gateway = { ...gateway, configuredPort: args.port || gateway.configuredPort, address: gateway.running ? `http://127.0.0.1:${args.port || gateway.configuredPort}/v1` : null };
            return gateway;
          }
          if (command === "codex_account_details") return { details: JSON.parse(sessionStorage.getItem("fixtureDetails") || '{"email":"alice@example.test","password":"","twoFactor":"","mailUrl":"","phone":"","note":""}'), version: 1, auth: { userId: "fixture-user", accessExpiresAt: 1893456000, idExpiresAt: 1893456000, hasRefreshToken: true }, availableSecrets: ["access_token", "refresh_token", "id_token"], lastRefresh: null };
          if (command === "codex_account_secret") return (args as { copy?: boolean }).copy ? null : "invalid-fixture-display";
          if (command === "codex_save_account_details") { sessionStorage.setItem("fixtureDetails", JSON.stringify(args.input)); return; }
          if (command === "codex_auth_metadata" || command === "codex_force_refresh") return { userId: "user-fixture", accessExpiresAt: 1893456000, idExpiresAt: 1893456000, hasRefreshToken: true };
          if (command === "codex_launch_config") return { version: "fixture-version", model: "fixture-model", contextWindow: 200000, compactLimit: 180000 };
          if (command === "codex_bind_instance") return instances;
          if (command === "codex_list_instances") return instances;
          if (command === "codex_create_instance") { instances = [{ id: "instance-fixture", accountId: 1, name: "开发实例", workDir: "C:\\fixture\\project", kind: args.kind!, running: false, lastError: null }]; return instances; }
          if (command === "codex_start_instance") { instances[0].running = true; return instances; }
          if (command === "codex_stop_instance") { instances[0].running = false; return instances; }
          if (command === "codex_get_state" || command === "codex_import_local") return state();
          if (command === "codex_import_file") return null;
          if (command === "codex_save_metadata") { accounts = accounts.map((v) => v.id === args.input!.id ? { ...v, ...args.input! } : v); return accounts.find((v) => v.id === args.input!.id); }
          if (command === "codex_refresh_quota") { const account = accounts.find((v) => v.id === args.id)!; account.lastError = "Codex 请求失败，请检查登录状态（HTTP 401）"; return account; }
          if (command === "codex_prepare_switch") { pendingSwitchId = args.id!; return { token: "confirmation-fixture", accountLabel: accounts.find(account => account.id === args.id)?.label ?? "fixture@example.test", profileHome: "C:\\fixture\\.codex", hasPreviousAuth: true }; }
          if (command === "codex_confirm_switch") { currentAccountId = pendingSwitchId; return state(); }
          if (command === "codex_delete_account") { trashed.push(...accounts.filter(v => v.id === args.id)); accounts = accounts.filter((v) => v.id !== args.id); return state(); }
          if (command === "plugin:app|version") return "0.1.45";
          if (command === "plugin:updater|check") return null;
          if (command === "plugin:event|listen") return 1;
          return [];
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  await expect(page.getByText("70% 剩余", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "管理分组", exact: true }).click();
  const groupDialog = page.getByRole("dialog", { name: "管理 Codex 分组", exact: true });
  await groupDialog.getByLabel("新分组名称", { exact: true }).fill("开发组");
  await groupDialog.getByRole("button", { name: "创建分组", exact: true }).click();
  await groupDialog.getByLabel("将 alice@example.test 加入分组", { exact: true }).check();
  await groupDialog.getByRole("button", { name: "保存分组", exact: true }).click();
  await expect(groupDialog).toHaveCount(0);
  await page.getByRole("button", { name: "开发组 1", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByRole("button", { name: "全部 2", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(2);
  await page.getByRole("button", { name: "鹈鹕测智", exact: true }).click();
  const testDialog = page.getByRole("dialog", { name: "鹈鹕测智", exact: true });
  await testDialog.getByLabel("测试模型", {exact: true}).fill("fixture-model");
  await expect(testDialog.getByLabel("鹈鹕提示词", {exact: true})).toHaveValue(/HTML/);
  expect(await page.evaluate(() => (window as unknown as {__codexCalls: {command:string}[]}).__codexCalls.filter(call => call.command === "codex_test_account").length)).toBe(0);
  await testDialog.getByRole("button", { name: "确认消耗额度并测试", exact: true }).click();
  await expect(testDialog.getByText("alice@example.test · 完成 · 0.3 秒", {exact: true})).toBeVisible();
  await expect(testDialog.getByText("second@example.test · 失败，请检查账号、模型权限与额度", {exact: true})).toBeVisible();
  await testDialog.getByText("alice@example.test · 完成 · 0.3 秒", {exact: true}).click();
  await testDialog.getByRole("button", { name: "预览 HTML", exact: true }).click();
  await expect(testDialog.locator("iframe")).toHaveAttribute("sandbox", "");
  await expect(testDialog.locator("iframe")).toHaveAttribute("srcdoc", /script-src 'none'/);
  await testDialog.getByRole("button", { name: "关闭", exact: true }).click();
  const savedGroups = await page.evaluate(() => JSON.parse(JSON.parse(sessionStorage.getItem("fixturePreferences") || "{}")["codex.overview.v1"]).groups);
  expect(savedGroups).toEqual([{ id: expect.any(String), name: "开发组", accountIds: [1] }]);
  await page.getByRole("button", { name: "列表视图", exact: true }).click();
  await expect(page.locator(".codex-reference-grid")).toHaveClass(/codex-list-view/);
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  await expect(page.getByRole("table")).toContainText("alice@example.test");
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(3);
  for (const width of [375, 768, 1024, 1440]) { await page.setViewportSize({width,height:900}); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  await page.getByRole("button", { name: "卡片视图", exact: true }).click();
  await page.getByRole("button", { name: "Codex 设置", exact: true }).click();
  const overviewSettings = page.getByRole("dialog", { name: "Codex 设置", exact: true });
  await overviewSettings.getByLabel("紧凑卡片", { exact: true }).check();
  await expect(page.locator(".codex-reference-grid")).toHaveClass(/codex-compact-view/);
  await overviewSettings.getByLabel("紧凑卡片", { exact: true }).uncheck();
  await overviewSettings.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await page.getByLabel("筛选 Codex 标签", { exact: true }).selectOption("工作");
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByLabel("筛选 Codex 标签", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "唤醒账号 (2)", exact: true }).click();
  const wakeDialog = page.getByRole("dialog", { name: "唤醒 Codex 账号", exact: true });
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: {command:string}[] }).__codexCalls.filter(call => call.command === "codex_wake_account").length)).toBe(0);
  await wakeDialog.getByLabel("唤醒模型", { exact: true }).fill("fixture-model");
  await wakeDialog.getByRole("button", { name: "确认消耗额度并唤醒", exact: true }).click();
  await expect(wakeDialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: {command:string;args:{id:number}}[] }).__codexCalls.filter(call => call.command === "codex_wake_account").map(call => call.args.id))).toEqual([1,2]);
  await page.getByLabel("选择 second@example.test", { exact: true }).check();
  await page.getByRole("button", { name: "删除所选 (1)", exact: true }).click();
  await page.getByRole("button", { name: "确认移入回收站", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const recycle = page.getByRole("dialog", { name: "Codex 账号回收站", exact: true });
  await recycle.getByLabel("选择 second@example.test", { exact: true }).check();
  await recycle.getByRole("button", { name: "恢复 (1)", exact: true }).click();
  await expect(recycle.getByText("暂无已删除的数据", { exact: true })).toBeVisible();
  await recycle.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(2);
  await page.getByRole("button", { name: "添加 Codex 账号", exact: true }).click();
  const tokenDialog = page.getByRole("dialog", { name: "添加 Codex 账号", exact: true });
  const tokenTab = tokenDialog.getByRole("tab", { name: "Token / JSON", exact: true });
  await tokenTab.click();
  const tokenInput = tokenDialog.getByRole("textbox", { name: "Token / JSON 内容", exact: true });
  await expect(tokenTab).toBeFocused();
  await expect(tokenInput).toBeVisible();
  await tokenInput.fill("invalid-input");
  await page.mouse.click(2, 2);
  await expect(tokenDialog).toBeVisible();
  await tokenDialog.getByRole("button", { name: "导入账号", exact: true }).click();
  await expect(tokenDialog.getByRole("alert")).toHaveText("导入失败，请检查凭据格式、网络或账号运行状态后重试");
  await expect(tokenInput).toHaveValue("invalid-input");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await tokenDialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  }
  await tokenDialog.screenshot({ path: "test-results/codex-token-import.png" });
  await page.keyboard.press("Escape");
  await expect(tokenDialog).toHaveCount(0);
  await page.getByRole("button", { name: "添加 Codex 账号", exact: true }).click();
  await tokenDialog.getByRole("tab", { name: "Token / JSON", exact: true }).click();
  await expect(tokenInput).toHaveValue("");
  await tokenInput.fill('{"OPENAI_API_KEY":"invalid-fixture"}');
  await tokenDialog.getByRole("button", { name: "导入账号", exact: true }).click();
  await expect(tokenDialog).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByRole("tab", { name: "账号总览", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "API 反代服务", exact: false })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.codex-toolbar').screenshot({ path: 'test-results/codex-toolbar-alignment.png' });
  const serviceSummary = page.getByLabel("API 服务概览", { exact: true });
  await expect(serviceSummary.locator(".codex-summary-action-rail button")).toHaveCount(7);
  await serviceSummary.getByRole("button", { name: "查看概览服务密钥", exact: true }).click();
  await expect(serviceSummary.getByLabel("概览服务密钥", { exact: true })).toHaveValue("test-only-display-value");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(serviceSummary.getByLabel("概览服务密钥", { exact: true })).toHaveValue("");
  await serviceSummary.getByRole("button", { name: "概览服务账号池", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "服务账号池", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭服务账号池", exact: true }).click();
  await page.getByRole("tab", { name: "账号总览", exact: true }).click();
  const aliceCard = page.getByRole("article", { name: "Codex 账号 alice@example.test", exact: true });
  await expect(aliceCard.getByText("Team Name：个人账户", { exact: true })).toBeVisible();
  await expect(aliceCard.locator(".codex-account-id")).toHaveText("使用 Google 登录 | 用户 ID：display-user-a");
  await expect(aliceCard.locator(".codex-account-id")).toHaveAttribute("title", /工作区 ID：workspace-a/);
  await expect(aliceCard.locator(".codex-card-actions button")).toHaveCount(8);
  await aliceCard.getByRole("button", { name: "启动 alice@example.test 的 Codex CLI", exact: true }).click();
  await expect(page.locator(".codex-feedback").filter({ hasText: "已使用当前账号启动 Codex CLI" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter(call => call.command === "codex_open_default_cli").length)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter(call => call.command === "codex_prepare_switch").length)).toBe(0);
  await aliceCard.getByRole("button", { name: "查看 alice@example.test 信息", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Codex 账号信息", exact: true })).toContainText("workspace-a");
  const accountDetailDialog = page.getByRole("dialog", { name: "Codex 账号信息", exact: true });
  await expect(accountDetailDialog.getByLabel("Access Token（AT）", { exact: true })).toHaveValue("••••••••••••••••");
  await accountDetailDialog.getByRole("button", { name: "显示Access Token（AT）", exact: true }).click();
  await expect(accountDetailDialog.getByLabel("Access Token（AT）", { exact: true })).toHaveValue("invalid-fixture-display");
  await accountDetailDialog.getByRole("button", { name: "隐藏Access Token（AT）", exact: true }).click();
  await expect(accountDetailDialog.getByLabel("Access Token（AT）", { exact: true })).toHaveValue("••••••••••••••••");
  await accountDetailDialog.getByLabel("手机号", { exact: true }).fill("fixture-phone");
  await accountDetailDialog.getByLabel("其他备注", { exact: true }).fill("fixture private note");
  await accountDetailDialog.getByRole("button", { name: "保存资料", exact: true }).click();
  await expect(accountDetailDialog.getByText("账号资料已加密保存", { exact: true })).toBeVisible();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await accountDetailDialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
  await page.setViewportSize({ width: 1920, height: 1800 });
  await page.getByRole("dialog", { name: "Codex 账号信息", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
  await aliceCard.getByRole("button", { name: "导出 alice@example.test JSON", exact: true }).click();
  const exportDialog = page.getByRole("dialog", { name: "导出 Codex 账号", exact: true });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await exportDialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    expect(await exportDialog.locator(".modal-body").evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await expect(exportDialog.getByRole("button", { name: "选择保存位置", exact: true })).toBeInViewport();
  }
  await page.setViewportSize({ width: 1920, height: 1800 });
  await expect(exportDialog.getByLabel("导出格式")).toHaveValue("cockpit_tools");
  await expect(exportDialog.getByLabel("导出密码", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "选择保存位置", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: {command:string;args:{accountId:number}}[] }).__codexCalls.find(call => call.command === "codex_export_accounts_file")?.args.accountId)).toBe(1);
  await aliceCard.getByRole("button", { name: "添加至 API 服务", exact: true }).click();
  await expect(aliceCard.getByRole("button", { name: "移除 API 服务", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("fixtureGatewayPool") ?? "[]"))).toEqual([1]);
  await aliceCard.getByRole("button", { name: "移除 API 服务", exact: true }).click();
  await expect(aliceCard.getByRole("button", { name: "添加至 API 服务", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("fixtureGatewayPool") ?? "[]"))).toEqual([]);
  await page.locator(".codex-reference-grid").screenshot({ path: "test-results/codex-reference-account-board.png" });
  await page.setViewportSize({width:1920,height:1080});
  const referenceMetrics = await page.locator(".codex-page").evaluate(root => {
    const grid = root.querySelector(".codex-reference-grid")!;
    const toolbar = root.querySelector(".codex-toolbar")!;
    return { columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length, toolbarHeight: toolbar.getBoundingClientRect().height };
  });
  expect(referenceMetrics.columns).toBe(4);
  expect(referenceMetrics.toolbarHeight).toBeLessThan(105);
  await page.locator(".codex-page").screenshot({path:"test-results/codex-overview-compact-1920.png"});
  await page.setViewportSize({width:1280,height:720});
  const cardLayout = await page.locator(".codex-reference-grid > .codex-card").evaluateAll(cards => cards.map(card => {
    const box = card.getBoundingClientRect();
    const actions = card.querySelector(".codex-card-actions,.codex-summary-action-rail")!.getBoundingClientRect();
    return { height: box.height, bottomGap: box.bottom - actions.bottom };
  }));
  expect(cardLayout.every(card => card.height < 430), JSON.stringify(cardLayout)).toBe(true);
  expect(Math.max(...cardLayout.map(card => card.bottomGap)) - Math.min(...cardLayout.map(card => card.bottomGap))).toBeLessThan(2);
  await page.getByRole("button", { name: "Codex 设置", exact: true }).click();
  await page.getByRole("dialog", { name: "Codex 设置", exact: true }).getByRole("button", { name: "启动 Codex", exact: true }).click();
  await expect(page.locator(".codex-feedback").filter({hasText:"已请求打开默认 Codex 客户端"})).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter((v) => v.command === "codex_open_default").length)).toBe(1);
  await page.getByRole("button", { name: "添加 Codex 账号", exact: true }).click();
  const addAccountDialog = page.getByRole("dialog", { name: "添加 Codex 账号", exact: true });
  await addAccountDialog.getByRole("tab", { name: "OAuth 授权", exact: true }).click();
  await addAccountDialog.getByRole("button", { name: "开始 OAuth 授权", exact: true }).click();
  await expect(page.getByLabel("授权登录地址", { exact: true })).toHaveValue("https://auth.openai.com/oauth/authorize?state=test-only-state");
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: {command:string}[] }).__codexCalls.filter(call=>call.command==="codex_open_login_url").length)).toBe(0);
  await page.getByRole("button", { name: "复制地址", exact: true }).click();
  await expect(page.locator(".codex-feedback").filter({hasText:"授权地址已复制，可在你选择的浏览器中打开"})).toBeVisible();
  await page.getByRole("button", { name: "打开浏览器", exact: true }).click();
  await expect(page.locator(".codex-feedback").filter({hasText:"官方登录完成，账号已加密保存"})).toBeVisible();
  await expect(page.getByLabel("授权登录地址", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "添加 Codex 账号", exact: true }).click();
  const addAccountDialogAgain = page.getByRole("dialog", { name: "添加 Codex 账号", exact: true });
  await addAccountDialogAgain.getByRole("tab", { name: "OAuth 授权", exact: true }).click();
  await addAccountDialogAgain.getByRole("button", { name: "开始 OAuth 授权", exact: true }).click();
  await page.getByRole("button", { name: "取消登录", exact: true }).click();
  await expect(page.getByLabel("授权登录地址", { exact: true })).toHaveCount(0);
  await page.getByLabel("筛选 Codex 套餐").selectOption("free");
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByLabel("筛选 Codex 套餐").selectOption("");
  await page.getByLabel("搜索 Codex 账号").fill("工作");
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByLabel("搜索 Codex 账号").fill("");
  await page.getByLabel("筛选 Codex 额度状态").selectOption("stale");
  await expect(page.getByRole("article", {name:"Codex 账号 alice@example.test"})).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByRole("button",{name:"清除筛选",exact:true}).click();
  await page.getByLabel("Codex 账号排序").selectOption("name");
  await expect(page.locator('.codex-card:not(.codex-service-summary)').first()).toHaveAttribute("aria-label","Codex 账号 alice@example.test");
  await page.getByLabel("选择 second@example.test",{exact:true}).check();
  await page.getByLabel("筛选 Codex 套餐").selectOption("plus");
  await expect(page.getByRole("button",{name:"刷新所选订阅权益",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"清空选择",exact:true}).click();
  await page.getByRole("button",{name:"清除筛选",exact:true}).click();
  await page.evaluate(() => Object.assign(window, { __holdBenefits: true }));
  await page.getByRole("button", { name: "刷新 alice@example.test 订阅与重置次数", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新 alice@example.test 额度", exact: true })).toBeDisabled();
  const refreshingButton = page.getByRole("button", { name: "刷新 alice@example.test 额度", exact: true });
  await expect(refreshingButton).toHaveAttribute("aria-busy", "true");
  await expect(refreshingButton.locator("svg")).toHaveCSS("animation-name", "codex-refresh-spin");
  await expect(page.getByRole("button", { name: "刷新 alice@example.test 订阅与重置次数", exact: true })).toHaveText("刷新中…");
  const otherRefresh = page.getByRole("button", { name: "刷新 second@example.test 额度", exact: true });
  await expect(otherRefresh).toBeEnabled();
  await otherRefresh.click();
  await expect(otherRefresh).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string; args: { id: number } }[] }).__codexCalls.filter(call => call.command === "codex_refresh_quota").slice(-1)[0].args.id)).toBe(2);
  await expect(page.getByRole("button", { name: "刷新 alice@example.test 额度", exact: true })).toBeDisabled();
  await page.evaluate(() => { const c=window as unknown as {__holdBenefits:boolean;__releaseBenefits:()=>void};c.__holdBenefits=false;c.__releaseBenefits(); });
  await expect(page.getByRole("button", { name: "刷新 alice@example.test 额度", exact: true })).toBeEnabled();
  await page.getByLabel("筛选 Codex 套餐").selectOption("plus");
  const benefitsBefore = await page.evaluate(()=>(window as unknown as {__codexCalls:{command:string}[]}).__codexCalls.filter(call=>call.command==="codex_refresh_benefits").length);
  await page.getByLabel("选择 alice@example.test", { exact: true }).check();
  await page.getByRole("button", { name: "刷新所选订阅权益", exact: true }).click();
  await expect(page.locator(".codex-feedback").filter({hasText:"已处理 1 / 1 个账号，订阅权益已更新"})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {__codexCalls:{command:string;args:{id:number}}[]}).__codexCalls.filter(call=>call.command==="codex_refresh_benefits").slice(-1)[0].args.id)).toBe(1);
  await page.getByRole("button",{name:"清除筛选",exact:true}).click();
  await page.getByLabel("全选", { exact: true }).check();
  await page.evaluate(() => { (window as unknown as {__holdBenefits:boolean}).__holdBenefits=true; });
  await page.getByRole("button", { name: "刷新所选订阅权益", exact: true }).click();
  await expect(page.getByRole("progressbar",{name:"账号刷新进度"})).toHaveAttribute("value","0");
  await page.getByRole("button",{name:"停止后续刷新",exact:true}).click();
  await expect(page.getByRole("button",{name:"等待当前账号完成",exact:true})).toBeDisabled();
  await page.evaluate(() => { const control=window as unknown as {__holdBenefits:boolean;__releaseBenefits:()=>void};control.__holdBenefits=false;control.__releaseBenefits(); });
  await expect(page.locator(".codex-feedback").filter({hasText:"已停止后续刷新，已处理 1 / 2 个账号，订阅权益已更新"})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {__codexCalls:{command:string}[]}).__codexCalls.filter(call=>call.command==="codex_refresh_benefits").length)).toBe(benefitsBefore+2);
  expect(await page.evaluate(()=>(window as unknown as {__codexCalls:{command:string}[]}).__codexCalls.filter(call=>call.command==="codex_consume_reset").length)).toBe(0);
  await page.getByRole("button", { name: "编辑 alice@example.test 备注" }).click();
  await page.getByLabel("账号名称", { exact: true }).fill("Alice 工作账号");
  await page.getByLabel("标签（逗号分隔）").fill("项目A, 测试");
  await page.getByRole("button", { name: "保存账号信息" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Alice 工作账号" })).toBeVisible();
  await page.getByRole("button", { name: "刷新 Alice 工作账号 额度" }).click();
  const quotaError = page.getByRole("article", { name: "Codex 账号 Alice 工作账号", exact: true }).locator(".codex-refresh-error-bar");
  await expect(quotaError.getByRole("status")).toHaveText("额度刷新失败 · HTTP 401");
  await quotaError.getByRole("button", { name: "查看详情", exact: true }).click();
  const errorDialog = page.getByRole("dialog", { name: "错误详情", exact: true });
  await expect(errorDialog).toBeVisible();
  await expect(errorDialog.locator("pre")).toHaveText("Codex 请求失败，请检查登录状态（HTTP 401）");
  await expect(errorDialog.getByText("Alice 工作账号", { exact: true })).toBeVisible();
  await expect(errorDialog.getByRole("button", { name: "复制", exact: true })).toBeVisible();
  await errorDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(errorDialog).toHaveCount(0);
  await page.getByRole("article", { name: "Codex 账号 Alice 工作账号", exact: true }).getByRole("button", { name: "重新授权", exact: true }).click();
  await expect(page.getByLabel("授权登录地址", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as {__codexCalls:{command:string;args:{accountId:number}}[]}).__codexCalls.filter(call => call.command === "codex_start_login").slice(-1)[0].args.accountId)).toBe(1);
  await page.getByRole("button", { name: "取消登录", exact: true }).click();
  await expect(page.getByText("70% 剩余", { exact: true })).toBeVisible();
  await page.getByRole("article", { name: "Codex 账号 second@example.test" }).getByRole("button", { name: "启动预览 second@example.test", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const before = await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter((v) => v.command === "codex_confirm_switch").length);
  expect(before).toBe(0);
  const playPreview = page.getByRole("dialog", { name: "Codex 启动预览", exact: true });
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter(v => v.command === "codex_prepare_switch").length)).toBe(0);
  await playPreview.getByRole("button", { name: "切换", exact: true }).click();
  await expect(playPreview.getByText("账号切换完成，尚未启动客户端")).toBeVisible();
  await playPreview.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("article", { name: "Codex 账号 second@example.test" }).getByText("当前", { exact: true })).toBeVisible();
  const cliCallsBeforeSwitch = await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter(call => call.command === "codex_open_default_cli").length);
  await page.getByRole("button", { name: "启动 Alice 工作账号 的 Codex CLI", exact: true }).click();
  const cliSwitch = page.getByRole("dialog", { name: "切换账号并启动 CLI", exact: true });
  await expect(cliSwitch).toBeVisible();
  await cliSwitch.getByRole("button", { name: "已结束任务，确认切换并启动 CLI", exact: true }).click();
  await expect(page.locator(".codex-feedback").filter({ hasText: "默认账号已切换并启动 Codex CLI" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter(call => call.command === "codex_open_default_cli").length)).toBe(cliCallsBeforeSwitch + 1);
  await page.getByRole("button", { name: "启动预览 Alice 工作账号", exact: true }).click();
  const launch = page.getByRole("dialog", { name: "Codex 启动预览", exact: true });
  await expect(launch).toBeVisible();
  await expect(launch.getByText(/“切换并启动”将打开Codex 桌面客户端；“CLI 启动”才会打开命令行客户端/)).toBeVisible();
  await expect(launch.getByText("user-fixture", { exact: true })).toBeVisible();
  await expect(launch.getByLabel("目标实例", { exact: true })).toHaveValue("");
  await launch.getByRole("button", { name: "配置上下文", exact: true }).click();
  await launch.getByLabel("上下文窗口", { exact: true }).fill("100000");
  await launch.getByLabel("自动压缩阈值", { exact: true }).fill("90000");
  await launch.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(launch.getByRole("group", { name: "上下文配置" })).toHaveCount(0);
  await launch.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(launch.getByText("官方 CLI 已完成认证刷新检查")).toBeVisible();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await launch.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await expect(launch.getByRole("button", { name: "切换并启动", exact: true })).toBeInViewport();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await launch.getByRole("button", { name: "切换", exact: true }).click();
  await expect(launch.getByText("账号切换完成，尚未启动客户端")).toBeVisible();
  await page.evaluate(() => Object.assign(window, { __failLaunch: true }));
  await launch.getByRole("button", { name: "切换并启动", exact: true }).click();
  await expect(launch.getByRole("alert")).toContainText("账号已切换，启动失败");
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.some(call => call.command === "codex_open_default"))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter(call => call.command === "codex_open_default_cli").length)).toBe(cliCallsBeforeSwitch + 1);
  await expect(launch).toBeVisible();
  await page.evaluate(() => Object.assign(window, { __failLaunch: false }));
  await page.screenshot({ path: "test-results/codex-launch-preview-1440.png" });
  await launch.getByRole("button", { name: "关闭", exact: true }).click();
  for (const closeMethod of ["header", "footer", "escape"]) {
    await page.getByRole("button", { name: "启动预览 Alice 工作账号", exact: true }).click();
    await page.evaluate(() => Object.assign(window, { __holdBenefits: true }));
    await launch.getByRole("button", { name: "订阅到期", exact: true }).click();
    await expect(launch).toHaveAttribute("aria-busy", "true");
    if (closeMethod === "header") await launch.getByRole("button", { name: "关闭对话框", exact: true }).click();
    else if (closeMethod === "footer") await launch.getByRole("button", { name: "关闭", exact: true }).click();
    else await page.keyboard.press("Escape");
    await expect(launch).toHaveCount(0);
    await page.evaluate(() => { const control = window as unknown as { __holdBenefits: boolean; __releaseBenefits: () => void }; control.__holdBenefits = false; control.__releaseBenefits(); });
    await expect(launch).toHaveCount(0);
  }
  await page.getByRole("tab", { name: "应用多开", exact: true }).click();
  await page.getByRole("button", { name: "创建独立实例", exact: true }).click();
  await expect(page.getByLabel("实例类型", { exact: true })).toHaveValue("desktop");
  await page.getByLabel("实例名称", { exact: true }).fill("开发实例");
  await page.getByRole("button", { name: "选择项目目录", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string; args: { kind?: string } }[] }).__codexCalls.find((v) => v.command === "codex_create_instance")?.args.kind)).toBe("desktop");
  await page.getByRole("button", { name: "启动", exact: true }).click();
  await expect(page.getByText("Alice 工作账号 · 运行中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter((v) => v.command === "codex_stop_instance").length)).toBe(0);
  await page.getByRole("button", { name: "确认停止实例", exact: true }).click();
  await expect(page.getByText("Alice 工作账号 · 已停止", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "API 反代服务", exact: true }).click();
  await expect(page.getByRole("heading", { name: "API 反代服务", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1920, height: 1800 });
  await page.locator(".codex-gateway").scrollIntoViewIfNeeded();
  await expect(page.locator(".codex-api-header .codex-header-status")).toContainText("已完成请求");
  await expect(page.locator(".codex-status-card")).toHaveCount(0);
  await expect(page.locator(".codex-config-card .codex-routing-card")).toHaveCount(1);
  await page.locator(".codex-gateway").screenshot({ path: "test-results/codex-api-reference-refined-1920.png" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByRole("tabpanel", { name: "应用多开", exact: true })).toBeHidden();
  await expect(page.getByText("点击“服务账号池”选择至少一个账号，再启动反代服务。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "启动反代服务", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "获取模型列表", exact: true })).toBeDisabled();
  await page.getByLabel("选择模型 ID", { exact: true }).selectOption("gpt-6.1-sol");
  await expect(page.getByPlaceholder("填写账号可用的模型 ID")).toHaveValue("gpt-6.1-sol");
  await expect(page.getByLabel("选择模型 ID", { exact: true }).locator('optgroup[label="推荐模型（未验证账号权限）"] option')).toHaveCount(8);
  await expect(page.getByRole("group", { name: "API 反代服务账号" })).toBeHidden();
  await page.getByRole("button", { name: "服务账号池", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "服务账号池", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "最大化服务账号池", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "服务账号池", exact: true })).toHaveClass(/is-maximized/);
  await page.getByRole("button", { name: "还原服务账号池", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "服务账号池", exact: true })).not.toHaveClass(/is-maximized/);
  await page.getByRole("button", { name: "全选账号", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.getByRole("button", { name: "启动反代服务", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "服务账号池", exact: true }).click();
  await page.getByRole("button", { name: "清空选择", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByPlaceholder("填写账号可用的模型 ID").fill("fixture-model");
  await page.getByRole("button", { name: "服务账号池", exact: true }).click();
  await page.getByRole("group", { name: "API 反代服务账号" }).getByLabel("Alice 工作账号", { exact: true }).check();
  await page.getByRole("button", { name: "唤醒所选账号", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "唤醒 Codex 账号", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "服务账号池", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "服务账号池", exact: true })).toBeFocused();
  await page.getByRole("tab", { name: "API 反代服务", exact: true }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "应用多开", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "创建独立实例", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "应用多开", exact: true }).press("ArrowLeft");
  await expect(page.getByPlaceholder("填写账号可用的模型 ID")).toHaveValue("fixture-model");
  await page.getByRole("button", { name: "服务账号池", exact: true }).click();
  await expect(page.getByRole("group", { name: "API 反代服务账号" }).getByLabel("Alice 工作账号", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByLabel("服务密钥", { exact: true }).fill("short");
  await expect(page.getByRole("button", { name: "启动反代服务", exact: true })).toBeDisabled();
  await page.getByLabel("服务密钥", { exact: true }).fill("test-only-".repeat(4));
  await page.getByRole("button", { name: "查看服务密钥", exact: true }).click();
  await expect(page.getByLabel("服务密钥", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "隐藏服务密钥", exact: true }).click();
  await expect(page.getByLabel("服务密钥", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByLabel("服务密钥", { exact: true })).toHaveValue("test-only-".repeat(4));
  await page.getByLabel("服务端口", { exact: true }).fill("80");
  await expect(page.getByRole("button", { name: "启动反代服务", exact: true })).toBeDisabled();
  await page.getByLabel("服务端口", { exact: true }).fill("58169");
  await page.getByRole("button", { name: "启动反代服务", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "启动API 反代服务", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter((v) => v.command === "codex_gateway_start").length)).toBe(0);
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(page.locator(".codex-gateway").getByText("http://127.0.0.1:58169/v1", { exact: true })).toBeVisible();
  const lanToggle = page.getByRole("switch", { name: "允许局域网访问", exact: true });
  await lanToggle.check();
  await expect(lanToggle).toBeChecked();
  await expect(page.getByText("待重启生效", { exact: true })).toBeVisible();
  await expect(page.getByText("已保存：下次启动允许局域网访问（IPv4）。", { exact: true })).toBeVisible();
  await expect(page.locator(".codex-current-listener code")).toHaveText("127.0.0.1:58169");
  await expect(page.getByText("其他设备请将 127.0.0.1 换成本机局域网 IPv4 地址，端口和服务密钥不变。", { exact: true })).toHaveCount(0);
  await page.locator(".codex-config-card").screenshot({ path: "test-results/codex-network-pending.png" });
  await lanToggle.uncheck();
  await expect(lanToggle).not.toBeChecked();
  expect(await page.evaluate(() => { const call = (window as unknown as { __codexCalls: { command: string; args: { port: number; serviceKey: string } }[] }).__codexCalls.find((v) => v.command === "codex_gateway_start"); return call?.args.port === 58169 && call.args.serviceKey === "test-only-".repeat(4); })).toBe(true);
  await expect(page.getByLabel("服务端口", { exact: true })).toHaveValue("58169");
  await expect(page.getByLabel("服务端口", { exact: true })).toBeEnabled();
  await expect(page.getByRole("switch", { name: "跟随应用自动启动", exact: true })).not.toBeChecked();
  await page.getByRole("switch", { name: "跟随应用自动启动", exact: true }).check();
  await expect(page.getByRole("switch", { name: "跟随应用自动启动", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "停止服务", exact: true })).toBeEnabled();
  await page.getByRole("switch", { name: "跟随应用自动启动", exact: true }).uncheck();
  await expect(page.getByRole("switch", { name: "跟随应用自动启动", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "查看服务密钥", exact: true }).click();
  await expect(page.getByLabel("服务密钥", { exact: true })).toHaveValue("test-only-display-value");
  await expect(page.getByLabel("服务密钥", { exact: true })).toHaveAttribute("readonly", "");
  await page.getByRole("button", { name: "隐藏服务密钥", exact: true }).click();
  await expect(page.getByLabel("服务密钥", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "查看服务密钥", exact: true }).click();
  await expect(page.getByLabel("服务密钥", { exact: true })).toHaveAttribute("type", "text");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.getByLabel("服务密钥", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByLabel("服务密钥", { exact: true })).toHaveValue("");
  await page.getByLabel("服务端口", { exact: true }).fill("80");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await page.getByLabel("服务端口", { exact: true }).fill("58170");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".codex-gateway").getByText("http://127.0.0.1:58170/v1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止服务", exact: true })).toBeEnabled();
  await page.getByLabel("服务端口", { exact: true }).fill("58171");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("端口已被占用");
  await expect(page.locator(".codex-gateway").getByText("http://127.0.0.1:58170/v1", { exact: true })).toBeVisible();
  await page.getByLabel("服务端口", { exact: true }).fill("58169");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".codex-gateway").getByText("http://127.0.0.1:58169/v1", { exact: true })).toBeVisible();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const config = page.locator(".codex-config-sections");
    expect(await config.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await config.screenshot({ path: `test-results/codex-api-config-save-${width}.png` });
    expect(await page.locator(".codex-gateway").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.setViewportSize({ width, height: width <= 768 ? 3600 : 1800 });
    await page.locator(".codex-gateway").scrollIntoViewIfNeeded();
    await page.locator(".codex-gateway").screenshot({ path: `test-results/codex-api-reference-${width}.png` });
  }
  await page.getByRole("button", { name: "服务账号池", exact: true }).click();
  await expect(page.getByText("70% 剩余（缓存）", { exact: false })).toBeVisible();
  await expect(page.getByRole("group", { name: "API 反代服务账号" }).getByLabel("Alice 工作账号", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "全选账号", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "最大化服务账号池", exact: true }).click();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.locator(".codex-pool-dialog").evaluate(element => { const rect = element.getBoundingClientRect(); return rect.right <= innerWidth && rect.left >= 0 && rect.top >= 0 && rect.bottom <= innerHeight && element.scrollWidth <= element.clientWidth; })).toBe(true);
    await page.screenshot({ path: `test-results/codex-pool-dialog-${width}.png` });
  }
  await page.getByRole("button", { name: "还原服务账号池", exact: true }).click();
  await page.getByRole("button", { name: "关闭服务账号池", exact: true }).click();
  await page.getByLabel("账号选择规则", { exact: true }).selectOption("quota_first");
  await page.getByLabel("失败冷却秒数", { exact: true }).fill("0");
  await expect(page.getByRole("button", { name: "保存轮询规则", exact: true })).toBeDisabled();
  await page.getByLabel("失败冷却秒数", { exact: true }).fill("120");
  await page.getByRole("button", { name: "保存轮询规则", exact: true }).click();
  await expect(page.getByText("轮询规则已保存并生效", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "调用日志", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "调用日志", exact: true })).toBeVisible();
  await expect(page.getByLabel("记录调用日志", { exact: true })).not.toBeChecked();
  await page.getByLabel("记录调用日志", { exact: true }).check();
  await expect(page.getByText("调用日志已开启", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "刷新日志", exact: true }).click();
  await expect(page.getByRole("region", { name: "调用日志列表", exact: true })).toContainText("200 / 200");
  await expect(page.getByRole("region", { name: "调用日志列表", exact: true })).toContainText("输入 12 / 输出 4");
  await page.getByRole("button", { name: "放大调用日志", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "调用日志", exact: true })).toHaveClass(/codex-log-expanded/);
  await page.getByRole("button", { name: "还原调用日志", exact: true }).click();
  await page.getByRole("button", { name: "查看调用 log-fixture 详情", exact: true }).click();
  const detailDialog = page.getByRole("dialog", { name: "调用详情", exact: true });
  await expect(detailDialog).toBeVisible();
  await page.getByRole("button", { name: "放大调用详情", exact: true }).click();
  await expect(detailDialog).toHaveClass(/codex-log-expanded/);
  await expect(page.getByLabel("客户端上送参数", { exact: true })).toContainText('"max_output_tokens": 100');
  await expect(page.getByLabel("网关上送参数（转换后）", { exact: true })).toContainText('"store": false');
  await expect(page.getByLabel("返回参数", { exact: true })).toContainText('"output_tokens": 4');
  await page.getByText("流式事件 · 1 / 1", { exact: true }).click();
  await expect(page.getByLabel("流式事件", { exact: true })).toContainText("response.completed");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await detailDialog.getByRole("heading", { name: "调用详情", exact: true }).scrollIntoViewIfNeeded();
    expect(await detailDialog.evaluate((element) => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1 && element.scrollWidth <= element.clientWidth; })).toBe(true);
    await page.screenshot({ path: `test-results/codex-gateway-monitoring-${width}.png` });
  }
  await page.getByRole("button", { name: "还原调用详情", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(detailDialog).toBeHidden();
  await expect(page.getByRole("dialog", { name: "调用日志", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看调用 log-fixture 详情", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "查看调用 log-fixture 详情", exact: true }).click();
  await expect(detailDialog).toBeVisible();
  await page.getByRole("button", { name: "关闭调用详情", exact: true }).click();
  await expect(detailDialog).toBeHidden();
  await page.getByLabel("记录调用日志", { exact: true }).uncheck();
  await expect(page.getByText("调用日志已关闭", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "调用日志列表", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "清空日志", exact: true }).click();
  await expect(page.getByRole("region", { name: "调用日志列表", exact: true })).toBeHidden();
  await expect(page.getByText("日志记录已关闭，开启后可查看调用状态。", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "调用日志", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "调用日志", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "获取模型列表", exact: true }).click();
  await expect(page.getByText("已获取 2 个模型 ID", { exact: true })).toBeVisible();
  await page.getByLabel("选择模型 ID", { exact: true }).selectOption("fixture-model-two");
  await expect(page.getByPlaceholder("填写账号可用的模型 ID")).toHaveValue("fixture-model-two");
  await expect(page.getByRole("button", { name: "复制 OpenAI 协议 Base URL", exact: true })).toBeEnabled();
  await expect(page.locator(".codex-protocol-card")).toHaveCount(3);
  await expect(page.locator(".codex-protocol-card.is-unavailable")).toHaveCount(0);
  await expect(page.locator(".protocol-openai")).toContainText("/v1/responses (Codex)");
  await expect(page.locator(".protocol-anthropic")).toContainText("/v1/messages");
  await expect(page.locator(".protocol-gemini")).toContainText(":streamGenerateContent");
  await page.getByRole("button", { name: "刷新统计", exact: true }).click();
  await expect(page.getByText("服务统计已刷新", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "复制服务密钥", exact: true }).click();
  await expect(page.getByText("本地服务密钥已复制；停止和重启后保持不变", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止服务", exact: true }).click();
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(page.getByRole("button", { name: "启动反代服务", exact: true })).toBeVisible();
  await expect(page.getByLabel("服务端口", { exact: true })).toHaveValue("58169");
  await expect(page.getByLabel("服务密钥", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("选择模型 ID", { exact: true }).locator('optgroup[label="官方目录返回"]')).toHaveCount(0);
  await lanToggle.check();
  await expect(page.locator(".codex-lan-url code")).toHaveText("http://192.168.1.23:58169/v1");
  await expect(page.getByRole("button", { name: "复制分享配置", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "启动反代服务", exact: true }).click();
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(page.locator(".codex-gateway").getByText("http://127.0.0.1:58169/v1", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => { const calls = (window as unknown as { __codexCalls: { command: string; args: { port: number; serviceKey: string | null } }[] }).__codexCalls.filter((v) => v.command === "codex_gateway_start"); return calls.length === 2 && calls[1].args.port === 58169 && calls[1].args.serviceKey === null; })).toBe(true);
  await page.getByRole("combobox", { name: "选择局域网网络", exact: true }).selectOption("172.18.0.1");
  await expect(page.locator(".codex-lan-url code")).toHaveText("http://172.18.0.1:58169/v1");
  await expect(page.getByRole("combobox", { name: "选择局域网网络", exact: true })).toContainText("vEthernet · Virtual switch · 172.18.0.1");
  await page.getByRole("button", { name: "复制分享配置", exact: true }).click();
  await expect(page.getByText("局域网地址和服务密钥已复制，可发给同一局域网的朋友", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: {command:string}[] }).__codexCalls.filter(call => call.command === "codex_gateway_copy_share_config").length)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: {command:string;args:{ip:string}}[] }).__codexCalls.find(call => call.command === "codex_gateway_copy_share_config")?.args.ip)).toBe("172.18.0.1");
  await expect(page.getByLabel("服务密钥", { exact: true })).toHaveValue("");
  await page.locator(".codex-config-card").screenshot({ path: "test-results/codex-lan-share-config.png" });
  await page.getByRole("button", { name: "停止服务", exact: true }).click();
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await lanToggle.uncheck();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter((v) => v.command === "codex_wake_account").length)).toBe(2);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const panel of ["账号总览", "API 反代服务", "应用多开"]) {
      await page.getByRole("tab", { name: panel, exact: true }).click();
      await expect(page.getByRole("tab", { name: panel, exact: true })).toHaveAttribute("aria-selected", "true");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.getByRole("tab", { name: "API 反代服务", exact: true }).click();
  await page.getByRole("button", { name: "服务账号池", exact: true }).click();
  await page.getByRole("group", { name: "API 反代服务账号" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/codex-gateway-layout.png" });
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.locator(".codex-api-card").filter({ has: page.getByRole("heading", { name: "多协议支持", exact: true }) }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/codex-protocol-layout.png" });
  await page.getByRole("tab", { name: "账号总览", exact: true }).click();
  await page.getByRole("button", { name: "Codex 设置", exact: true }).click();
  await page.getByRole("dialog", { name: "Codex 设置", exact: true }).getByRole("button", { name: "远端请求与正文日志", exact: true }).click();
  const remoteDialog=page.getByRole("dialog", {name:"远端 API 日志",exact:true});
  await expect(remoteDialog).toBeVisible();
  await expect(remoteDialog.getByRole("checkbox",{name:"记录远端 API 日志"})).not.toBeChecked();
  await remoteDialog.getByRole("checkbox",{name:"记录远端 API 日志"}).check();
  await expect(remoteDialog.getByText("账号代理：http://127.0.0.1:10808/",{exact:true})).toBeVisible();
  await remoteDialog.getByRole("button",{name:"查看远端日志 remote-fixture"}).click();
  const remoteDetail=page.getByRole("dialog",{name:"远端 API 调用详情",exact:true});
  await expect(remoteDetail.getByLabel("发送参数与请求头")).toContainText("[凭据或身份已隐藏]");
  await expect(remoteDetail.getByLabel("返回参数与响应头")).toContainText("fixture answer");
  for (const width of [375,768,1024,1440]) {
    await page.setViewportSize({width,height:900});
    expect(await remoteDetail.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  }
  await page.screenshot({path:"test-results/codex-remote-log-detail.png"});
  await remoteDetail.getByRole("button",{name:"放大远端详情"}).click();
  await remoteDetail.getByRole("button",{name:"还原远端详情"}).click();
  await remoteDetail.getByRole("button",{name:"关闭远端详情"}).click();
  await page.screenshot({path:"test-results/codex-remote-logs.png"});
  await remoteDialog.getByRole("button",{name:"清空日志",exact:true}).click();
  await expect(remoteDialog.getByRole("button",{name:"查看远端日志 remote-fixture"})).toHaveCount(0);
  await remoteDialog.getByRole("button",{name:"关闭远端日志"}).click();
  if (await page.getByRole("button", { name: "清空选择", exact: true }).isEnabled()) await page.getByRole("button", { name: "清空选择", exact: true }).click();
  await expect(page.getByRole("button", { name: "批量设置代理 (0)", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "全选", exact: true }).check();
  await page.getByRole("button", { name: "批量设置代理 (2)", exact: true }).click();
  const batchProxy = page.getByRole("dialog", { name: "批量设置代理", exact: true });
  await batchProxy.getByLabel("批量代理地址", { exact: true }).fill("127.0.0.1:10808");
  await batchProxy.getByRole("button", { name: "保存到 2 个账号", exact: true }).click();
  await expect(batchProxy.getByRole("alert")).toContainText("缺少协议");
  await batchProxy.getByLabel("批量代理地址", { exact: true }).fill("http://127.0.0.1:7891/");
  await batchProxy.getByRole("button", { name: "保存到 2 个账号", exact: true }).click();
  await expect(batchProxy.getByRole("alert")).toContainText("未修改任何账号");
  await batchProxy.getByRole("button", { name: "检测本机代理", exact: true }).click();
  await batchProxy.getByLabel("检测到的批量代理", { exact: true }).selectOption("http://127.0.0.1:10808/");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await batchProxy.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: "test-results/codex-batch-proxy.png" });
  await batchProxy.getByRole("button", { name: "保存到 2 个账号", exact: true }).click();
  await expect(batchProxy).not.toBeVisible();
  await expect(page.getByRole("button", { name: /^配置 .* 代理$/ }).filter({ hasText: "代理已设" })).toHaveCount(2);
  await page.getByRole("button", { name: "批量设置代理 (2)", exact: true }).click();
  await batchProxy.getByLabel("批量代理地址", { exact: true }).fill("");
  await batchProxy.getByRole("button", { name: "清除 2 个账号代理", exact: true }).click();
  await expect(batchProxy).not.toBeVisible();
  await expect(page.getByRole("button", { name: /^配置 .* 代理$/ }).filter({ hasText: "代理已设" })).toHaveCount(0);
  await page.getByRole("button", { name: "清空选择", exact: true }).click();
  await page.getByRole("button", { name: "配置 Alice 工作账号 代理", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "账号代理", exact: true })).toBeVisible();
  await page.getByLabel("账号代理地址", { exact: true }).fill("invalid");
  await page.getByRole("button", { name: "保存代理", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "账号代理", exact: true }).getByRole("alert")).toHaveText("代理地址缺少协议，请填写 http://127.0.0.1:10808 这样的完整地址");
  await page.getByLabel("账号代理地址", { exact: true }).fill("http://127.0.0.1:7891/");
  await page.getByRole("button", { name: "保存代理", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "账号代理", exact: true }).getByRole("alert")).toHaveText("请先停止该账号的服务或实例，再修改代理");
  await page.getByRole("button", { name: "检测本机代理", exact: true }).click();
  await page.getByLabel("检测到的代理", { exact: true }).selectOption("http://127.0.0.1:10808/");
  await expect(page.getByLabel("账号代理地址", { exact: true })).toHaveValue("http://127.0.0.1:10808/");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.getByRole("dialog", { name: "账号代理", exact: true }).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: "test-results/codex-proxy-detection.png" });
  await page.evaluate(() => { (window as unknown as { __proxyMode: string }).__proxyMode = "empty"; });
  await page.getByRole("button", { name: "检测本机代理", exact: true }).click();
  await expect(page.getByText("未检测到可用的 HTTP/HTTPS 代理配置，请在代理软件中查看地址并手动填写。")).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __proxyMode: string }).__proxyMode = "error"; });
  await page.getByRole("button", { name: "检测本机代理", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "账号代理", exact: true }).getByRole("alert")).toHaveText("读取本机代理配置失败，请手动填写代理地址");
  await page.evaluate(() => { (window as unknown as { __proxyMode: string }).__proxyMode = "unsafe"; });
  await page.getByRole("button", { name: "检测本机代理", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "账号代理", exact: true }).getByRole("alert")).toHaveText("代理操作失败，请检查地址或手动填写");
  await page.getByLabel("账号代理地址", { exact: true }).fill("http://127.0.0.1:7890/");
  await page.getByRole("button", { name: "保存代理", exact: true }).click();
  await expect(page.getByRole("button", { name: "配置 Alice 工作账号 代理", exact: true })).toHaveText("代理已设");
  await page.getByRole("button", { name: "刷新 Alice 工作账号 订阅与重置次数", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看 Alice 工作账号 重置次数", exact: true })).toHaveText("重置 3");
  await expect(page.getByRole("article", { name: "Codex 账号 Alice 工作账号", exact: true }).getByText(/订阅有效期 \d+ 天/)).toBeVisible();
  const subscriptionDetails = page.getByRole("article", { name: "Codex 账号 Alice 工作账号", exact: true }).locator(".codex-benefit-details");
  await expect(subscriptionDetails).not.toHaveAttribute("open");
  await expect(subscriptionDetails.locator("small")).toHaveCount(0);
  await subscriptionDetails.locator("summary").click();
  await expect(subscriptionDetails.locator("small").first()).toBeVisible();
  await subscriptionDetails.locator("summary").click();
  await expect(subscriptionDetails.locator("small")).toHaveCount(0);

  await page.getByRole("button", { name: "查看 Alice 工作账号 重置次数", exact: true }).click();
  await page.getByRole("dialog", { name: "主动重置额度", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: {command:string}[] }).__codexCalls.filter(call=>call.command==="codex_consume_reset").length)).toBe(0);
  await page.getByRole("button", { name: "查看 Alice 工作账号 重置次数", exact: true }).click();
  await page.getByRole("button", { name: "按官方规则重置", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看 Alice 工作账号 重置次数", exact: true })).toHaveText("重置 0");
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: {command:string}[] }).__codexCalls.filter(call=>call.command==="codex_consume_reset").length)).toBe(1);
  for (const width of [375,768,1024,1440]) { await page.setViewportSize({width,height:1000}); expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true); await page.screenshot({path:`test-results/codex-account-controls-${width}.png`}); }
  await page.getByRole("tab", { name: "应用多开", exact: true }).click();
  await expect(page.getByRole("tab", { name: "应用多开", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "应用多开", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/codex-instances-layout.png" });
  await page.getByRole("tab", { name: "账号总览", exact: true }).click();
  await page.locator(".codex-heading").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/codex-management.png", fullPage: true });
  await page.getByRole("button", { name: "删除 Alice 工作账号", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Alice 工作账号" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  await page.getByRole("tab", { name: "API 反代服务", exact: true }).click();
  await page.getByRole("button", { name: "服务账号池", exact: true }).click();
  await expect(page.getByRole("group", { name: "API 反代服务账号" }).getByLabel("alice@example.test", { exact: true })).toBeChecked();
  await expect(page.getByRole("group", { name: "API 反代服务账号" }).getByLabel("second@example.test", { exact: true })).not.toBeChecked();
});
