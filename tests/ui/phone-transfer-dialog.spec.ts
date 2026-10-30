import { expect, test } from "@playwright/test";

test("phone migration defaults to 95 percent with fixed common header and footer and can shrink", async ({page}) => {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {metadata:{currentWindow:{label:"main"},currentWebview:{label:"main"}},transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string)=>{
      if(command === "list_accounts") return Array.from({length:40},(_,i)=>({id:i+1,account_name:`测试账号 ${i+1}`,cloud_type:"aliyun",access_key_id:"fixture-id",enabled:true,sort_order:i}));
      if(command === "authenticator_status") return {configured:false,unlocked:false};
      if(command === "database_transfer_catalog") return [{table:"cloud_accounts",label:"云账号",count:40},{table:"ssh_connections",label:"SSH 主机",count:0},{table:"panel_connections",label:"面板",count:0}];
      if(command === "plugin:app|version") return "0.1.52";
      if(command === "plugin:event|listen") return 1;
      if(command === "list_client_preferences") return {};
      return [];
    }};
  });
  await page.setViewportSize({width:1440,height:900}); await page.goto("/");
  await page.getByRole("button", {name:"系统设置",exact:true}).first().click();
  await page.getByRole("tab", {name:"数据管理"}).click();
  await page.getByRole("button", {name:"开始迁移",exact:true}).click();
  const panel = page.getByRole("dialog", {name:"迁移到手机",exact:true});
  await panel.locator("details.sync-transfer-scope-details > summary").click();
  await expect(panel.getByRole("group", { name: "数据范围" })).toBeVisible();
  await expect(panel.locator(".sync-transfer-scope-details .data-transfer-check input[type=checkbox]")).toHaveCount(3);
  await expect(panel.getByRole("checkbox", { name: "包含回收站（默认关闭）" })).not.toBeChecked();
  for (const width of [375,768,1024,1440]) {
    await page.setViewportSize({width,height:900});
    const bounds = await panel.boundingBox();
    expect(bounds!.width).toBeCloseTo(width*0.95,0); expect(bounds!.height).toBeCloseTo(900*0.95,0);
    expect(await panel.evaluate(el=>el.scrollWidth <= el.clientWidth)).toBe(true);
    const header = panel.locator(":scope > .modal-head"), footer = panel.locator(":scope > .modal-actions");
    const initialHead = await header.boundingBox(), initialFoot = await footer.boundingBox();
    await panel.locator(".modal-body").evaluate(el=>{el.scrollTop=el.scrollHeight;});
    expect(await header.boundingBox()).toEqual(initialHead); expect(await footer.boundingBox()).toEqual(initialFoot);
    await expect(panel.getByRole("button", {name:"关闭", exact:true})).toBeVisible();
    expect(await panel.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe(await footer.evaluate(el=>getComputedStyle(el).backgroundColor));
  }
  await panel.getByRole("button", {name:"缩小弹层"}).click();
  const small = await panel.boundingBox(); expect(small!.width).toBeLessThan(1440 * 0.95); expect(small!.height).toBeLessThan(900 * 0.95);
  await panel.getByRole("button", {name:"最大化弹层"}).click();
  await panel.locator(".modal-body").evaluate(el=>{el.scrollTop=0;});
  await page.screenshot({path:"test-results/phone-migration-common-dialog.png"});
  await panel.getByRole("button", {name:"关闭迁移到手机"}).click(); await expect(panel).toBeHidden();
  await page.getByRole("button", {name:"开始迁移",exact:true}).click();
  expect((await panel.boundingBox())!.width).toBeCloseTo(1440*0.95,0);
});
