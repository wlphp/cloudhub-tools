import { expect, test } from "@playwright/test";

test("recent runs sort across provider pages and retain search and group navigation", async ({ page }) => {
  const pipelines = Array.from({ length: 32 }, (_, index) => ({ pipelineId: String(index), pipelineName: `流水线 ${index}`, latestStatus: "SUCCESS" }));
  const requests: URL[] = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/flow-connections") return route.fulfill({ json: [{ id: 1, name: "测试连接", edition: "central", tokenSaved: true }] });
    if (url.pathname === "/api/flow-groups") return route.fulfill({ json: [{ groupId: "group-one", groupName: "测试项目" }] });
    if (url.pathname === "/api/flow-pipeline-cache") return route.fulfill({ json: { pipelines: [], updatedAt: null } });
    if (url.pathname === "/api/flow-pipelines") {
      requests.push(url);
      const matches = url.searchParams.get("groupId") ? [pipelines[4]] : pipelines.filter(item => !url.searchParams.get("keyword") || item.pipelineName.includes(url.searchParams.get("keyword")!));
      const start = (Number(url.searchParams.get("page")) - 1) * 30;
      return route.fulfill({ json: matches.slice(start, start + 30) });
    }
    if (url.pathname === "/api/flow-latest-run") {
      const id = Number(url.searchParams.get("pipelineId"));
      return route.fulfill({ json: { pipelineRunId: `run-${id}`, status: "SUCCESS", startTime: id === 31 ? null : 1700000000000 + id * 60000, stages: [] } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "云效流水线", exact: true }).first().click();
  const rows = page.locator(".flow-pipeline-table tbody tr");
  await expect(rows).toHaveCount(30);
  await expect(rows.first()).toContainText("流水线 0");
  const recent = page.getByRole("tab", { name: "最近运行", exact: true });
  await recent.click();
  await expect(recent).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".flow-recent-note")).toContainText("按最近运行开始时间从新到旧排列");
  await expect(page.locator(".flow-count")).toHaveText("31");
  await expect(rows).toHaveCount(30);
  await expect(rows.first()).toContainText("流水线 30");
  await expect(rows.last()).toContainText("流水线 1");
  const requestCount = requests.length;
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("流水线 0");
  expect(requests.length).toBe(requestCount);
  await page.getByLabel("搜索流水线", { exact: true }).fill("流水线 30");
  await page.locator(".flow-search").getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator(".flow-recent-note")).toContainText("按最近运行开始时间从新到旧排列");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("流水线 30");
  await page.getByRole("tab", { name: "测试项目", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("流水线 4");
  expect(requests.at(-1)?.searchParams.get("groupId")).toBe("group-one");
  await page.getByRole("tab", { name: "全部", exact: true }).click();
  await expect(rows).toHaveCount(30);
  await expect(rows.first()).toContainText("流水线 0");
  await recent.click();
  await expect(page.locator(".flow-recent-note")).toContainText("按最近运行开始时间从新到旧排列");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await recent.scrollIntoViewIfNeeded();
    await expect(recent).toBeVisible();
    expect(await page.locator(".flow-page").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.locator(".flow-pipeline-panel").screenshot({ path: "test-results/flow-recent-runs.png" });
});
