import { expect, test } from "@playwright/test";

for (const width of [320, 360, 375, 390, 430]) {
  test(`compact navigation and resource actions fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const longName = "用于验证窄屏完整换行的云服务器名称".repeat(3);
    await page.route("**/api/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/accounts") return route.fulfill({ json: [{ id: 12, account_name: "测试账号", cloud_type: "aliyun", enabled: true }] });
      if (url.pathname === "/api/panel-connections") return route.fulfill({ json: [{ id: 1, name: "测试面板", panel_url: "https://panel.example.test", status: "unknown", api_key_saved: false, summary: {} }] });
      if (url.pathname === "/api/managed-hosts") return route.fulfill({ json: [
        { id: 1, name: "Linux 测试主机", host: "ssh.example.test", username: "operator", port: 22, platform: "linux", status: "online", password_saved: true },
        { id: 2, name: "Windows 测试主机", host: "rdp.example.test", username: "operator", port: 3389, platform: "windows", status: "unknown", password_saved: true },
        { id: 3, name: "用于验证换行的长名称托管主机".repeat(3), host: "unconfigured.example.test", username: "operator", port: 22, platform: "linux", status: "offline", password_saved: false },
      ] });
      if (url.pathname === "/api/local-assets") return route.fulfill({ json: url.searchParams.get("resource_type") === "ecs" ? [{ account_id: 12, resource_type: "ecs", asset_key: "compact-server", region_id: "cn-hangzhou", payload: { instanceId: "compact-server", instanceName: longName, status: "Running" }, fetched_at: 1700000000 }] : [] });
      return route.fulfill({ json: [] });
    });
    await page.goto("/");
    const navigation = page.locator(".mobile-tab-bar");
    await expect(page.getByRole("heading", { name: "云账号", exact: true })).toBeVisible();
    const header = await page.locator(".mobile-header").boundingBox();
    expect(header!.height).toBeLessThanOrEqual(60);
    await navigation.getByRole("button", { name: "服务器", exact: true }).click();
    await expect(page.getByText(longName, { exact: true })).toBeVisible();
    const server = page.locator(".mobile-server-card-featured").first();
    await expect(server.getByRole("button", { name: "启动", exact: true })).toBeHidden();
    await server.locator("summary").click();
    await expect(server.getByRole("button", { name: "启动", exact: true })).toBeVisible();
    await expect(server.getByText(/compact-server/)).toBeVisible();
    // Check visibility of the complete name and that expanded actions remain in the viewport.
    expect(await server.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
    await navigation.getByRole("button", { name: "域名", exact: true }).click();
    await expect(page.getByRole("heading", { name: "域名与 DNS", exact: true })).toBeVisible();
    for (const name of ["对象存储", "云数据库", "Redis", "证书管理", "SSH 终端", "运维面板", "系统设置"]) {
      await navigation.getByRole("button", { name: "更多", exact: true }).click();
      await expect(page.getByRole("heading", { name: "更多管理", exact: true })).toBeVisible();
      await page.locator(".mobile-more-feature").filter({ hasText: name }).click();
      await expect(page.getByRole("heading", { name, exact: true }).first()).toBeVisible();
      if (name === "SSH 终端") {
        await expect(page.locator(".mobile-ssh-host-row")).toHaveCount(3);
        await expect(page.getByRole("button", { name: "连接终端 Linux 测试主机", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: "连接终端 Windows 测试主机", exact: true })).toBeDisabled();
        await expect(page.locator(".mobile-ssh-host-row").filter({ hasText: "unconfigured.example.test" }).getByRole("button")).toBeDisabled();
        if (width === 390) await page.screenshot({ path: "test-results/mobile-compact-ssh.png" });
      }
      if (name === "运维面板") {
        await expect(page.getByText("测试面板", { exact: true })).toBeVisible();
        await expect(page.locator(".mobile-page-title").getByRole("button", { name: "添加面板" })).toBeVisible();
        const panel = page.locator(".mobile-panel-card").first();
        expect((await panel.boundingBox())!.height).toBeLessThan(190);
        await expect(panel.getByRole("button", { name: "打开面板 测试面板", exact: true })).toBeDisabled();
        for (const button of await panel.locator(".mobile-panel-actions button").all()) {
          const bounds = await button.boundingBox();
          expect(bounds!.height).toBe(36);
          expect(bounds!.width).toBeLessThan(100);
        }
        if (width === 390) await page.screenshot({ path: "test-results/mobile-compact-panels.png" });
        await expect(page.getByText("系统负载", { exact: true })).toBeHidden();
        await page.locator("summary").filter({ hasText: "监控详情" }).click();
        await expect(page.getByText("系统负载", { exact: true })).toBeVisible();
      }
      const dimensions = await page.locator(".mobile-content").evaluate((el) => ({ inner: el.clientWidth, outer: el.scrollWidth }));
      expect(dimensions.outer).toBeLessThanOrEqual(dimensions.inner);
      const navBounds = await navigation.boundingBox();
      expect(navBounds!.y + navBounds!.height).toBeLessThanOrEqual(844);
    }
    await navigation.getByRole("button", { name: "更多", exact: true }).click();
    await expect(page.getByRole("searchbox", { name: "搜索全部功能" })).toHaveCount(0);
    await page.getByRole("button", { name: "搜索功能", exact: true }).click();
    const search = page.getByRole("searchbox", { name: "搜索全部功能" });
    await expect(search).toBeFocused();
    await search.fill("Redis");
    await expect(page.locator(".mobile-more-feature")).toHaveCount(1);
    await search.press("Escape");
    await expect(page.locator(".mobile-more-feature")).toHaveCount(7);
    await expect(page.getByRole("button", { name: "搜索功能", exact: true })).toBeFocused();
    if (width === 390) await page.screenshot({ path: "test-results/mobile-compact-more.png" });
  });
}
