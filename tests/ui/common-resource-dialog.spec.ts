import { expect, test } from "@playwright/test";

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
  await dialog.getByRole("button", {name:"放大",exact:true}).click();
  await expect(dialog).toHaveClass(/is-maximized/);
  await dialog.getByRole("button", {name:"还原",exact:true}).click();
  await expect(dialog).not.toHaveClass(/is-maximized/);
});