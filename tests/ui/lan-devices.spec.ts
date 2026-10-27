import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, native = true) {
  await page.addInitScript(({ native }) => {
    const w = window as any;
    if (!native) return;
    const networkKey = "a".repeat(64);
    const device = { ip:"192.168.40.7", mac:"b8:27:eb:01:02:03", hostname:"fixture.local", vendor:"Raspberry Pi Foundation", kind:"服务器/网络设备（推测）", evidence:["TCP 22 开放"], ports:[22,443], latencyMs:3, lastSeen:1700000000000, alias:"", note:"", tags:"", favorite:false, manualKind:"" };
    const old = { ...device, ip:"192.168.40.8", mac:"b8:27:eb:01:02:04", ports:[], hostname:"old.local", alias:"历史设备" };
    w.__lan = { calls:[], scan:null, devices:[device,old], history:[], fail:false };
    Object.defineProperty(window,"__TAURI_INTERNALS__", { value: {
      metadata:{currentWindow:{label:"main"},currentWebview:{label:"main"}}, transformCallback:()=>1,unregisterCallback:()=>{},
      invoke: async (command: string, args: any) => {
        w.__lan.calls.push({command,args});
        if (command === "lan_interfaces") return [{id:"1",name:"Wi-Fi",ip:"192.168.40.2",prefix:24,gateway:"192.168.40.1",network:"测试网络",networkKey,suggestedRange:"192.168.40.0/24"},{id:"2",name:"VPN",ip:"192.168.40.3",prefix:24,gateway:"",network:"另一个网络",networkKey:"b".repeat(64),suggestedRange:"192.168.40.0/24"}];
        if (command === "lan_status") return w.__lan.scan;
        if (command === "lan_ledger") return args.networkKey === networkKey ? {devices:w.__lan.devices,history:w.__lan.history} : {devices:[],history:[]};
        if (command === "lan_start") {
          if (w.__lan.fail) throw new Error("网络已变化，请刷新网卡后重试");
          w.__lan.scan = {id:"scan-1",networkKey,interfaceId:"1",range:args.range,status:"running",completed:1,total:254,startedAt:1700000000000,finishedAt:null,devices:[device],warnings:[]}; return w.__lan.scan;
        }
        if (command === "lan_cancel") { w.__lan.scan = {...w.__lan.scan,status:"cancelled",finishedAt:1700000001000}; w.__lan.history=[w.__lan.scan]; return; }
        if (command === "lan_annotate") { w.__lan.devices = w.__lan.devices.map((d:any)=>`mac:${d.mac}`===args.input.deviceKey ? {...d,...args.input} : d); return; }
        if (command === "lan_export") return "fixture.csv";
        if (command === "wechat_plugin_status") return {supported:true,detectedPath:null,runningProcesses:0};
        if (command === "authenticator_status") return {configured:false,unlocked:false};
        if (command === "list_client_preferences") return {};
        if (command === "notes_snapshot") return {notes:[],trashed:[],groups:[],reminders:[]};
        return [];
      }
    }});
  }, { native });
  await page.goto("/");
  await page.getByRole("button", { name:"软件商店", exact:true }).first().click();
  await page.getByLabel("应用搜索", {exact:true}).fill("局域网设备");
  await page.locator(".store-table tbody tr").getByRole("button", {name:"打开",exact:true}).click();
}

test("browser preview does not expose native scan controls", async ({ page }) => {
  await fixture(page,false);
  await expect(page.getByText("局域网设备扫描仅支持 Windows 和 macOS",{exact:false})).toBeVisible();
  await expect(page.getByRole("button",{name:"开始扫描",exact:true})).toHaveCount(0);
});

test("scan sends typed range and ports; stop persists partial results and history", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button",{name:"开始扫描",exact:true}).click();
  await expect(page.getByRole("button",{name:"停止",exact:true})).toBeEnabled();
  await expect(page.getByLabel("扫描进度")).toHaveAttribute("value","1");
  expect(await page.evaluate(()=>(window as any).__lan.calls.find((c:any)=>c.command==="lan_start").args)).toMatchObject({interfaceId:"1",sourceIp:"192.168.40.2",networkKey:"a".repeat(64),range:"192.168.40.0/24",ports:[22,80,443,445,3389,631,9100,554]});
  const old = page.locator(".lan-table tbody tr").filter({hasText:"历史设备"});
  await expect(old).toContainText("尚未发现");
  await page.getByRole("button",{name:"停止",exact:true}).click();
  await expect(page.getByRole("button",{name:"开始扫描",exact:true})).toBeEnabled();
  await expect(old).toContainText("历史 / 本次未发现");
  await page.getByRole("button",{name:"扫描历史",exact:false}).click();
  await page.locator(".lan-history > button").click();
  await expect(page.getByRole("dialog",{name:"扫描历史详情"})).toContainText("已停止");
});

