import { expect, test } from "@playwright/test";

test("mobile account groups suggest existing names and allow new names", async ({ page }) => {
  await page.route("**/api/accounts**", route => route.fulfill({json:[{id:1,account_name:"测试账号",cloud_type:"aliyun",access_key_id:"test-only-id",group_name:"生产",enabled:true,sort_order:0}]}));
  await page.route("**/api/local-assets**", route => route.fulfill({json:[]}));
  await page.goto("/");
  await page.getByRole("button",{name:"添加账号",exact:true}).first().click();
  const group=page.locator(".mobile-account-form").getByLabel("分组",{exact:true});
  await expect.poll(()=>group.evaluate((el:HTMLInputElement)=>Array.from(el.list!.options,option=>option.value))).toEqual(["生产"]);
  await group.fill("生产");await expect(group).toHaveValue("生产");
  await group.fill("新分组");await expect(group).toHaveValue("新分组");
});

test("mobile AI settings allow browser configuration and fit 375px", async ({ page }) => {
  await page.setViewportSize({ width:375,height:844 });
  await page.route("**/api/accounts**",route=>route.fulfill({json:[]}));await page.route("**/api/local-assets**",route=>route.fulfill({json:[]}));
  await page.goto("/");await page.locator(".mobile-tab-bar").getByRole("button",{name:"更多"}).click();await page.getByRole("button",{name:"系统设置"}).click();
  await expect(page.getByRole("heading",{name:"AI 服务"})).toBeVisible();await expect(page.getByRole("button",{name:"添加服务",exact:true})).toBeEnabled();
  const dimensions=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
});

test("native mobile AI config form and encrypted transfer remain within the viewport",async({page})=>{
  await page.setViewportSize({width:375,height:844});
  await page.addInitScript(()=>{(window as any).__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string)=>{
    if(command==="authenticator_status")return{configured:false,unlocked:false};if(command==="list_client_preferences")return{};
    if(command==="get_sync_device_identity")return{deviceId:"fixture",publicKey:"fixture"};return[];
  }};});
  await page.goto("/");await page.locator(".mobile-tab-bar").getByRole("button",{name:"更多"}).click();await page.getByRole("button",{name:"系统设置"}).click();
  await page.getByRole("button",{name:"添加服务",exact:true}).click();
  await page.getByLabel("模型名称", {exact:true}).fill("fixture-model");
  await page.getByRole("button", {name:"添加模型 ID"}).click();
  await page.getByLabel("模型 ID 2", {exact:true}).fill("fixture-other");
  await page.getByRole("radio", {name:"默认模型 2",exact:true}).check();
  await expect(page.getByLabel("模型名称", {exact:true})).toHaveValue("fixture-model");
  await page.getByText("高级设置",{exact:true}).click();
  await expect(page.getByLabel("配置名称")).toBeVisible();const dimensions=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  await page.screenshot({path:"test-results/mobile-ai-settings-375.png",fullPage:true});
  await page.getByRole("button",{name:"取消编辑AI服务",exact:true}).click();
  await page.getByText("AI配置文件迁移",{exact:true}).click();
});

test("native mobile SSH and panel forms expose optional AI drafts without touching credentials", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = { metadata:{currentWindow:{label:"main"},currentWebview:{label:"main"}},transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any) => {
      if (command === "ai_list_profiles") return [{ id: "fixture", name: "本地测试服务", protocol: "openai_chat", baseUrl: "http://127.0.0.1", model: "fixture", enabled: true, isDefault: true, timeoutSeconds: 20, maxOutputTokens: 512, allowLoopbackHttp: true, hasKey: true, updatedAt: 1, visionStatus: "unknown" }];
      if (command === "ai_preview") return { text: args.text, removedLines: 0 };
      if (command === "ai_run") return { requestId: args.input.requestId, inputTokens: 1, outputTokens: 1, draft: { summary: "测试草稿", fields: args.input.task === "server" ? { name: "AI主机", host: "host.example.test", port: 2222, username: "admin" } : { name: "AI面板", panel_url: "https://panel.example.test", group_name: "生产", remark: "测试面板" }, items: [], warnings: [], evidence: [] } };
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      return [];
    } };
  });
  await page.route("**/api/accounts**", route => route.fulfill({ json: [] }));
  await page.route("**/api/local-assets**", route => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多" }).click();
  await page.getByRole("button", { name: "SSH 终端" }).click();
  await page.getByRole("button", { name: "添加主机" }).click();
  const sshForm = page.locator(".mobile-account-form");
  await sshForm.getByRole("button", { name: "AI 识别主机信息" }).click();
  await expect(page.getByRole("dialog", { name: "AI 识别主机信息" })).toBeVisible();
  const sshAi = page.getByRole("dialog", { name: "AI 识别主机信息" });
  await sshAi.getByRole("textbox",{name:"分析内容",exact:true}).fill("SSH地址 host.example.test，端口2222，用户admin");

  await sshAi.getByRole("button", { name: "发送并分析" }).click();
  await sshAi.getByRole("button", { name: "勾选全部字段" }).click();
  await sshAi.getByRole("button", { name: "应用勾选字段" }).click();
  await expect(sshForm.getByLabel("主机地址")).toHaveValue("host.example.test");
  await expect(sshForm.getByLabel("SSH 端口")).toHaveValue("2222");
  await expect(sshForm.getByRole("textbox", { name: "SSH 密码" })).toHaveValue("");
  await sshForm.getByRole("button", { name: "关闭" }).click();
  await page.getByRole("button", { name: "更多" }).click();
  await page.locator(".mobile-more-feature").filter({ hasText: "运维面板" }).click();
  await page.getByRole("button", { name: "添加面板" }).click();
  const panelForm = page.locator(".mobile-account-form");
  await panelForm.getByRole("button", { name: "AI 识别面板信息" }).click();
  const panelAi = page.getByRole("dialog", { name: "AI 识别面板信息" });
  await panelAi.getByRole("textbox",{name:"分析内容",exact:true}).fill("面板地址 https://panel.example.test");

  await panelAi.getByRole("button", { name: "发送并分析" }).click();
  await panelAi.getByRole("button", { name: "应用勾选字段" }).click();
  await expect(panelForm.getByLabel("面板名称")).toHaveValue("AI面板");
  await expect(panelForm.getByLabel("分组", {exact:true})).toHaveValue("生产");
  await expect(panelForm.getByLabel("分组", {exact:true})).toHaveAttribute("list", /group-options-/);
  await expect(panelForm.getByLabel("分组", {exact:true})).toHaveAttribute("placeholder", "选择已有分组或输入新分组");
  await expect(panelForm.getByLabel("面板根地址")).toHaveValue("https://panel.example.test");
  await expect(panelForm.getByRole("textbox", { name: "API 密钥" })).toHaveValue("");
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
});
