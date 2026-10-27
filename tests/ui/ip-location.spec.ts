import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, section = "我的收藏") {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("cloudhub-tools-favorite-assets", JSON.stringify(["1:ecs:ip-test"]));
    (window as any).ipCalls = [];
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args?: any) => {
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        if (command === "list_panel_connections") return [{ id: 7, name: "归属地测试面板", panel_url: "https://60.4.168.142:8888/entry", status: "online", summary: {}, api_key_saved: true, created_at: 1, updated_at: 1 }];
        if (command === "pet_settings") return { enabled: false, appearance: "alpaca", monitoring: false, panels: false, panelAccess: true, certificates: true, servers: true, size: 160, roam: "edge", activity: 1, sound: false, reducedMotion: false, quiet: false, intervalSeconds: 300, expiryDays: 30, cpuThreshold: 90, diskThreshold: 90, keepInTray: false };
        if (command === "pet_snapshot") return { alerts: [], checkedAt: 0, lastError: null };
        if (command === "list_accounts") return [{ id: 1, account_name: "测试云账户", cloud_type: "aliyun", access_key_id: "", enabled: true, sort_order: 0, created_at: 1, updated_at: 1 }];
        if (command === "list_local_assets") return [{ account_id: 1, resource_type: "ecs", asset_key: "ip-test", region_id: "cn-test", fetched_at: 1, payload: { InstanceId: "ip-test", InstanceName: "归属地测试服务器", PublicIpAddress: "60.4.168.142" } }];
        if (command === "query_ip_location") {
          (window as any).ipCalls.push(args);
          await new Promise(resolve => setTimeout(resolve, 100));
          if ((window as any).ipFail) throw new Error("fixture failure");
          return { feature: "ip", target: args.ip, found: true, location: { country: "中国", province: "河北", city: "保定", isp: "中国联通", display: (window as any).ipUpdated ? "河北/石家庄/中国联通" : "河北/保定/中国联通", longitude: 115.48233, latitude: 38.867657, has_coordinates: true }, checked_at: 1793068142, request_id: "fixture-request", additional_info: { note: "新增字段同样展示" } };
        }
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: section, exact: true }).first().click();
  return errors;
}

test("面板管理卡片在 IP 下方左对齐查询归属地并可查看刷新", async ({ page }) => {
  const errors = await fixture(page, "面板管理");
  const card = page.locator('[data-panel-id="7"]');
  const row = card.locator(".ip-location-row");
  await expect(row.getByRole("button", { name: "一键获取归属地", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).ipCalls)).toHaveLength(0);
  await row.getByRole("button", { name: "一键获取归属地", exact: true }).click();
  await expect(row).toContainText("河北/保定/中国联通");
  expect(await page.evaluate(() => (window as any).ipCalls)).toEqual([{ ip: "60.4.168.142" }]);
  for (const light of [false, true]) {
    await page.evaluate(value => document.body.classList.toggle("theme-light", value), light);
    const layout = await card.evaluate(element => {
      const address = element.querySelector(".panel-row-address")!.getBoundingClientRect();
      const location = element.querySelector(".ip-location-row")!.getBoundingClientRect();
      const note = element.querySelector(".panel-row-note")!.getBoundingClientRect();
      return { left: Math.abs(location.left - address.left), below: location.top >= address.bottom, aboveNote: location.bottom <= note.top };
    });
    expect(layout).toEqual({ left: 0, below: true, aboveNote: true });
  }
  await card.screenshot({ path: "test-results/ip-location-panel-card.png" });
  await row.getByRole("button", { name: /查看/ }).click();
  const dialog = page.getByRole("dialog", { name: "IP 归属地详情", exact: true });
  await expect(dialog).toContainText("fixture-request");
  await page.evaluate(() => { (window as any).ipUpdated = true; });
  await dialog.getByRole("button", { name: "重新拉取最新信息" }).click();
  await expect(row).toContainText("河北/石家庄/中国联通");
  expect(errors).toEqual([]);
});

