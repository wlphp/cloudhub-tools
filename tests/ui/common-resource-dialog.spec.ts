import { expect, test } from "@playwright/test";

test("summary, servers, lightweight servers and WHOIS reuse the neutral shared shell", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      if (command === "list_accounts") return [{ id: 7, account_name: "fixture-account", cloud_type: "aliyun", access_key_id: "fixture-id", enabled: true, created_at: 1 }];
      if (command === "list_local_assets") return ["ecs", "swas", "domain"].filter(type => !args.resourceType || type === args.resourceType).map(resource_type => ({ account_id: 7, resource_type, asset_key: resource_type === "domain" ? "example.test" : `fixture-${resource_type}`, region_id: "cn-hangzhou", payload: resource_type === "domain" ? { DomainName: "example.test" } : { InstanceId: `fixture-${resource_type}`, InstanceName: `fixture-${resource_type}`, InstanceStatus: "Running" }, fetched_at: 1 }));
      if (command === "query_whois") return "Domain Name: EXAMPLE.TEST\nRegistrar: Fixture Registrar";
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      return [];
    } };
  });
  await page.goto("/");
  for (const view of ["summary", "ecs", "swas"]) {
    if (view === "summary") await page.getByRole("button", { name: "打开 fixture-account 资产汇总", exact: true }).click();
    else if (view === "ecs") await page.getByRole("button", { name: /查看 fixture-account 服务器资产/ }).click();
    else {
      await page.getByRole("button", { name: "更多 fixture-account 资产操作", exact: true }).click();
      await page.getByRole("button", { name: /查看 fixture-account 轻量服务器资产/ }).click();
    }
    const dialog = page.locator(".resource-modal");
    await expect(dialog).toHaveClass(/shared-content-dialog/);
    await expect(dialog.getByText("加载中...", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "实时拉取", exact: true })).toBeEnabled();
    expect(await dialog.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(40, 40, 40)");
    expect(await dialog.locator(".modal-head").evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(48, 48, 48)");
    await dialog.screenshot({ path: `test-results/shared-resource-${view}.png` });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  await page.getByRole("button", { name: "资产管理", exact: true }).click();
  await page.getByRole("button", { name: "WHOIS", exact: true }).click();
  const whois = page.getByRole("dialog", { name: "【example.test】WHOIS", exact: true });
  await expect(whois).toHaveClass(/shared-content-dialog/);
  await expect(whois).toContainText("Fixture Registrar");
  expect(await whois.locator(".modal-head").evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(48, 48, 48)");
  await whois.screenshot({ path: "test-results/shared-resource-whois.png" });
  await page.keyboard.press("Escape");
  await expect(whois).toHaveCount(0);
});

test("resource dialog has one live pull action and refreshes local data without duplicate requests", async ({page}) => {
  await page.addInitScript(() => {
    let refreshed = false;
    (window as any).resourcePulls = [];
    (window as any).__TAURI_INTERNALS__ = {transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,args:any={})=>{
      if(command === "list_accounts") return [{id:7,account_name:"fixture-account",cloud_type:"aliyun",access_key_id:"fixture-id",enabled:true,created_at:1}];
      if(command === "list_local_assets") return Array.from({length:refreshed?2:1},(_,i)=>({account_id:7,resource_type:"rds",asset_key:`fixture-db-${i}`,region_id:"cn-hangzhou",payload:{DBInstanceId:`fixture-db-${i}`,DBInstanceStatus:"Running",Engine:"MySQL",RegionId:"cn-hangzhou"},fetched_at:1}));
      if(command === "sync_cloud_assets") { (window as any).resourcePulls.push(args); return new Promise(resolve => { (window as any).finishPull = () => {refreshed=true;resolve({fetched:2,counts:{rds:2},errors:[]});}; }); }
      if(command === "authenticator_status") return {configured:false,unlocked:false};
      return [];
    }};
  });
  await page.goto("/");
  await page.getByRole("button", {name:"更多 fixture-account 资产操作",exact:true}).click();
  await page.getByRole("button", {name:/查看 fixture-account 云数据库资产/}).click();
  const dialog = page.locator(".resource-modal");
  await expect(dialog.locator(".rds-card")).toHaveCount(1);
  await expect(dialog.getByRole("button", {name:"实时拉取",exact:true})).toHaveCount(1);
  await dialog.getByRole("button", {name:"实时拉取",exact:true}).click();
  await expect(dialog.getByRole("button", {name:"实时拉取",exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>(window as any).resourcePulls)).toEqual([{id:7,resourceTypes:["rds"]}]);
  await page.evaluate(()=>(window as any).finishPull());
  await expect(dialog.locator(".rds-card")).toHaveCount(2);
  await expect(dialog.getByRole("button", {name:"实时拉取",exact:true})).toBeEnabled();
  await expect(dialog).toHaveClass(/shared-content-dialog/);
  expect(await dialog.evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(40, 40, 40)");
  expect(await dialog.locator(".modal-head").evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(48, 48, 48)");
  await page.locator(".shared-dialog-backdrop").click({position:{x:2,y:2}});
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", {name:"最大化弹层",exact:true}).click();
  await expect(dialog).toHaveClass(/dialog-size-expanded/);
  await dialog.getByRole("button", {name:"缩小弹层",exact:true}).click();
  await expect(dialog).not.toHaveClass(/dialog-size-expanded/);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
