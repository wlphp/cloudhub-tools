import { test, expect } from "@playwright/test";

test("loads the workbench shell without native credentials", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("云账号", { exact: true }).first()).toBeVisible();
  const operationLogs = page.getByRole("button", { name: /操作日志/ }).first();
  const apiLogs = page.getByRole("button", { name: /API日志/ }).first();
  await expect(operationLogs).toBeVisible();
  await expect(apiLogs).toBeVisible();

  await operationLogs.click();
  await expect(page.getByText("操作日志", { exact: true }).last()).toBeVisible();
  await apiLogs.click();
  await expect(page.getByRole("heading", { name: "API日志" })).toBeVisible();

  await page.locator("button:visible").filter({ hasText: "设置" }).last().click();
  await expect(page.getByRole("heading", { name: "系统设置" })).toBeVisible();
  await page.getByRole("button", { name: /打开目录/ }).click();
  await expect(page.getByRole("status")).toContainText("打开数据目录仅支持桌面客户端");
});

test("opens the cloud account form with required credential boundaries", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "添加云账号" }).click();
  const dialog = page.getByRole("heading", { name: "添加云账号" }).locator("..")
    .locator("..");
  await expect(dialog).toBeVisible();

  await expect(page.getByLabel("账号名称")).toHaveAttribute("required", "");
  await expect(page.getByLabel("AccessKey ID")).toHaveAttribute("required", "");
  await expect(page.locator("form.modal input[type=\"password\"]")).toHaveAttribute("required", "");
  await expect(page.getByRole("button", { name: "保存账号" })).toBeVisible();

  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("heading", { name: "添加云账号" })).toBeHidden();
});

test("opens the managed server form without attempting an SSH connection", async ({ page }) => {
  await page.goto("/");

  await page.locator("button:visible").filter({ hasText: "终端" }).last().click();
  await expect(page.getByRole("heading", { name: "选择一台服务器开始连接" })).toBeVisible();
  await page.getByRole("button", { name: /添加服务器/ }).first().click();

  await expect(page.getByRole("heading", { name: "添加服务器" })).toBeVisible();
  await expect(page.getByLabel("主机 / IP")).toHaveAttribute("required", "");
  await expect(page.getByLabel("SSH 用户名")).toHaveAttribute("required", "");
  await expect(page.locator("form.modal input[type=\"password\"]")).toHaveAttribute("required", "");

  await page.getByRole("button", { name: "私钥验证" }).click();
  await expect(page.getByLabel("SSH 私钥")).toHaveAttribute("required", "");
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("heading", { name: "添加服务器" })).toBeHidden();
});

test("renders DNS and OSS tools from sanitized local-asset fixtures", async ({ page }) => {
  const account = {
    id: 7,
    account_name: "fixture-account",
    cloud_type: "aliyun",
    access_key_id: "fixture-access-id",
    enabled: true,
    sort_order: 0,
    created_at: 1700000000000,
    updated_at: 1700000000000,
  };
  const assets = [
    {
      account_id: 7,
      resource_type: "domain",
      asset_key: "example.test",
      region_id: "cn-hangzhou",
      payload: { DomainName: "example.test", DomainStatus: "ok" },
      fetched_at: 1700000000000,
    },
    {
      account_id: 7,
      resource_type: "oss",
      asset_key: "fixture-bucket",
      region_id: "cn-hangzhou",
      payload: { Name: "fixture-bucket", Location: "cn-hangzhou", Acl: "private" },
      fetched_at: 1700000000000,
    },
  ];

  await page.route("**/api/accounts**", (route) => route.fulfill({ json: [account] }));
  await page.route("**/api/local-assets**", (route) => route.fulfill({ json: assets }));
  await page.route("**/api/dns-records**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("keyword") === "leak") {
      return route.fulfill({ status: 500, json: { error: "provider failed secret=TOP_SECRET token=TOP_TOKEN" } });
    }
    return route.fulfill({
      json: { items: [{ RR: "www", Type: "A", Value: "192.0.2.10", Status: "ENABLE", TTL: "600" }], total: 1 },
    });
  });
  await page.route("**/api/oss-detail**", (route) => route.fulfill({
    json: { storage: 1024, objectCount: 1, multipartUploadCount: 0, liveChannelCount: 0, monthTraffic: 0, monthRequests: 1, acl: "private", cnames: [], cors: [], errors: [] },
  }));
  await page.route("**/api/oss-objects**", (route) => route.fulfill({
    json: { objects: [{ Key: "readme.txt", LastModified: "2023-11-14T00:00:00Z", ETag: "fixture", Size: "12" }], prefixes: [], isTruncated: false, nextMarker: "" },
  }));

  await page.goto("/");
  await page.locator("button:visible").filter({ hasText: "资产" }).last().click();
  await expect(page.getByText("example.test", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("fixture-bucket", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "解析管理" }).click();
  await expect(page.getByRole("heading", { name: "【example.test】解析管理" })).toBeVisible();
  await expect(page.getByText("192.0.2.10", { exact: true })).toBeVisible();
  await page.locator(".domain-tool-filter input").fill("leak");
  await page.getByRole("button", { name: "查询" }).click();
  await expect(page.getByRole("button", { name: "查询" })).toBeEnabled();
  await page.getByRole("button", { name: "查询" }).click();
  await expect(page.locator(".domain-tool-modal .error-list")).toContainText("操作失败，请稍后重试");
  await expect(page.getByText("TOP_SECRET", { exact: true })).toBeHidden();
  await expect(page.getByText("TOP_TOKEN", { exact: true })).toBeHidden();
  await page.locator(".close-detail").click();

  await page.getByRole("button", { name: "文件列表" }).click();
  await expect(page.getByRole("heading", { name: "文件列表" })).toBeVisible();
  await expect(page.getByText("readme.txt", { exact: true })).toBeVisible();
});
