import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

const account = {
  id: 12,
  account_name: "mobile-fixture",
  cloud_type: "aliyun",
  access_key_id: "fixture-access-id",
  enabled: true,
  sort_order: 0,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

async function stubLocalApi(page: Page, accounts: unknown[] = []) {
  await page.route("**/api/accounts**", (route: Route) => route.fulfill({ json: accounts }));
  await page.route("**/api/local-assets**", (route: Route) => {
    const url = new URL(route.request().url());
    const resourceType = url.searchParams.get("resource_type");
    const fixtures = [
      { account_id: 12, resource_type: "ecs", asset_key: "i-fixture", region_id: "cn-hangzhou", payload: { instanceId: "i-fixture", instanceName: "mobile-server", status: "Running" }, fetched_at: 1_700_000_000 },
      { account_id: 12, resource_type: "domain", asset_key: "example.test", region_id: "cn-hangzhou", payload: { DomainName: "example.test" }, fetched_at: 1_700_000_000 },
    ];
    return route.fulfill({ json: fixtures.filter((item) => !resourceType || item.resource_type === resourceType) });
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
      .slice(0, 8)
      .map((element) => ({ tag: element.tagName, className: String(element.className), right: element.getBoundingClientRect().right })),
  }));
  expect(dimensions.document, JSON.stringify(dimensions.offenders)).toBeLessThanOrEqual(dimensions.viewport);
}

test("fits the account form on a narrow phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 360 });
  await stubLocalApi(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "云账号" })).toBeVisible();
  await expect(page.getByText("还没有云账号")).toBeVisible();
  await page.getByRole("button", { name: "添加云账号" }).click();
  await expect(page.getByRole("heading", { name: "添加云账号" })).toBeVisible();
  await expect(page.locator('input[name="accountName"]')).toHaveAttribute("required", "");
  await expect(page.locator('input[name="accessKeyId"]')).toHaveAttribute("required", "");
  await expect(page.locator('input[name="accessKeySecret"]')).toHaveAttribute("type", "password");
  await expectNoHorizontalOverflow(page);

  const form = page.locator(".mobile-account-form");
  const bounds = await form.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  const scrollable = await form.evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(scrollable).toBeTruthy();
  const submit = page.getByRole("button", { name: /保存到本机/ });
  await submit.scrollIntoViewIfNeeded();
  const submitBounds = await submit.boundingBox();
  expect(submitBounds).not.toBeNull();
  expect(submitBounds!.y).toBeGreaterThanOrEqual(0);
  expect(submitBounds!.y + submitBounds!.height).toBeLessThanOrEqual(360);
});

test("shows provider-specific credentials and secret field types", async ({ page }) => {
  await stubLocalApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "添加云账号" }).click();
  const form = page.locator(".mobile-account-form");

  await form.locator('select:not([name="enabled"])').selectOption("oracle");
  await expect(form.locator('input[name="tenancyOcid"]')).toHaveAttribute("required", "");
  await expect(form.locator('input[name="keyFingerprint"]')).toHaveAttribute("required", "");
  await expect(form.locator('textarea[name="accessKeySecret"]')).toHaveAttribute("required", "");
  await expect(form.locator('textarea[name="accessKeySecret"]')).toHaveAttribute("spellcheck", "false");

  await form.locator('select:not([name="enabled"])').selectOption("azure");
  await expect(form.locator('input[name="tenantId"]')).toHaveAttribute("required", "");
  await expect(form.locator('input[name="subscriptionId"]')).toHaveAttribute("required", "");
  await expect(form.locator('input[name="accessKeySecret"]')).toHaveAttribute("type", "password");
});

test("edits account settings without reading the saved secret back into the form", async ({ page }) => {
  const fixture = { ...account, group_name: "prod", region_id: "cn-hangzhou", remark: "primary" };
  await stubLocalApi(page, [fixture]);
  let posted: Record<string, unknown> | null = null;
  await page.route("**/api/accounts", async (route: Route) => {
    if (route.request().method() === "POST") {
      posted = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ json: { ...account, ...posted } });
      return;
    }
    await route.fulfill({ json: [fixture] });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "编辑本机账号 mobile-fixture" }).click();
  const form = page.locator(".mobile-account-form");
  await expect(page.getByRole("heading", { name: "编辑云账号" })).toBeVisible();
  await expect(form.locator('input[name="accountName"]')).toHaveValue("mobile-fixture");
  await expect(form.locator('input[name="accessKeyId"]')).toHaveValue("fixture-access-id");
  await expect(form.locator('input[name="accessKeySecret"]')).toHaveValue("");
  await expect(form.locator('input[name="accessKeySecret"]')).not.toHaveAttribute("required", "");
  await form.locator('input[name="regionId"]').fill("us-west-1");
  await form.getByRole("button", { name: "保存配置" }).click();
  await expect.poll(() => posted).not.toBeNull();
  expect(posted).toMatchObject({ id: 12, account_name: "mobile-fixture", access_key_id: "fixture-access-id", access_key_secret: "", region_id: "us-west-1", group_name: "prod", remark: "primary" });
  expect(JSON.stringify(posted)).not.toContain("saved-secret");
});

