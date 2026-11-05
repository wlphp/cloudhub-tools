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

test("opens the matching Tencent EdgeOne console from a favorited ESA asset in browser preview", async ({ page }) => {
  const tencentAccount = { ...account, cloud_type: "tencent", account_name: "tencent-fixture" };
  const esaSite = {
    account_id: tencentAccount.id,
    resource_type: "esa",
    asset_key: "zone-fixture",
    region_id: "",
    payload: { SiteName: "zone-fixture", Status: "active" },
    fetched_at: 1_700_000_000,
  };
  await page.route("**/api/accounts**", (route) => route.fulfill({ json: [tencentAccount] }));
  await page.route("**/api/local-assets**", (route) => route.fulfill({ json: [esaSite] }));
  await page.route("**/api/preferences**", (route) => route.fulfill({ json: {} }));
  await page.context().route("https://console.cloud.tencent.com/edgeone", (route) => route.fulfill({ contentType: "text/html", body: "<title>EdgeOne console</title>" }));
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的", exact: true }).click();
  await page.getByRole("button", { name: "我的资产" }).click();
  const asset = page.locator(".mobile-asset-card", { hasText: "zone-fixture" });
  await expect(asset).toBeVisible();
  await asset.getByRole("button", { name: "收藏 zone-fixture" }).click();
  await page.getByRole("tab", { name: /我的收藏/ }).click();
  const favorite = page.locator(".mobile-asset-card", { hasText: "zone-fixture" });
  const popup = page.waitForEvent("popup");
  await favorite.getByRole("button", { name: "操作" }).click();
  const consolePage = await popup;
  expect(consolePage.url()).toBe("https://console.cloud.tencent.com/edgeone");
  await expect(page.getByRole("status")).toContainText("腾讯云 EdgeOne 控制台");
  await expect(page.getByText("该类型暂未提供移动端操作入口")).toHaveCount(0);
});

test("server actions match power state and use the shared confirmation", async ({ page }) => {
  await stubLocalApi(page, [account]);
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "服务器", exact: true }).click();
  const card = page.locator(".mobile-server-card-featured").first();
  await card.getByText("详情与操作").click();
  await expect(card.getByRole("button", { name: "启动" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "停止" })).toBeEnabled();
  await expect(card.getByRole("button", { name: "重启" })).toBeEnabled();
  await card.getByRole("button", { name: "停止" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "确认服务器操作" });
  await expect(confirmation).toContainText("停止服务器");
  await confirmation.getByRole("button", { name: "取消" }).click();
  await expect(confirmation).toHaveCount(0);
});

