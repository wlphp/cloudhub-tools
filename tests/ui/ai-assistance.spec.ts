import { expect, test, type Page } from "@playwright/test";
import { redactAiContext } from "../../src/features/ai/context";
import { sourceDimensions, validRect } from "../../src/features/ai/image";
import { panelAiFields } from "../../src/features/ai/panelDraft";
import { assetNoteCandidate } from "../../src/features/assets/aiNoteDraft";
import { assetSearchFilters, withinAssetExpiry } from "../../src/features/assets/aiSearch";
import { frpAiRule } from "../../src/features/frp/aiRuleDraft";
import { aiMonitorSummary, aiPanelMonitorSummary } from "../../src/features/servers/aiMonitorSummary";
import { reviewServerAiCandidates } from "../../src/features/servers/serverAiCandidates";
import { ossAiSummary, rdsAiSummary, redisAiSummary } from "../../src/features/resources/aiResourceSummary";

async function openAiSettings(page: Page) {
  await page.getByRole("button", { name: /^(系统设置|设置)$/ }).click();
  await page.getByRole("tab", { name: "AI 接入", exact: true }).click();
}

test("FRP drafts reject sensitive fields and invalid mappings and clear stale protocol settings",()=>{
  const current={serverId:1,name:"old",kind:"tcp" as const,localIp:"127.0.0.1",localPort:80,remotePort:9000,enabled:true};
  expect(frpAiRule(current,{local_port:3000,remote_port:9001}).localPort).toBe(3000);
  const changed=frpAiRule(current,{kind:"https",custom_domain:"app.example.test"});expect(changed.remotePort).toBeNull();expect(changed.customDomain).toBe("app.example.test");expect(changed.plugin).toBeNull();expect(changed.enabled).toBe(true);expect(changed.serverId).toBe(1);
  for(const fields of [{token:"test-only-secret"},{plugin:"private path"},{local_port:0},{local_port:65536},{remote_port:2.5},{local_ip:"https://example.test"},{custom_domain:"app.example.test"},{kind:"https",remote_port:9000},{kind:"http",custom_domain:"https://example.test/path"},{kind:"unknown"}])expect(()=>frpAiRule(current,fields)).toThrow();
});

test("monitor diagnosis exports only allowlisted numeric metrics", () => {
  const summary = JSON.parse(aiMonitorSummary({ ip: "192.0.2.10", os: "Linux secret-host", cpu: { usage: 82.5, cores: 4, model: "private hardware" }, memory: { used: 8, total: 16 }, network: { up_rate: 10, interface: "eth0" }, disk_io: { latency: 2 }, load: "1.2, 0.9, 0.8", processes: 120 }));
  expect(summary).toMatchObject({ load: "1.2, 0.9, 0.8", cpu: { cores: 4, usage_percent: 82.5 }, memory: { used_bytes: 8, total_bytes: 16 }, network: { upload_rate_bytes: 10 } });
  expect(JSON.stringify(summary)).not.toMatch(/192\.0\.2\.10|secret-host|private hardware|eth0/);
  expect(Object.keys(summary).sort()).toEqual(["active_processes", "cpu", "disk_io", "load", "memory", "network", "processes", "swap"]);
});

test("panel monitoring AI context omits host metadata and clamps untrusted measurements", () => {
  const summary = aiPanelMonitorSummary({ status: "online", load: "1.2 / 0.9 / 0.8", cpuPercent: 82.5, memoryPercent: 140, diskPercentages: [50, 101, null], });
  expect(JSON.parse(summary)).toEqual({ status: "online", load: "1.2 / 0.9 / 0.8", cpu_usage_percent: 82.5, memory_usage_percent: null, disk_usage_percentages: [50, null, null] });
  expect(summary).not.toContain("192.0.2");
});

test("server AI candidate review validates allowlisted fields and identifies stored and in-batch duplicates", () => {
  const existing = [{ id: 9, name: "已登记", host: "192.0.2.10", port: 22, username: "root", platform: "linux" }] as any;
  const candidates = reviewServerAiCandidates([
    { name: "重复主机", host: "192.0.2.10", port: 22, username: "root", platform: "linux", password: "never-accepted" },
    { name: "新主机", host: "NEW.example.test", port: 2222, username: "admin", platform: "windows" },
    { name: "同批重复", host: "new.example.test", port: 2222, username: "admin", platform: "windows" },
    { name: "坏端口", host: "https://example.test/path", port: 65536, username: "root", platform: "other" },
  ], existing);
  expect(candidates[0].duplicateOf).toContain("已存在");
  expect(candidates[1].duplicateOf).toBeNull();
  expect(candidates[2].duplicateOf).toContain("候选 2");
  expect(candidates[3].errors).toHaveLength(3);
  expect(candidates[0].fields).not.toHaveProperty("password");
});

test("database AI summaries contain only bounded resource metrics and omit identifiers and endpoints", () => {
  const rds = rdsAiSummary({ DBInstanceId: "test-only-instance-id", ConnectionString: "secret.endpoint.test", Engine: "MySQL", EngineVersion: "8.0", DBInstanceStatus: "Running", DBInstanceClass: "rds.mysql.x1", DBInstanceStorage: 100, DBInstanceNetType: "VPC", PayType: "Postpaid" }, 72, 100);
  expect(rds).toContain("存储使用百分比：72"); expect(rds).toContain("引擎：MySQL");
  expect(rds).not.toContain("test-only-instance-id"); expect(rds).not.toContain("secret.endpoint.test");
  const redis = redisAiSummary({ InstanceId: "test-only-redis-id", ConnectionDomain: "secret.redis.test", InstanceStatus: "Normal", ArchitectureType: "cluster", EngineVersion: "7.0", Capacity: 4096, Bandwidth: 12, Connections: 300, NetworkType: "VPC", ChargeType: "PostPaid" });
  expect(redis).toContain("容量MB：4096"); expect(redis).not.toContain("test-only-redis-id"); expect(redis).not.toContain("secret.redis.test");
  const oss = ossAiSummary({ Name: "test-only-bucket", Location: "secret-region", StorageClass: "Standard", Acl: "private", ExtranetEndpoint: "secret.endpoint.test" }, { storage: 2048, objectCount: 10, multipartUploadCount: 2, monthTraffic: 512, monthRequests: 30, acl: "private", cors: [{ origin: ["private.origin.test"] }] });
  expect(oss).toContain("访问控制级别：private"); expect(oss).toContain("CORS规则数：1"); expect(oss).not.toContain("test-only-bucket"); expect(oss).not.toContain("secret-region"); expect(oss).not.toContain("secret.endpoint.test"); expect(oss).not.toContain("private.origin.test");
});