test("notes use shared dialogs; backdrop preserves edits; exports and network scopes work", async ({ page }) => {
  await fixture(page);
  await page.locator(".lan-table tbody tr").filter({hasText:"fixture.local"}).getByRole("button",{name:"详情",exact:true}).click();
  await page.getByRole("button",{name:"编辑台账",exact:true}).click();
  const dialog = page.getByRole("dialog",{name:"编辑设备台账",exact:true});
  await dialog.getByLabel("设备别名",{exact:true}).fill("办公 NAS");
  await dialog.getByLabel("备注",{exact:true}).fill("本地记录");
  await dialog.getByLabel("操作系统（手动标记）",{exact:true}).fill("Linux / Ubuntu");
  await dialog.getByLabel("收藏设备",{exact:true}).check();
  await page.locator("body > .modal-backdrop").last().click({position:{x:2,y:2},force:true});
  await expect(dialog).toBeVisible(); await expect(dialog.getByLabel("设备别名",{exact:true})).toHaveValue("办公 NAS");
  await dialog.getByRole("button",{name:"保存",exact:true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".lan-table")).toContainText("办公 NAS");
  await expect(page.locator(".lan-table")).toContainText("Linux / Ubuntu · 手动标记");
  await page.getByRole("button",{name:"CSV",exact:true}).click();
  await expect(page.getByText("设备台账已导出：fixture.csv",{exact:true})).toBeVisible();
  await page.getByLabel("网络接口",{exact:true}).selectOption({label:"VPN · 192.168.40.3/24 · 另一个网络"});
  await expect(page.locator(".lan-table tbody tr")).toHaveCount(0);
});

test("invalid ports stay local and backend failures are visible", async ({ page }) => {
  await fixture(page);
  await page.getByLabel("TCP 端口",{exact:true}).fill("22,bad");
  await page.getByRole("button",{name:"开始扫描",exact:true}).click();
  await expect(page.getByRole("alert").filter({hasText:"TCP 端口"})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__lan.calls.some((c:any)=>c.command==="lan_start"))).toBe(false);
  await page.getByLabel("TCP 端口",{exact:true}).fill("22,443");
  await page.evaluate(()=>(window as any).__lan.fail=true);
  await page.getByRole("button",{name:"开始扫描",exact:true}).click();
  await expect(page.getByRole("alert").filter({hasText:"网络已变化"})).toBeVisible();
  await expect(page.getByRole("button",{name:"开始扫描",exact:true})).toBeEnabled();
});

test("SSH reuses the existing connection editor with no credentials in scanner", async ({ page }) => {
  await fixture(page);
  await page.locator(".lan-table tbody tr").filter({hasText:"fixture.local"}).getByRole("button",{name:"SSH",exact:true}).click();
  await expect(page.locator(".lan-devices")).toHaveCount(0);
  await expect(page.getByRole("dialog").last()).toContainText("SSH");
  await expect(page.locator('input[value="192.168.40.7"]')).toBeVisible();
});

