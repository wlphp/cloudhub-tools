import { expect, type Page } from "@playwright/test";
import type { CloudSyncView } from "../src/platform/clients/cloudSync";

export async function verifyCloudChannels(page: Page, mobile: boolean) {
  const fixture = (id: string, name: string): CloudSyncView => ({ configured: true,
    config: { id, name, method: "webdav", provider: "custom", endpoint: "https://storage.example/dav", username: "fixture-user", accessKeyId: "", bucket: "", region: "us-east-1", pathStyle: true, remoteRoot: name, profile: "default", autoSync: false, allowInsecure: false, passwordProtected: false, hasPassword: true, hasSecretKey: false, hasBackupPassword: false },
    status: { busy: false, paused: false, error: null, lastUpload: null, lastDownload: null },
  });
  let channels = [fixture("default", "主渠道"), fixture("22222222-2222-4222-8222-222222222222", "备用渠道")];
  const operations: Array<{ action: string; channelId: string }> = [];
  let backups = [
    { id: "backup-11111111-1111-4111-8111-111111111111.chdb", machineName: "备用电脑", uploadedAt: "2026-10-29T12:00:00Z" },
    { id: "backup-33333333-3333-4333-8333-333333333333.chdb", machineName: "测试手机", uploadedAt: "2026-10-28T12:00:00Z" },
  ];
  let failPreview = true;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), action = url.pathname.split("/").pop()!, channelId = url.searchParams.get("channelId") ?? "default";
    if (url.pathname === "/api/database-import/catalog") return route.fulfill({json:[{table:"memo_notes",label:"备忘录",count:0},{table:"flow_connections",label:"流水线连接",count:0}]});
    if (url.pathname === "/api/database-import/preview") return failPreview
      ? route.fulfill({ status: 400, json: { error: "备份校验失败" } })
      : route.fulfill({ json: { token: "fixture-backup", packageName: "cloudhub-cloud-backup.chdb", exportedAt: "2026-10-29T12:00:00Z", totalRecords: 0, categories: [], details: [], conflicts: [] } });
    if (!url.pathname.startsWith("/api/cloud-sync/")) return route.fulfill({ json: [] });
    if (action === "channels") return route.fulfill({ json: channels });
    if (action === "state") return route.fulfill({ json: channels.find(c => c.config.id === channelId) });
    operations.push({ action, channelId });
    if (action === "save") {
      const { password, secretKey, backupPassword: _b, ...config } = route.request().postDataJSON().config;
      expect(config.id).toBe(channelId);
      const index = channels.findIndex(c => c.config.id === channelId);
      const view = { ...fixture(channelId, config.name), config: { ...fixture(channelId, config.name).config, ...config, hasPassword: !!password || index >= 0, hasSecretKey: !!secretKey || (index >= 0 && channels[index].config.hasSecretKey) } };
      if (index >= 0) channels[index] = view; else channels.push(view);
      return route.fulfill({ json: view });
    }
    if (action === "delete") { channels = channels.filter(c => c.config.id !== channelId); return route.fulfill({ json: null }); }
    if (action === "versions") return route.fulfill({ json: backups });
    if (action === "delete-version") { backups = backups.filter(v => v.id !== route.request().postDataJSON().versionId); return route.fulfill({ json: null }); }
    if (action === "download") return route.fulfill({ contentType: "application/octet-stream", body: "fixture-backup" });
    if (action === "upload") return route.fulfill({ json: channels.find(c => c.config.id === channelId) });
    return route.fulfill({ json: null });
  });
  await page.goto("/");
  if (mobile) {
    await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
    await page.locator(".mobile-more-feature").filter({ hasText: "系统设置" }).click();
    await page.getByRole("button", { name: /导入数据/ }).click();
  } else {
    await page.getByRole("button", { name: "系统设置", exact: true }).first().click();
    await page.getByRole("tab", { name: "数据管理", exact: true }).click();
  }
  const region = page.getByRole("region", { name: "云同步", exact: true });
  await expect(region.getByRole("article")).toHaveCount(2);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await region.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: mobile ? 375 : 1024, height: 900 });
  const primary = region.getByRole("article", { name: "主渠道", exact: true });
  const secondary = region.getByRole("article", { name: "备用渠道", exact: true });
  await secondary.getByRole("button", { name: "下载备份", exact: true }).click();
  const versions = page.getByRole("dialog", { name: "选择云端备份版本", exact: true });
  await expect(versions).toContainText("备用渠道");
  await expect(versions.locator(".cloud-sync-version-list")).toContainText("备用电脑");
  const rows = versions.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("备用电脑");
  await versions.getByRole("combobox", { name: "上传时间排序" }).selectOption("asc");
  await expect(rows.first()).toContainText("测试手机");
  await expect(rows.last()).toContainText("最新");
  await versions.getByRole("searchbox").fill("不存在");
  await expect(versions).toContainText("没有匹配的备份");
  await versions.getByRole("searchbox").fill("测试手机");
  await expect(rows).toHaveCount(1);
  await versions.getByRole("searchbox").fill("");
  await versions.getByRole("combobox", { name: "上传时间排序" }).selectOption("desc");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await versions.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await versions.locator(".cloud-backup-table").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: mobile ? 375 : 1440, height: 900 });
  await versions.screenshot({ path: `test-results/cloud-backup-versions-${mobile ? "mobile" : "desktop"}.png` });
  await rows.last().getByRole("button", { name: /^删除 / }).click();
  const deleteBackup = page.getByRole("alertdialog", { name: "删除云端备份版本", exact: true });
  await deleteBackup.getByRole("button", { name: "取消", exact: true }).click();
  expect(operations.some(c => c.action === "delete-version")).toBe(false);
  await rows.last().getByRole("button", { name: /^删除 / }).click();
  await deleteBackup.getByRole("button", { name: "删除此版本", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await versions.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(rows).toHaveCount(1);
  expect(operations.find(c => c.action === "delete-version")?.channelId).toBe("22222222-2222-4222-8222-222222222222");
  // A failed download/validation must not increment local usage metadata.
  await rows.first().getByRole("button", { name: /^下载 / }).click();
  const downloadDialog = page.getByRole("dialog", { name: "下载并解密云备份", exact: true });
  await downloadDialog.getByRole("button", { name: "下载并预览", exact: true }).click();
  await expect(downloadDialog.getByRole("alert")).toContainText("备份校验失败");
  await downloadDialog.getByRole("button", { name: "取消", exact: true }).click();
  await secondary.getByRole("button", { name: "下载记录", exact: true }).click();
  const emptyDownloadHistory = page.getByRole("dialog", { name: "下载记录", exact: true });
  await expect(emptyDownloadHistory).toContainText("暂无操作记录");
  await emptyDownloadHistory.getByRole("button", { name: "关闭", exact: true }).click();
  await secondary.getByRole("button", { name: "下载备份", exact: true }).click();
  await expect(rows.first().locator(".cloud-backup-download-count")).toHaveText("本机下载 0 次");
  failPreview = false;
  await rows.first().getByRole("button", { name: /^下载 / }).click();
  await page.getByRole("dialog", { name: "下载并解密云备份", exact: true }).getByRole("button", { name: "下载并预览", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("cloudhub.backup-downloads.v1:")).some(k => JSON.parse(localStorage.getItem(k) ?? "{}")["backup-11111111-1111-4111-8111-111111111111.chdb"]?.count === 1))).toBe(true);
  await page.keyboard.press("Escape");
  await secondary.getByRole("button", { name: "下载记录", exact: true }).click();
  const successfulDownloads = page.getByRole("dialog", { name: "下载记录", exact: true });
  await expect(successfulDownloads.locator("tbody tr")).toHaveCount(1);
  await expect(successfulDownloads.locator("tbody tr").first()).toContainText("backup-11111111");
  await successfulDownloads.getByRole("searchbox").fill("无此版本");
  await expect(successfulDownloads).toContainText("没有匹配的记录");
  await successfulDownloads.getByRole("button", { name: "关闭", exact: true }).click();
  // Reopen the versions after inspecting local download history.
  await secondary.getByRole("button", { name: "下载备份", exact: true }).click();
  await expect(rows.first().locator(".cloud-backup-download-count")).toHaveText("本机下载 1 次");
  await expect(rows.first().locator(".cloud-backup-last-download")).not.toHaveText("尚无下载记录");
  await versions.getByRole("button", { name: "取消", exact: true }).click();
  expect(operations.find(c => c.action === "versions")?.channelId).toBe("22222222-2222-4222-8222-222222222222");
  await primary.getByRole("button", { name: "上传备份", exact: true }).click();
  const upload = page.getByRole("alertdialog", { name: "上传云备份", exact: true });
  await expect(upload).toContainText("主渠道");
  expect(operations.some(c => c.action === "upload")).toBe(false);
  await upload.getByRole("button", { name: "确认上传", exact: true }).click();
  await page.getByRole("alertdialog", { name: "上传云备份成功", exact: true }).getByRole("button", { name: "确定", exact: true }).click();
  expect(operations.find(c => c.action === "upload")?.channelId).toBe("default");
  await primary.getByRole("button", { name: "上传记录", exact: true }).click();
  const successfulUploads = page.getByRole("dialog", { name: "上传记录", exact: true });
  await expect(successfulUploads.locator("tbody tr")).toHaveCount(1);
  await expect(successfulUploads.locator("tbody tr").first()).toContainText("上传新版本");
  await successfulUploads.getByRole("button", { name: "关闭", exact: true }).click();
  await region.getByRole("button", { name: "添加同步渠道", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "添加同步渠道", exact: true });
  await editor.getByLabel("渠道名称").fill("第三渠道");
  await editor.getByRole("combobox", { name: /^同步方式/ }).selectOption("oss");
  await expect(editor.getByLabel("区域", { exact: true })).toHaveValue("cn-beijing");
  await expect(editor.getByLabel("使用路径风格地址", { exact: false })).toHaveCount(0);
  await editor.getByLabel("OSS Endpoint", { exact: true }).fill("https://oss-cn-beijing.aliyuncs.com");
  await editor.getByLabel("存储桶", { exact: true }).fill("fixture-bucket");
  await editor.getByLabel("AccessKey ID", { exact: true }).fill("fixture-access");
  await editor.getByLabel("AccessKey Secret", { exact: true }).fill("fixture-signing");
  await editor.locator("details.data-settings-scope > summary").click();
  const scope = editor.locator(".data-transfer-scope");
  await scope.getByRole("checkbox", { name: "选择全部数据", exact: true }).uncheck();
  await scope.getByRole("checkbox", { name: "选择全部数据", exact: true }).check();
  await expect(scope.getByLabel("流水线连接", { exact: true })).toBeChecked();
  await scope.getByLabel("全选流水线与 FRP", { exact: true }).uncheck();
  await expect(scope.getByLabel("流水线连接", { exact: true })).not.toBeChecked();
  await expect(scope.getByRole("checkbox", { name: "选择全部数据", exact: true })).toHaveJSProperty("indeterminate", true);
  await page.mouse.click(2, 2);
  await expect(editor).toBeVisible();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await editor.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await editor.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(region.getByRole("article")).toHaveCount(3);
  expect(channels.find(c=>c.config.name==="第三渠道")?.config.tables).toEqual(["memo_notes"]);
  expect(channels.find(c=>c.config.name==="第三渠道")?.config.method).toBe("oss");
  await expect(region.getByRole("article", { name: "第三渠道", exact: true })).toContainText("阿里云 OSS");
  await primary.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑同步渠道", exact: true });
  await expect(edit.getByLabel("WebDAV 密码", { exact: true })).toHaveValue("");
  await edit.getByLabel("渠道名称").fill("修改后取消");
  await page.keyboard.press("Escape");
  await expect(primary).toBeVisible();
  await secondary.getByRole("button", { name: "删除", exact: true }).click();
  const remove = page.getByRole("alertdialog", { name: "删除同步渠道", exact: true });
  await expect(remove).toContainText("云端备份文件不会删除");
  await remove.getByRole("button", { name: "删除渠道", exact: true }).click();
  await expect(region.getByRole("article")).toHaveCount(2);
  await expect(primary).toBeVisible();
  await expect(region.getByRole("article", { name: "第三渠道", exact: true })).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 844, height: 390 });
  expect(await region.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.setViewportSize({ width: mobile ? 375 : 1440, height: 900 });
  await region.screenshot({ path: `test-results/cloud-sync-channels-${mobile ? "mobile" : "desktop"}.png` });
}