test("FRP AI fills a rule draft without saving, applying config or starting the process",async({page})=>{
  await nativeFixture(page);await page.addInitScript(()=>{
    const original=(window as any).__TAURI_INTERNALS__.invoke;const server={id:1,name:"测试FRP",serverAddr:"192.0.2.15",serverPort:7000,tokenSaved:true,panelUrl:null,panelUsername:null,panelPasswordSaved:false,adminPort:7400,proxies:[],updatedAt:1};(window as any).frpActions=[];
    (window as any).__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>{
      if(command==="list_frp_servers")return[server];if(command==="get_frp_global_settings")return{adminUser:"admin",adminPasswordSaved:true};if(command==="get_frpc_runtime")return[{serverId:1,installed:true,configPresent:true,configCurrent:true,running:false,connected:false,proxies:[]}];if(command==="get_frp_local_paths")return{installed:true,binaryPath:"fixture",configPath:"fixture"};
      if(["save_frp_server","start_frpc","apply_frp_config"].includes(command))(window as any).frpActions.push(command);
      if(command==="ai_run"&&args.input.task==="frp"){(window as any).aiRequests.push(args.input);return{requestId:args.input.requestId,draft:{summary:"本地开发服务TCP映射草稿",fields:{name:"dev",kind:"tcp",local_ip:"127.0.0.1",local_port:3000,remote_port:9000},items:[],warnings:["请确认公网暴露范围"],evidence:[]}};}
      return original(command,args);
    };
  });
  await page.goto("/");await page.getByRole("button",{name:"内网穿透",exact:true}).first().click();await page.getByRole("button",{name:"新增规则",exact:true}).click();const form=page.getByRole("dialog",{name:"新增穿透规则",exact:true});await form.getByLabel("规则名称",{exact:true}).fill("manual_name");await form.getByRole("button",{name:"AI 生成规则草稿",exact:true}).click();const side=page.getByRole("dialog",{name:"AI 生成规则草稿",exact:true});await side.getByRole("textbox",{name:"分析内容",exact:true}).fill("将本机127.0.0.1的3000端口通过TCP映射到远端9000端口");await side.getByRole("button",{name:"发送并分析"}).click();await side.getByRole("button",{name:"应用勾选字段"}).click();await expect(form.getByLabel("规则名称",{exact:true})).toHaveValue("manual_name");await expect(form.getByLabel("本地端口",{exact:true})).toHaveValue("3000");await expect(form.getByLabel("服务端远端端口",{exact:true})).toHaveValue("9000");expect(await page.evaluate(()=>(window as any).frpActions)).toHaveLength(0);
});

test("AI rejection diagnostics preserve status and safe parameters without provider content", async ({page}) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    let calls = 0;
    (window as any).__TAURI_INTERNALS__.invoke = async (command:string, args:any) => {
      if(command === "ai_run") throw {code:"ai", message: calls++ === 0 ? "AI服务拒绝请求（HTTP 400）：参数 max_output_tokens 不兼容" : "AI服务拒绝请求（HTTP 400）：参数 test-only-private-value 不兼容"};
      return original(command,args);
    };
  });
  await page.goto("/");
  await openAiSettings(page);
  const button = page.locator(".ai-profile").first().getByRole("button",{name:"测试连接",exact:true});
  await button.click();
  await expect(page.getByRole("status")).toContainText("AI服务拒绝请求（HTTP 400）：参数 max_output_tokens 不兼容");
  await button.click();
  await expect(page.getByRole("status")).toContainText("AI操作失败，请检查配置或继续手动操作");
  await expect(page.locator("body")).not.toContainText("test-only-private-value");
});

test("local AI search validates its allowlist and excludes unknown and expired dates",()=>{
  expect(assetSearchFilters({query:"test",group:"生产",resource_type:"domain",expires_within_days:"30"},["domain"],["生产"])).toEqual({query:"test",group:"生产",resource_type:"domain",expires_within_days:30});
  for(const fields of [{sql:"delete"},{group:"未知分组"},{resource_type:"arbitrary"},{expires_within_days:-1},{expires_within_days:3651},{expires_within_days:1.5},{query:42}])expect(()=>assetSearchFilters(fields,["domain"],["生产"])).toThrow();
  const now=Date.parse("2026-10-13T00:00:00Z");const asset=(expiry:unknown)=>({account_id:1,resource_type:"domain",asset_key:"fixture",payload:{ExpiredTime:expiry},fetched_at:1});
  expect(withinAssetExpiry(asset("2026-10-20T00:00:00Z"),30,now)).toBe(true);expect(withinAssetExpiry(asset("2026-12-20T00:00:00Z"),30,now)).toBe(false);expect(withinAssetExpiry(asset("2026-10-01T00:00:00Z"),30,now)).toBe(false);expect(withinAssetExpiry(asset(undefined),30,now)).toBe(false);expect(withinAssetExpiry(asset(undefined),null,now)).toBe(true);
});

test("natural-language filters are applied locally without sending the resource catalog",async({page})=>{
  await nativeFixture(page);await page.addInitScript(()=>{
    const original=(window as any).__TAURI_INTERNALS__.invoke;(window as any).resourceWrites=0;
    const assets=[{account_id:1,resource_type:"domain",asset_key:"fixture-near.test",fetched_at:1,payload:{DomainName:"fixture-near.test",ExpiredTime:Date.now()+10*86400000,privateField:"test-only-not-uploaded"}},{account_id:1,resource_type:"domain",asset_key:"fixture-far.test",fetched_at:1,payload:{DomainName:"fixture-far.test",ExpiredTime:Date.now()+90*86400000}},{account_id:2,resource_type:"domain",asset_key:"fixture-other.test",fetched_at:1,payload:{DomainName:"fixture-other.test",ExpiredTime:Date.now()+10*86400000}}];
    (window as any).__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>{
      if(command==="list_accounts")return[{id:1,account_name:"生产账号",cloud_type:"aliyun",group_name:"生产",access_key_id:"fixture-id",enabled:true,sort_order:1},{id:2,account_name:"测试账号",cloud_type:"aliyun",group_name:"测试",access_key_id:"fixture-other-id",enabled:true,sort_order:2}];
      if(command==="list_local_assets")return assets;
      if(command==="ai_run"&&args.input.task==="search"){(window as any).aiRequests.push(args.input);return{requestId:args.input.requestId,draft:{summary:"筛选生产组30天内到期域名",fields:{query:"fixture",group:"生产",resource_type:"domain",expires_within_days:30},items:[],warnings:[],evidence:[]}};}
      if(command==="update_asset_name")(window as any).resourceWrites++;
      return original(command,args);
    };
  });
  await page.goto("/");await page.getByRole("button",{name:"资产管理",exact:true}).click();await expect(page.locator(".local-assets-panel tbody tr")).toHaveCount(3);
  await page.getByRole("button",{name:"AI 自然语言筛选",exact:true}).click();const side=page.getByRole("dialog",{name:"AI 自然语言筛选",exact:true});await expect(side.getByRole("textbox",{name:"分析内容",exact:true})).toHaveValue("");await side.getByRole("textbox",{name:"分析内容",exact:true}).fill("找生产分组里未来30天到期的域名，名称包含fixture");await side.getByRole("button",{name:"发送并分析"}).click();await expect(page.locator(".local-assets-panel tbody tr")).toHaveCount(3);await side.getByRole("button",{name:"应用勾选字段"}).click();
  await expect(page.locator(".local-assets-panel tbody tr")).toHaveCount(1);await expect(page.locator(".local-assets-panel tbody tr")).toContainText("fixture-near.test");const calls=await page.evaluate(()=>(window as any).aiRequests);expect(calls).toHaveLength(1);expect(calls[0].text).not.toContain("fixture-near.test");expect(calls[0].text).not.toContain("test-only-not-uploaded");expect(await page.evaluate(()=>(window as any).resourceWrites)).toBe(0);
  await page.getByRole("button",{name:"清除筛选",exact:true}).click();await expect(page.locator(".local-assets-panel tbody tr")).toHaveCount(3);
});

test("asset note extraction ignores credentials and unknown supplier fields",()=>{
  expect(assetNoteCandidate({name:"候选名称",expires_at:"2027-01-01",remark:"用途说明",api_key:"test-only-key",price:999})).toBe("名称：候选名称\n到期日期：2027-01-01\n备注：用途说明");
});

test("panel candidates accept only non-secret editable fields and validated addresses",()=>{
  expect(panelAiFields({name:" 测试面板 ",panel_url:"https://example.test:8888/panel",api_key:"test-only-secret",ssh_password:"test-only-password"})).toEqual({name:"测试面板",panel_url:"https://example.test:8888/panel"});
  for(const panel_url of ["javascript:alert(1)","https://user:password@example.test","https://example.test/?key=test-only-key","https://example.test/#token","not-url"]) expect(()=>panelAiFields({panel_url})).toThrow();
});

