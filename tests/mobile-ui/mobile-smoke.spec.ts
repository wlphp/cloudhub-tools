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

test("refreshes both server types and shows provider failures instead of false success", async ({ page }) => {
  await stubLocalApi(page, [account]);
  await page.route("**/api/local-assets**", (route) => route.fulfill({ json: [] }));
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/sync-assets", async (route) => {
    expect(route.request().postDataJSON().resource_types).toEqual(["ecs", "swas"]);
    await ready;
    await route.fulfill({ json: { fetched: 0, counts: { ecs: 0, swas: 0 }, errors: ["云厂商权限不足，请检查账号权限"] } });
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "服务器", exact: true }).click();
  await page.getByRole("button", { name: "拉取云端", exact: true }).click();
  await expect(page.getByText("正在查询云端服务器")).toBeVisible();
  await expect(page.getByText("暂无普通服务器", { exact: true })).toHaveCount(0);
  release();
  await expect(page.getByText(/部分服务器刷新失败.*云厂商权限不足/)).toBeVisible();
  await expect(page.getByRole("button", { name: "拉取云端", exact: true })).toBeEnabled();
  await expect(page.getByText(/已从 \d+ 个云账号刷新/)).toHaveCount(0);
});

test("shows cached lightweight servers alongside ECS servers", async ({ page }) => {
  await stubLocalApi(page, [account]);
  await page.route("**/api/local-assets**", (route) => {
    const kind = new URL(route.request().url()).searchParams.get("resource_type");
    return route.fulfill({ json: [{ account_id: 12, resource_type: kind, asset_key: `${kind}-fixture`, region_id: "cn-hangzhou", payload: { InstanceId: `${kind}-fixture`, InstanceName: `${kind}-server` }, fetched_at: 1_700_000_000 }] });
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "服务器", exact: true }).click();
  await expect(page.getByText("ecs-server", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^轻量服务器/ }).click();
  await expect(page.getByText("swas-server", { exact: true })).toBeVisible();
});

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
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "服务器", exact: true }).click();
  await expect(page.getByRole("heading", { name: "云服务器", exact: true })).toBeVisible();
  await expect(page.getByText("mobile-server")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "域名" }).click();
  await expect(page.getByRole("heading", { name: "域名与 DNS", exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "更多" }).click();
  await expect(page.getByRole("heading", { name: "更多管理" })).toBeVisible();
  await expect(page.locator(".mobile-more-feature").filter({ hasText: "运维面板" })).toBeVisible();
  await page.locator(".mobile-more-feature").filter({ hasText: "系统设置" }).click();
  await page.getByRole("button", { name: /导入数据/ }).click();
  await expect(page.getByRole("heading", { name: "导入电脑数据" })).toBeVisible();
  await expect(page.getByText(/当前浏览器预览不支持原生扫码/)).toBeVisible();
  await expect(page.getByRole("button", { name: "选择 .chdb 电脑备份文件", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "扫码从电脑迁移（免口令）", exact: true })).toHaveCount(0);
  await expect(page.locator('[aria-labelledby="sync-mobile-send-title"]')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("keeps a slower resource read from replacing the cache after returning to servers", async ({ page }) => {
  const secondAccount = { ...account, id: 13, account_name: "secondary-fixture" };
  let firstRequestStarted = false;
  let secondRequestStarted = false;
  let finishFirstRequest!: () => void;
  let finishSecondRequest!: () => void;
  const firstRequestGate = new Promise<void>((resolve) => { finishFirstRequest = resolve; });
  const secondRequestGate = new Promise<void>((resolve) => { finishSecondRequest = resolve; });
  let reads = 0;
  await stubLocalApi(page, [account, secondAccount]);
  await page.route("**/api/local-assets**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("resource_type") === "swas") {
      await route.fulfill({ json: [] });
      return;
    }
    if (++reads === 1) {
      firstRequestStarted = true;
      await firstRequestGate;
      await route.fulfill({ json: [{ account_id: 12, resource_type: "ecs", asset_key: "i-first", region_id: "cn-hangzhou", payload: { instanceId: "i-first", instanceName: "first-account-server", status: "Running" }, fetched_at: 1_700_000_000 }] });
      return;
    }
    secondRequestStarted = true;
    await secondRequestGate;
    await route.fulfill({ json: [{ account_id: 13, resource_type: "ecs", asset_key: "i-second", region_id: "us-west-1", payload: { instanceId: "i-second", instanceName: "second-account-server", status: "Running" }, fetched_at: 1_700_000_000 }] });
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "服务器", exact: true }).click();
  await expect.poll(() => firstRequestStarted).toBeTruthy();

  await page.locator(".mobile-tab-bar").getByRole("button", { name: "账号" }).click();
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "服务器", exact: true }).click();
  await expect(page.getByRole("heading", { name: "云服务器", exact: true })).toBeVisible();
  await expect.poll(() => secondRequestStarted).toBeTruthy();
  await expect(page.getByText("first-account-server")).toHaveCount(0);

  finishSecondRequest();
  await expect(page.getByText("second-account-server")).toBeVisible();

  finishFirstRequest();
  await expect(page.getByText("first-account-server")).toHaveCount(0);
  await expect(page.getByText("second-account-server")).toBeVisible();
});

test("releases resource loading state after navigating away from a pending read", async ({ page }) => {
  let finishRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => { finishRequest = resolve; });
  let requestStarted = false;
  await stubLocalApi(page, [account]);
  await page.route("**/api/local-assets**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("resource_type") === "ecs") {
      requestStarted = true;
      await requestGate;
      await route.fulfill({ json: [] });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "服务器", exact: true }).click();
  await expect.poll(() => requestStarted).toBeTruthy();
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多" }).click();
  await expect(page.getByRole("heading", { name: "更多管理" })).toBeVisible();
  await expect(page.locator(".mobile-header .mobile-spin")).toHaveCount(0);
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "账号", exact: true }).click();
  await expect(page.locator(".mobile-header").getByRole("button", { name: "刷新" })).toBeEnabled();
  finishRequest();
});

test("adds a panel locally and rejects non-root panel URLs before native save", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await stubLocalApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "更多" }).click();
  await page.locator(".mobile-more-feature").filter({ hasText: "运维面板" }).click();
  await page.getByRole("button", { name: "添加面板" }).click();

  const form = page.locator(".mobile-account-form");
  await expect(page.getByRole("heading", { name: "添加运维面板" })).toBeVisible();
  await expect(form.getByLabel("API 密钥", { exact: true })).toHaveAttribute("type", "password");
  await expect(form.getByLabel("API 密钥", { exact: true })).toHaveAttribute("required", "");
  await form.getByLabel("面板名称").fill("生产面板");
  await form.getByLabel("面板根地址").fill("https://panel.example.com/admin");
  await form.getByLabel("API 密钥", { exact: true }).fill("secret-fixture");
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
