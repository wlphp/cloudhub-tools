import { expect, test } from "@playwright/test";

test("mobile recent runs work without provider groups", async ({ page }) => {
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/flow-connections") return route.fulfill({ json: [{ id: 1, name: "测试连接", edition: "central", tokenSaved: true }] });
    if (url.pathname === "/api/flow-pipelines") return route.fulfill({ json: [
      { pipelineId: "old", pipelineName: "较早运行" }, { pipelineId: "new", pipelineName: "最新运行" }, { pipelineId: "none", pipelineName: "未运行" },
    ] });
    if (url.pathname === "/api/flow-pipeline-cache") return route.fulfill({ json: { pipelines: [], updatedAt: null } });
    if (url.pathname === "/api/flow-latest-run") return route.fulfill({ json: { pipelineRunId: "1", status: "SUCCESS", startTime: { old: 1700000000000, new: 1700000100000 }[url.searchParams.get("pipelineId")!] ?? null, stages: [] } });
    return route.fulfill({ json: [] });
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
  await page.locator(".mobile-more-feature").filter({ hasText: "云效流水线" }).click();
  await page.getByRole("tab", { name: "最近运行", exact: true }).click();
  await expect(page.locator(".flow-recent-note")).toContainText("按最近运行开始时间从新到旧排列");
  const cards = page.locator(".flow-mobile-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("最新运行");
  await expect(cards.last()).toContainText("较早运行");
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.locator(".mobile-content").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.locator(".flow-pipeline-panel").screenshot({ path: "test-results/mobile-flow-recent.png" });
});
