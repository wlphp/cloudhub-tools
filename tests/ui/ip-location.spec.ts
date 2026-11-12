import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, section = "我的收藏") {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("cloudhub-tools-favorite-assets", JSON.stringify(["1:ecs:ip-test"]));
    (window as any).ipCalls = [];
    (window as any).ipActive = 0;
    (window as any).ipMaxActive = 0;
    (window as any).ipResolvers = {};
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args?: any) => {
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        if (command === "list_panel_connections") return [
          { id: 7, name: "归属地测试面板", panel_url: "https://60.4.168.142:8888/entry", status: "online", summary: {}, api_key_saved: true, created_at: 1, updated_at: 1 },
          { id: 8, name: "同IP第二面板", panel_url: "https://60.4.168.142:8889/entry", status: "online", summary: {}, api_key_saved: true, created_at: 1, updated_at: 1 },
          { id: 9, name: "待获取面板", panel_url: "https://192.0.2.10:8888/entry", status: "offline", summary: {}, api_key_saved: true, created_at: 1, updated_at: 1 },
        ];
        if (command === "list_ip_locations") return JSON.parse(sessionStorage.getItem("fixture-ip-cache") || "[]");
        if (command === "delete_ip_location") {
          if ((window as any).ipDeleteFail) throw new Error("fixture deletion failure");
          sessionStorage.setItem("fixture-ip-cache", JSON.stringify(JSON.parse(sessionStorage.getItem("fixture-ip-cache") || "[]").filter((row: any) => row.target !== args.ip)));
          return;
        }
        if (command === "pet_settings") return { enabled: false, appearance: "alpaca", monitoring: false, panels: false, panelAccess: true, certificates: true, servers: true, size: 160, roam: "edge", activity: 1, sound: false, reducedMotion: false, quiet: false, intervalSeconds: 300, expiryDays: 30, cpuThreshold: 90, diskThreshold: 90, keepInTray: false };
        if (command === "pet_snapshot") return { alerts: [], checkedAt: 0, lastError: null };
        if (command === "list_accounts") return [{ id: 1, account_name: "测试云账户", cloud_type: "aliyun", access_key_id: "", enabled: true, sort_order: 0, created_at: 1, updated_at: 1 }];
        if (command === "list_local_assets") return [{ account_id: 1, resource_type: "ecs", asset_key: "ip-test", region_id: "cn-test", fetched_at: 1, payload: { InstanceId: "ip-test", InstanceName: "归属地测试服务器", PublicIpAddress: "60.4.168.142" } }];
        if (command === "query_ip_location") {
          (window as any).ipCalls.push(args);
          (window as any).ipActive++;
          (window as any).ipMaxActive = Math.max((window as any).ipMaxActive, (window as any).ipActive);
          try {
            if ((window as any).ipHold) await new Promise(resolve => { (window as any).ipResolvers[args.ip] = resolve; });
            else await new Promise(resolve => setTimeout(resolve, 100));
            if ((window as any).ipFail || (window as any).ipFailIps?.includes(args.ip)) throw new Error("fixture failure");
            const result = { feature: "ip", target: args.ip, found: !(window as any).ipNotFoundIps?.includes(args.ip), location: { country: "中国", province: "河北", city: "保定", isp: "中国联通", display: (window as any).ipUpdated ? "河北/石家庄/中国联通" : "河北/保定/中国联通", longitude: 115.48233, latitude: 38.867657, has_coordinates: true }, checked_at: 1793068142, request_id: "fixture-request", additional_info: { note: "新增字段同样展示" } };
            sessionStorage.setItem("fixture-ip-cache", JSON.stringify([...JSON.parse(sessionStorage.getItem("fixture-ip-cache") || "[]").filter((row: any) => row.target !== args.ip), result]));
            return result;
          } finally { (window as any).ipActive--; }
        }
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: section, exact: true }).first().click();
  return errors;
}