test("image headers and crop bounds reject invalid input before decoding", () => {
  expect(() => sourceDimensions(new Uint8Array([1,2,3]))).toThrow();
  expect(() => sourceDimensions(new Uint8Array([255,216,255,192,0,99]))).toThrow();
  expect(validRect({x:1,y:2,width:10,height:10},20,20)).toBe(true);
  for (const rect of [{x:-1,y:0,width:10,height:10},{x:0,y:0,width:21,height:10},{x:0,y:0,width:0,height:10},{x:0.5,y:0,width:10,height:10}]) expect(validRect(rect,20,20)).toBe(false);
});

test("image masking sends only processed pixels and replacing an image requires preparation", async ({page}) => {
  await nativeFixture(page); await page.goto("/");
  await page.getByRole("button",{name:"终端管理",exact:true}).click(); await page.locator(".terminal-add-host").click();
  await page.locator(".managed-host-modal").getByRole("button",{name:"AI 识别填写",exact:true}).click();
  const side=page.getByRole("dialog",{name:"AI 识别填写",exact:true});
  await page.setViewportSize({width:375,height:844});
  const data=await page.evaluate(()=>{const c=document.createElement("canvas");c.width=200;c.height=120;const ctx=c.getContext("2d")!;ctx.fillStyle="red";ctx.fillRect(0,0,200,120);return c.toDataURL("image/png").split(",")[1];});
  await side.getByLabel("选择PNG或JPEG图片",{exact:true}).setInputFiles({name:"fixture.png",mimeType:"image/png",buffer:Buffer.from(data,"base64")});
  const editor=side.getByRole("region",{name:"图片遮罩处理",exact:true});
  const canvas=editor.locator("canvas"); await expect(canvas).toHaveAttribute("width","200");
  await expect(side.getByRole("button",{name:"发送并分析"})).toBeDisabled();
  const box=(await canvas.boundingBox())!; await page.mouse.move(box.x+box.width/4,box.y+box.height/4); await page.mouse.down(); await page.mouse.move(box.x+box.width/2,box.y+box.height/4); await page.mouse.up();
  await expect(editor.getByText("已遮挡 1 处")).toBeVisible();
  await editor.getByRole("button",{name:"使用处理后的图片"}).click();
  const pixels=await side.getByAltText("裁剪遮挡后将发送的截图").evaluate(async element=>{const img=element as HTMLImageElement;await img.decode();const c=document.createElement("canvas");c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext("2d")!;ctx.drawImage(img,0,0);return{masked:Array.from(ctx.getImageData(75,30,1,1).data),plain:Array.from(ctx.getImageData(180,100,1,1).data)};});
  expect(pixels.masked.slice(0,3).every(v=>v<15)).toBe(true);expect(pixels.plain[0]).toBeGreaterThan(235);
  await side.getByRole("button",{name:"发送并分析"}).click();await expect(side.getByRole("heading",{name:"结果草稿"})).toBeVisible();
  const requests=await page.evaluate(()=>(window as any).aiRequests);expect(requests).toHaveLength(1);expect(requests[0].image.reviewed).toBe(true);expect(requests[0].image.dataUrl).not.toContain(data);
  await side.getByLabel("选择PNG或JPEG图片",{exact:true}).setInputFiles({name:"replacement.png",mimeType:"image/png",buffer:Buffer.from(data,"base64")});
  await expect(editor).toBeVisible();await expect(side.getByRole("button",{name:"发送并分析"})).toBeDisabled();expect(await page.evaluate(()=>(window as any).aiRequests)).toHaveLength(1);
});

test("image composer accepts pasted screenshots and rejects invalid files without sending", async ({page})=>{
  await nativeFixture(page);await page.goto("/");await page.getByRole("button",{name:"终端管理",exact:true}).click();await page.locator(".terminal-add-host").click();await page.locator(".managed-host-modal").getByRole("button",{name:"AI 识别填写",exact:true}).click();
  const side=page.getByRole("dialog",{name:"AI 识别填写",exact:true});
  await side.getByRole("textbox",{name:"分析内容",exact:true}).evaluate(async el=>{const c=document.createElement("canvas");c.width=80;c.height=50;const blob=await new Promise<Blob>(resolve=>c.toBlob(b=>resolve(b!),"image/png"));const transfer=new DataTransfer();transfer.items.add(new File([blob],"paste.png",{type:"image/png"}));el.dispatchEvent(new ClipboardEvent("paste",{clipboardData:transfer,bubbles:true,cancelable:true}));});
  await expect(side.locator("canvas")).toHaveAttribute("width","80");await side.getByRole("region",{name:"图片遮罩处理",exact:true}).getByRole("button",{name:"取消",exact:true}).click();
  await side.getByLabel("选择PNG或JPEG图片",{exact:true}).setInputFiles({name:"bad.png",mimeType:"image/png",buffer:Buffer.from("invalid")});await expect(side.getByRole("alert")).toBeVisible();expect(await page.evaluate(()=>(window as any).aiRequests)).toHaveLength(0);
});

test("model list and capability metadata do not leak into profile save payload", async ({page}) => {
  await nativeFixture(page);await page.goto("/");await openAiSettings(page);
  await page.locator(".ai-profile").first().getByRole("button",{name:"编辑",exact:true}).click();
  const form=page.locator(".ai-config-form");await form.getByRole("button",{name:"获取模型列表"}).click();
  await expect(page.getByText("已获取 2 个模型名称，可下拉选择或直接填写")).toBeVisible();
  await form.getByLabel("模型名称",{exact:true}).fill("vendor/other-model");await form.getByRole("button",{name:"保存配置"}).click();
  await expect(page.getByText("AI配置已加密保存")).toBeVisible();
  const input=await page.evaluate(()=>(window as any).aiSavedInput);expect(input.model).toBe("vendor/other-model");expect(input).not.toHaveProperty("visionStatus");expect(input).not.toHaveProperty("hasKey");expect(input).not.toHaveProperty("updatedAt");
  await page.locator(".ai-profile").first().getByRole("button",{name:"测试图像",exact:true}).click();await expect(page.getByText("图像测试通过，可以使用裁剪遮挡后的截图识别")).toBeVisible();
});

test("panel AI applies selected information without saving or touching entered credentials",async({page})=>{
  await nativeFixture(page);await page.goto("/");await page.getByRole("button",{name:"面板管理",exact:true}).click();await page.getByRole("button",{name:"添加面板",exact:true}).click();
  const form=page.locator(".panel-bind-modal");await form.getByLabel("名称",{exact:true}).fill("原有面板名称");await form.getByLabel("API 密钥",{exact:true}).fill("test-only-manual-panel-key");
  await form.getByRole("button",{name:"AI 识别面板信息",exact:true}).click();
  const side=page.getByRole("dialog",{name:"AI 识别面板信息",exact:true});await side.getByRole("textbox",{name:"分析内容",exact:true}).fill("安装完成，面板地址 https://example.test:8888");
  await side.getByRole("button",{name:"发送并分析"}).click();await side.getByRole("button",{name:"应用勾选字段"}).click();
  await expect(form.getByLabel("名称",{exact:true})).toHaveValue("原有面板名称");await expect(form.getByLabel("面板 URL",{exact:true})).toHaveValue("https://example.test:8888");await expect(form.getByLabel("API 密钥",{exact:true})).toHaveValue("test-only-manual-panel-key");await expect(form.getByLabel("分组",{exact:true})).toHaveValue("生产");
  const state=await page.evaluate(()=>({requests:(window as any).aiRequests,saves:(window as any).panelSaves}));expect(state.saves).toBe(0);expect(state.requests[0].text).not.toContain("test-only-manual-panel-key");
});

