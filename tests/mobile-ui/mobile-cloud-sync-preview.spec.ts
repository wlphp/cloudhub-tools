import { test, expect } from "@playwright/test";
import type { CloudSyncProgress } from "../../src/platform/clients/cloudSync";

test("mobile cloud restore aligns scopes, defaults to append and requires explicit replacement acknowledgement", async ({ page }) => {
  let restored: unknown;
  let cancelled = 0;
  let view = {
    configured: false,
    config: { id: "default", name: "默认渠道", method: "webdav", provider: "custom", endpoint: "", username: "", accessKeyId: "", bucket: "", region: "us-east-1", pathStyle: true, remoteRoot: "cloudhub-sync", profile: "default", autoSync: false, allowInsecure: false, passwordProtected: false, hasPassword: false, hasSecretKey: false, hasBackupPassword: false },
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
    if (path === "/api/cloud-sync/channels") return route.fulfill({ json: view.configured ? [view] : [] });
    if (path === "/api/cloud-sync/versions") return route.fulfill({ json: [{ id: "backup-11111111-1111-4111-8111-111111111111.chdb", machineName: "测试电脑", uploadedAt: "2026-10-29T12:00:00Z", passwordProtected: false }] });
    if (path === "/api/cloud-sync/test") return route.fulfill({ json: null });
    if (path === "/api/cloud-sync/save") {
      const { password: _password, secretKey: _secret, backupPassword: _backup, ...config } = route.request().postDataJSON().config;
      view = { ...view, configured: true, config: { ...view.config, ...config, hasPassword: true } };
      return route.fulfill({ json: view });
    }
    if (path === "/api/cloud-sync/upload") {
      expect(new URL(route.request().url()).searchParams.get("channelId")).toBe(view.config.id);
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
      expect(new URL(route.request().url()).searchParams.get("channelId")).toBe(view.config.id);
      expect(new URL(route.request().url()).searchParams.get("versionId")).toBe("backup-11111111-1111-4111-8111-111111111111.chdb");
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
    if (path === "/api/database-import/catalog") return route.fulfill({json:[{table:"memo_notes",label:"备忘录",count:0},{table:"flow_connections",label:"流水线连接",count:0}]});
    if (path === "/api/database-import/plan") {
      const tables=route.request().postDataJSON().tables;
      return route.fulfill({json:{requestedModules:tables,dependencyModules:[],effectiveModules:tables,policyVersion:2,warnings:[],impacts:tables.map((table:string)=>({table,label:table==="memo_notes"?"备忘录":"流水线连接",added:2,updated:0,skipped:0,deleted:0}))}});
    }
    if (path === "/api/database-import/cancel") { cancelled++; return route.fulfill({ json: null }); }
    return route.fulfill({ json: [] });
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
  await page.locator(".mobile-more-feature").filter({ hasText: "系统设置" }).click();
  await page.getByRole("button", { name: /导入数据/ }).click();
  await page.getByText("同步数据范围与恢复规则", { exact: true }).click();
  await expect(page.locator(".mobile-sync-scope")).toContainText("云盘连接、资产收藏与备注、外观偏好");
  await expect(page.locator(".mobile-sync-scope")).toContainText("云同步渠道凭据");
  const cloud = page.getByRole("region", { name: "云同步" });
  await cloud.getByRole("button", { name: "添加同步渠道", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "添加同步渠道", exact: true });
  await editor.getByLabel("渠道名称").fill("手机备份渠道");
  await editor.getByLabel("WebDAV 服务器地址").fill("https://storage.example/dav");
  await editor.getByLabel("WebDAV 账号", { exact: true }).fill("fixture-user");
  await editor.getByLabel("WebDAV 密码", { exact: true }).fill("non-sensitive-fixture");
  await editor.getByRole("button", { name: "测试连接", exact: true }).click();
  const result = page.getByRole("alertdialog");
  await expect(result).toContainText("测试连接成功");
  await result.getByRole("button", { name: "确定", exact: true }).click();
  await editor.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(cloud.getByRole("article", { name: "手机备份渠道" })).toBeVisible();
  await expect(cloud.getByLabel("上传备份文件")).toHaveCount(0);
  await expect(cloud.getByRole("button", { name: "上传备份", exact: true })).toBeEnabled();
  await cloud.getByRole("button", { name: "上传备份", exact: true }).click();
  await page.getByRole("alertdialog", { name: "上传云备份", exact: true }).getByRole("button", { name: "确认上传" }).click();
  await expect(cloud.getByRole("progressbar")).toHaveAttribute("value", "50");
  await expect(cloud.locator(".cloud-sync-progress")).toContainText("50% · 1.0 KB / 2.0 KB");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await cloud.locator(".cloud-sync-progress").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  finishUpload();
  await expect(result).toContainText("本机当前数据已作为新版本上传到云端，历史版本已保留");
  await expect(cloud.getByRole("progressbar")).toHaveCount(0);
  expect(uploaded).toBe(true);
  await result.getByRole("button", { name: "确定", exact: true }).click();
  await cloud.getByRole("button", { name: "下载备份", exact: true }).click();
  await page.getByRole("dialog", { name: "选择云端备份版本" }).getByRole("button", { name: /^下载 / }).click();
  await expect(cloud.getByRole("progressbar")).toHaveAccessibleName("正在下载备份");
  await expect(cloud.getByRole("progressbar")).not.toHaveAttribute("value");
  await expect(cloud.locator(".cloud-sync-progress")).toContainText("1.0 KB");
  finishDownload();
  const review = page.getByRole("alertdialog", { name: "确认恢复业务数据" });
  await expect(review).toBeVisible();
  expect(restored).toBeUndefined();
  await expect(review.locator('[aria-label="恢复影响"]')).toContainText("新增 2");
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
  await cloud.getByRole("button", { name: "下载备份", exact: true }).click();
  await page.getByRole("dialog", { name: "选择云端备份版本" }).getByRole("button", { name: /^下载 / }).click();
  await expect(review).toBeVisible();
  await review.locator("summary").filter({ hasText: /^数据范围/ }).click();
  await review.getByRole("checkbox", { name: /流水线连接/ }).uncheck();
  await expect(review.getByLabel("恢复方式", { exact: true })).toHaveValue("merge");
  await review.getByLabel("恢复方式", { exact: true }).selectOption("replace");
  await expect(review.getByRole("alert")).toContainText("删除其中备份未包含的本地记录");
  await expect(review.getByRole("button", { name: "备份本机并导入", exact: true })).toBeDisabled();
  await review.getByLabel("恢复方式", { exact: true }).selectOption("merge");
  await review.getByRole("button", { name: "备份本机并导入", exact: true }).click();
  await expect(review).toHaveCount(0);
  expect(restored).toEqual({ token: "fixture-preview", tables: ["memo_notes"], mode: "merge", forceRestore: true });
  await expect(page.getByRole("region", { name: "数据迁移" })).toContainText("恢复完成：新增 2 条");
  await cloud.getByRole("button", { name: "下载备份", exact: true }).click();
  await page.getByRole("dialog", { name: "选择云端备份版本" }).getByRole("button", { name: /^下载 / }).click();
  await expect(review.getByLabel("恢复方式", { exact: true })).toHaveValue("merge");
  await expect(review.getByRole("checkbox", { name: /包含备份回收站/ })).not.toBeChecked();
  await review.getByLabel("恢复方式", { exact: true }).selectOption("replace");
  const confirmRestore = review.getByRole("button", { name: "备份本机并导入", exact: true });
  await expect(confirmRestore).toBeDisabled();
  await review.getByRole("checkbox", { name: "我确认替换所选模块并删除本地独有记录", exact: true }).check();
  await review.getByRole("checkbox", { name: /包含备份回收站/ }).check();
  await expect(confirmRestore).toBeDisabled();
  await review.getByRole("checkbox", { name: "我确认替换所选模块并删除本地独有记录", exact: true }).check();
  await confirmRestore.click();
  await expect(review).toHaveCount(0);
  expect(restored).toEqual({ token: "fixture-preview", tables: ["memo_notes", "flow_connections"], mode: "replace", forceRestore: true });
  await page.route("**/api/cloud-sync/versions?*", route => route.fulfill({ json: [{ id: "backup-11111111-1111-4111-8111-111111111111.chdb", machineName: "测试电脑", uploadedAt: "2026-10-29T12:00:00Z", passwordProtected: true }] }));
  await page.route("**/api/database-import/preview?*", async route => {
    if (decodeURIComponent(route.request().headers()["x-backup-password"] ?? "") !== "non-sensitive-restore-fixture") return route.fulfill({ status: 400, json: { error: "备份密码错误或文件已损坏" } });
    return route.fulfill({ json: { token: "protected-fixture", packageName: "云端备份", exportedAt: "2026-10-29", totalRecords: 2, categories: [{ table: "memo_notes", label: "备忘录", count: 2 }], details: [], conflicts: [], importMode: "backup" } });
  });
  await cloud.getByRole("button", { name: "下载备份", exact: true }).click();
  const versions = page.getByRole("dialog", { name: "选择云端备份版本" });
  await expect(versions).toContainText("有密码");
  await versions.getByRole("button", { name: /^下载 / }).click();
  const password = page.getByRole("dialog", { name: "下载并解密云备份", exact: true });
  await password.getByLabel("本次恢复密码", { exact: true }).fill("wrong-fixture");
  await password.getByRole("button", { name: "下载并预览", exact: true }).click();
  await expect(password.getByRole("alert")).toContainText("密码错误");
  await expect(review).toHaveCount(0);
  await password.getByLabel("本次恢复密码", { exact: true }).fill("non-sensitive-restore-fixture");
  await password.getByRole("button", { name: "下载并预览", exact: true }).click();
  await expect(review).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await cloud.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
});
