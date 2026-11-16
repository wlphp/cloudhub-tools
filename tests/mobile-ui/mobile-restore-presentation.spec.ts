import { expect, test } from "@playwright/test";
import { restoreCountsText, restoreResultPresentation } from "../../src/features/accounts/restore-presentation";

test("恢复汇总省略零值，结果汇总使用实际执行数而非预览数", () => {
  expect(restoreCountsText({ added: 2, updated: 0, skipped: 3, deleted: 0 })).toBe("新增 2 条 · 跳过 3 条");
  expect(restoreCountsText({ added: 0, updated: 0, skipped: 0, deleted: 0 })).toBe("无数据变化");
  const result = restoreResultPresentation("恢复完成：新增 0 条、更新 0 条、跳过 206 条；恢复前快照已保存；云账号：新增 0、更新 0、跳过 11、删除 0；空模块：新增 0、更新 0、跳过 0、删除 0");
  expect(result.summary).toBe("恢复完成：跳过 206 条");
  expect(result.details).toEqual(["云账号：跳过 11"]);
  expect(restoreResultPresentation("恢复完成：新增 0 条、更新 0 条、跳过 0 条").summary).toBe("恢复完成：无数据变化");
});

test("版本默认展示三项，恢复影响和结果按需展开且不显示零值", async ({ page }, testInfo) => {
  const channel = { configured: true, config: { id: "default", name: "备份渠道", method: "webdav", provider: "custom", endpoint: "https://storage.example.test/dav", username: "", remoteRoot: "cloudhub-sync", profile: "default", autoSync: false }, status: { busy: false, paused: false } };
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/member") return route.fulfill({ json: null });
    if (path === "/api/cloud-sync/channels") return route.fulfill({ json: [channel] });
    if (path === "/api/cloud-sync/state") return route.fulfill({ json: channel });
    if (path === "/api/cloud-sync/versions") return route.fulfill({ json: Array.from({ length: 14 }, (_, index) => ({ id: `backup-fixture-${index}.chdb`, machineName: "测试电脑", uploadedAt: new Date(Date.UTC(2026, 10, 16 - index)).toISOString(), passwordProtected: false })) });
    if (path === "/api/cloud-sync/download") return route.fulfill({ body: "fixture-backup" });
    if (path === "/api/database-import/preview") return route.fulfill({ json: { token: "fixture", packageName: "云端备份", exportedAt: "2026-11-16T01:23:12Z", totalRecords: 206, categories: [{ table: "memo_notes", label: "备忘录", count: 206 }], details: [], conflicts: [], importMode: "backup" } });
    if (path === "/api/database-import/plan") return route.fulfill({ json: { requestedModules: ["memo_notes"], dependencyModules: [], effectiveModules: ["memo_notes"], policyVersion: 2, sourcePolicyVersion: 2, warnings: [], impacts: [{ table: "memo_notes", label: "备忘录", added: 0, updated: 0, skipped: 206, deleted: 0 }, { table: "empty", label: "空模块", added: 0, updated: 0, skipped: 0, deleted: 0 }] } });
    if (path === "/api/database-import/confirm") return route.fulfill({ json: "恢复完成：新增 0 条、更新 0 条、跳过 206 条；恢复前快照已保存；备忘录：新增 0、更新 0、跳过 206、删除 0" });
    return route.fulfill({ json: [] });
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的", exact: true }).click();
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: "数据导入与迁移", exact: true }).click();
  await page.getByRole("button", { name: /^云同步/ }).click();
  await page.getByRole("button", { name: "下载备份", exact: true }).click();
  const versions = page.getByRole("dialog", { name: "选择云端备份版本", exact: true });
  await expect(versions.locator("tbody tr")).toHaveCount(3);
  await expect(versions).not.toContainText("本机下载 0");
  await versions.getByRole("button", { name: "展开其余 11 个版本" }).click();
  await expect(versions.locator("tbody tr")).toHaveCount(14);
  await versions.getByRole("button", { name: "收起更多版本" }).click();
  await versions.getByRole("searchbox").fill("fixture-13");
  await expect(versions.locator("tbody tr")).toHaveCount(1);
  await versions.getByRole("searchbox").fill("");
  await page.screenshot({ path: testInfo.outputPath("versions.png") });
  await versions.getByRole("button", { name: /^下载 / }).first().click();
  const review = page.getByRole("alertdialog", { name: "确认恢复业务数据" });
  await expect(review.locator(".import-impact-total")).toHaveText("跳过 206 条");
  await expect(review.locator(".import-impact-details")).not.toHaveAttribute("open", "");
  await expect(review.locator(".import-options")).not.toHaveAttribute("open", "");
  await review.locator(".import-impact-details > summary").click();
  await expect(review.locator(".import-impact-list")).not.toContainText("空模块");
  await expect(review.locator(".import-impact-list")).not.toContainText("新增 0");
  await review.locator(".import-impact-details > summary").click();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await review.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 375, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("review.png") });
  await page.evaluate(() => { document.body.classList.remove("theme-light"); document.body.classList.add("theme-dark"); });
  await page.screenshot({ path: testInfo.outputPath("review-dark.png") });
  await page.evaluate(() => { document.body.classList.remove("theme-dark"); document.body.classList.add("theme-light"); });
  await review.getByRole("button", { name: "备份本机并导入", exact: true }).click();
  const result = page.locator(".mobile-restore-result");
  await expect(result).toContainText("恢复完成：跳过 206 条");
  await expect(result).not.toContainText("新增 0");
  await expect(result.locator("details")).not.toHaveAttribute("open", "");
  await expect(page.locator(".app-toast-notice")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("result.png"), fullPage: true });
});
