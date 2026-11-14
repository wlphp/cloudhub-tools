import { estimateBandwidth } from "../../src/features/plugins/bandwidth-estimate";
import type { SpeedRun } from "../../src/platform/clients/speed-test";
import { expect, test, type Page } from "@playwright/test";

async function openTool(page: Page, native = true) {
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  if (native) await page.addInitScript(() => {
    let current: any = null;
    const history: any[] = [];
    (window as any).__speedCalls = [];
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args?: any) => {
        if (command.startsWith("speed_test_")) (window as any).__speedCalls.push({ command, args });
        if (command === "speed_test_status") {
          if (current && (window as any).__speedComplete) {
            current = { ...current, status: "completed", downloadMbps: (window as any).__speedMbps ?? 426.8, warnings: ["下载达到流量预算，测试提前结束；高带宽线路可提高上限重测", "国内 CDN 仅提供下载与 HTTP 延迟，上传请切换兼容节点"] };
            current.points = [{ seconds: 1, mbps: current.downloadMbps * .85, direction: "download" }, { seconds: 2, mbps: current.downloadMbps, direction: "download" }];
            if (!history.length) history.push(current);
          }
          return current;
        }
        if (command === "speed_test_network_info") {
          if ((window as any).__networkInfoFails) throw new Error("公网 IP 查询连接失败或超时");
          return { publicIp: "1.1.1.1", localIp: "192.168.1.10", location: "中国 示例省 示例市 示例运营商", source: "IPIP.NET", checkedAt: Date.now(), warning: null };
        }
        if (command === "speed_test_history") return history;
        if (command === "speed_test_start") {
          if ((window as any).__speedFail) throw new Error("测速节点解析失败");
          current = { id: "test-run", node: args.config.node, endpoint: "https://speed.example.test/", colo: "", status: "running", phase: "download", startedAt: Date.now(), finishedAt: null, elapsedSecs: 2, durationSecs: args.config.durationSecs, limitMib: args.config.limitMib, downloadMbps: 80, uploadMbps: null, latencyMs: 24, jitterMs: 2, trafficBytes: 1048576, points: [{ seconds: 1, mbps: 60, direction: "download" }, { seconds: 2, mbps: 80, direction: "download" }], warnings: [], error: null };
          return current;
        }
        if (command === "speed_test_cancel") { current = { ...current, status: "cancelled", finishedAt: Date.now() }; history.unshift(current); return null; }
        if (command === "list_client_preferences") return {};
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "wechat_plugin_status") return { supported: true, detectedPath: null, runningProcesses: 0 };
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await page.getByRole("searchbox").fill("网络测速");
  await page.locator(".store-table tbody tr").getByRole("button", { name: "管理", exact: true }).click();
  await expect(page.locator(".network-speed")).toBeVisible();
}

test("start, prevent repeat, cancel, history, and revisit the shared page", async ({ page }) => {
  await openTool(page);
  const start = page.getByRole("button", { name: "开始测速", exact: true });
  await expect(start).toBeEnabled();
  await page.getByLabel("每方向时长").selectOption("5");
  await page.getByLabel("总载荷上限").selectOption("50");
  await start.click();
  await expect(page.getByRole("button", { name: "停止测速", exact: true })).toBeEnabled();
  await expect(page.locator(".speed-metrics")).toContainText("80.0");
  await page.getByRole("button", { name: "返回软件商店" }).click();
  await page.getByRole("searchbox").fill("网络测速");
  await page.locator(".store-table tbody tr").getByRole("button", { name: "管理", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止测速", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "停止测速", exact: true }).click();
  await expect(start).toBeEnabled();
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await expect(page.locator(".speed-history")).toContainText("已停止 · 部分结果");
  const starts = await page.evaluate(() => (window as any).__speedCalls.filter((v: any) => v.command === "speed_test_start"));
  expect(starts).toHaveLength(1);
  expect(starts[0].args.config).toMatchObject({ durationSecs: 5, limitMib: 50 });
});

test("compact view collapses secondary information and reveals upload for compatible nodes", async ({ page }) => {
  await openTool(page);
  await expect(page.getByLabel("每方向时长")).toBeVisible();
  await expect(page.locator(".speed-network dl")).toBeHidden();
  await expect(page.locator(".speed-method p")).toBeHidden();
  await expect(page.locator(".speed-metric-upload")).toHaveCount(0);
  await expect(page.locator(".speed-chart-idle")).toBeVisible();
  expect(await page.locator(".network-speed").evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(400);
  await page.screenshot({ path: "test-results/network-speed-compact-idle.png", fullPage: true });
  await page.getByRole("combobox", { name: "测速节点", exact: true }).selectOption("cloudflare");
  await expect(page.locator(".speed-metric-upload")).toBeVisible();
  await page.getByRole("button", { name: "开始测速", exact: true }).click();
  await expect(page.locator(".speed-chart")).toBeVisible();
  expect(await page.locator(".speed-chart").evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(220);
  await page.locator(".speed-method summary").click();
  await expect(page.locator(".speed-method p")).toBeVisible();
});

test("download conversion divides completed Mbps by eight and rejects incomplete or invalid results", () => {
  const run = (status: SpeedRun["status"], downloadMbps: number | null) => ({ status, downloadMbps }) as SpeedRun;
  expect(estimateBandwidth(null)).toBeNull();
  for (const status of ["running", "failed", "cancelled"] as const) expect(estimateBandwidth(run(status, 426.8))).toBeNull();
  for (const value of [null, 0, -10, NaN, Infinity]) expect(estimateBandwidth(run("completed", value))).toBeNull();
  expect(estimateBandwidth(run("completed", 426.8))).toBe("约 53.4 MB/s");
  expect(estimateBandwidth(run("completed", 80))).toBe("约 10.0 MB/s");
  expect(estimateBandwidth(run("completed", 403.9))).toBe("约 50.5 MB/s");
  expect(estimateBandwidth(run("completed", 276.1))).toBe("约 34.5 MB/s");
  expect(estimateBandwidth(run("completed", 0.03))).toBe("不足 0.1 MB/s");
  expect(estimateBandwidth(run("completed", 1.25))).toBe("约 0.2 MB/s");
  expect(estimateBandwidth(run("completed", 1200))).toBe("约 150.0 MB/s");
});

test("inline settings keep toolbar aligned and completed history keeps warnings folded", async ({ page }) => {
  await openTool(page);
  await expect(page.locator(".speed-metric-bandwidth")).toContainText("测速后换算");
  const node = page.getByRole("combobox", { name: "测速节点", exact: true });
  const nodeBox = (await node.boundingBox())!;
  expect(nodeBox.width).toBeLessThanOrEqual(360);
  const start = page.getByRole("button", { name: "开始测速", exact: true });
  for (const control of [page.getByLabel("每方向时长"), page.getByLabel("总载荷上限"), start]) {
    expect((await control.boundingBox())!.y).toBeCloseTo(nodeBox.y, 0);
  }
  await start.click();
  await expect(page.locator(".speed-metric-bandwidth")).toContainText("测速完成后换算");
  await page.evaluate(() => { (window as any).__speedComplete = true; });
  await expect(page.locator(".speed-metric-bandwidth")).toContainText("约 53.4 MB/s");
  await expect(page.locator(".speed-metric-bandwidth")).toContainText("Mbps ÷ 8 = MB/s");
  await expect(page.locator(".speed-run-notes ul")).toBeHidden();
  await page.locator(".speed-network summary").click();
  expect((await page.getByRole("button", { name: "刷新网络信息" }).boundingBox())!.y).toBeLessThan((await page.locator(".speed-network dl").boundingBox())!.y);
  const metricTops = await page.locator(".speed-metrics strong").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
  expect(Math.max(...metricTops) - Math.min(...metricTops)).toBeLessThanOrEqual(1);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.locator(".network-speed").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: "test-results/network-speed-aligned-completed.png", fullPage: true });
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await expect(page.locator(".speed-history")).toContainText("约 53.4 MB/s");
  await expect(page.locator(".speed-history-details p").first()).toBeHidden();
  expect((await page.locator(".speed-history tbody tr").boundingBox())!.height).toBeLessThan(90);
  await page.screenshot({ path: "test-results/network-speed-history-compact.png", fullPage: true });
  await page.locator(".speed-history-details summary").click();
  await expect(page.locator(".speed-history-details")).toContainText("下载达到流量预算");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.locator(".network-speed").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }
});

test("custom node validation and native failures stay visible and recoverable", async ({ page }) => {
  await openTool(page);
  await page.getByRole("combobox", { name: "测速节点", exact: true }).selectOption("custom");
  await page.getByLabel("节点基础地址").fill("http://example.test/");
  await page.getByRole("button", { name: "开始测速" }).click();
  await expect(page.getByRole("alert")).toContainText("公网 HTTPS");
  await page.getByLabel("节点基础地址").fill("https://speed.example.test/");
  await page.evaluate(() => { (window as any).__speedFail = true; });
  await page.getByRole("button", { name: "开始测速" }).click();
  await expect(page.getByRole("alert")).toContainText("测速节点解析失败");
  await expect(page.getByRole("button", { name: "开始测速" })).toBeEnabled();
});

test("domestic nodes state download capability and show public/local IP and location", async ({ page }) => {
  await openTool(page);
  const nodes = page.getByRole("combobox", { name: "测速节点", exact: true });
  await expect(nodes).toHaveValue("cn-qiniu");
  await expect(nodes.locator("option")).toHaveText(["国内 · 七牛 CDN（仅下载）", "国内 · 支付宝 CDN（仅下载）", "Cloudflare · 自动边缘节点（下载 / 上传）", "自建兼容节点"]);
  const info = page.getByRole("region", { name: "本机网络信息", exact: true });
  await info.locator("summary").click();
  await expect(info.getByText("1.1.1.1", { exact: true })).toBeVisible();
  await expect(info).toContainText("1.1.1.1"); await expect(info).toContainText("192.168.1.10");
  await expect(info).toContainText("中国 示例省 示例市 示例运营商");
  await expect(page.locator(".speed-metric-upload")).toHaveCount(0);
  await nodes.selectOption("cn-alipay");
  await page.getByRole("button", { name: "开始测速", exact: true }).click();
  const start = await page.evaluate(() => (window as any).__speedCalls.find((v: any) => v.command === "speed_test_start"));
  expect(start.args.config.node).toBe("cn-alipay");
});

test("network info failures can be retried and do not block measurement", async ({ page }) => {
  await openTool(page);
  await page.locator(".speed-network summary").click();
  const refresh = page.getByRole("button", { name: "刷新网络信息", exact: true });
  await expect(refresh).toBeEnabled();
  await page.evaluate(() => { (window as any).__networkInfoFails = true; });
  await refresh.click();
  await expect(page.getByRole("region", { name: "本机网络信息", exact: true })).toContainText("测速仍可正常使用");
  await expect(page.getByRole("button", { name: "开始测速", exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).__networkInfoFails = false; });
  await refresh.click();
  await expect(page.locator(".speed-network-error")).toHaveCount(0);
});

test("preview allows parameters and reports unsupported execution on click", async ({ page }) => {
  await openTool(page, false);
  await page.getByLabel("测速节点", { exact: true }).selectOption("custom");
  await page.getByLabel("节点基础地址", { exact: false }).fill("https://speed.example.com/");
  await page.getByLabel("每方向时长", { exact: true }).selectOption("5");
  await page.getByLabel("总载荷上限", { exact: true }).selectOption("50");
  await expect(page.locator(".speed-status")).toContainText("每方向 5 秒 · 上限 50 MiB");
  await page.getByRole("button", { name: "开始测速" }).click();
  await expect(page.getByRole("alert")).toContainText("原生客户端");
  await page.locator(".speed-network summary").click();
  await expect(page.getByRole("button", { name: "刷新网络信息" })).toBeDisabled();
  await expect(page.locator(".network-speed select").first()).toBeEnabled();
  await expect(page.locator(".network-speed")).toContainText("网页端不读取");
});

test("mobile shell uses a single-column form and touch-sized controls", async ({ page }) => {
  await openTool(page, false);
  await page.evaluate(() => {
    const shell = document.createElement("div");
    shell.className = "mobile-shell";
    document.body.append(shell);
  });
  await page.locator(".speed-network summary").click();
  const styles = await page.locator(".speed-form").evaluate(form => ({
    columns: getComputedStyle(form).gridTemplateColumns,
    buttonHeight: getComputedStyle(form.querySelector(".speed-actions button")!).minHeight,
    networkColumns: getComputedStyle(document.querySelector(".speed-network dl")!).gridTemplateColumns,
  }));
  expect(styles.columns.trim().split(/\s+/)).toHaveLength(1);
  expect(styles.buttonHeight).toBe("48px");
  expect(styles.networkColumns.trim().split(/\s+/)).toHaveLength(1);
});

test("tool fits narrow and wide hosts with a labelled chart", async ({ page }) => {
  await openTool(page);
  await page.getByRole("button", { name: "开始测速" }).click();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const tool = page.locator(".network-speed");
    await expect(tool.getByRole("img", { name: /速度曲线/ })).toBeVisible();
    expect(await tool.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: "test-results/network-speed-desktop.png", fullPage: true });
});

test("dark small dialog uses shared shell, ignores backdrop, and closes with Escape", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("cloudhub-tools-ui-theme", "dark");
    localStorage.setItem("cloudhub.plugin-presentation", JSON.stringify({ "cloudhub.network-speed": { mode: "modal", size: "small" } }));
  });
  await openTool(page);
  const dialog = page.getByRole("dialog", { name: "网络测速", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator("body > .modal-backdrop")).toHaveCount(1);
  await page.locator("body > .modal-backdrop").click({ position: { x: 2, y: 2 } });
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "开始测速" }).click();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.locator(".network-speed").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    if (width === 375) await page.screenshot({ path: "test-results/network-speed-dark-small.png", fullPage: true });
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.locator(".store-table tbody tr").getByRole("button", { name: "管理", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止测速", exact: true })).toBeEnabled();
});
