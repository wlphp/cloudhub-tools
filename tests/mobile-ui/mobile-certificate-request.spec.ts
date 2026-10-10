import { expect, test, type Page } from "@playwright/test";
import { certificateDomains, validateCertificateRequest } from "../../src/mobile/certificate-request";

test("certificate request validates domains within selected account zone", () => {
  expect(certificateDomains("EXAMPLE.COM., *.example.com\nexample.com")).toEqual(["example.com","*.example.com"]);
  const input = {accountId:1,provider:"letsencrypt" as const,primaryDomain:"example.com",domains:["example.com","*.example.com"],dnsZone:"example.com"};
  expect(validateCertificateRequest(input,["example.com"])).toBe("");
  expect(validateCertificateRequest({...input,domains:["other-example.com"]},["example.com"])).toContain("必须属于");
  expect(validateCertificateRequest({...input,dnsZone:"other.com"},["example.com"])).toContain("当前账号");
  expect(validateCertificateRequest({...input,domains:["*.bad..example.com"]},["example.com"])).toContain("有效");
  expect(validateCertificateRequest({...input,provider:"litessl"},["example.com"])).toContain("EAB");
});

async function fixture(page: Page) {
  await page.addInitScript(() => {
    const callbacks = new Map<number,any>();
    let next = 0, progressHandler = 0;
    const state:any = {calls:[],issued:false,failSync:false,failRequest:false,resolve:null,reject:null};
    (window as any).certificateFixture = state;
    state.emit = (stage:string,message:string,operationId?:string) => {
      const input = state.calls.findLast((call:any)=>call.command==="request_certificate")?.args.input;
      callbacks.get(progressHandler)?.({event:"certificate-request-progress",id:progressHandler,payload:{operationId:operationId ?? input?.operationId,stage,level:"info",message}});
    };
    state.complete = () => { state.issued=true;state.emit("completed","证书已签发并加密保存到本地");state.resolve({id:1,primaryDomain:"example.com"}); };
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback:(callback:any)=>{ callbacks.set(++next,callback);return next; },unregisterCallback:(id:number)=>callbacks.delete(id),
      invoke:async (command:string,args:any={})=>{
        state.calls.push({command,args});
        if(command === "list_accounts")return [{id:1,account_name:"DNS 账号一",cloud_type:"aliyun",enabled:true},{id:2,account_name:"DNS 账号二",cloud_type:"aliyun",enabled:true}];
        if(command === "list_local_assets")return [{account_id:1,resource_type:"domain",asset_key:"example.com",payload:{DomainName:"example.com"}},{account_id:2,resource_type:"domain",asset_key:"other.com",payload:{DomainName:"other.com"}}];
        if(command === "plugin:event|listen") {if(args.event==="certificate-request-progress") progressHandler=args.handler;return args.handler;}
        if(command === "plugin:event|unlisten")return;
        if(command === "request_certificate") {
          if(state.failRequest)throw {code:"permission",message:"fixture denied"};
          return new Promise((resolve,reject)=>{state.resolve=resolve;state.reject=reject;state.emit("dns-propagation","等待公共 DNS 验证");});
        }
        if(command === "cancel_certificate_request") { state.reject?.({code:"cancelled",message:"已取消并清理验证记录"});return; }
        if(command === "sync_cloud_assets") {if(state.failSync)throw {code:"network",message:"fixture offline"};return {errors:[],fetched:1,counts:{domain:1}};}
        if(command === "list_certificate_summaries")return state.issued ? [{id:1,syncId:"",provider:"letsencrypt",primaryDomain:"example.com",domains:["example.com"],status:"issued",notBefore:Date.now()/1000-86400,notAfter:Date.now()/1000+86400*90,updatedAt:Date.now()}]:[];
        return [];
      },
    };
  });
}

async function open(page:Page) {
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button",{name:"更多",exact:true}).click();
  await page.locator(".mobile-more-feature").filter({hasText:"证书管理"}).click();
  await page.getByRole("button",{name:"申请证书",exact:true}).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("DNS 区域",{exact:true})).toHaveValue("example.com");
}

