import { expect, test } from "@playwright/test";
import { verifyCloudChannels } from "../cloud-sync-channels.scenario";

test("mobile manages independent cloud channels and scopes every operation", async ({ page }) => {
  await verifyCloudChannels(page, true);
});

test("迁移页和同步弹层在手机宽度下布局统一且遮罩不关闭", async ({ page }) => {
  const channel = { configured: true, config: { id: "default", name: "演示渠道", method: "webdav", provider: "custom", endpoint: "https://storage.example.test/dav", username: "", accessKeyId: "", bucket: "", region: "us-east-1", remoteRoot: "cloudhub-sync", profile: "default", hasPassword: true, hasSecretKey: false, hasBackupPassword: false, pathStyle: true, autoSync: false, allowInsecure: false, passwordProtected: false }, status: { busy: false, paused: false, error: null, lastUpload: null, lastDownload: null } };
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === "/api/member" ? null : path === "/api/cloud-sync/channels" ? [channel] : path === "/api/cloud-sync/state" ? channel : path === "/api/database-import/catalog" ? [{ table: "memo_notes", label: "备忘录", count: 0 }] : path === "/api/cloud-sync/versions" ? [{ id: "backup-demo.chdb", machineName: "演示电脑", uploadedAt: "2026-11-14T01:00:00Z", passwordProtected: true }] : [];
    return route.fulfill({ json });
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的", exact: true }).click();
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: "数据导入与迁移", exact: true }).click();
  const card = page.getByRole("article", { name: "演示渠道", exact: true });
  await expect(card).toBeVisible();
  for (const width of [320, 390, 519, 768]) {
    await page.setViewportSize({ width, height: 838 });
    expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const button of await card.locator(".cloud-sync-history-open").all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await button.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe("1px");
    }
  }
  await page.setViewportSize({ width: 519, height: 838 });
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/migration-page-refined.png", animations: "disabled" });
  for (const trigger of ["编辑", "上传记录", "下载记录", "下载备份"]) {
    await card.getByRole("button", { name: trigger, exact: true }).click();
    const dialog = page.getByRole("dialog").last();
    await expect(dialog).toBeVisible();
    if (trigger === "编辑") {
      for (const method of ["s3", "oss", "webdav"]) {
        await dialog.getByRole("combobox", { name: "同步方式", exact: true }).selectOption(method);
        for (const width of [320, 390, 519, 768]) {
          await page.setViewportSize({ width, height: 838 });
          expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        }
      }
    }
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => document.body.classList.toggle("theme-light", value === "light"), theme);
      for (const width of [320, 390, 519]) {
        await page.setViewportSize({ width, height: 838 });
        expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await dialog.screenshot({ path: `test-results/migration-dialog-${trigger}-${theme}.png`, animations: "disabled" });
    }
    const search = dialog.locator('input[type="search"]').first();
    if (await search.count()) {
      await search.focus();
      expect(await search.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe("0px");
    }
    await page.locator(".shared-dialog-backdrop").last().click({ position: { x: 1, y: 1 }, force: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  await page.getByRole("button", { name: "添加同步渠道", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "添加同步渠道", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
});
