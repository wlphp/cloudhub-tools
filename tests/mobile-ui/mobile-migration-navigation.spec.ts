import { expect, test } from "@playwright/test";

test("数据目录按钮打开只读文件列表，支持子目录和显式关闭", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: { directory?: string } = {}) => {
      if (command === "member_me") return null;
      if (command === "monitor_alerts_snapshot") return { alerts: [], checkedAt: 0, lastError: null };
      if (command === "app_data_path") return "/data/user/0/com.example.cloudhub/files/CloudHubTools";
      if (command === "list_app_data_directory") return args.directory ? [{ name: "fixture.chdb", directory: false, sizeBytes: 2048 }] : [{ name: "backups", directory: true, sizeBytes: 0 }, { name: "settings.json", directory: false, sizeBytes: 123 }];
      return [];
    } };
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的", exact: true }).click();
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: "数据导入与迁移", exact: true }).click();
  await page.getByRole("button", { name: "打开数据目录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "数据目录", exact: true });
  await expect(dialog.getByRole("button", { name: "返回上级目录", exact: true })).toBeDisabled();
  await expect(dialog.getByText("settings.json", { exact: true })).toBeVisible();
  await expect(dialog.getByText("123 B", { exact: true })).toBeVisible();
  await page.locator(".modal-backdrop").last().click({ position: { x: 1, y: 1 }, force: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "打开文件夹 backups", exact: true }).click();
  await expect(dialog.getByText("fixture.chdb", { exact: true })).toBeVisible();
  await expect(dialog.getByText("2.0 KB", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /删除|导出|打开文件 / })).toHaveCount(0);
  await dialog.getByRole("button", { name: "返回上级目录", exact: true }).click();
  await expect(dialog.getByText("settings.json", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("directory-browser.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("目录读取失败显示紧凑提示，重试成功后清除错误", async ({ page }) => {
  await page.addInitScript(() => {
    let reads = 0;
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
      if (command === "member_me") return null;
      if (command === "monitor_alerts_snapshot") return { alerts: [], checkedAt: 0, lastError: null };
      if (command === "app_data_path") {
        if (++reads === 1) throw "目录暂不可用";
        return "/data/user/0/com.example.cloudhub/files/CloudHubTools";
      }
      return [];
    } };
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的", exact: true }).click();
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: "数据导入与迁移", exact: true }).click();
  const storage = page.getByRole("region", { name: "存储位置", exact: true });
  await expect(storage.getByRole("alert")).toHaveText("读取存储位置失败，请重试。");
  await expect(storage.locator("textarea")).toHaveCount(0);
  await storage.getByRole("button", { name: "刷新存储位置", exact: true }).click();
  await expect(storage.getByRole("alert")).toHaveCount(0);
  await expect(storage.locator("details")).not.toHaveAttribute("open", "");
});

test("迁移列表仅展示存储与入口，子页逐级返回且各尺寸不溢出", async ({ page }, testInfo) => {
  let cloudReads = 0;
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/cloud-sync/")) cloudReads++;
    return route.fulfill({ json: path === "/api/member" ? null : [] });
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的", exact: true }).click();
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: "数据导入与迁移", exact: true }).click();
  await expect(page.getByText("请在手机 App 内查看本机目录", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新存储位置", exact: true })).toBeDisabled();
  await expect(page.getByLabel("备份密码（可选）", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加同步渠道", exact: true })).toHaveCount(0);
  expect(cloudReads).toBe(0);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const index = page.locator(".mobile-migration-index");
    expect(await index.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const entry of await page.locator(".mobile-migration-entry").all()) {
      expect((await entry.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    }
  }
  await page.setViewportSize({ width: 375, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("migration-index.png"), fullPage: true });
  for (const [title, control] of [["扫码接收", ""], ["导入本地备份", "选择 .chdb 备份"], ["云同步", "添加同步渠道"]]) {
    await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
    await expect(page.locator(".mobile-settings-page-header h1")).toHaveText(title);
    await expect(page.locator(".mobile-migration-index")).toHaveCount(0);
    if (control) await expect(page.getByRole("button", { name: control, exact: true })).toBeVisible();
    else await expect(page.getByText(/请在手机 App 内扫码/)).toBeVisible();
    await page.getByRole("button", { name: "返回数据导入与迁移", exact: true }).click();
    await expect(page.locator(".mobile-migration-index")).toBeVisible();
  }
});

test("手机 App 显示实际存储路径并可刷新，长路径不撑开卡片", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    let reads = 0;
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
      if (command === "member_me") return null;
      if (command === "monitor_alerts_snapshot") return { alerts: [], checkedAt: 0, lastError: null };
      if (command === "app_data_path") return `/data/user/0/com.example.cloudhub/files/CloudHubTools/fixture-${++reads}`;
      return [];
    } };
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的", exact: true }).click();
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: "数据导入与迁移", exact: true }).click();
  const path = page.getByLabel("CloudHub 数据目录", { exact: true });
  await expect(page.locator(".mobile-migration-storage-details")).not.toHaveAttribute("open", "");
  await page.getByText("查看数据目录", { exact: true }).click();
  await expect(path).toHaveText(/fixture-1$/);
  await page.getByRole("button", { name: "刷新存储位置", exact: true }).click();
  await expect(path).toHaveText(/fixture-2$/);
  for (const viewport of [{ width: 375, height: 844 }, { width: 844, height: 375 }]) {
    await page.setViewportSize(viewport);
    expect(await path.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 375, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("migration-native-storage.png"), fullPage: true });
});

test("首页扫码直接进入接收操作页并保留导入预览", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
      if (command === "member_me") return null;
      if (command === "monitor_alerts_snapshot") return { alerts: [], checkedAt: 0, lastError: null };
      if (command.endsWith("|request_permissions")) return { camera: "granted" };
      if (command.endsWith("|scan")) return { content: "http://192.0.2.1:1234/v1/transfer/fixture#fixture", format: "QR_CODE" };
      if (command === "fetch_sync_transfer") return { sessionId: "fixture-session", preview: { protocolVersion: 5, categories: [{ table: "memo_notes", label: "备忘录", count: 1 }] } };
      return [];
    } };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "扫一扫", exact: true }).click();
  await page.getByRole("button", { name: "接收电脑配置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "确认导入配置", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认导入所选配置", exact: true })).toBeEnabled();
  await expect(page.getByLabel("备份密码（可选）", { exact: true })).toHaveCount(0);
  await expect(page.locator(".cloud-sync-section")).toHaveCount(0);
});
