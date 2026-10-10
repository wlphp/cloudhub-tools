import { expect, test } from "@playwright/test";

test("phone can review and import only certificate metadata from QR without accounts", async ({page}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator,"userAgent",{value:"Mozilla/5.0 Android CloudHub"});
    const fixture = { imported: false, selection: null as any };
    (window as any).certificateSync = fixture;
    const certificate = {syncId:"certificate-fixture",provider:"letsencrypt",primaryDomain:"example.com",domains:["example.com"],status:"issued",issuer:"Fixture CA",notBefore:Math.floor(Date.now()/1000)-86400,notAfter:Math.floor(Date.now()/1000)+86400*60,updatedAt:Date.now()};
    (window as any).__TAURI_INTERNALS__ = { transformCallback:()=>1,unregisterCallback:()=>{},invoke:async (command:string,args:any={}) => {
      if (command.endsWith("|request_permissions")) return {camera:"granted"};
      if (command.endsWith("|scan")) return {content:"http://192.168.1.2:1234/sync/fixture",format:"QR_CODE"};
      if (command === "fetch_sync_transfer") return {sessionId:"fixture-session",sourceDeviceId:"fixture-pc",sourcePublicKeyFingerprint:"fixture-key",preview:{protocolVersion:2,accounts:[],managedHosts:[],panels:[],flowConnections:[],deletions:[],conflicts:[],certificates:[certificate]}};
      if (command === "confirm_sync_transfer_import") { fixture.imported=true;fixture.selection=args.selection;return {accounts:0,managedHosts:0,panels:0,flowConnections:0,certificates:1,added:1,updated:0,deleted:0}; }
      if (command === "list_certificate_summaries") return fixture.imported ? [{...certificate,id:-1}] : [];
      return [];
    } };
  });
  await page.goto("/");
  const more = page.locator(".mobile-tab-bar").getByRole("button",{name:"更多",exact:true});
  await more.click();
  await page.locator(".mobile-more-feature").filter({hasText:"证书管理"}).click();
  await page.getByRole("button",{name:"从电脑同步",exact:true}).click();
  await page.getByRole("button",{name:"扫码从电脑迁移（免口令）"}).click();
  await expect(page.getByText(/证书信息 · .*不含私钥/)).toBeVisible();
  const confirm=page.getByRole("button",{name:"确认导入所选配置"});
  await page.getByRole("checkbox",{name:"导入证书 example.com"}).uncheck();
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox",{name:"导入证书 example.com"}).check();
  await confirm.click();
  await expect(page.getByRole("status")).toContainText("证书 1");
  expect(await page.evaluate(()=>(window as any).certificateSync.selection)).toMatchObject({accountSyncIds:[],managedHostSyncIds:[],panelSyncIds:[],flowConnectionSyncIds:[],certificateSyncIds:["certificate-fixture"]});
  await more.click();
  await page.locator(".mobile-more-feature").filter({hasText:"证书管理"}).click();
  await expect(page.locator(".mobile-cert-card h3")).toHaveText("example.com");
});