test("API diagnosis sends only reviewed selected lines and strips labelled credentials",async({page})=>{
  await nativeFixture(page);await page.addInitScript(()=>{
    const original=(window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>command==="list_api_logs" ? [{id:1,endpoint:"DescribeFixture",action:"查询测试资源",status:"失败",created_at:1,request_params:'{"Region":"test-region"}',response_params:JSON.stringify({message:"connection refused",password:"test-only-log-secret",other:"unselected context"},null,2)}] : original(command,args);
  });
  await page.goto("/");await page.getByRole("button",{name:"API日志",exact:true}).click();await page.getByRole("button",{name:"查看详情",exact:true}).click();
  const output=page.locator(".api-log-section").filter({hasText:"返回参数"}).locator("pre");
  await output.evaluate(el=>{const node=el.firstChild!;const text=node.textContent!;const range=document.createRange();range.setStart(node,text.indexOf('"message"'));range.setEnd(node,text.indexOf('"other"'));const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);});
  await page.getByRole("button",{name:"AI 分析选中API日志",exact:true}).click();
  const side=page.getByRole("dialog",{name:"AI 分析选中API日志",exact:true});await expect(side.getByRole("textbox",{name:"分析内容",exact:true})).toHaveValue(/connection refused/);await expect(side.getByRole("textbox",{name:"分析内容",exact:true})).not.toHaveValue(/test-only-log-secret|unselected context|test-region/);
  expect(await page.evaluate(()=>(window as any).aiRequests)).toHaveLength(0);await side.getByRole("button",{name:"发送并分析"}).click();
  await expect(side.getByRole("heading",{name:"结果草稿"})).toBeVisible();const calls=await page.evaluate(()=>(window as any).aiRequests);expect(calls[0].task).toBe("diagnose");expect(calls[0].text).not.toContain("test-only-log-secret");await expect(side.getByRole("button",{name:"应用勾选字段"})).toHaveCount(0);
});

test("log selection crossing allowed boundaries is not automatically included",async({page})=>{
  await nativeFixture(page);await page.goto("/");await page.getByRole("button",{name:"操作日志",exact:true}).click();
  await page.locator(".operation-log-ai-scope h1").evaluate(el=>{const range=document.createRange();range.setStart(el.firstChild!,0);const logs=document.querySelector(".operation-log-ai-scope .log-list")!;range.setEnd(logs,logs.childNodes.length);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);});
  await page.getByRole("button",{name:"AI 分析选中操作日志",exact:true}).click();const side=page.getByRole("dialog",{name:"AI 分析选中操作日志",exact:true});await expect(side.getByRole("textbox",{name:"分析内容",exact:true})).toHaveValue("");await expect(side.getByRole("button",{name:"发送并分析"})).toBeDisabled();
});

test("pipeline failure analysis uses selected log output and never reruns the pipeline",async({page})=>{
  await nativeFixture(page);await page.addInitScript(()=>{
    const pipeline={pipelineId:"fixture-pipeline",pipelineName:"测试流水线",latestStatus:"FAIL"};const run={pipelineRunId:"fixture-run",status:"FAIL",startTime:1,endTime:2,sources:[],stages:[{name:"构建",status:"FAIL",jobs:[{id:"fixture-job",name:"测试任务",status:"FAIL"}]}]};
    const original=(window as any).__TAURI_INTERNALS__.invoke;(window as any).flowStarts=0;
    (window as any).__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>{
      if(command==="list_flow_connections")return[{id:1,name:"测试连接",edition:"central",organizationId:"fixture",tokenSaved:true}];
      if(command==="get_flow_pipeline_cache")return{pipelines:[pipeline],updatedAt:1};if(command==="list_flow_pipelines")return[pipeline];if(command==="list_flow_runs")return[run];if(command==="get_flow_run"||command==="get_flow_latest_run")return run;
      if(command==="get_flow_job_steps")return[{stepIndex:0,buildId:1,name:"构建"}];if(command==="get_flow_job_log")return{logs:"compile error: missing module\npassword: test-only-build-secret\nunselected build context",more:false,nextOffset:1};
      if(command==="run_flow_pipeline"){(window as any).flowStarts++;return"fixture-run";}
      return original(command,args);
    };
  });
  await page.goto("/");await page.getByRole("button",{name:"云效流水线",exact:true}).click();await page.getByRole("button",{name:"查看 测试流水线 详情",exact:true}).click();const detail=page.getByRole("dialog",{name:"测试流水线",exact:true});await detail.getByRole("button",{name:"日志",exact:true}).click();
  const output=detail.locator(".flow-job-log pre");await expect(output).toContainText("compile error");await output.evaluate(el=>{const node=el.firstChild!;const range=document.createRange();range.setStart(node,0);range.setEnd(node,node.textContent!.indexOf("unselected"));const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);});
  await detail.getByRole("button",{name:"AI 分析选中流水线日志",exact:true}).click();const side=page.getByRole("dialog",{name:"AI 分析选中流水线日志",exact:true});await expect(side.getByRole("textbox",{name:"分析内容",exact:true})).toHaveValue(/compile error/);await expect(side.getByRole("textbox",{name:"分析内容",exact:true})).not.toHaveValue(/test-only-build-secret|unselected/);await side.getByRole("button",{name:"发送并分析"}).click();await expect(side.getByRole("heading",{name:"结果草稿"})).toBeVisible();expect(await page.evaluate(()=>(window as any).flowStarts)).toBe(0);await page.keyboard.press("Escape");await expect(detail).toBeVisible();
});

for (const section of ["资产管理", "我的收藏"]) test(`${section} AI keeps existing notes and saves only after explicit confirmation`,async({page})=>{
  await nativeFixture(page);
  await page.addInitScript(()=>{
    const notesKey="cloudhub-tools-asset-notes",key="1:domain:example.test";
    localStorage.setItem(notesKey,JSON.stringify({[key]:"原有备注"}));localStorage.setItem("cloudhub-tools-favorite-assets",JSON.stringify([key]));
    (window as any).assetNoteWrites=[];const original=(window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>{
      if(command==="list_local_assets") return[{account_id:1,resource_type:"domain",asset_key:"example.test",payload:{DomainName:"example.test",apiKey:"test-only-supplier-secret"},fetched_at:1}];
      if(command==="save_client_preference" && args.key===notesKey)(window as any).assetNoteWrites.push(args.value);
      if(command==="ai_run" && args.input.task==="asset") { (window as any).aiRequests.push(args.input);return{requestId:args.input.requestId,inputTokens:4,outputTokens:5,draft:{summary:"用途说明",fields:{name:"候选名称",expires_at:"2027-01-01"},items:[],evidence:[],warnings:[]}}; }
      return original(command,args);
    };
  });
  await page.goto("/");await page.getByRole("button",{name:section,exact:true}).click();
  if(section==="资产管理"){
    const row=page.locator(".asset-note-line").first();
    await expect(row.getByRole("button",{name:"AI 整理备注",exact:true})).toBeVisible();
    await expect(page.locator(".local-assets-panel tbody td").nth(1).locator(".ai-assist-button")).toHaveCount(0);
    const layout=await row.evaluate(el=>{
      const note=el.querySelector(".asset-note-button")!.getBoundingClientRect();
      const ai=el.querySelector(".ai-assist-button")!.getBoundingClientRect();
      return {noteRight:note.right,aiLeft:ai.left,aiHeight:ai.height,noteCenter:note.top+note.height/2,aiCenter:ai.top+ai.height/2};
    });
    expect(layout.aiLeft).toBeGreaterThanOrEqual(layout.noteRight);
    expect(layout.aiHeight).toBe(24);
    expect(Math.abs(layout.noteCenter-layout.aiCenter)).toBeLessThanOrEqual(1);
    await page.screenshot({path:"test-results/resource-ai-note-position.png"});
  }
  if(section==="我的收藏"){
    const row=page.locator(".favorite-card-note").first();
    await expect(row.getByRole("button",{name:"AI 整理备注",exact:true})).toBeVisible();
    const layout=await row.evaluate(el=>{
      const note=el.querySelector(":scope > button")!.getBoundingClientRect();
      const ai=el.querySelector(".ai-assist-button")!.getBoundingClientRect();
      return {noteRight:note.right,aiLeft:ai.left,noteCenter:note.top+note.height/2,aiCenter:ai.top+ai.height/2};
    });
    expect(layout.aiLeft).toBeGreaterThanOrEqual(layout.noteRight);
    expect(Math.abs(layout.noteCenter-layout.aiCenter)).toBeLessThanOrEqual(1);
    await page.screenshot({path:"test-results/favorite-ai-note-position.png"});
  }
  await page.getByRole("button",{name:"AI 整理备注",exact:true}).first().click();
  const side=page.getByRole("dialog",{name:"AI 整理备注",exact:true});await expect(side.getByRole("textbox",{name:"分析内容",exact:true})).not.toHaveValue(/test-only-supplier-secret/);
  await side.getByRole("textbox",{name:"分析内容",exact:true}).fill("资源用途说明：名称候选名称，到期2027-01-01");await side.getByRole("button",{name:"发送并分析"}).click();await side.getByRole("button",{name:"应用勾选字段"}).click();
  const dialog=page.getByRole("dialog",{name:"核对资产备注",exact:true});await expect(dialog.getByLabel("备注草稿")).toBeFocused();await expect(dialog.getByLabel("备注草稿")).toHaveValue("原有备注\n\n名称：候选名称\n到期日期：2027-01-01");
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("cloudhub-tools-asset-notes")!)["1:domain:example.test"])).toBe("原有备注");
  await dialog.getByRole("button",{name:"保存备注",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem("cloudhub-tools-asset-notes")!)["1:domain:example.test"])).toContain("到期日期：2027-01-01");
  const calls=await page.evaluate(()=>(window as any).aiRequests);expect(calls).toHaveLength(1);expect(calls[0].text).not.toContain("test-only-supplier-secret");
});