test("面板归属地重启恢复、同IP共享、地区计数筛选及手动删除", async ({ page }) => {
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
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const regions = page.getByRole("group", { name: "按地区筛选面板" });
  await expect(regions.getByRole("button", { name: "河北 2" })).toBeVisible();
  for (const light of [false, true]) {
    await page.evaluate(value => document.body.classList.toggle("theme-light", value), light);
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await regions.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await page.screenshot({ path: `test-results/panel-region-${light ? "light" : "dark"}.png` });
  }
  await regions.getByRole("button", { name: "河北 2" }).click();
  await expect(page.locator("[data-panel-id]")).toHaveCount(2);
  await expect(regions.getByRole("button", { name: "河北 2" })).toHaveAttribute("aria-pressed", "true");
  await regions.getByRole("button", { name: "河北 2" }).click();
  await expect(page.locator("[data-panel-id]")).toHaveCount(3);
  await regions.getByRole("button", { name: "全部地区 3" }).click();
  await page.reload();
  await page.getByRole("button", { name: "面板管理", exact: true }).first().click();
  await expect(row).toContainText("河北/保定/中国联通");
  expect(await page.evaluate(() => (window as any).ipCalls)).toHaveLength(0);
  await regions.getByRole("button", { name: "河北 2" }).click();
  await row.getByRole("button", { name: /查看/ }).click();
  await dialog.getByRole("button", { name: "删除归属地缓存", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "删除缓存", exact: true }).click();
  await expect(row.getByRole("button", { name: "一键获取归属地", exact: true })).toBeVisible();
  await expect(regions.getByRole("button", { name: "全部地区 3" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-panel-id="8"] .ip-location-row')).toContainText("一键获取归属地");
  await page.evaluate(() => { (window as any).ipUpdated = true; });
  await row.getByRole("button", { name: "一键获取归属地", exact: true }).click();
  await expect(row).toContainText("河北/石家庄/中国联通");
  expect(errors).toEqual([]);
});

test("未获取入口按顺序串行去重，实时进度及完成总结", async ({ page }) => {
  const errors = await fixture(page, "面板管理");
  await page.evaluate(() => { (window as any).ipHold = true; (window as any).ipNotFoundIps = ["192.0.2.10"]; });
  const unknown = page.getByRole("group", { name: "按地区筛选面板" }).getByRole("button", { name: "未获取 3" });
  await unknown.click();
  const progress = page.getByRole("region", { name: "归属地批量获取进度" });
  await expect(progress).toContainText("共 2 个 IP，正在获取第 1 / 2 个");
  await expect(progress).toContainText("涉及 3 台面板");
  await expect(progress).toContainText("当前：归属地测试面板");
  await expect(unknown).toBeDisabled();
  await expect(page.locator('[data-panel-id="9"]').getByRole("button", { name: "一键获取归属地", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).ipCalls)).toEqual([{ ip: "60.4.168.142" }]);
  for (const light of [false, true]) {
    await page.evaluate(value => document.body.classList.toggle("theme-light", value), light);
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await progress.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await page.screenshot({ path: `test-results/panel-location-batch-${light ? "light" : "dark"}.png` });
  }
  await page.getByRole("button", { name: "我的收藏", exact: true }).first().click();
  await page.evaluate(() => (window as any).ipResolvers["60.4.168.142"]());
  await expect.poll(() => page.evaluate(() => (window as any).ipCalls.length)).toBe(2);
  await page.getByRole("button", { name: "面板管理", exact: true }).first().click();
  await expect(progress).toContainText("正在获取第 2 / 2 个");
  await expect(progress).toContainText("当前：待获取面板");
  await page.evaluate(() => (window as any).ipResolvers["192.0.2.10"]());
  await expect(progress).toContainText("归属地全部获取完毕，共 2 个 IP");
  await expect(progress).toContainText("已保存 2 · 失败 0 · 未收录 / 内网 1（已缓存）");
  expect(await page.evaluate(() => (window as any).ipCalls)).toEqual([{ ip: "60.4.168.142" }, { ip: "192.0.2.10" }]);
  expect(await page.evaluate(() => (window as any).ipMaxActive)).toBe(1);
  await expect(page.getByRole("group", { name: "按地区筛选面板" }).getByRole("button", { name: /^未获取/ })).toHaveCount(0);
  await progress.getByRole("button", { name: "关闭归属地获取总结" }).click();
  await expect(progress).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("批量停止保留已获取结果，继续只查剩余，失败可单独重试", async ({ page }) => {
  const errors = await fixture(page, "面板管理");
  await page.evaluate(() => { (window as any).ipHold = true; });
  const regions = page.getByRole("group", { name: "按地区筛选面板" });
  await page.locator('[data-panel-id="7"]').getByRole("button", { name: "一键获取归属地", exact: true }).click();
  // A batch started during a single lookup must wait for it and reuse its result.
  await regions.getByRole("button", { name: "未获取 3" }).click();
  const progress = page.getByRole("region", { name: "归属地批量获取进度" });
  await progress.getByRole("button", { name: "停止后续获取" }).click();
  await expect(progress).toContainText("等待当前查询完成");
  await page.evaluate(() => (window as any).ipResolvers["60.4.168.142"]());
  await expect(progress).toContainText("已停止获取：已处理 1 / 2 个 IP");
  await expect(progress).toContainText("已保存 1 · 失败 0 · 待处理 1");
  expect(await page.evaluate(() => (window as any).ipCalls)).toHaveLength(1);
  await page.evaluate(() => { (window as any).ipHold = false; (window as any).ipFailIps = ["192.0.2.10"]; });
  await progress.getByRole("button", { name: "重试未完成" }).click();
  await expect(progress).toContainText("本轮获取结束：已处理全部 1 个 IP，1 个失败");
  await expect(regions.getByRole("button", { name: "未获取 1" })).toBeEnabled();
  await page.evaluate(() => { (window as any).ipFailIps = []; });
  await progress.getByRole("button", { name: "重试未完成" }).click();
  await expect(progress).toContainText("归属地全部获取完毕，共 1 个 IP");
  expect(await page.evaluate(() => (window as any).ipCalls)).toEqual([{ ip: "60.4.168.142" }, { ip: "192.0.2.10" }, { ip: "192.0.2.10" }]);
  expect(await page.evaluate(() => (window as any).ipMaxActive)).toBe(1);
  expect(errors).toEqual([]);
});

test("单个IP失败后继续后续查询，重试跳过已保存结果", async ({ page }) => {
  const errors = await fixture(page, "面板管理");
  await page.evaluate(() => { (window as any).ipFailIps = ["60.4.168.142"]; });
  await page.getByRole("group", { name: "按地区筛选面板" }).getByRole("button", { name: "未获取 3" }).click();
  const progress = page.getByRole("region", { name: "归属地批量获取进度" });
  await expect(progress).toContainText("本轮获取结束：已处理全部 2 个 IP，1 个失败");
  await expect(progress).toContainText("已保存 1 · 失败 1");
  expect(await page.evaluate(() => (window as any).ipCalls)).toEqual([{ ip: "60.4.168.142" }, { ip: "192.0.2.10" }]);
  await page.evaluate(() => { (window as any).ipFailIps = []; });
  await progress.getByRole("button", { name: "重试未完成" }).click();
  await expect(progress).toContainText("归属地全部获取完毕，共 1 个 IP");
  expect(await page.evaluate(() => (window as any).ipCalls)).toEqual([{ ip: "60.4.168.142" }, { ip: "192.0.2.10" }, { ip: "60.4.168.142" }]);
  expect(await page.evaluate(() => (window as any).ipMaxActive)).toBe(1);
  expect(errors).toEqual([]);
});

test("按需获取、查看全部字段、删除失败恢复，沿用公共弹层交互", async ({ page }) => {
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
  await page.evaluate(() => { (window as any).ipDeleteFail = true; });
  await dialog.getByRole("button", { name: "删除归属地缓存", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await confirmation.getByRole("button", { name: "删除缓存", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toContainText("删除归属地缓存失败");
  await expect(row).toContainText("河北/保定/中国联通");
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => (window as any).ipCalls)).toHaveLength(1);
  await dialog.getByRole("button", { name: "删除归属地缓存", exact: true }).focus();
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