test("stopped and unknown server states do not offer invalid operations", async ({ page }) => {
  await stubLocalApi(page, [account]);
  await page.route("**/api/local-assets**", route => route.fulfill({ json: new URL(route.request().url()).searchParams.get("resource_type") === "swas" ? [] : [
    { account_id: 12, resource_type: "ecs", asset_key: "stopped", region_id: "cn-hangzhou", payload: { instanceId: "stopped", instanceName: "stopped-server", status: "Stopped" }, fetched_at: 1_700_000_000 },
    { account_id: 12, resource_type: "ecs", asset_key: "pending", region_id: "cn-hangzhou", payload: { instanceId: "pending", instanceName: "pending-server", status: "Starting" }, fetched_at: 1_700_000_000 },
  ] }));
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "服务器", exact: true }).click();
  const stopped = page.locator(".mobile-server-card-featured", { hasText: "stopped-server" });
  await stopped.getByText("详情与操作").click();
  await expect(stopped.getByRole("button", { name: "启动" })).toBeEnabled();
  await expect(stopped.getByRole("button", { name: "停止" })).toBeDisabled();
  await expect(stopped.getByRole("button", { name: "重启" })).toBeDisabled();
  const pending = page.locator(".mobile-server-card-featured", { hasText: "pending-server" });
  await pending.getByText("详情与操作").click();
  await expect(pending.getByText("状态待确认，请刷新")).toBeVisible();
  for (const action of ["启动", "停止", "重启"]) await expect(pending.getByRole("button", { name: action })).toBeDisabled();
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
  await page.locator('input[name="accountName"]').fill("保留的账号名称");
  await page.locator(".shared-dialog-backdrop").click({ position: { x: 2, y: 2 } });
  await expect(page.getByRole("heading", { name: "添加云账号" })).toBeVisible();
  await expect(page.locator('input[name="accountName"]')).toHaveValue("保留的账号名称");
  await expect(page.locator('input[name="accountName"]')).toHaveAttribute("required", "");
  await expect(page.locator('input[name="accessKeyId"]')).toHaveAttribute("required", "");
  await expect(page.locator('input[name="accessKeySecret"]')).toHaveAttribute("type", "password");
  await expectNoHorizontalOverflow(page);

  const form = page.getByRole("dialog", { name: "添加云账号", exact: true });
  const bounds = await form.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  const scrollable = await form.locator(".modal-body").evaluate((element) => element.scrollHeight > element.clientHeight);
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
  const form = page.getByRole("dialog", { name: "添加云账号", exact: true });

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
  await page.getByRole("button", { name: "展开 mobile-fixture 操作",exact:true }).click();
  await page.getByRole("button", { name: "编辑本机账号 mobile-fixture" }).click();
  const form = page.getByRole("dialog", { name: "编辑云账号", exact: true });
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

  const form = page.getByRole("dialog", { name: "新增 DNS 记录", exact: true });
  await form.getByRole("button", { name: "AI 识别 DNS 草稿" }).click();
  const ai = page.getByRole("dialog", { name: "AI 识别 DNS 草稿" });
  await expect(ai.getByRole("textbox",{name:"分析内容",exact:true})).toBeVisible();await expect(ai.getByRole("button",{name:"发送并分析"})).toBeDisabled();
  await ai.getByRole("button", { name: "关闭AI辅助" }).click();
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
  await expect(page.getByRole("heading", { name: "导入数据", exact: true })).toBeVisible();
  await expect(page.getByText(/请在手机 App 内扫码/)).toBeVisible();
  await expect(page.getByRole("button", { name: "选择 .chdb 备份", exact: true })).toBeVisible();
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

  await page.locator(".mobile-tab-bar").getByRole("button", { name: "首页" }).click();
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
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "首页", exact: true }).click();
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

  const form = page.getByRole("dialog", { name: "添加运维面板", exact: true });
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

  const form = page.getByRole("dialog", { name: "添加 SSH 主机", exact: true });
  await expect(page.getByRole("heading", { name: "添加 SSH 主机" })).toBeVisible();
  await form.getByLabel("主机地址").fill("host.example.test");
  await form.getByLabel("认证方式").selectOption("private_key");
  await expect(form.getByRole("textbox", { name: "SSH 私钥" })).toBeVisible();

  // Models the reduced WebView viewport commonly caused by an onscreen keyboard;
  // it does not claim to exercise Android/iOS keyboard behavior.
  await page.setViewportSize({ width: 320, height: 320 });
  await expectNoHorizontalOverflow(page);
  expect(await form.locator(".modal-body").evaluate((element) => element.scrollHeight > element.clientHeight)).toBeTruthy();

  const submit = form.getByRole("button", { name: "加密保存主机" });
  await submit.scrollIntoViewIfNeeded();
  const bounds = await submit.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(320);
});