async function nativeFixture(page: Page) {
  await page.addInitScript(() => {
    let profiles = [{ id: "11111111-1111-4111-8111-111111111111", name: "测试服务", protocol: "openai_chat", baseUrl: "https://example.test/v1", model: "fixture-model", enabled: true, isDefault: true, timeoutSeconds: 60, maxOutputTokens: 512, allowLoopbackHttp: false, hasKey: true, updatedAt: 1, visionStatus: "supported" }];
    (window as any).aiRequests = [];
    (window as any).hostSaves = 0;
    (window as any).panelSaves = 0;
    let callbackId=0;
    const callbacks:Record<number,(event:any)=>void>={};
    (window as any).nativeImageReads=[];
    (window as any).nativeDragCallbacks={};
    (window as any).__TAURI_INTERNALS__ = { metadata:{currentWindow:{label:"main"},currentWebview:{label:"main"}}, transformCallback: (callback:(event:any)=>void) => {callbacks[++callbackId]=callback;return callbackId;}, unregisterCallback: (id:number) => {delete callbacks[id];}, invoke: async (command: string, args?: any) => {
      if(command==="plugin:event|listen"){(window as any).nativeDragCallbacks[args.event]=callbacks[args.handler];return args.handler;}
      if(command==="member_me") return null;
      if (command === "pet_settings") return { enabled: false, appearance: "alpaca", monitoring: false, panels: false, panelAccess: true, certificates: true, servers: true, size: 160, roam: "edge", activity: 1, sound: false, reducedMotion: false, quiet: false, intervalSeconds: 300, expiryDays: 30, cpuThreshold: 90, diskThreshold: 90, keepInTray: false };
      if (command === "pet_snapshot") return { alerts: [], checkedAt: 0, lastError: null };
      if(command==="ai_read_image_file"){(window as any).nativeImageReads.push(args.sourcePath);return (window as any).fixtureImageData;}
      if (command === "ai_list_profiles") return structuredClone(profiles);
      if (command === "ai_save_profile") {
        const { apiKey: _secret, ...input } = args.input;
        (window as any).aiSavedInput = input;
        const result = { ...input, id: input.id || "22222222-2222-4222-8222-222222222222", hasKey: true, updatedAt: 2, visionStatus: "unknown" };
        profiles = [...profiles.filter(p => p.id !== result.id), result]; return result;
      }
      if (command === "ai_delete_profile") { profiles = profiles.filter(p => p.id !== args.id); return; }
      if (command === "ai_prepare_import") return { token: "test-only-import", profiles: [{ ...profiles[0], id: "33333333-3333-4333-8333-333333333333", name: "迁移服务", enabled: true, isDefault: true, hasKey: true }] };
      if (command === "ai_confirm_import") { profiles.forEach(profile => { profile.isDefault = false; }); profiles.push({ ...profiles[0], id: "33333333-3333-4333-8333-333333333333", name: "迁移服务", enabled: true, isDefault: true, hasKey: true }); return 1; }
      if (command === "ai_export_config") return true;
      if (command === "ai_list_models") return ["fixture-model", "vendor/other-model"];
      if (command === "ai_test_vision") { profiles = profiles.map(p=>p.id===args.input.profileId ? {...p,visionStatus:"supported"}:p); return {passed:true,profile:structuredClone(profiles[0])}; }
      if (command === "ai_preview") { const lines = args.text.split("\n"); let count = 0; return { text: lines.map((line: string) => { if (/password:/i.test(line)) { count++; return "[已移除可能含凭据的行]"; } return line; }).join("\n"), removedLines: count }; }
      if (command === "ai_run") { (window as any).aiRequests.push(args.input); return { requestId: args.input.requestId, inputTokens: 10, outputTokens: 20, draft: { summary: "从选定说明提取的信息", fields: args.input.task === "panel" ? {name:"建议面板",panel_url:"https://example.test:8888",group_name:"生产",remark:"安装说明"} : { name: "建议名称", host: "192.0.2.22", port: 2200 }, items: [], warnings: ["请核对主机地址"], evidence: ["主机 192.0.2.22" ] } }; }
      if (command === "save_panel_connection") { (window as any).panelSaves++; return {}; }
      if (command === "save_managed_host") { (window as any).hostSaves++; return { ...args.input, id: 1 }; }
      if (command === "list_client_preferences") return {};
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      return [];
    } };
  });
}

test("AI configuration saves without exposing stored keys or sending a model request", async ({ page }) => {
  await nativeFixture(page); await page.goto("/");
  await openAiSettings(page);
  await page.getByRole("button", { name: "添加服务", exact: true }).click();
  const form = page.locator(".ai-config-form");
  await form.getByLabel("配置名称").fill("我的模型"); await form.getByLabel("模型名称",{exact:true}).fill("fixture-model");
  await form.getByLabel("API Key",{exact:true}).fill("test-only-ai-secret"); await form.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText("AI配置已加密保存")).toBeVisible(); await expect(page.locator(".ai-profile")).toHaveCount(2);
  await expect(page.locator("body")).not.toContainText("test-only-ai-secret");
  expect(await page.evaluate(() => (window as any).aiRequests)).toHaveLength(0);
  await page.locator(".ai-profile").filter({ hasText: "我的模型" }).getByRole("button", { name: "编辑", exact: true }).click();
  await expect(form.getByLabel("API Key",{exact:true})).toHaveValue("");
});

test("AI save explains missing fields and reveals invalid advanced settings", async ({ page }) => {
  await nativeFixture(page); await page.goto("/");
  await openAiSettings(page);
  await page.getByRole("button", { name: "添加服务", exact: true }).click();
  const form = page.locator(".ai-config-form");
  await form.getByRole("button", { name: "保存配置" }).click();
  await expect(form.getByRole("status")).toContainText("配置名称");
  await expect(form.getByLabel("配置名称")).toBeFocused();
  await form.getByLabel("配置名称").fill("校验测试");
  await form.getByLabel("模型名称",{exact:true}).fill("fixture-model");
  await form.getByLabel("API Key",{exact:true}).fill("test-only-ai-secret");
  await form.getByText("高级设置", { exact: true }).click();
  await form.getByLabel("请求超时（秒）").fill("1");
  await form.getByText("高级设置", { exact: true }).click();
  await form.getByRole("button", { name: "保存配置" }).click();
  await expect(form.getByRole("status")).toContainText("请求超时（秒）");
  await expect(form.getByLabel("请求超时（秒）")).toBeVisible();
  await expect(form.getByLabel("请求超时（秒）")).toBeFocused();
  expect(await page.evaluate(() => (window as any).aiSavedInput)).toBeUndefined();
  await form.getByLabel("请求超时（秒）").fill("60");
  await form.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText("AI配置已加密保存")).toBeVisible();
  await expect(page.locator(".ai-profile")).toHaveCount(2);
});

