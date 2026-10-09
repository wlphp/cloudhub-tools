import { expect, test } from "@playwright/test";

for (const width of [320, 375, 430]) {
  test(`browser Flow supports configuration, details, logs and confirmed run at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    let connection: Record<string, unknown> | null = null;
    let starts = 0;
    let saves = 0;
    let revealRequests = 0;
    let testStatus = 200;
    const run = { pipelineRunId: "run-test", status: "SUCCESS", startTime: 1700000000000, endTime: 1700000010000, sources: [], stages: [{ name: "构建阶段", status: "SUCCESS", jobs: [{ id: "job-test", name: "构建任务", status: "SUCCESS", steps: [] }] }] };
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      let value: unknown = [];
      if (url.pathname.includes("token") || url.pathname.includes("secret")) revealRequests++;
      if (url.pathname === "/api/flow-connections") {
        if (request.method() === "POST") {
          const input = request.postDataJSON();
          // Only public connection metadata is returned by the API.
          if (saves > 0) expect(input.token === "").toBeTruthy();
          connection = { id: 1, name: input.name, edition: input.edition, organizationId: input.organizationId, domain: input.domain, tokenSaved: true };
          saves++;
          value = connection;
        } else if (request.method() === "DELETE") connection = null;
        else value = connection ? [connection] : [];
      }
      if (url.pathname === "/api/flow-test") {
        await route.fulfill({ status: testStatus, json: testStatus === 200 ? null : { error: "云效账号无权访问此组织或流水线", code: "permission" } });
        return;
      }
      if (url.pathname === "/api/flow-groups") value = [{ groupId: "7", groupName: "开发分组" }];
      if (url.pathname === "/api/flow-pipelines") value = [{ pipelineId: "pipeline-test", pipelineName: "浏览器流水线".repeat(4), latestStatus: "SUCCESS" }];
      if (url.pathname === "/api/flow-runs") value = [run];
      if (url.pathname === "/api/flow-run" || url.pathname === "/api/flow-latest-run") value = run;
      if (url.pathname === "/api/flow-run" && request.method() === "POST") { starts++; value = "new-run"; }
      if (url.pathname === "/api/flow-steps") value = [{ stepIndex: 0, buildId: 1, name: "构建步骤" }];
      if (url.pathname === "/api/flow-log") value = { logs: "浏览器任务日志：构建成功", more: false, nextOffset: 20 };
      await route.fulfill({ json: value });
    });
    await page.goto("/");
    await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
    await page.locator(".mobile-more-feature").filter({ hasText: "云效流水线" }).click();
    await expect(page.getByText(/云效流水线需在桌面或手机 App/)).toHaveCount(0);
    await page.getByRole("button", { name: "配置连接", exact: true }).click();
    await page.getByLabel("连接名称", { exact: true }).fill("浏览器组织");
    await page.getByLabel("组织 ID", { exact: true }).fill("org-test");
    const token = await page.evaluate(() => crypto.randomUUID());
    await page.getByPlaceholder("粘贴云效 PAT").fill(token);
    await page.getByRole("button", { name: "保存并验证", exact: true }).click();
    await expect(page.getByText("连接验证成功，已读取云效流水线权限", { exact: true })).toBeVisible();
    await expect(page.locator(".flow-name-button")).toBeVisible();
    expect(await page.locator(".mobile-content").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
    await page.getByRole("button", { name: "编辑连接", exact: true }).click();
    await expect(page.getByPlaceholder("留空以保留原令牌")).toHaveValue("");
    await page.getByLabel("连接名称", { exact: true }).fill("浏览器组织已修改");
    await page.getByRole("button", { name: "保存并验证", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "选择云效连接" })).toContainText("浏览器组织已修改");
    expect(revealRequests).toBe(0);
    await page.locator(".flow-name-button").click();
    await expect(page.getByText("构建任务", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "日志", exact: true }).click();
    await expect(page.getByText("浏览器任务日志：构建成功", { exact: true })).toBeVisible();
    expect(await page.locator(".flow-details-dialog").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
    await page.locator(".flow-row-actions button").first().click();
    expect(starts).toBe(0);
    await page.locator(".flow-run-dialog textarea").fill("[]");
    await page.getByRole("button", { name: "确认运行", exact: true }).click();
    await expect(page.getByText("运行参数必须是有效的 JSON 对象", { exact: true })).toBeVisible();
    expect(starts).toBe(0);
    await page.locator(".flow-run-dialog textarea").fill("{}");
    await page.getByRole("button", { name: "确认运行", exact: true }).click();
    await expect(page.getByText("已触发运行 #new-run", { exact: true })).toBeVisible();
    expect(starts).toBe(1);
    testStatus = 403;
    await page.getByRole("button", { name: "验证连接", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("权限不足");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "移除此连接", exact: true }).click();
    await expect(page.getByRole("button", { name: "配置连接", exact: true })).toBeEnabled();
    expect(saves).toBe(2);
  });
}

for (const width of [375, 768, 1024, 1440]) {
  test(`saved pipeline cards remain available when cloud refresh fails at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const pipelines = [
      { pipelineId: "release-android", pipelineName: "CloudHub · Android 发布", latestStatus: "SUCCESS" },
      { pipelineId: "deploy-console", pipelineName: "生产环境 · 控制台部署", latestStatus: "RUNNING" },
      { pipelineId: "build-service", pipelineName: "云资源服务 · 构建与测试", latestStatus: "FAIL" },
    ];
    let cloudRequests = 0;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/flow-connections") return route.fulfill({ json: [{ id: 1, name: "研发组织", edition: "central", organizationId: "org-test", domain: "openapi-rdc.aliyuncs.com", tokenSaved: true, updatedAt: 1 }] });
      if (url.pathname === "/api/flow-pipeline-cache") return route.fulfill({ json: { pipelines, updatedAt: 1700000000000 } });
      if (url.pathname === "/api/flow-pipelines") { cloudRequests++; return route.fulfill({ status: 502, json: { error: "连接云效失败，请检查网络和接入点", code: "network" } }); }
      return route.fulfill({ json: [] });
    });
    await page.goto("/");
    await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
    await page.locator(".mobile-more-feature").filter({ hasText: "云效流水线" }).click();
    await expect(page.locator(".flow-mobile-card")).toHaveCount(3);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText(/更新于/)).toBeVisible();
    await expect(page.locator(".flow-card-status.success")).toContainText("成功");
    await expect(page.locator(".flow-card-status.running")).toContainText("运行中");
    await expect(page.locator(".flow-card-status.fail")).toContainText("失败");
    expect(await page.locator(".mobile-content").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
    await page.getByRole("button", { name: "刷新流水线", exact: true }).click();
    await expect(page.getByRole("button", { name: "刷新流水线", exact: true })).toBeEnabled();
    await expect(page.locator(".flow-mobile-card")).toHaveCount(3);
    expect(cloudRequests).toBe(2);
    if (width === 375) {
      await page.getByRole("button", { name: "关闭错误", exact: true }).click();
      await page.screenshot({ path: "test-results/flow-local-cache-375.png" });
    }
    await page.reload();
    await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
    await page.locator(".mobile-more-feature").filter({ hasText: "云效流水线" }).click();
    await expect(page.locator(".flow-mobile-card")).toHaveCount(3);
  });
}
