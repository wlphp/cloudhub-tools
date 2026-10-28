import { test, expect } from "@playwright/test";
import { transferFixture } from "../transfer-fixture";
test("phone unified migration selects flow module", async ({ page }) => {
  await transferFixture(page, "flow_connections", "流水线连接", true);
});
test("phone reports denied camera permission and allows retry", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator,"userAgent",{value:"Mozilla/5.0 Android CloudHub"});
    (window as any).__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string)=>{
      if(command.endsWith("|request_permissions")) return {camera:"denied"};
      return [];
    }};
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button",{name:"更多",exact:true}).click();
  await page.locator(".mobile-more-feature").filter({hasText:"系统设置"}).click();
  await page.getByRole("button",{name:/导入数据/}).click();
  const scan=page.getByRole("button",{name:"扫码接收电脑配置"});
  await scan.click();
  await expect(page.getByRole("alert")).toContainText("相机权限");
  await expect(page.getByRole("button",{name:"打开相机权限设置"})).toBeVisible();
  await expect(scan).toBeEnabled();
});
