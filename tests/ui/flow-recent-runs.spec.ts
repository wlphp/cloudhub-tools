import { expect, test } from "@playwright/test";

test("recent runs sort across provider pages and retain search and group navigation", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cloudhub-tools-ui-theme", "dark"));
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
  await page.getByRole("button", { name: "添加连接", exact: true }).click();
  const connectionDialog = page.locator(".flow-dialog");
  await expect(connectionDialog).toHaveClass(/dialog-common-theme/);
  const connectionColors = await connectionDialog.evaluate(element => {
    const header = element.querySelector("header")!;
    const input = element.querySelector("input")!;
    return {
      surface: getComputedStyle(element).backgroundColor,
      border: getComputedStyle(element).borderColor,
      header: getComputedStyle(header).backgroundColor,
      input: getComputedStyle(input).backgroundColor,
      headerInset: header.getBoundingClientRect().left - element.getBoundingClientRect().left,
    };
  });
  expect(connectionColors.surface).toBe("rgb(29, 29, 29)");
  expect(connectionColors.header).toBe("rgb(36, 36, 36)");
  expect(connectionColors.input).toBe("rgb(26, 26, 26)");
  expect(connectionColors.headerInset).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "test-results/flow-connection-dialog.png" });
  await connectionDialog.getByRole("button", { name: /^关闭/ }).click();
  const rows = page.locator(".flow-pipeline-table tbody tr");
  await expect(rows).toHaveCount(30);
  await expect(rows.first()).toContainText("流水线 0");
  await page.getByRole("button", { name: "运行 流水线 0", exact: true }).click();
  const darkRunDialog = page.getByRole("dialog", { name: "运行流水线", exact: true });
  await expect(darkRunDialog).toHaveCSS("background-color", "rgb(29, 29, 29)");
  await expect(darkRunDialog.getByRole("textbox")).toBeHidden();
  await darkRunDialog.screenshot({ path: "test-results/flow-run-dialog-dark.png" });
  await page.keyboard.press("Escape");
  await expect(darkRunDialog).toBeHidden();
  const recent = page.getByRole("tab", { name: "云端最近运行", exact: true });
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

test("local recent runs persist successful triggers per connection and explain both sources", async ({ page }) => {
  const items = ["A", "B", "C"].map(id => ({ pipelineId: id, pipelineName: `本地测试 ${id}` }));
  let pipelineRequests = 0;
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/flow-connections") return route.fulfill({ json: [1, 2].map(id => ({ id, name: `连接 ${id}`, edition: "central", tokenSaved: true })) });
    if (url.pathname === "/api/flow-groups") return route.fulfill({ json: [] });
    if (url.pathname === "/api/flow-pipeline-cache") return route.fulfill({ json: { pipelines: [], updatedAt: null } });
    if (url.pathname === "/api/flow-pipelines") { pipelineRequests++; return route.fulfill({ json: items }); }
    if (url.pathname === "/api/flow-latest-run" || url.pathname === "/api/flow-run" && route.request().method() === "GET") return route.fulfill({ json: { pipelineRunId: "cloud-run", status: "SUCCESS", startTime: 1700000000000, stages: [], sources: [] } });
    if (url.pathname === "/api/flow-run") return route.fulfill({ json: "new-run" });
    return route.fulfill({ json: [] });
  });
  await page.goto("/");
  await expect(page.locator("body")).toHaveClass(/theme-light/);
  await page.evaluate(() => localStorage.setItem("cloudhub-tools-flow-local-runs:1", JSON.stringify([
    { pipeline: { pipelineId: "A", pipelineName: "本地测试 A" }, triggeredAt: 1700000000000 },
    { pipeline: { pipelineId: "B", pipelineName: "本地测试 B" }, triggeredAt: 1700000010000 },
  ])));
  await page.getByRole("button", { name: "云效流水线", exact: true }).first().click();
  const tabs = page.getByRole("tablist", { name: "流水线分组" });
  const local = tabs.getByRole("tab", { name: "本地最近运行", exact: true });
  await expect(tabs.getByRole("tab").first()).toHaveText("本地最近运行");
  await expect(local).toHaveAttribute("title", /本机.*成功触发/);
  await expect(tabs.getByRole("tab", { name: "云端最近运行", exact: true })).toHaveAttribute("title", /云效接口/);
  const rows = page.locator(".flow-pipeline-table tbody tr");
  await expect(rows).toHaveCount(3);
  const previousRequests = pipelineRequests;
  await local.click();
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("本地测试 B");
  expect(pipelineRequests).toBe(previousRequests);
  await page.getByRole("tab", { name: "全部", exact: true }).click();
  await page.getByRole("button", { name: "运行 本地测试 C", exact: true }).click();
  const runDialog = page.getByRole("dialog", { name: "运行流水线", exact: true });
  await expect(runDialog.getByText("本地测试 C", { exact: true })).toBeVisible();
  await expect(runDialog.getByRole("textbox")).toBeHidden();
  await page.locator(".shared-dialog-backdrop").click({ position: { x: 2, y: 2 } });
  await expect(runDialog).toBeVisible();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await runDialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(runDialog.getByRole("button", { name: "确认运行", exact: true })).toBeInViewport();
  }
  await runDialog.screenshot({ path: "test-results/flow-run-dialog-light.png" });
  await runDialog.locator("summary").click();
  await expect(runDialog.getByRole("textbox")).toBeVisible();
  await runDialog.getByRole("textbox").fill("{}");
  await runDialog.screenshot({ path: "test-results/flow-run-dialog-expanded.png" });
  await page.getByRole("button", { name: "确认运行", exact: true }).click();
  await expect(page.getByText("已触发运行 #new-run", { exact: true })).toBeVisible();
  await local.click();
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("本地测试 C");
  await page.locator(".flow-toolbar-actions select").selectOption("2");
  await expect(rows).toHaveCount(0);
  await page.locator(".flow-toolbar-actions select").selectOption("1");
  await expect(rows.first()).toContainText("本地测试 C");
  await page.evaluate(() => localStorage.setItem("cloudhub-tools-ui-theme", "dark"));
  await page.reload();
  await expect(page.locator("body")).not.toHaveClass(/theme-light/);
  await page.getByRole("button", { name: "云效流水线", exact: true }).first().click();
  await local.click();
  await expect(rows.first()).toContainText("本地测试 C");
});