test("AI save keeps entered fields and shows a native failure beside the save action", async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    let fail = true;
    (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === "ai_save_profile" && fail) {
        fail = false;
        throw { code: "ai", message: "最多保存20个AI服务配置", retryable: false };
      }
      return original(command, args);
    };
  });
  await page.goto("/");
  await openAiSettings(page);
  await page.getByRole("button", { name: "添加服务", exact: true }).click();
  const form = page.locator(".ai-config-form");
  await form.getByLabel("配置名称").fill("重试测试");
  await form.getByLabel("模型名称",{exact:true}).fill("fixture-model");
  await form.getByLabel("API Key",{exact:true}).fill("test-only-ai-secret");
  await form.getByRole("button", { name: "保存配置" }).click();
  await expect(form.getByRole("status")).toContainText("最多保存20个AI服务配置");
  await expect(form.getByRole("status")).toBeFocused();
  await expect(form.getByLabel("配置名称")).toHaveValue("重试测试");
  await expect(form.getByRole("button", { name: "保存配置" })).toBeEnabled();
  await form.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText("AI配置已加密保存")).toBeVisible();
});

test("AI draft automatically checks the send and never saves or overwrites existing fields automatically", async ({ page }) => {
  await nativeFixture(page); await page.goto("/"); await page.getByRole("button", { name: "终端管理", exact: true }).click(); await page.locator(".terminal-add-host").click();
  const form = page.locator(".managed-host-modal"); await form.getByLabel("服务器名称").fill("原有名称");
  await form.getByRole("button", { name: "AI 识别填写", exact: true }).click();
  const side = page.getByRole("dialog", { name: "AI 识别填写", exact: true });
  await side.getByRole("textbox",{name:"分析内容",exact:true}).fill("主机 192.0.2.22\npassword: test-only-host-secret");
  await side.getByRole("button", { name: "发送并分析" }).click();
  await expect(side.getByRole("textbox",{name:"分析内容",exact:true})).not.toHaveValue(/test-only-host-secret/);
  await expect(side.getByRole("heading", { name: "结果草稿" })).toBeVisible();
  await side.getByRole("button", { name: "应用勾选字段" }).click();
  await expect(form.getByLabel("服务器名称")).toHaveValue("原有名称"); await expect(form.getByLabel("主机 / IP")).toHaveValue("192.0.2.22");
  await expect(form.getByLabel("SSH 端口")).toHaveValue("22");
  const state = await page.evaluate(() => ({ calls: (window as any).aiRequests, saves: (window as any).hostSaves }));
  expect(state.saves).toBe(0); expect(state.calls).toHaveLength(1); expect(state.calls[0].text).not.toContain("test-only-host-secret");
});

test("multiple AI server candidates are reviewed and deduplicated before filling the manual form", async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const invoke = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === "list_managed_hosts") return [{ id: 9, name: "已有主机", host: "192.0.2.10", port: 22, username: "root", platform: "linux", auth_method: "password", group_name: "", tags: "", password_saved: true, private_key_saved: false, status: "unknown", metrics: {}, created_at: 1, updated_at: 1 }];
      if (command === "ai_run" && args.input.task === "server") {
        (window as any).aiRequests.push(args.input);
        return { requestId: args.input.requestId, draft: { summary: "识别到多台主机", fields: {}, items: [
          { name: "已有主机", host: "192.0.2.10", port: 22, username: "root", platform: "linux" },
          { name: "新主机", host: "new.example.test", port: 2222, username: "admin", platform: "linux", group_name: "生产" },
          { name: "重复候选", host: "NEW.example.test", port: 2222, username: "admin", platform: "linux" },
        ], warnings: [], evidence: [] } };
      }
      return invoke(command, args);
    };
  });
  await page.goto("/"); await page.getByRole("button", { name: "终端管理", exact: true }).click(); await page.locator(".terminal-add-host").click();
  const form = page.locator(".managed-host-modal");
  await form.getByRole("button", { name: "AI 识别填写", exact: true }).click();
  const side = page.getByRole("dialog", { name: "AI 识别填写", exact: true });
  await side.getByRole("textbox",{name:"分析内容",exact:true}).fill("主机列表，包含已有主机与新主机");
  await side.getByRole("button", { name: "发送并分析" }).click();
  await expect(side.getByText("识别到 3 条服务器候选")).toBeVisible();
  await side.getByRole("button", { name: "审核并填入选中候选" }).click();
  const review = page.getByRole("dialog", { name: "审核服务器候选" });
  await expect(review.locator(".server-ai-review-card")).toHaveCount(3);
  await expect(review.getByText("已存在：已有主机")).toBeVisible();
  await expect(review.getByText("与候选 2 重复")).toBeVisible();
  const cards = review.locator(".server-ai-review-card");
  await expect(cards.nth(0).getByRole("button", { name: "填入此服务器表单" })).toBeDisabled();
  await expect(cards.nth(1).getByRole("button", { name: "填入此服务器表单" })).toBeEnabled();
  await cards.nth(1).getByRole("button", { name: "填入此服务器表单" }).click();
  await expect(form.getByLabel("服务器名称")).toHaveValue("新主机");
  await expect(form.getByLabel("主机 / IP")).toHaveValue("new.example.test");
  await expect(form.getByLabel("SSH 端口")).toHaveValue("2222");
  await expect(form.getByLabel("SSH 密码")).toBeEmpty();
  expect(await page.evaluate(() => (window as any).hostSaves)).toBe(0);
});

test("browser preview enables AI configuration while retaining manual server entry",async({page})=>{
 await page.route("**/api/ai/profiles",route=>route.fulfill({json:[]}));await page.goto("/");await openAiSettings(page);await expect(page.getByRole("button",{name:"添加服务",exact:true})).toBeEnabled();await page.getByRole("button",{name:"添加服务",exact:true}).click();await expect(page.getByRole("dialog",{name:"添加AI服务",exact:true})).toBeVisible();await page.keyboard.press("Escape");await page.getByRole("button",{name:"终端管理",exact:true}).click();await page.locator(".terminal-add-host").click();await page.locator(".managed-host-modal").getByLabel("服务器名称").fill("手动服务器");
});

test("AI transfer restores configuration state and keeps the existing service", async ({ page }) => {
  await nativeFixture(page); await page.goto("/"); await openAiSettings(page);
  await page.getByText("AI配置文件迁移", { exact: true }).click();
  await expect(page.getByLabel("迁移口令")).toHaveCount(0);
  await expect(page.getByLabel("在加密迁移包中携带密钥")).toHaveCount(0);
  await expect(page.getByText("导出的文件包含明文 API 密钥", { exact: false })).toBeVisible();
  for (const width of [375,768,1024,1440]) {
    await page.setViewportSize({width,height:900});
    const exportButton = await page.getByRole("button", {name:"导出配置文件",exact:true}).boundingBox();
    const importButton = await page.getByRole("button", {name:"选择配置文件",exact:true}).boundingBox();
    expect(exportButton!.height).toBe(importButton!.height);
    expect(exportButton!.y).toBe(importButton!.y);
  }
  await page.getByRole("button", { name: "选择配置文件", exact: true }).click();
  await expect(page.getByRole("region", { name: "AI配置迁移预览" })).toBeVisible();
  await expect(page.getByRole("region", { name: "AI配置迁移预览" })).toContainText("包含密钥 · 已启用 · 默认配置");
  await expect(page.getByRole("heading", { name: "确认要新增的配置" })).toBeVisible();
  await expect(page.locator(".ai-profile")).toHaveCount(1);
  await page.getByRole("button", { name: "确认新增配置" }).click();
  await expect(page.locator(".ai-profile")).toHaveCount(2);
  await expect(page.locator(".ai-profile").filter({ hasText: "迁移服务" })).toContainText("默认");
  expect(await page.evaluate(() => (window as any).aiRequests)).toHaveLength(0);
});

