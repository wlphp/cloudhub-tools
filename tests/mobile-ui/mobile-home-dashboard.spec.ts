import { expect, test, type Page } from "@playwright/test";
import { homeStatistics, expiryTimestamp } from "../../src/mobile/home-statistics";
import type { Account, LocalAsset } from "../../src/shared/types";
import type { CertificateSummary } from "../../src/platform/clients/certificates";

test("统计口径覆盖日期单位、边界、未知有效期及未关联账号", () => {
  const now = Date.parse("2026-11-14T00:00:00Z");
  const asset = (id: number, expiry: unknown): LocalAsset => ({ account_id: id, resource_type: "ecs", asset_key: String(id), payload: { ExpiredTime: expiry }, fetched_at: now });
  const stats = homeStatistics([asset(1, (now - 1) / 1000), asset(1, now + 7 * 86400000), asset(1, now + 30 * 86400000), asset(1, "invalid"), asset(99, now + 31 * 86400000)], [{ id: 1, cloud_type: "aliyun" } as Account], [{ status: "issued", notAfter: now / 1000 + 86400 } as CertificateSummary], now);
  expect(stats.expiry).toEqual({ expired: 1, week: 2, month: 1, later: 1, unknown: 1 });
  expect(stats.types[0].count).toBe(5);
  expect(stats.providers.find(row => row.label === "未关联账号")?.count).toBe(1);
  expect(expiryTimestamp("2026-12-01")).toBe(Date.parse("2026-12-01"));
  expect(expiryTimestamp(0)).toBeNull();
  expect(expiryTimestamp({})).toBeNull();
});

async function fixture(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.dashboardFail = false;
    w.dashboardCalls = 0;
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string) => {
        if (command === "list_client_preferences") return { "cloudhub-startup-animation": "0" };
        if(command === "member_me") return null; if(command === "list_accounts") return [{ id: 1, account_name: "演示云账号", cloud_type: "aliyun", enabled: true, sort_order: 0, created_at: 1, updated_at: 1 }];
        if (command === "list_local_assets") return Array.from({ length: 6 }, (_, i) => ({ account_id: 1, resource_type: i < 3 ? "ecs" : i < 5 ? "domain" : "oss", asset_key: `demo-${i}`, payload: i < 4 ? { ExpiredTime: Date.now() + (i - 1) * 86400000 } : {}, fetched_at: Date.now() }));
        if (command === "monitor_alerts_snapshot") {
          w.dashboardCalls++;
          if (w.dashboardFail) throw new Error("fixture read failed");
          if (w.dashboardMalformed) return [];
          return { alerts: [
            { key: "one", active: true, severity: "emergency", section: "resources" },
            { key: "two", active: true, severity: "warning", section: "certificates" },
            { key: "ignored", active: true, ignored: true, severity: "critical", section: "panels" },
            { key: "recovered", active: false, severity: "critical", section: "resources" },
          ], checkedAt: Math.floor(Date.now() / 1000), lastError: null };
        }
        if (command === "list_certificate_summaries") return [{ id: 1, status: "issued", notAfter: Math.floor(Date.now() / 1000) + 5 * 86400 }];
        if (command === "member_me") return null;
        return [];
      },
    };
  });
  await page.route("**/api/**", route => route.fulfill({ json: new URL(route.request().url()).pathname === "/api/member" ? null : [] }));
  await page.goto("/");
}

test("首页展示真实聚合、分布切换、独立预警入口及读取失败时的上次快照", async ({ page }) => {
  await fixture(page);
  const dashboard = page.getByRole("region", { name: "资产与风险概览", exact: true });
  await expect(dashboard.getByRole("button", { name: /资产总数/ })).toContainText("6");
  await expect(dashboard.getByRole("button", { name: /待处理预警/ })).toContainText("2");
  await expect(page.locator(".mobile-home-alerts")).toHaveCount(0);
  await expect(page.locator(".mobile-home-top-action").first()).toContainText("2");
  await dashboard.getByRole("button", { name: "按云厂商", exact: true }).click();
  await expect(dashboard.locator(".home-bars").first()).toContainText("阿里云");
  await dashboard.getByRole("button", { name: "按类型", exact: true }).click();
  await expect(dashboard.locator(".home-bars").first()).toContainText("服务器");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => document.body.classList.toggle("theme-light", value === "light"), theme);
    for (const width of [320, 390, 519, 768]) {
      await page.setViewportSize({ width, height: 838 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 838 });
    await page.locator(".mobile-content").evaluate(el => el.scrollTo(0, 0));
    await page.screenshot({ path: `test-results/home-dashboard-${theme}.png`, animations: "disabled" });
    await page.getByRole("region", { name: "到期关注", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/home-dashboard-expiry-${theme}.png`, animations: "disabled" });
  }
  await page.evaluate(() => { (window as any).dashboardFail = true; window.dispatchEvent(new Event("focus")); });
  await expect(dashboard.getByRole("status")).toContainText("上次快照");
  await expect(dashboard.getByRole("button", { name: /待处理预警/ })).toContainText("2");
  await dashboard.getByRole("button", { name: "全部预警", exact: true }).click();
  await expect(page.locator(".mobile-tab-bar").getByRole("button", { name: "监控预警", exact: true })).toHaveAttribute("aria-current", "page");
});

test("浏览器无法读取预警时显示未知，资产仍可统计", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: new URL(route.request().url()).pathname === "/api/member" ? null : [] }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: /待处理预警/ })).toContainText("—");
  await expect(page.getByRole("region", { name: "预警概况", exact: true })).toContainText("浏览器预览无法读取预警");
});

test("异常预警快照保留上次统计，页面与导航仍可操作", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await fixture(page);
  const dashboard = page.getByRole("region", { name: "资产与风险概览", exact: true });
  await expect(dashboard.getByRole("button", { name: /待处理预警/ })).toContainText("2");
  await page.evaluate(() => { (window as any).dashboardMalformed = true; window.dispatchEvent(new Event("focus")); });
  await expect(dashboard.getByRole("status")).toContainText("上次快照");
  await expect(dashboard.getByRole("button", { name: /待处理预警/ })).toContainText("2");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的", exact: true }).click();
  await expect(page.locator(".mobile-more-shortcuts")).toBeVisible();
  expect(errors).toEqual([]);
});

test("缓存和证书读取失败不显示虚假的零到期", async ({ page }) => {
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill(path === "/api/local-assets" || path === "/api/certificate-summaries" ? { status: 500, json: { error: "fixture unavailable" } } : { json: [] });
  });
  await page.goto("/");
  const dashboard = page.getByRole("region", { name: "资产与风险概览", exact: true });
  await expect(dashboard.getByRole("button", { name: /资产总数/ })).toContainText("—");
  await expect(dashboard.getByRole("button", { name: /30天内到期/ })).toContainText("—");
  await expect(dashboard).toContainText("证书读取失败");
  await expect(dashboard).toContainText("资产统计暂不可用");
});
