import { test, expect } from "@playwright/test";
import type { CloudSyncProgress } from "../../src/platform/clients/cloudSync";

test("browser cloud backup downloads directly into desktop restore review and confirms selected modules", async ({ page }) => {
  let restored: unknown;
  let cancelled = 0;
  let view = {
    configured: false,
    config: { method: "webdav", provider: "custom", endpoint: "", username: "", accessKeyId: "", bucket: "", region: "us-east-1", pathStyle: true, remoteRoot: "cloudhub-sync", profile: "default", autoSync: false, allowInsecure: false, passwordProtected: false, hasPassword: false, hasSecretKey: false, hasBackupPassword: false },
    status: { busy: false, paused: false, lastUpload: null as string | null, lastDownload: null as string | null, error: null, progress: null as CloudSyncProgress | null },
  };
  let uploaded = false;
  let finishUpload!: () => void;
  const uploadGate = new Promise<void>(resolve => { finishUpload = resolve; });
  let finishDownload!: () => void;
  const downloadGate = new Promise<void>(resolve => { finishDownload = resolve; });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/cloud-sync/state") return route.fulfill({ json: view });
    if (path === "/api/cloud-sync/test") return route.fulfill({ json: null });
    if (path === "/api/cloud-sync/save") {
      const { password: _password, secretKey: _secret, backupPassword: _backup, ...config } = route.request().postDataJSON().config;
      view = { ...view, configured: true, config: { ...view.config, ...config, hasPassword: true } };
      return route.fulfill({ json: view });
    }
    if (path === "/api/cloud-sync/upload") {
      expect(route.request().postDataJSON()).toEqual({});
      uploaded = true;
      view.status.busy = true;
      view.status.progress = { phase: "uploading", transferred: 1024, total: 2048 };
      await uploadGate;
      view.status.busy = false; view.status.progress = null;
      view.status.lastUpload = new Date().toISOString();
      return route.fulfill({ json: view });
    }
    if (path === "/api/cloud-sync/download") {
      view.status.busy = true;
      view.status.progress = { phase: "downloading", transferred: 1024, total: null };
      await downloadGate;
      view.status.busy = false; view.status.progress = null;
      return route.fulfill({ contentType: "application/octet-stream", body: "non-sensitive-file-fixture" });
    }
    if (path === "/api/database-import/preview") {
      expect(route.request().postDataBuffer()?.toString()).toBe("non-sensitive-file-fixture");
      return route.fulfill({ json: { token: "fixture-preview", packageName: "云端备份", exportedAt: "2026-10-29", totalRecords: 3, categories: [{ table: "memo_notes", label: "备忘录", count: 2 }, { table: "flow_connections", label: "流水线连接", count: 1 }], details: [], conflicts: [], importMode: "backup" } });
    }
    if (path === "/api/database-import/confirm") {
      restored = route.request().postDataJSON();
      return route.fulfill({ json: "恢复完成：新增 2 条；恢复前快照已保存" });
    }
    if (path === "/api/database-import/cancel") { cancelled++; return route.fulfill({ json: null }); }
    return route.fulfill({ json: [] });
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
  await page.locator(".mobile-more-feature").filter({ hasText: "系统设置" }).click();
  await page.getByRole("button", { name: /导入数据/ }).click();
  const cloud = page.getByRole("region", { name: "云同步" });
  await expect(cloud.locator(".data-settings-badge")).toHaveText("未配置");
  await cloud.getByRole("button", { name: "展开", exact: true }).click();
  await cloud.getByLabel("WebDAV 服务器地址").fill("https://storage.example/dav");
  await cloud.getByLabel("WebDAV 账号", { exact: true }).fill("fixture-user");
  await cloud.getByLabel("WebDAV 密码", { exact: true }).fill("non-sensitive-fixture");
  await cloud.getByRole("button", { name: "测试连接", exact: true }).click();
  const result = page.getByRole("alertdialog");
  await expect(result).toContainText("测试连接成功");
  await result.getByRole("button", { name: "确定", exact: true }).click();
  await cloud.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(result).toContainText("保存配置成功");
  await result.getByRole("button", { name: "确定", exact: true }).click();
  await expect(cloud.locator(".data-settings-badge")).toHaveText("已配置");
  await expect(cloud.getByLabel("上传备份文件")).toHaveCount(0);
  await expect(cloud.getByRole("button", { name: "上传到云端" })).toBeEnabled();
  await cloud.getByRole("button", { name: "上传到云端" }).click();
  await page.getByRole("alertdialog", { name: "上传云备份", exact: true }).getByRole("button", { name: "确认上传" }).click();
  await expect(cloud.getByRole("progressbar")).toHaveAttribute("value", "50");
  await expect(cloud.locator(".cloud-sync-progress")).toContainText("50% · 1.0 KB / 2.0 KB");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await cloud.locator(".cloud-sync-progress").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  finishUpload();
  await expect(result).toContainText("本机当前数据已备份并上传");
  await expect(cloud.getByRole("progressbar")).toHaveCount(0);
  expect(uploaded).toBe(true);
  await result.getByRole("button", { name: "确定", exact: true }).click();
  await cloud.getByRole("button", { name: "从云端下载" }).click();
  await expect(cloud.getByRole("progressbar")).toHaveAccessibleName("正在下载备份");
  await expect(cloud.getByRole("progressbar")).not.toHaveAttribute("value");
  await expect(cloud.locator(".cloud-sync-progress")).toContainText("1.0 KB");
  finishDownload();
  const review = page.getByRole("alertdialog", { name: "确认恢复业务数据" });
  await expect(review).toBeVisible();
  expect(restored).toBeUndefined();
  await page.locator(".modal-backdrop").last().click({ position: { x: 1, y: 1 }, force: true });
  await expect(review).toBeVisible();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await review.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  await expect.poll(() => cancelled).toBe(1);
  expect(restored).toBeUndefined();
  await cloud.getByRole("button", { name: "从云端下载" }).click();
  await expect(review).toBeVisible();
  await review.getByRole("checkbox", { name: /流水线连接/ }).uncheck();
  await review.getByLabel("恢复方式", { exact: true }).selectOption("merge");
  await review.getByRole("button", { name: "确定导入", exact: true }).click();
  await expect(review).toHaveCount(0);
  expect(restored).toEqual({ token: "fixture-preview", tables: ["memo_notes"], mode: "merge", forceRestore: false });
  await expect(page.getByRole("region", { name: "数据迁移" })).toContainText("恢复完成：新增 2 条");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await cloud.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
});
