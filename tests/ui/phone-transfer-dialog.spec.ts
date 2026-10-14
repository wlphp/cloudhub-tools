import { expect, test } from "@playwright/test";

test("phone migration defaults to 95 percent with fixed common header and footer and can shrink", async ({page}) => {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string)=>{
      if(command === "list_accounts") return Array.from({length:40},(_,i)=>({id:i+1,account_name:`测试账号 ${i+1}`,cloud_type:"aliyun",access_key_id:"fixture-id",enabled:true,sort_order:i}));
      if(command === "authenticator_status") return {configured:false,unlocked:false};
      if(command === "plugin:app|version") return "0.1.52";
      if(command === "plugin:event|listen") return 1;
      return [];
    }};
  });
  await page.setViewportSize({width:1440,height:900}); await page.goto("/");
  await page.getByRole("button", {name:"手机扫码迁移",exact:true}).first().click();
  const panel = page.getByRole("dialog", {name:"迁移到手机",exact:true});
  await expect(panel.locator(".sync-transfer-account")).toHaveCount(40);
  for (const width of [375,768,1024,1440]) {
    await page.setViewportSize({width,height:900});
    const bounds = await panel.boundingBox();
    expect(bounds!.width).toBeCloseTo(width*0.95,0); expect(bounds!.height).toBeCloseTo(900*0.95,0);
    expect(await panel.evaluate(el=>el.scrollWidth <= el.clientWidth)).toBe(true);
    const header = panel.locator(".sync-transfer-heading"), footer = panel.locator(".sync-transfer-footer");
    const initialHead = await header.boundingBox(), initialFoot = await footer.boundingBox();
    await panel.locator(".sync-transfer-body").evaluate(el=>{el.scrollTop=el.scrollHeight;});
    expect(await header.boundingBox()).toEqual(initialHead); expect(await footer.boundingBox()).toEqual(initialFoot);
    await expect(panel.getByRole("button", {name:"关闭迁移面板"})).toBeVisible();
    expect(await panel.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe(await footer.evaluate(el=>getComputedStyle(el).backgroundColor));
  }
  await panel.getByRole("button", {name:"缩小迁移弹层"}).click();
  const small = await panel.boundingBox(); expect(small!.width).toBe(760); expect(small!.height).toBe(720);
  await panel.getByRole("button", {name:"放大迁移弹层"}).click();
  await panel.locator(".sync-transfer-body").evaluate(el=>{el.scrollTop=0;});
  await page.screenshot({path:"test-results/phone-migration-common-dialog.png"});
  await panel.getByRole("button", {name:"关闭迁移面板"}).click(); await expect(panel).toBeHidden();
  await page.getByRole("button", {name:"手机扫码迁移",exact:true}).first().click();
  expect((await panel.boundingBox())!.width).toBeCloseTo(1440*0.95,0);
});