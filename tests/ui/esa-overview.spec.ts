import { test, expect } from "@playwright/test";

test("ESA loads on open, refreshes filters automatically and ignores stale responses", async ({ page }) => {
  await page.addInitScript(() => {
    let attempts = 0;
    let resolveWeek: (() => void) | undefined;
    const calls: any[] = [];
    const account = { id: 7, account_name: "Fixture ESA", cloud_type: "aliyun", access_key_id: "test-only-id", enabled: true, sort_order: 0, created_at: 1, updated_at: 1 };
    Object.assign(window, { __esaOverviewCalls: calls, __resolveWeek: () => resolveWeek?.(), __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: any = {}) => {
        if (command === "list_accounts") return [account];
        if (command === "list_local_assets") return [{ account_id: 7, resource_type: "esa", asset_key: "123", payload: { SiteId: 123, SiteName: "example.test", Status: "active" }, fetched_at: 1 }];
        if (command === "sync_cloud_assets") return { fetched: 1, counts: { esa: 1 }, errors: [] };
        if (command === "esa_overview") {
          calls.push(args);
          if (++attempts === 1) throw { code: "esa-query", message: "ESA 查询失败：DescribeSiteTimeSeriesData（HTTP 400，错误代码 MissingFields）", retryable: false };
          if (args.range === "week") await new Promise<void>((resolve) => { resolveWeek = resolve; });
          return { traffic: 1234, requests: args.range === "month" ? 222 : args.range === "yesterday" ? 789 : args.siteId ? 901 : 567, defence_requests: null, site_count: 1, active_count: 1, range_label: "今日", site_options: [{ id: "123", name: "example.test" }], trend: { traffic: [{ time: "2026-10-12T00:00:00Z", value: 1234 }], requests: [], page_view: [] } };
        }
        if (command === "plugin:event|listen") return 1;
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /查看 Fixture ESA 边缘安全加速资产/ }).click();
  const refresh = page.locator(".esa-head").getByRole("button", { name: "实时拉取", exact: true });
  await expect(page.getByRole("alert")).toContainText("MissingFields");
  await refresh.click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".esa-reference .metric-card").nth(1)).toContainText("567");
  await expect(page.getByRole("img", { name: "ESA 趋势图" })).toBeVisible();
  const centers = await page.locator(".esa-overview-toolbar").evaluate((toolbar) => {
    return [toolbar.querySelector("select"), toolbar.querySelector(".esa-range-tabs"), toolbar.querySelector(":scope > span")].map((element) => {
      const rect = element!.getBoundingClientRect();
      return rect.y + rect.height / 2;
    });
  });
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "昨日", exact: true }).click();
  await expect(page.locator(".esa-reference .metric-card").nth(1)).toContainText("789");
  await page.getByRole("button", { name: "今日", exact: true }).click();
  await expect(page.locator(".esa-reference .metric-card").nth(1)).toContainText("567");
  await page.locator(".esa-overview-toolbar select").selectOption("123");
  await expect(page.locator(".esa-reference .metric-card").nth(1)).toContainText("901");
  await page.getByRole("button", { name: "近 7 日", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__esaOverviewCalls.at(-1)?.range)).toBe("week");
  await page.getByRole("button", { name: "近 30 日", exact: true }).click();
  await expect(page.locator(".esa-reference .metric-card").nth(1)).toContainText("222");
  await page.evaluate(() => (window as any).__resolveWeek());
  await expect(page.locator(".esa-reference .metric-card").nth(1)).toContainText("222");
  await page.getByRole("button", { name: "站点列表", exact: true }).click();
  await page.setViewportSize({ width: 1851, height: 900 });
  const rowLayout = await page.locator(".esa-sites").evaluate((sites) => {
    const summary = sites.querySelector(".site-summary")!.getBoundingClientRect();
    const search = sites.querySelector(".esa-site-search")!.getBoundingClientRect();
    const table = sites.querySelector("table")!.getBoundingClientRect();
    return { centerOffset: Math.abs(summary.y + summary.height / 2 - search.y - search.height / 2), rightOffset: Math.abs(search.right - table.right) };
  });
  expect(rowLayout.centerOffset).toBeLessThanOrEqual(1);
  expect(rowLayout.rightOffset).toBeLessThanOrEqual(1);
  await page.locator(".esa-reference").screenshot({ path: "test-results/esa-search-alignment.png" });
  const search = page.getByPlaceholder("搜索站点或站点 ID");
  const searchLayout = await search.evaluate((input) => {
    const outer = input.parentElement!.getBoundingClientRect();
    const inner = input.getBoundingClientRect();
    const icon = input.parentElement!.querySelector("svg")!.getBoundingClientRect();
    return { offset: Math.abs(inner.y + inner.height / 2 - icon.y - icon.height / 2), contained: inner.top >= outer.top && inner.bottom <= outer.bottom, background: getComputedStyle(input).backgroundColor };
  });
  expect(searchLayout.offset).toBeLessThanOrEqual(1);
  expect(searchLayout.contained).toBe(true);
  expect(searchLayout.background).toBe("rgba(0, 0, 0, 0)");
  await search.fill("no-match.test");
  await expect(page.locator(".esa-reference").getByText("example.test", { exact: true })).toHaveCount(0);
});