test("systems, models, evidence and legacy unknown records remain distinct", async ({ page }) => {
  await page.setViewportSize({width:1440,height:1000});
  await fixture(page);
  await page.evaluate(() => {
    const state = (window as any).__lan;
    const base = state.devices[0];
    state.devices = [
      {...base, os:"Linux / Ubuntu",osStatus:"inferred",evidence:["SSH 服务标识：SSH-2.0-OpenSSH_9.6 Ubuntu-1"],manualOs:""},
      {...base,ip:"192.168.40.9",mac:"00:1c:b3:01:02:03",hostname:"MacBook.local",kind:"电脑（推测）",vendor:"Apple",os:"macOS",osStatus:"inferred",model:"MacBookPro18,3",ports:[],evidence:["Bonjour 设备型号：MacBookPro18,3"]},
      {...base,ip:"192.168.40.10",mac:"",hostname:"workstation",kind:"本机",vendor:"",os:"Windows",osStatus:"identified",ports:[445],evidence:["本机运行平台信息（非端口推测）"]},
      {...state.devices[1],macKind:"local",vendor:""},
    ];
  });
  await page.getByLabel("网络接口",{exact:true}).selectOption({label:"VPN · 192.168.40.3/24 · 另一个网络"});
  await page.getByLabel("网络接口",{exact:true}).selectOption({label:"Wi-Fi · 192.168.40.2/24 · 测试网络"});
  const table = page.locator(".lan-table");
  await expect(table).toContainText("Windows · 已识别（本机）");
  await expect(table).toContainText("macOS · 推测");
  await expect(table).toContainText("Linux / Ubuntu · 推测");
  await expect(table).toContainText("系统未识别");
  await expect(table).toContainText("本地管理 MAC");
  await page.getByLabel("搜索设备",{exact:true}).fill("macOS");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await table.getByRole("button",{name:"详情",exact:true}).click();
  const detail = page.getByRole("dialog",{name:"设备详情",exact:false});
  await expect(detail).toContainText("MacBookPro18,3");
  await expect(detail).toContainText("Bonjour 设备型号");
  await detail.screenshot({path:"test-results/lan-device-detail-macos.png"});
  await page.keyboard.press("Escape");
  await page.getByLabel("搜索设备",{exact:true}).fill("");
  await page.locator(".lan-devices").screenshot({path:"test-results/lan-devices-systems.png"});
});

for (const width of [375,768,1024,1440]) {
  test(`device layout stays inside viewport at ${width}px`, async ({ page }) => {
    await page.setViewportSize({width,height:900}); await fixture(page);
    // Force page presentation through the shared store settings when opened as a dialog.
    const region = page.locator(".lan-devices"); await expect(region).toBeVisible();
    const bounds = await region.boundingBox(); expect(bounds).not.toBeNull(); expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width+1);
    expect(await region.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    if (width === 1440) {
      const controlHeights = await region.locator(".lan-scan-form input, .lan-scan-form select").evaluateAll(els => els.map(el => el.getBoundingClientRect().height));
      expect(controlHeights).toEqual([34,34,34]);
      const tabBounds = await region.getByRole("button", {name:"设备台账",exact:false}).boundingBox();
      expect(tabBounds!.width).toBeLessThan(200);
      await page.getByRole("button", {name:"开始扫描",exact:true}).click();
      await expect(page.getByLabel("扫描进度")).toBeVisible();
      await page.evaluate(() => {
        document.body.classList.remove("theme-light");
        document.querySelector(".app-shell")?.classList.remove("theme-light");
      });
      await region.screenshot({path:"test-results/lan-devices-desktop.png"});
      await page.evaluate(() => {
        document.body.classList.add("theme-light");
        document.querySelector(".app-shell")?.classList.add("theme-light");
      });
      await region.screenshot({path:"test-results/lan-devices-light.png"});
    }
    if (width === 375) await region.screenshot({path:"test-results/lan-devices-narrow.png"});
    await region.locator(".lan-table tbody tr").filter({hasText:"fixture.local"}).getByRole("button",{name:"详情",exact:true}).click();
    const detail = page.getByRole("dialog", {name:"设备详情",exact:false});
    const detailBounds = await detail.boundingBox();
    expect(detailBounds!.width).toBeLessThanOrEqual(Math.min(760,width-32)+1);
    expect(detailBounds!.x).toBeGreaterThanOrEqual(0);
    expect(detailBounds!.x+detailBounds!.width).toBeLessThanOrEqual(width);
    expect(await detail.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    await expect(detail.getByRole("button",{name:"详情",exact:true})).toHaveCount(0);
    await expect(detail.getByRole("button",{name:"编辑台账",exact:true})).toBeInViewport();
    if (width === 375) await detail.screenshot({path:"test-results/lan-device-detail-narrow.png"});
    if (width === 1440) {
      await detail.screenshot({path:"test-results/lan-device-detail-light.png"});
      await page.evaluate(()=>{
        document.body.classList.remove("theme-light");
        document.querySelector(".app-shell")?.classList.remove("theme-light");
      });
      await detail.screenshot({path:"test-results/lan-device-detail-dark.png"});
      await detail.getByRole("button",{name:"最大化弹层",exact:true}).click();
      expect((await detail.boundingBox())!.width).toBeGreaterThan(1000);
      await detail.getByRole("button",{name:"缩小弹层",exact:true}).click();
      expect((await detail.boundingBox())!.width).toBeLessThanOrEqual(761);
    }
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
  });
}
