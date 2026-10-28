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
        if (command === "speed_test_status") return current;
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
  await page.locator(".store-table tbody tr").getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.locator(".network-speed")).toBeVisible();
}

test("start, prevent repeat, cancel, history, and revisit the shared page", async ({ page }) => {
  await openTool(page);
  const start = page.getByRole("button", { name: "开始测速", exact: true });
  await expect(start).toBeEnabled();
  await page.getByLabel("每方向时长").selectOption("5");
  await page.getByLabel("总载荷上限").selectOption("50");
  await start.click();
  await expect(start).toBeDisabled();
  await expect(page.locator(".speed-metrics")).toContainText("80.0");
  await page.getByRole("button", { name: "返回软件商店" }).click();
  await page.getByRole("searchbox").fill("网络测速");
  await page.locator(".store-table tbody tr").getByRole("button", { name: "打开", exact: true }).click();
  await expect(start).toBeDisabled();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(start).toBeEnabled();
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await expect(page.locator(".speed-history")).toContainText("已停止 · 部分结果");
  const starts = await page.evaluate(() => (window as any).__speedCalls.filter((v: any) => v.command === "speed_test_start"));
  expect(starts).toHaveLength(1);
  expect(starts[0].args.config).toMatchObject({ durationSecs: 5, limitMib: 50 });
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
  await expect(info).toContainText("1.1.1.1"); await expect(info).toContainText("192.168.1.10");
  await expect(info).toContainText("中国 示例省 示例市 示例运营商");
  await expect(page.locator(".speed-metrics")).toContainText("此节点仅测下载");
  await nodes.selectOption("cn-alipay");
  await page.getByRole("button", { name: "开始测速", exact: true }).click();
  const start = await page.evaluate(() => (window as any).__speedCalls.find((v: any) => v.command === "speed_test_start"));
  expect(start.args.config.node).toBe("cn-alipay");
});

test("network info failures can be retried and do not block measurement", async ({ page }) => {
  await openTool(page);
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

test("preview explicitly refuses native measurement", async ({ page }) => {
  await openTool(page, false);
  await expect(page.locator(".network-speed")).toContainText("浏览器预览和手机端不执行测速");
  await expect(page.getByRole("button", { name: "开始测速" })).toHaveCount(0);
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
  await page.locator(".store-table tbody tr").getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.getByRole("button", { name: "开始测速" })).toBeDisabled();
});
