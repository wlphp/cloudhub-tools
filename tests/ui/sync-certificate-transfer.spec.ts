import { expect, test } from "@playwright/test";

test("desktop can generate a QR containing certificates only", async ({page}) => {
  await page.addInitScript(() => {
    const calls:any[]=[];(window as any).certificateCalls=calls;
    (window as any).__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async (command:string,args:any={})=>{
      calls.push({command,args});
      if(command === "list_certificate_summaries")return [{id:7,syncId:"",provider:"letsencrypt",primaryDomain:"example.com",domains:["example.com"],status:"issued",notAfter:Date.now()/1000+86400*90,updatedAt:Date.now()}];
      if(command === "start_sync_transfer")return {pairingUrl:"http://192.168.1.2:1234/sync/fixture",sourceDeviceId:"fixture-pc",sourcePublicKeyFingerprint:"fixture-key"};
      if(command === "plugin:event|listen")return 1;
      if(command === "plugin:app|version")return "0.1.43";
      return [];
    }};
  });
  await page.goto("/");
  await page.getByRole("button",{name:"手机扫码迁移",exact:true}).first().click();
  await page.getByRole("tab",{name:/证书/}).click();
  await expect(page.getByText("仅证书信息",{exact:false})).toBeVisible();
  await page.getByRole("button",{name:"显示手机迁移二维码（免口令）"}).click();
  await expect(page.getByText(/电脑正在等待手机扫码/)).toBeVisible();
  const args=await page.evaluate(()=>(window as any).certificateCalls.find((call:any)=>call.command==="start_sync_transfer").args);
  expect(args.certificateIds).toEqual([7]);
  expect(args.accountIds).toEqual([]);
  expect(args.flowConnectionIds).toEqual([]);
});
