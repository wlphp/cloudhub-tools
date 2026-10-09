import { expect, test, type Page } from "@playwright/test";

async function nativeFixture(page: Page, available = true) {
  await page.addInitScript(({ available }) => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 Android CloudHub" });
    const fixture = { calls: [] as Array<{ command: string; args: any }>, finish: null as null | (() => void), reject: null as null | ((reason: string) => void), install: 0 };
    (window as any).mobileFixture = fixture;
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        fixture.calls.push({ command, args });
        if (command.endsWith("|check")) return { version: "0.1.99", available, downloadable: true, size: 1048576, notes: "测试更新说明" };
        if (command.endsWith("|download")) {
          args.onProgress.onmessage({ downloaded: 524288, total: 1048576 });
          return new Promise<void>((resolve, reject) => { fixture.finish = resolve; fixture.reject = reject; });
        }
        if (command.endsWith("|cancel")) { fixture.reject?.("下载已取消"); return; }
        if (command.endsWith("|install")) return fixture.install++ === 0 ? "permission_required" : "installer_opened";
        if (command === "list_flow_connections") return [{ id: 1, name: "测试组织", edition: "central", organizationId: "org-test", domain: "openapi-rdc.aliyuncs.com", tokenSaved: true }];
        if (command === "list_flow_groups") return [{ groupId: "group-test", groupName: "测试分组" }];
        if (command === "list_flow_pipelines") return [{ pipelineId: "pipeline-test", pipelineName: "用于窄屏验证的流水线名称".repeat(3), latestStatus: "SUCCESS" }];
        const run = { pipelineRunId: "run-test", status: "SUCCESS", startTime: 1700000000000, endTime: 1700000010000, sources: [], stages: [{ name: "构建阶段", status: "SUCCESS", jobs: [{ id: "job-test", name: "构建任务", status: "SUCCESS", steps: [] }] }] };
        if (command === "list_flow_runs") return [run];
        if (command === "get_flow_run" || command === "get_flow_latest_run") return run;
        if (command === "get_flow_job_steps") return [{ stepIndex: 0, buildId: 1, name: "构建步骤" }];
        if (command === "get_flow_job_log") return { logs: "测试任务日志：构建成功", more: false, nextOffset: 10 };
        if (command === "run_flow_pipeline") return "new-run";
        if (command === "test_flow_connection") throw { code: "permission", message: "云效权限不足" };
        return [];
      },
    };
  }, { available });
}

async function more(page: Page) {
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
}

test("Android checks automatically, downloads only on request, and retries installation after permission", async ({ page }) => {
  await nativeFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: /发现新版/ }).click();
  expect(await page.evaluate(() => (window as any).mobileFixture.calls.filter((c: any) => c.command.endsWith("|download")).length)).toBe(0);
  await page.getByRole("button", { name: /下载更新/ }).click();
  await expect(page.getByRole("progressbar", { name: "更新下载进度" })).toHaveAttribute("value", "50");
  await page.getByRole("button", { name: "取消下载" }).click();
  await expect(page.getByText("下载已取消", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /下载更新/ }).click();
  await page.evaluate(() => (window as any).mobileFixture.finish());
  await page.getByRole("button", { name: "安装更新", exact: true }).click();
  await expect(page.getByText(/请允许安装应用/)).toBeVisible();
  await page.getByRole("button", { name: "安装更新", exact: true }).click();
  await expect(page.getByText(/请在系统安装器确认安装/)).toBeVisible();
  await expect(page.getByRole("button", { name: "安装更新", exact: true })).toBeEnabled();
});

for (const width of [320, 375, 430]) {
  test(`native Flow cards, run confirmation and logs fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await nativeFixture(page, false);
    await page.goto("/");
    await more(page);
    const entries = await page.locator(".mobile-more-feature-copy strong").allTextContents();
    expect(entries.indexOf("云效流水线")).toBe(entries.indexOf("运维面板") + 1);
    await page.locator(".mobile-more-feature").filter({ hasText: "云效流水线" }).click();
    await expect(page.locator(".flow-name-button")).toBeVisible();
    await expect(page.locator(".flow-status-icon.success")).toBeVisible();
    expect(await page.locator(".mobile-content").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
    await page.locator(".flow-name-button").click();
    await expect(page.getByText("构建任务", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "日志", exact: true }).click();
    await expect(page.getByText("测试任务日志：构建成功", { exact: true })).toBeVisible();
    expect(await page.locator(".flow-details-dialog").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
    if (width === 375) await page.screenshot({ path: "test-results/mobile-flow-details.png" });
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
    await page.locator(".flow-row-actions button").first().click();
    expect(await page.evaluate(() => (window as any).mobileFixture.calls.filter((c: any) => c.command === "run_flow_pipeline").length)).toBe(0);
    await page.locator(".flow-run-dialog textarea").fill("[]");
    await page.getByRole("button", { name: "确认运行" }).click();
    await expect(page.getByText("运行参数必须是有效的 JSON 对象", { exact: true })).toBeVisible();
    await page.locator(".flow-run-dialog textarea").fill('{"envs":{"target":"test"}}');
    await page.getByRole("button", { name: "确认运行" }).click();
    await expect(page.getByText("已触发运行 #new-run", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "验证连接", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("权限不足");
  });
}

test("browser checks stable releases but never offers native APK installation", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: [] }));
  await page.route("https://api.github.com/repos/wlphp/cloudhub-tools/releases/latest", (route) => route.fulfill({ json: { tag_name: "v0.1.99", draft: false, prerelease: false } }));
  await page.goto("/");
  await more(page);
  await page.locator(".mobile-more-feature").filter({ hasText: "系统设置" }).click();
  await page.getByRole("button", { name: /^关于/ }).click();
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByText("发现新版本 v0.1.99", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "发布页", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /下载更新|安装更新/ })).toHaveCount(0);
});

test("Android update failure shows a safe message and allows retry", async ({ page }) => {
  await nativeFixture(page, false);
  await page.goto("/");
  await more(page);
  await page.locator(".mobile-more-feature").filter({ hasText: "系统设置" }).click();
  await page.getByRole("button", { name: /^关于/ }).click();
  await expect(page.getByText(/当前版本无需更新/)).toBeVisible();
  await page.evaluate(() => {
    const internals = (window as any).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    let failed = false;
    internals.invoke = (command: string, args: any) => {
      if (command.endsWith("|check") && !failed) { failed = true; return Promise.reject("offline"); }
      return invoke(command, args);
    };
  });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByText("检查失败，请检查网络后重试。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByText(/当前版本无需更新/)).toBeVisible();
});
