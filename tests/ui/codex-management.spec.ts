import { test, expect } from "@playwright/test";
import { quotaPresentation, remainingPercent } from "../../src/features/codex/quotaPresentation";
import type { CodexAccount } from "../../src/platform/clients/codex";

test("Codex quota presentation treats stale, reset, invalid and failed data as unknown availability", () => {
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
  await page.addInitScript(() => {
    const calls: { command: string; args: unknown }[] = [];
    let accounts = [{ id: 1, label: "alice@example.test", email: "alice@example.test", accountId: "workspace-a", authMode: "chatgpt", plan: "plus", note: "开发账号", tags: ["工作"], quota: { fetchedAt: 1791620000000, windows: [{ name: "codex", usedPercent: 30, windowMinutes: 300, resetsAt: 1791700000 }] }, lastError: null as string | null, updatedAt: 1, proxyUrl: null as string | null, benefits: { expiresAt: null as number | null, resetCredits: null as number | null, resetExpiresAt: null as number | null, fetchedAt: null as number | null, subscriptionError: null as string | null, creditsError: null as string | null } }, { id: 2, label: "second@example.test", email: "second@example.test", accountId: "workspace-b", authMode: "chatgpt", plan: "free", note: "", tags: [], quota: { fetchedAt: null as number | null, windows: [] as { name: string; usedPercent: number; windowMinutes: number; resetsAt: number }[] }, lastError: null as string | null, updatedAt: 1, proxyUrl: null as string | null, benefits: { expiresAt: null as number | null, resetCredits: null as number | null, resetExpiresAt: null as number | null, fetchedAt: null as number | null, subscriptionError: null as string | null, creditsError: null as string | null } }];
    let currentAccountId = 1;
    let loginPolls = 0;
    let consumedResets = 0;
    let gateway = { running: false, address: null as string | null, accountIds: [] as number[], completed: 0, failed: 0, active: 0, supportsCustomKey: true, supportsModels: true, supportsRemoteModels: true, supportsPersistentConfig: true, configuredPort: 58169, settings: { loggingEnabled: false, strategy: "round_robin", cooldownSeconds: 60 } };
    let logs: { id: string; timestamp: number; endpoint: string; model: string; accountId: number; status: number; upstreamStatus: number; outcome: string; streaming: boolean; durationMs: number; inputTokens: number; outputTokens: number }[] = [];
    let instances: { id: string; accountId: number; name: string; workDir: string; kind: "cli" | "desktop"; running: boolean; lastError: null }[] = [];
    const state = () => ({ accounts, cliAvailable: true, desktopAvailable: true, canOpenDefault: true, profileHome: "C:\\fixture\\.codex", currentAccountId, canRestore: false });
    Object.assign(window, {
      __codexCalls: calls,
      __holdBenefits: false,
      __releaseBenefits: () => {},
      __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string, args: { url?: string; settings?: { loggingEnabled: boolean; strategy: string; cooldownSeconds: number }; id?: number; token?: string; kind?: "cli" | "desktop"; input?: { id: number; label: string; note: string; tags: string[] } }) => {
          if (command.startsWith("codex_")) calls.push({ command, args });
          if (command === "codex_save_proxy") { const account=accounts.find(v=>v.id===args.id)!; if (args.url === "invalid") throw new Error("代理地址无效"); account.proxyUrl=args.url || null; return account; }
          if (command === "codex_refresh_benefits") { const control=window as unknown as {__holdBenefits:boolean;__releaseBenefits:()=>void}; if(control.__holdBenefits) await new Promise<void>(resolve=>{control.__releaseBenefits=resolve;}); const account=accounts.find(v=>v.id===args.id)!; account.benefits={expiresAt:1893456000,resetCredits:3-consumedResets,resetExpiresAt:1893456000,fetchedAt:Date.now(),subscriptionError:null,creditsError:null}; return account; }
          if (command === "codex_consume_reset") { consumedResets++; const account=accounts.find(v=>v.id===args.id)!; account.benefits={expiresAt:null,resetCredits:null,resetExpiresAt:null,fetchedAt:null,subscriptionError:null,creditsError:null}; return account; }
          if (command === "codex_open_default") return;
          if (command === "codex_start_login") return { token: "login-fixture" };
          if (command === "codex_poll_login") return { status: ++loginPolls > 1 ? "completed" : "pending" };
          if (command === "codex_cancel_login") return;
          if (command === "codex_gateway_configure") { gateway.settings = args.settings!; if (gateway.settings.loggingEnabled && !logs.length) logs = [{ id: "log-fixture", timestamp: Date.now(), endpoint: "/v1/responses", model: "fixture-model", accountId: 1, status: 200, upstreamStatus: 200, outcome: "completed", streaming: true, durationMs: 250, inputTokens: 12, outputTokens: 4 }]; return gateway; }
          if (command === "codex_gateway_log_detail") return { request: { model: "fixture-model", input: [{ role: "user", content: "[内容已隐藏]" }], stream: true, max_output_tokens: 100 }, forwarded: { model: "fixture-model", stream: true, store: false }, response: { status: "completed", usage: { input_tokens: 12, output_tokens: 4 } }, events: [{ type: "response.completed" }], eventCount: 1, truncated: false };
          if (command === "codex_gateway_logs") return logs;
          if (command === "codex_gateway_clear_logs") { logs = []; return; }
          if (command === "codex_gateway_models") return ["fixture-model", "fixture-model-two"];
          if (command === "codex_gateway_state") return gateway;
          if (command === "codex_gateway_start") { gateway = { ...gateway, running: true, address: "http://127.0.0.1:58169/v1", accountIds: [1] }; return gateway; }
          if (command === "codex_gateway_stop") { gateway = { ...gateway, running: false, address: null }; return gateway; }
          if (command === "codex_gateway_copy_key") return;
          if (command === "codex_list_instances") return instances;
          if (command === "codex_create_instance") { instances = [{ id: "instance-fixture", accountId: 1, name: "开发实例", workDir: "C:\\fixture\\project", kind: args.kind!, running: false, lastError: null }]; return instances; }
          if (command === "codex_start_instance") { instances[0].running = true; return instances; }
          if (command === "codex_stop_instance") { instances[0].running = false; return instances; }
          if (command === "codex_get_state" || command === "codex_import_local") return state();
          if (command === "codex_import_file") return null;
          if (command === "codex_save_metadata") { accounts = accounts.map((v) => v.id === args.input!.id ? { ...v, ...args.input! } : v); return accounts.find((v) => v.id === args.input!.id); }
          if (command === "codex_refresh_quota") { const account = accounts.find((v) => v.id === args.id)!; account.lastError = "Codex 请求失败，请检查登录状态"; return account; }
          if (command === "codex_prepare_switch") return { token: "confirmation-fixture", accountLabel: "second@example.test", profileHome: "C:\\fixture\\.codex", hasPreviousAuth: true };
          if (command === "codex_confirm_switch") { currentAccountId = 2; return state(); }
          if (command === "codex_delete_account") { accounts = accounts.filter((v) => v.id !== args.id); return state(); }
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
  await expect(page.getByRole("tab", { name: "账号总览", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "本地 API 服务", exact: false })).toBeHidden();
  const toolbarCenters = await page.locator('.codex-toolbar-filters input, .codex-toolbar-filters select').evaluateAll((controls) => controls.map((control) => { const box = control.getBoundingClientRect(); return box.top + box.height / 2; }));
  expect(Math.max(...toolbarCenters) - Math.min(...toolbarCenters)).toBeLessThan(1);
  await page.locator('.codex-toolbar').screenshot({ path: 'test-results/codex-toolbar-alignment.png' });
  await page.getByRole("button", { name: "启动 Codex", exact: true }).click();
  await expect(page.getByText("已请求打开默认 Codex 客户端", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter((v) => v.command === "codex_open_default").length)).toBe(1);
  await page.getByRole("button", { name: "登录新账号", exact: true }).click();
  await expect(page.getByText("已打开 Codex 官方登录页面", { exact: false })).toBeVisible();
  await expect(page.getByText("官方登录完成，账号已加密保存", { exact: true })).toBeVisible();
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
  await expect(page.locator('.codex-card').first()).toHaveAttribute("aria-label","Codex 账号 alice@example.test");
  await page.getByLabel("选择 second@example.test",{exact:true}).check();
  await page.getByLabel("筛选 Codex 套餐").selectOption("plus");
  await expect(page.getByRole("button",{name:"刷新所选订阅权益",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"清空选择",exact:true}).click();
  const benefitsBefore = await page.evaluate(()=>(window as unknown as {__codexCalls:{command:string}[]}).__codexCalls.filter(call=>call.command==="codex_refresh_benefits").length);
  await page.getByRole("button",{name:"刷新列表订阅权益",exact:true}).click();
  await expect(page.getByText("已处理 1 / 1 个账号，订阅权益已更新",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {__codexCalls:{command:string;args:{id:number}}[]}).__codexCalls.filter(call=>call.command==="codex_refresh_benefits").slice(-1)[0].args.id)).toBe(1);
  await page.getByRole("button",{name:"清除筛选",exact:true}).click();
  await page.evaluate(() => { (window as unknown as {__holdBenefits:boolean}).__holdBenefits=true; });
  await page.getByRole("button",{name:"刷新列表订阅权益",exact:true}).click();
  await expect(page.getByRole("progressbar",{name:"账号刷新进度"})).toHaveAttribute("value","0");
  await page.getByRole("button",{name:"停止后续刷新",exact:true}).click();
  await expect(page.getByRole("button",{name:"等待当前账号完成",exact:true})).toBeDisabled();
  await page.evaluate(() => { const control=window as unknown as {__holdBenefits:boolean;__releaseBenefits:()=>void};control.__holdBenefits=false;control.__releaseBenefits(); });
  await expect(page.getByText("已停止后续刷新，已处理 1 / 2 个账号，订阅权益已更新",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {__codexCalls:{command:string}[]}).__codexCalls.filter(call=>call.command==="codex_refresh_benefits").length)).toBe(benefitsBefore+2);
  expect(await page.evaluate(()=>(window as unknown as {__codexCalls:{command:string}[]}).__codexCalls.filter(call=>call.command==="codex_consume_reset").length)).toBe(0);
  await page.getByRole("button", { name: "编辑 alice@example.test 备注" }).click();
  await page.getByLabel("账号名称", { exact: true }).fill("Alice 工作账号");
  await page.getByLabel("标签（逗号分隔）").fill("项目A, 测试");
  await page.getByRole("button", { name: "保存账号信息" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Alice 工作账号" })).toBeVisible();
  await page.getByRole("button", { name: "刷新 Alice 工作账号 额度" }).click();
  await expect(page.getByText("Codex 请求失败，请检查登录状态", { exact: true })).toBeVisible();
  await expect(page.getByText("70% 剩余", { exact: true })).toBeVisible();
  await page.getByRole("article", { name: "Codex 账号 second@example.test" }).getByRole("button", { name: "切换", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const before = await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter((v) => v.command === "codex_confirm_switch").length);
  expect(before).toBe(0);
  await page.getByRole("button", { name: "已结束任务，确认切换" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("article", { name: "Codex 账号 second@example.test" }).getByText("当前默认账号")).toBeVisible();
  await page.getByRole("button", { name: "创建 Alice 工作账号 独立实例" }).click();
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
  await page.getByRole("tab", { name: "API 服务", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "应用多开", exact: true })).toBeHidden();
  await expect(page.getByText("点击“服务账号池”选择至少一个账号，再启动本地服务。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "启动本地服务", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "获取模型列表", exact: true })).toBeDisabled();
  await page.getByLabel("选择模型 ID", { exact: true }).selectOption("gpt-6.1-sol");
  await expect(page.getByPlaceholder("填写账号可用的模型 ID")).toHaveValue("gpt-6.1-sol");
  await expect(page.getByLabel("选择模型 ID", { exact: true }).locator('optgroup[label="推荐模型（未验证账号权限）"] option')).toHaveCount(8);
  await expect(page.getByRole("group", { name: "本地 API 服务账号" })).toBeHidden();
  await page.getByRole("button", { name: "服务账号池", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "服务账号池", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "全选账号", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.getByRole("button", { name: "启动本地服务", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "服务账号池", exact: true }).click();
  await page.getByRole("button", { name: "清空选择", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByPlaceholder("填写账号可用的模型 ID").fill("fixture-model");
  await page.getByRole("button", { name: "服务账号池", exact: true }).click();
  await page.getByRole("group", { name: "本地 API 服务账号" }).getByLabel("Alice 工作账号", { exact: true }).check();
  await page.getByRole("button", { name: "唤醒所选账号", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "唤醒 Codex 账号", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "服务账号池", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "服务账号池", exact: true })).toBeFocused();
  await page.getByRole("tab", { name: "API 服务", exact: true }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "应用多开", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "创建独立实例", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "应用多开", exact: true }).press("ArrowLeft");
  await expect(page.getByPlaceholder("填写账号可用的模型 ID")).toHaveValue("fixture-model");
  await page.getByRole("button", { name: "服务账号池", exact: true }).click();
  await expect(page.getByRole("group", { name: "本地 API 服务账号" }).getByLabel("Alice 工作账号", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByLabel("服务密钥", { exact: true }).fill("short");
  await expect(page.getByRole("button", { name: "启动本地服务", exact: true })).toBeDisabled();
  await page.getByLabel("服务密钥", { exact: true }).fill("test-only-".repeat(4));
  await page.getByLabel("服务端口", { exact: true }).fill("80");
  await expect(page.getByRole("button", { name: "启动本地服务", exact: true })).toBeDisabled();
  await page.getByLabel("服务端口", { exact: true }).fill("58169");
  await page.getByRole("button", { name: "启动本地服务", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "启动本地 API 服务", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter((v) => v.command === "codex_gateway_start").length)).toBe(0);
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(page.getByText("http://127.0.0.1:58169/v1", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => { const call = (window as unknown as { __codexCalls: { command: string; args: { port: number; serviceKey: string } }[] }).__codexCalls.find((v) => v.command === "codex_gateway_start"); return call?.args.port === 58169 && call.args.serviceKey === "test-only-".repeat(4); })).toBe(true);
  await expect(page.getByLabel("服务端口", { exact: true })).toHaveValue("58169");
  await expect(page.getByLabel("服务端口", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "服务账号池", exact: true }).click();
  await expect(page.getByText("70% 剩余（缓存）", { exact: false })).toBeVisible();
  await expect(page.getByRole("group", { name: "本地 API 服务账号" }).getByLabel("Alice 工作账号", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "全选账号", exact: true })).toBeDisabled();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.locator(".codex-pool-dialog").evaluate(element => element.getBoundingClientRect().right <= innerWidth && element.getBoundingClientRect().left >= 0)).toBe(true);
    await page.screenshot({ path: `test-results/codex-pool-dialog-${width}.png` });
  }
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
  await page.getByRole("button", { name: "查看调用 log-fixture 详情", exact: true }).click();
  await expect(page.getByLabel("客户端上送参数", { exact: true })).toContainText('"max_output_tokens": 100');
  await expect(page.getByLabel("网关上送参数（转换后）", { exact: true })).toContainText('"store": false');
  await expect(page.getByLabel("返回参数", { exact: true })).toContainText('"output_tokens": 4');
  await page.getByText("流式事件 · 1 / 1", { exact: true }).click();
  await expect(page.getByLabel("流式事件", { exact: true })).toContainText("response.completed");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole("heading", { name: "调用日志", exact: false }).scrollIntoViewIfNeeded();
    expect(await page.locator(".codex-log-dialog").evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `test-results/codex-gateway-monitoring-${width}.png` });
  }
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
  await expect(page.getByRole("button", { name: "复制 Responses 接入配置", exact: true })).toBeEnabled();
  await expect(page.locator(".codex-protocol-card.is-unavailable")).toHaveCount(3);
  await page.getByRole("button", { name: "刷新统计", exact: true }).click();
  await expect(page.getByText("服务统计已刷新", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "复制服务密钥", exact: true }).click();
  await expect(page.getByText("本地服务密钥已复制；停止和重启后保持不变", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止服务", exact: true }).click();
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(page.getByRole("button", { name: "启动本地服务", exact: true })).toBeVisible();
  await expect(page.getByLabel("服务端口", { exact: true })).toHaveValue("58169");
  await expect(page.getByLabel("服务密钥", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("选择模型 ID", { exact: true }).locator('optgroup[label="官方目录返回"]')).toHaveCount(0);
  await page.getByRole("button", { name: "启动本地服务", exact: true }).click();
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(page.getByText("http://127.0.0.1:58169/v1", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => { const calls = (window as unknown as { __codexCalls: { command: string; args: { port: number; serviceKey: string | null } }[] }).__codexCalls.filter((v) => v.command === "codex_gateway_start"); return calls.length === 2 && calls[1].args.port === 58169 && calls[1].args.serviceKey === null; })).toBe(true);
  await page.getByRole("button", { name: "停止服务", exact: true }).click();
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: { command: string }[] }).__codexCalls.filter((v) => v.command === "codex_wake_account").length)).toBe(0);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const panel of ["账号总览", "API 服务", "应用多开"]) {
      await page.getByRole("tab", { name: panel, exact: true }).click();
      await expect(page.getByRole("tab", { name: panel, exact: true })).toHaveAttribute("aria-selected", "true");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.getByRole("tab", { name: "API 服务", exact: true }).click();
  await page.getByRole("button", { name: "服务账号池", exact: true }).click();
  await page.getByRole("group", { name: "本地 API 服务账号" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/codex-gateway-layout.png" });
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.locator(".codex-api-card").filter({ has: page.getByRole("heading", { name: "协议兼容", exact: true }) }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/codex-protocol-layout.png" });
  await page.getByRole("tab", { name: "账号总览", exact: true }).click();
  await page.getByRole("button", { name: "配置 Alice 工作账号 代理", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "账号代理", exact: true })).toBeVisible();
  await page.getByLabel("账号代理地址", { exact: true }).fill("invalid");
  await page.getByRole("button", { name: "保存代理", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "账号代理", exact: true }).getByRole("alert")).toHaveText("输入参数无效，请检查后重试");
  await page.getByLabel("账号代理地址", { exact: true }).fill("http://127.0.0.1:7890/");
  await page.getByRole("button", { name: "保存代理", exact: true }).click();
  await expect(page.getByRole("button", { name: "配置 Alice 工作账号 代理", exact: true })).toHaveText("代理已设");
  await page.getByRole("button", { name: "刷新 Alice 工作账号 订阅与重置次数", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看 Alice 工作账号 重置次数", exact: true })).toHaveText("重置 3");
  await expect(page.getByText(/订阅有效期 \d+ 天/)).toBeVisible();
  await page.getByRole("button", { name: "查看 Alice 工作账号 重置次数", exact: true }).click();
  await page.getByRole("dialog", { name: "主动重置额度", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __codexCalls: {command:string}[] }).__codexCalls.filter(call=>call.command==="codex_consume_reset").length)).toBe(0);
  await page.getByRole("button", { name: "查看 Alice 工作账号 重置次数", exact: true }).click();
  await page.getByRole("button", { name: "确认消耗一次并重置", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看 Alice 工作账号 重置次数", exact: true })).toHaveText("重置 —");
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
});