test("validates mobile DNS input before sending provider mutations", async ({ page }) => {
  await stubLocalApi(page, [account]);
  let posted: Record<string, unknown> | null = null;
  await page.route("**/api/dns-records**", async (route: Route) => {
    if (route.request().method() === "POST") {
      posted = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ json: { success: true } });
      return;
    }
    await route.fulfill({ json: { items: [], total: 0 } });
  });
  await page.goto("/");
  await page.locator(".mobile-account-select").click();
  await page.getByRole("button", { name: "域名" }).click();
  await page.getByRole("button", { name: /example\.test/ }).click();
  await page.getByRole("button", { name: /新增记录/ }).click();

  const form = page.locator(".mobile-account-form");
  await form.locator('select[name="recordType"]').selectOption("AAAA");
  await form.locator('input[name="rr"]').fill("api");
  await form.locator('input[name="value"]').fill("not-an-ipv6-address");
  await form.getByRole("button", { name: /保存记录/ }).click();
  await expect(page.getByRole("status")).toContainText("AAAA 记录需要 IPv6 地址");
  expect(posted).toBeNull();

  await form.locator('input[name="value"]').fill("2001:db8::1");
  await form.getByRole("button", { name: /保存记录/ }).click();
  await expect.poll(() => posted).not.toBeNull();
  expect(posted).toMatchObject({ id: 12, domain: "example.test", recordType: "AAAA", rr: "api", value: "2001:db8::1", ttl: 600, line: "default" });
});

test("navigates mobile resource sections and preserves narrow layout", async ({ page }) => {
  await stubLocalApi(page, [account]);
  await page.goto("/");
  await page.locator(".mobile-account-select").click();
  await expect(page.getByRole("heading", { name: "服务器" })).toBeVisible();
  await expect(page.getByText("mobile-server")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "域名" }).click();
  await expect(page.getByRole("heading", { name: "域名与 DNS" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "更多" }).click();
  await expect(page.getByRole("heading", { name: "更多管理" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "运维面板" })).toBeVisible();
  await expect(page.getByRole("button", { name: "从电脑迁移面板" })).toBeVisible();
  await page.getByRole("button", { name: /从电脑迁移配置/ }).click();
  await expect(page.getByRole("heading", { name: "导入电脑数据" })).toBeVisible();
  const exportSection = page.locator(".sync-transfer-mobile-export");
  await expect(exportSection.getByText("mobile-fixture")).toBeVisible();
  await exportSection.getByRole("checkbox", { name: /mobile-fixture/ }).check();
  await exportSection.getByRole("checkbox", { name: /包含源设备删除记录/ }).check();
  await expect(exportSection.getByRole("button", { name: "请在手机 App 中导出" })).toBeDisabled();
  const reverseSync = page.locator('[aria-labelledby="sync-mobile-send-title"]');
  await expect(page.getByRole("heading", { name: "授权并发送手机配置到电脑" })).toBeVisible();
  await expect(reverseSync.getByLabel("已信任的目标电脑")).toBeVisible();
  await expect(reverseSync.getByRole("button", { name: "授权所选配置并更新共享范围" })).toBeDisabled();
  await expect(reverseSync.getByRole("button", { name: "扫描桌面接收码并推送增量" })).toBeDisabled();
  await expectNoHorizontalOverflow(page);
});

test("adds a panel locally and rejects non-root panel URLs before native save", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await stubLocalApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("button", { name: "添加面板" }).click();

  const form = page.locator(".mobile-account-form");
  await expect(page.getByRole("heading", { name: "添加运维面板" })).toBeVisible();
  await expect(form.getByLabel("API 密钥")).toHaveAttribute("type", "password");
  await expect(form.getByLabel("API 密钥")).toHaveAttribute("required", "");
  await form.getByLabel("面板名称").fill("生产面板");
  await form.getByLabel("面板根地址").fill("https://panel.example.com/admin");
  await form.getByLabel("API 密钥").fill("secret-fixture");
  await form.getByRole("button", { name: "验证并加密保存" }).click();
  await expect(page.getByRole("status")).toContainText("仅支持 http(s) 根地址");
  await expectNoHorizontalOverflow(page);
});

test("keeps the SSH credential form usable when the mobile viewport shrinks", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await stubLocalApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("button", { name: "SSH 终端" }).click();
  await page.getByRole("button", { name: "添加主机" }).click();

  const form = page.locator(".mobile-account-form");
  await expect(page.getByRole("heading", { name: "添加 SSH 主机" })).toBeVisible();
  await form.getByLabel("主机地址").fill("host.example.test");
  await form.getByLabel("认证方式").selectOption("private_key");
  await expect(form.getByRole("textbox", { name: "SSH 私钥" })).toBeVisible();

  // Models the reduced WebView viewport commonly caused by an onscreen keyboard;
  // it does not claim to exercise Android/iOS keyboard behavior.
  await page.setViewportSize({ width: 320, height: 320 });
  await expectNoHorizontalOverflow(page);
  expect(await form.evaluate((element) => element.scrollHeight > element.clientHeight)).toBeTruthy();

  const submit = form.getByRole("button", { name: "加密保存主机" });
  await submit.scrollIntoViewIfNeeded();
  const bounds = await submit.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(320);
});