test("按需获取、查看全部字段、刷新与失败恢复，沿用公共弹层交互", async ({ page }) => {
  const errors = await fixture(page);
  expect(await page.evaluate(() => (window as any).ipCalls)).toHaveLength(0);
  await page.getByRole("button", { name: "一键获取归属地", exact: true }).click();
  await expect(page.getByRole("button", { name: "获取中…", exact: true })).toBeDisabled();
  const row = page.locator(".ip-location-row");
  await expect(row).toContainText("河北/保定/中国联通");
  const alignment = await page.locator(".favorite-card-details").evaluate(element => {
    const address = element.firstElementChild!.getBoundingClientRect();
    const location = element.querySelector(".ip-location-row")!.getBoundingClientRect();
    return { left: Math.abs(address.left - location.left), below: location.top >= address.bottom };
  });
  expect(alignment).toEqual({ left: 0, below: true });
  await page.screenshot({ path: "test-results/ip-location-card.png" });
  expect(await page.evaluate(() => (window as any).ipCalls)).toEqual([{ ip: "60.4.168.142" }]);
  await row.getByRole("button", { name: /查看/ }).click();
  const dialog = page.getByRole("dialog", { name: "IP 归属地详情", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator("body > .modal-backdrop .ip-location-dialog")).toHaveCount(1);
  for (const value of ["中国联通", "115.48233", "38.867657", "fixture-request", "新增字段同样展示"]) await expect(dialog.locator(".ip-location-fields").first()).toContainText(value);
  await page.locator("body > .modal-backdrop").click({ position: { x: 2, y: 2 } });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "最大化弹层" }).click();
  await expect(dialog).toHaveClass(/dialog-size-expanded/);
  await dialog.getByRole("button", { name: "缩小弹层" }).click();
  const before = (await dialog.boundingBox())!;
  const header = (await dialog.locator("header").boundingBox())!;
  await page.mouse.move(header.x + 180, header.y + 20);
  await page.mouse.down();
  await page.mouse.move(header.x + 200, header.y + 35);
  await page.mouse.up();
  const after = (await dialog.boundingBox())!;
  expect(after.x).toBeGreaterThan(before.x);
  await page.evaluate(() => { (window as any).ipFail = true; });
  await dialog.getByRole("button", { name: "重新拉取最新信息" }).click();
  await expect(dialog.getByRole("alert")).toContainText("保留上次查询结果");
  await expect(row).toContainText("河北/保定/中国联通");
  await page.evaluate(() => { (window as any).ipFail = false; (window as any).ipUpdated = true; });
  await dialog.getByRole("button", { name: "重新拉取最新信息" }).click();
  await expect(row).toContainText("河北/石家庄/中国联通");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "重新拉取最新信息" }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "最大化弹层" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(row.getByRole("button", { name: /查看/ })).toBeFocused();
  expect(errors).toEqual([]);
});

test("初次查询失败可重试，详情在窄屏与双主题中不溢出", async ({ page }) => {
  const errors = await fixture(page);
  await page.evaluate(() => { (window as any).ipFail = true; });
  await page.getByRole("button", { name: "一键获取归属地", exact: true }).click();
  await expect(page.locator(".ip-location-row").getByRole("alert")).toBeVisible();
  await page.evaluate(() => { (window as any).ipFail = false; });
  await page.getByRole("button", { name: "重新获取归属地", exact: true }).click();
  await page.getByRole("button", { name: /查看 60.4.168.142/ }).click();
  const dialog = page.getByRole("dialog", { name: "IP 归属地详情", exact: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const light of [false, true]) {
    await page.evaluate(value => document.body.classList.toggle("theme-light", value), light);
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: width === 768 ? 375 : 844 });
      const fits = await dialog.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth + 1; });
      expect(fits).toBe(true);
      if (width === 375) await page.screenshot({ path: `test-results/ip-location-narrow-${light ? "light" : "dark"}.png` });
    }
    await page.screenshot({ path: `test-results/ip-location-${light ? "light" : "dark"}.png` });
  }
  expect(errors).toEqual([]);
});
