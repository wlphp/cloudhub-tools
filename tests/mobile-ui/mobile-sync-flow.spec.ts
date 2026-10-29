import { test, expect } from "@playwright/test";
import { transferFixture } from "../transfer-fixture";

test("browser can select a local backup and review before restoring", async ({ page }) => {
  let confirmed = false;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/database-import/preview") {
      expect(route.request().headers()["x-backup-password"]).toBe(encodeURIComponent("测试密码"));
      expect(route.request().postDataBuffer()?.toString()).toBe("fixture-backup");
      return route.fulfill({ json: { token: "local-preview", packageName: "fixture.chdb", exportedAt: "2026-10-29", totalRecords: 1, categories: [{ table: "memo_notes", label: "备忘录", count: 1 }], details: [], conflicts: [], importMode: "backup" } });
    }
    if (path === "/api/database-import/confirm") confirmed = true;
    return route.fulfill({ json: [] });
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
  await page.locator(".mobile-more-feature").filter({ hasText: "系统设置" }).click();
  await page.getByRole("button", { name: /导入数据/ }).click();
  await page.getByLabel("备份密码（可选）", { exact: true }).fill("测试密码");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "选择 .chdb 备份", exact: true }).click();
  await (await chooser).setFiles({ name: "fixture.chdb", mimeType: "application/octet-stream", buffer: Buffer.from("fixture-backup") });
  await expect(page.getByRole("alertdialog", { name: "确认恢复业务数据" })).toContainText("备忘录");
  expect(confirmed).toBe(false);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog", { name: "确认恢复业务数据" })).toHaveCount(0);
  expect(confirmed).toBe(false);
});

test("errors after scanning are readable next to scan control", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
      if (command.endsWith("|request_permissions")) return { camera: "granted" };
      if (command.endsWith("|scan")) return { content: "http://192.168.1.2:1234/sync/fixture", format: "QR_CODE" };
      if (command === "fetch_sync_transfer") throw { kind: "platform-error", code: "network", message: "无法连接电脑迁移服务，请检查防火墙" };
      return [];
    } };
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
  await page.locator(".mobile-more-feature").filter({ hasText: "系统设置" }).click();
  await page.getByRole("button", { name: /导入数据/ }).click();
  await page.getByRole("button", { name: "扫码接收电脑配置" }).click();
  const card = page.locator(".mobile-import-card").first();
  await expect(card.getByRole("alert")).toHaveText("无法连接电脑迁移服务，请检查防火墙");
  await expect(card.getByRole("button", { name: "扫码接收电脑配置" })).toBeEnabled();
});
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
  await expect(page.getByRole("heading", { name: "导入数据", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "数据迁移" })).toHaveCSS("box-shadow", "none");
  const scan=page.getByRole("button",{name:"扫码接收电脑配置"});
  await scan.click();
  await expect(page.getByRole("alert")).toContainText("相机权限");
  await expect(page.getByRole("button",{name:"打开相机权限设置"})).toBeVisible();
  await expect(scan).toBeEnabled();
  await page.getByRole("button", { name: "返回系统设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "系统设置", exact: true })).toBeVisible();
});