test("embedded AI settings stay open and adding a service displays the form", async ({ page }) => {
  await nativeFixture(page); await page.goto("/"); await openAiSettings(page);
  const section = page.locator(".ai-settings");
  await expect(page.locator("#ai-settings-content")).toBeVisible();
  await expect(section.getByRole("button", { name: /^(展开|收起)$/ })).toHaveCount(0);
  await expect(page.getByText("1 项", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加服务", exact: true }).click();
  await expect(page.locator("#ai-settings-content")).toBeVisible();
  await expect(page.locator(".ai-config-form")).toBeVisible();
});

test("embedded AI settings show service statistics without revealing endpoints",async({page})=>{
  await nativeFixture(page);await page.addInitScript(()=>{
    const original=(window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>command==="ai_list_profiles"?[
      {id:"first",name:"云枢",protocol:"openai_responses",enabled:true,isDefault:true,visionStatus:"supported",baseUrl:"https://private-endpoint.test",model:"fixture"},
      {id:"second",name:"minimax",protocol:"claude",enabled:false,isDefault:false,visionStatus:"unknown",baseUrl:"https://private-other.test",model:"fixture"},
    ]:original(command,args);
  });
  await page.goto("/");await openAiSettings(page);
  const summary=page.getByRole("group",{name:"AI 服务概览",exact:true});
  await expect(summary).toContainText("启用 1 / 2");await expect(summary).toContainText("图像测试通过 1");await expect(summary).toContainText("默认：云枢");
  await expect(summary).toContainText("OpenAI · Responses");await expect(summary).toContainText("Claude · Messages · 已停用");await expect(summary).not.toContainText("private-endpoint");
  await expect(page.locator("#ai-settings-content")).toBeVisible();
  for(const width of [375,768,1024,1440]){
    await page.setViewportSize({width,height:900});
    await page.reload();await openAiSettings(page);
    if(width<=600)await expect(page.locator(".ai-config-summary")).toBeHidden();else expect(await summary.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    if(width===1440)await page.screenshot({path:"test-results/ai-settings-summary.png"});
  }
});

test("AI sidebar and configuration fit narrow desktop windows", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 }); await nativeFixture(page); await page.goto("/");
  await page.getByRole("button", { name: "终端管理", exact: true }).click(); await page.locator(".terminal-add-host").click(); await page.getByRole("button", { name: "AI 识别填写", exact: true }).click();
  const side=page.locator(".ai-workbench"); await expect(side).toBeVisible();
  const box=await side.boundingBox(); expect(box!.x+box!.width).toBeLessThanOrEqual(769); expect(box!.width).toBeGreaterThanOrEqual(400); expect(box!.height).toBeLessThanOrEqual(900);
  await page.screenshot({ path: "test-results/ai-sidebar-768.png" });
});

test("AI service dialog keeps actions visible, traps focus and preserves edits on backdrop clicks",async({page})=>{
  await nativeFixture(page);await page.goto("/");await openAiSettings(page);
  const add=page.getByRole("button",{name:"添加服务",exact:true});await add.click();
  const dialog=page.getByRole("dialog",{name:"添加AI服务",exact:true});
  await expect(dialog.getByLabel("配置名称")).toBeFocused();
  await dialog.getByLabel("配置名称").fill("保留草稿");
  await page.locator(".shared-dialog-backdrop").filter({has:dialog}).click({position:{x:1,y:1}});
  await expect(dialog.getByLabel("配置名称")).toHaveValue("保留草稿");
  await dialog.getByRole("button",{name:"保存配置",exact:true}).focus();await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button",{name:"最大化弹层",exact:true})).toBeFocused();
  await page.keyboard.press("Shift+Tab");await expect(dialog.getByRole("button",{name:"保存配置",exact:true})).toBeFocused();
  await dialog.getByText("高级设置",{exact:true}).click();
  for(const width of [375,768,1024,1440]){
    await page.setViewportSize({width,height:600});
    const before=await dialog.evaluate(el=>({head:el.querySelector("header")!.getBoundingClientRect().top,foot:el.querySelector("footer")!.getBoundingClientRect().top}));
    const after=await dialog.evaluate(el=>{
      const body=el.querySelector(".ai-config-dialog-body")!;body.scrollTop=body.scrollHeight;
      const box=el.getBoundingClientRect();return{head:el.querySelector("header")!.getBoundingClientRect().top,foot:el.querySelector("footer")!.getBoundingClientRect().top,bottom:box.bottom,width:box.width,overflow:el.scrollWidth>el.clientWidth};
    });
    expect(after.head).toBe(before.head);expect(after.foot).toBe(before.foot);expect(after.bottom).toBeLessThanOrEqual(600);expect(after.width).toBeLessThanOrEqual(width);expect(after.overflow).toBe(false);
    if(width===375||width===1440)await page.screenshot({path:`test-results/ai-service-dialog-${width}.png`});
  }
  await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);await expect(add).toBeFocused();
  await page.locator(".ai-profile").first().getByRole("button",{name:"编辑",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"编辑AI服务",exact:true})).toBeVisible();await expect(page.getByLabel("API Key",{exact:true})).toHaveValue("");
});

test("selected terminal context removes known credentials before entering the assistant",()=>{
  const text="\u001b[31mError: test-only-selected-password\u001b[0m\nconnection refused";
  const safe=redactAiContext(text,["test-only-selected-password"]);expect(safe).not.toContain("test-only-selected-password");expect(safe).not.toContain("\u001b");expect(safe).toContain("connection refused");
});


test("AI model configuration queries unsaved credentials and saves multiple searchable models", async ({page}) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).modelQueries = [];
    (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === "ai_list_models") (window as any).modelQueries.push(args.input);
      return original(command, args);
    };
  });
  await page.goto("/"); await openAiSettings(page);
  await page.getByRole("button", {name:"添加服务", exact:true}).click();
  const form = page.getByRole("dialog", {name:"添加AI服务", exact:true});
  await form.getByLabel("配置名称").fill("多模型服务");
  await expect(form.getByRole("button", {name:"获取模型列表"})).toBeDisabled();
  await form.getByLabel("API Key", {exact:true}).fill("test-only-query-key");
  await form.getByLabel("服务地址").fill("https://example.test/proxy/v1");
  await form.getByRole("button", {name:"获取模型列表"}).click();
  await expect(form.getByRole("status")).toContainText("已获取 2 个模型");
  const queries = await page.evaluate(() => (window as any).modelQueries);
  expect(queries[0].draft).toMatchObject({apiKey:"test-only-query-key",baseUrl:"https://example.test/proxy/v1"});
  expect(queries[0].profileId).toBeUndefined();
  const key = await form.getByLabel("API Key", {exact:true}).boundingBox();
  const model = await form.getByLabel("模型名称", {exact:true}).boundingBox();
  expect(key!.y).toBeLessThan(model!.y);
  await form.getByRole("button", {name:"选择模型名称", exact:true}).click();
  await form.getByLabel("搜索模型名称", {exact:true}).fill("fixture");
  await form.locator(".ai-model-options").getByRole("button", {name:"fixture-model", exact:true}).click();
  await form.getByRole("button", {name:"添加模型 ID"}).click();
  await form.getByRole("button", {name:"选择模型 ID 2", exact:true}).click();
  await form.getByLabel("搜索模型 ID 2", {exact:true}).fill("other");
  await form.locator(".ai-model-options").getByRole("button", {name:"vendor/other-model", exact:true}).click();
  await form.getByRole("radio", {name:"默认模型 2", exact:true}).check();
  for (const width of [375,768,1024,1440]) {
    await page.setViewportSize({width,height:900});
    expect(await form.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.screenshot({path:"test-results/ai-multiple-models.png"});
  await form.getByRole("button", {name:"保存配置", exact:true}).click();
  await expect(form).toBeHidden();
  const saved = await page.evaluate(() => (window as any).aiSavedInput);
  expect(saved.models).toEqual(["fixture-model", "vendor/other-model"]);
  expect(saved.model).toBe("vendor/other-model");
  await page.locator(".ai-profile").filter({hasText:"多模型服务"}).getByRole("button", {name:"编辑", exact:true}).click();
  await expect(page.getByLabel("模型 ID 2", {exact:true})).toHaveValue("vendor/other-model");
});