test("phone issues certificate with scoped DNS, live progress and encrypted save",async ({page})=>{
  await fixture(page);await open(page);
  await page.getByLabel("DNS 账号",{exact:true}).selectOption("2");
  await expect(page.getByLabel("DNS 区域",{exact:true})).toHaveValue("other.com");
  await page.getByLabel("DNS 账号",{exact:true}).selectOption("1");
  await page.getByRole("button",{name:"主域名 + 通配符",exact:true}).click();
  await page.getByRole("button",{name:"开始申请",exact:true}).click();
  await expect(page.getByRole("log")).toContainText("等待公共 DNS 验证");
  await expect(page.getByLabel("DNS 账号",{exact:true})).toBeDisabled();
  await page.evaluate(()=>(window as any).certificateFixture.emit("completed","ignored foreign event","wrong-operation"));
  await expect(page.getByRole("log")).not.toContainText("ignored foreign event");
  const input = await page.evaluate(()=>(window as any).certificateFixture.calls.find((call:any)=>call.command==="request_certificate").args.input);
  expect(input).toMatchObject({accountId:1,dnsZone:"example.com",domains:["example.com","*.example.com"]});
  expect(input.operationId).toBeTruthy();
  await page.evaluate(() => {
    Object.defineProperty(document,"visibilityState",{value:"hidden",configurable:true});
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document,"visibilityState",{value:"visible",configurable:true});
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByRole("log")).toContainText("等待公共 DNS 验证");
  await page.evaluate(()=>(window as any).certificateFixture.complete());
  await expect(page.getByRole("status")).toContainText("证书已签发并保存");
  await page.getByRole("button",{name:"完成",exact:true}).click();
  await expect(page.locator(".mobile-cert-card h3")).toHaveText("example.com");
});

test("LiteSSL uses transient EAB fields and clears them after a failed request",async ({page})=>{
  await fixture(page);await open(page);
  await page.getByLabel("证书品牌",{exact:true}).selectOption("litessl");
  await page.getByLabel("EAB KID",{exact:true}).fill("fixture-kid");
  await page.getByLabel("EAB HMAC 密钥",{exact:true}).fill("Zml4dHVyZQ");
  await page.evaluate(()=>(window as any).certificateFixture.failRequest=true);
  await page.getByRole("button",{name:"开始申请",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("权限不足");
  const input = await page.evaluate(()=>(window as any).certificateFixture.calls.find((call:any)=>call.command==="request_certificate").args.input);
  expect(input).toMatchObject({provider:"litessl",eabKid:"fixture-kid",eabHmacKey:"Zml4dHVyZQ"});
  await expect(page.getByLabel("EAB KID",{exact:true})).toHaveValue("");
  await expect(page.getByLabel("EAB HMAC 密钥",{exact:true})).toHaveValue("");
  expect(await page.getByRole("dialog").innerText()).not.toContain("Zml4dHVyZQ");
});

test("phone rejects cross-zone input, handles offline and permission errors, and cancels request",async ({page})=>{
  await fixture(page);await open(page);
  await page.getByLabel("证书域名",{exact:true}).fill("other.com");
  await page.getByRole("button",{name:"开始申请",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("必须属于");
  expect(await page.evaluate(()=>(window as any).certificateFixture.calls.filter((call:any)=>call.command==="request_certificate").length)).toBe(0);
  await page.getByRole("button",{name:"主域名",exact:true}).click();
  await page.evaluate(()=>(window as any).certificateFixture.failSync=true);
  await page.getByRole("button",{name:"拉取域名",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("网络或云服务暂时不可用");
  await page.evaluate(()=>(window as any).certificateFixture.failRequest=true);
  await page.getByRole("button",{name:"开始申请",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("权限不足");
  await page.evaluate(()=>(window as any).certificateFixture.failRequest=false);
  await page.getByRole("button",{name:"开始申请",exact:true}).click();
  await expect(page.getByRole("log")).toContainText("等待公共 DNS 验证");
  await page.getByRole("button",{name:"取消申请",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("操作已取消");
  const calls = await page.evaluate(()=>(window as any).certificateFixture.calls);
  expect(calls.find((call:any)=>call.command==="cancel_certificate_request").args.operationId).toBe(calls.filter((call:any)=>call.command==="request_certificate").at(-1).args.input.operationId);
  await expect(page.getByLabel("DNS 账号",{exact:true})).toBeEnabled();
});

for(const width of [375,768,1024,1440]) test(`phone request form fits ${width}px`,async ({page})=>{
  await page.setViewportSize({width,height:900});await fixture(page);await open(page);
  await page.getByLabel("证书品牌",{exact:true}).selectOption("litessl");
  await expect(page.getByRole("textbox",{name:"EAB KID",exact:true})).toBeVisible();
  expect(await page.getByRole("dialog").evaluate((el)=>el.scrollWidth<=el.clientWidth)).toBeTruthy();
  await page.getByRole("button",{name:"关闭申请证书",exact:true}).click();
});

test("browser can preview form without submitting native signing",async ({page})=>{
  await page.route("**/api/**",async route=>{
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({json:path==="/api/accounts" ? [{id:1,account_name:"DNS 账号",cloud_type:"aliyun"}] : path==="/api/local-assets" ? [{account_id:1,resource_type:"domain",asset_key:"example.com",payload:{DomainName:"example.com"}}] : []});
  });
  await open(page);
  await expect(page.getByRole("button",{name:"开始申请",exact:true})).toBeDisabled();
  await expect(page.getByText("请在手机 App 中提交申请",{exact:false})).toBeVisible();
  await page.screenshot({path:"test-results/mobile-certificate-request.png"});
});