test("shows compact software cards with optional details on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await stubLocalApi(page);
  await page.route("**/api/preferences**", (route) => route.fulfill({ json: {} }));
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "软件商店", exact: true }).click();
  await expect(page.getByRole("heading", { name: "软件商店" })).toBeVisible();
  const tableCaption = page.locator(".store-table-caption");
  await expect(tableCaption).toBeAttached();
  expect(await tableCaption.boundingBox()).toMatchObject({ width: 1, height: 1 });
  await expect(page.locator(".software-store-page .store-total")).toBeHidden();
  await expect(page.locator(".store-table th", { hasText: "左侧菜单显示" })).toHaveCount(0);
  await expect(page.locator(".store-table th", { hasText: "首页显示" })).toHaveCount(1);

  await page.getByRole("searchbox", { name: "应用搜索" }).fill("局域网设备");
  const appRow = page.locator(".store-table tbody tr").filter({ hasText: "局域网设备" });
  await expect(appRow).toBeVisible();
  await expect(appRow.locator('[data-label="说明"]')).toBeHidden();
  const detailsToggle = appRow.getByRole("button", { name: "展开详情" });
  await detailsToggle.click();
  await expect(appRow.getByRole("button", { name: "收起详情" })).toHaveAttribute("aria-expanded", "true");
  await expect(appRow.locator('[data-label="说明"]')).toBeVisible();
  const homeToggle = appRow.getByRole("checkbox", { name: "在首页显示局域网设备" });
  await homeToggle.check();
  const switchBounds = await homeToggle.locator("..").boundingBox();
  expect(switchBounds).not.toBeNull();
  expect(switchBounds!.width).toBeGreaterThanOrEqual(40);
  const track = await appRow.locator(".store-switch > span").boundingBox();
  expect(track?.width).toBe(38);
  expect(track?.height).toBe(22);
  await expectNoHorizontalOverflow(page);
  await appRow.getByRole("button", { name: "收起详情" }).click();
  await expect(appRow.locator('[data-label="说明"]')).toBeHidden();
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await expect(page.locator(".mobile-home-resource-stats")).toBeVisible();
  await expect(page.locator(".mobile-home-software")).toHaveCount(0);
});

test("home top bar matches mobile quick access and keeps search and actions usable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await stubLocalApi(page);
  await page.goto("/");

  const topbar = page.locator(".mobile-home-topbar");
  await expect(topbar).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(topbar.getByRole("button", { name: "登录或注册" })).toBeVisible();
  await expect(topbar.getByRole("button", { name: "扫一扫" })).toBeVisible();
  for (const control of [topbar.getByRole("button", { name: "登录或注册" }), topbar.getByRole("button", { name: "扫一扫" })]) {
    const bounds = await control.boundingBox();
    expect(bounds?.width).toBeGreaterThanOrEqual(44);
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
  }
  const search = topbar.getByRole("textbox", { name: "搜索应用" });
  await search.fill("账号");
  await expect(page.locator(".mobile-home-app-grid button")).toHaveCount(1);
  await topbar.getByRole("button", { name: "扫一扫" }).click();
  await expect(page.getByRole("status")).toContainText("仅支持手机 App");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的" }).click();
  await page.locator(".mobile-header-actions").getByRole("button", { name: "通知与监控预警" }).click();
  await expect(page.getByRole("heading", { name: "监控预警" })).toBeVisible();
  await expect(page.locator(".mobile-tab-bar").getByRole("button", { name: "我的" }).locator("svg")).toBeVisible();
});

test("replaces the more-page server shortcut with panel and terminal shortcuts", async ({ page }) => {
  await stubLocalApi(page);
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的", exact: true }).click();
  const shortcuts = page.locator(".mobile-more-shortcuts");
  await expect(shortcuts.getByRole("button")).toHaveCount(5);
  await expect(shortcuts.getByRole("button", { name: "服务器" })).toHaveCount(0);
  await shortcuts.getByRole("button", { name: "运维面板" }).click();
  await expect(page.getByRole("heading", { name: "运维面板", exact: true })).toBeVisible();
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的", exact: true }).click();
  await page.locator(".mobile-more-shortcuts").getByRole("button", { name: "SSH 终端" }).click();
  await expect(page.getByRole("heading", { name: "SSH 终端", exact: true })).toBeVisible();
});