test("AI assistance sends the selected configured model and resets screenshots when switching", async ({page}) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (command:string,args:any) => {
      const result = await original(command,args);
      return command === "ai_list_profiles" ? result.map((profile:any) => ({...profile,models:[profile.model,"fixture-alternate"]})) : result;
    };
  });
  await page.goto("/"); await page.getByRole("button", {name:"终端管理",exact:true}).click(); await page.locator(".terminal-add-host").click();
  await page.locator(".managed-host-modal").getByRole("button", {name:"AI 识别填写",exact:true}).click();
  const side = page.getByRole("dialog", {name:"AI 识别填写",exact:true});
  await side.getByLabel("本次使用的模型").selectOption("fixture-alternate");
  await expect(side.getByRole("button", {name:"添加图片"})).toBeDisabled();
  await side.getByRole("textbox",{name:"分析内容",exact:true}).fill("分析本次配置");
  await side.getByRole("button", {name:"发送并分析"}).click();
  await expect(side.getByRole("heading", {name:"结果草稿"})).toBeVisible();
  expect((await page.evaluate(() => (window as any).aiRequests))[0].model).toBe("fixture-alternate");
  await side.getByLabel("本次使用的模型").selectOption("fixture-model");
  await expect(side.getByRole("button", {name:"添加图片"})).toBeEnabled();
  await expect(side.getByRole("button", {name:"发送并分析"})).toBeEnabled();
});


test("AI key eye reveals only on click, clears on hide and never resaves revealed keys", async ({page}) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).keyRevealCount = 0;
    (window as any).savedKeyPayload = null;
    (window as any).__TAURI_INTERNALS__.invoke = async (command:string,args:any) => {
      if (command === "ai_reveal_key") { (window as any).keyRevealCount++; return "test-only-saved-ai-key"; }
      if (command === "ai_save_profile") (window as any).savedKeyPayload = args.input.apiKey;
      return original(command,args);
    };
  });
  await page.goto("/"); await openAiSettings(page);
  await page.locator(".ai-profile").first().getByRole("button", {name:"编辑",exact:true}).click();
  const form = page.getByRole("dialog", {name:"编辑AI服务",exact:true});
  const input = form.getByLabel("API Key", {exact:true});
  await expect(input).toHaveValue(""); await expect(input).toHaveAttribute("type","password");
  expect(await page.evaluate(() => (window as any).keyRevealCount)).toBe(0);
  await form.getByRole("button", {name:"查看 API Key",exact:true}).click();
  await expect(input).toHaveValue("test-only-saved-ai-key"); await expect(input).toHaveAttribute("type","text");
  await form.getByRole("button", {name:"隐藏 API Key",exact:true}).click();
  await expect(input).toHaveValue(""); await expect(input).toHaveAttribute("type","password");
  await page.clock.install();
  await form.getByRole("button", {name:"查看 API Key",exact:true}).click(); await expect(input).toHaveAttribute("type","text");
  await page.clock.fastForward(31000); await expect(input).toHaveValue(""); await expect(input).toHaveAttribute("type","password");
  await form.getByRole("button", {name:"查看 API Key",exact:true}).click(); await expect(input).toHaveValue("test-only-saved-ai-key");
  await form.getByRole("button", {name:"保存配置",exact:true}).click();
  await expect(form).toBeHidden(); expect(await page.evaluate(() => (window as any).savedKeyPayload)).toBe("");
  await page.locator(".ai-profile").first().getByRole("button", {name:"编辑",exact:true}).click(); await expect(input).toHaveValue("");
  await input.fill("test-only-new-ai-key"); await form.getByRole("button", {name:"查看 API Key",exact:true}).click(); await expect(input).toHaveAttribute("type","text");
  expect(await page.evaluate(() => (window as any).keyRevealCount)).toBe(3);
  await form.getByRole("button", {name:"隐藏 API Key",exact:true}).click(); await expect(input).toHaveValue("test-only-new-ai-key"); await expect(input).toHaveAttribute("type","password");
});

test("AI model queries and picker filtering preserve dialog geometry and body scroll", async ({page}) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (command:string,args:any) => {
      if (command === "ai_list_profiles") return (await original(command,args)).map((profile:any) => ({...profile,models:[profile.model,"fixture-second","fixture-third"]}));
      if (command === "ai_list_models") return new Promise(resolve => { (window as any).finishModelQuery = () => resolve(["fixture-model","fixture-second","fixture-third",...Array.from({length:50},(_,index)=>`fixture-${index}`)]); });
      return original(command,args);
    };
  });
  await page.goto("/"); await openAiSettings(page);
  await page.locator(".ai-profile").first().getByRole("button", {name:"编辑",exact:true}).click();
  const form = page.getByRole("dialog", {name:"编辑AI服务",exact:true});
  const geometry = () => form.evaluate(el => { const body = el.querySelector(".ai-config-dialog-body")!; const rect = el.getBoundingClientRect(); return {top:rect.top,height:rect.height,scroll:body.scrollTop,content:body.scrollHeight}; });
  for (const width of [375,768,1024,1440]) {
    await page.setViewportSize({width,height:900});
    await form.getByRole("button", {name:"获取模型列表",exact:true}).scrollIntoViewIfNeeded();
    const rows = await form.locator(".ai-model-row").evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height));
    expect(rows.every(height => height <= (width <= 600 ? 49 : 35))).toBe(true);
    const section = await form.getByRole("region", {name:"模型ID配置"}).boundingBox();
    expect(section!.height).toBeLessThanOrEqual(300);
    if (width === 1440) await page.screenshot({path:"test-results/ai-models-compact.png"});
    const beforeQuery = await geometry();
    await form.getByRole("button", {name:"获取模型列表",exact:true}).click();
    await expect(form.getByRole("button", {name:"正在获取…",exact:true})).toBeVisible();
    expect(await geometry()).toEqual(beforeQuery);
    await page.evaluate(() => (window as any).finishModelQuery());
    await expect(form.getByRole("status")).toContainText("已获取 53 个模型");
    expect(await geometry()).toEqual(beforeQuery);
    const toggle = form.getByRole("button", {name:"选择模型 ID 3",exact:true});
    await toggle.scrollIntoViewIfNeeded();
    const beforePicker = await geometry();
    await toggle.click();
    const search = form.getByLabel("搜索模型 ID 3", {exact:true});
    await expect(search).toBeFocused();
    expect(await geometry()).toEqual(beforePicker);
    const popup = form.locator(".ai-model-options");
    const bounds = await popup.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
    await search.fill("second");
    expect(await geometry()).toEqual(beforePicker);
    await popup.getByRole("button", {name:"fixture-second",exact:true}).click();
    await expect(popup).toBeHidden();
    expect(await geometry()).toEqual(beforePicker);
    await expect(form.getByLabel("模型 ID 3", {exact:true})).toBeFocused();
  }
});
