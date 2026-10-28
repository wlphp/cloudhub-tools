import { test, expect, type Page } from "@playwright/test";

async function openSettings(page: Page) {
  await page.addInitScript(() => {
    const calls: Array<{ command: string; format?: unknown; mode?: unknown; protected: boolean; sourceId?: unknown; tables?: unknown }> = [];
    let restoreAttempts = 0;
    let cloudConfigured = false;
    let cloudTestAttempts = 0;
    let cloudConfig = { method: "webdav", provider: "custom", endpoint: "", username: "", accessKeyId: "", bucket: "", region: "us-east-1", pathStyle: true, remoteRoot: "cloudhub-sync", profile: "default", autoSync: false, allowInsecure: false, passwordProtected: false, hasPassword: false, hasSecretKey: false, hasBackupPassword: false };
    const cloudView = () => ({ configured: cloudConfigured, config: cloudConfig, status: { busy: false, paused: false, error: null, lastUpload: null, lastDownload: null } });
    const record = (id: string, encrypted: boolean) => ({ id, encrypted, fileName: `${id}.chdb`, createdAt: "2026-10-26T00:00:00Z", sizeBytes: 12345 });
    Object.assign(window, {
      __dataCalls: calls,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, format: args.format, mode: args.mode, protected: typeof args.password === "string" && args.password.length >= 8, sourceId: args.sourceId, tables: args.tables });
          if (command === "app_data_path") return "C:\\fixture\\CloudHubTools-Dev";
          if (command === "plugin:app|version") return "0.1.91";
          if (command === "plugin:updater|check") return null;
          if (command === "plugin:event|listen") return 1;
          if (command === "cloud_sync_state" || command === "cloud_sync_upload") return cloudView();
          if (command === "cloud_sync_reveal_secret") return "non-sensitive-saved-fixture";
          if (command === "cloud_sync_test") { if (++cloudTestAttempts === 1) throw new Error("认证失败或权限不足"); return; }
          if (command === "cloud_sync_save") {
            const input = args.config as typeof cloudConfig & { password: string; secretKey: string; backupPassword: string };
            const { password, secretKey, backupPassword, ...rest } = input;
            cloudConfig = { ...rest, hasPassword: !!password || cloudConfig.hasPassword, hasSecretKey: !!secretKey || cloudConfig.hasSecretKey, hasBackupPassword: !!backupPassword || cloudConfig.hasBackupPassword };
            cloudConfigured = true; return cloudView();
          }
          if (command === "database_transfer_catalog") return [{ table: "cloud_accounts", label: "云账号", count: 0 }, { table: "flow_connections", label: "流水线连接", count: 0 }];
          if (command === "export_database_file") return "C:\\fixture\\transfer.sql";
          if (command === "list_database_backups") return [record("encrypted-fixture", true), record("legacy-fixture", false)];
          if (command === "create_database_backup") return record(args.password ? "protected-new-fixture" : "new-fixture", typeof args.password === "string");
          if (command === "import_database_backup") return record("imported-fixture", false);
          if (command === "prepare_database_backup_restore" && args.id === "encrypted-fixture" && ++restoreAttempts === 1) throw new Error("fixture-failure");
          if (command === "prepare_database_import" || command === "prepare_database_backup_restore" || command === "cloud_sync_download") return {
            token: "fixture-preview", packageName: "fixture", exportedAt: "fixture", totalRecords: 1,
            importMode: command === "prepare_database_import" ? args.mode : "backup",
            categories: [{ table: "cloud_accounts", label: "云账号", count: 1 }], details: ["凭据已在本机重新加密"], conflicts: [],
          };
          return [];
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "系统设置", exact: true }).first().click();
  await page.getByRole("tab", { name: "数据管理", exact: true }).click();
}
async function calls(page: Page) {
  return page.evaluate(() => (window as unknown as { __dataCalls: Array<{ command: string; format?: string; mode?: string; protected: boolean; sourceId?: string; tables?: string[] }> }).__dataCalls);
}

test("cloud eye reveals drafts and saved passwords without changing the configuration", async ({ page }) => {
  await openSettings(page);
  const cloud = page.getByRole("region", { name: "云同步", exact: true });
  const password = cloud.getByLabel("WebDAV 密码", { exact: true });
  await cloud.locator(".cloud-sync-toggle").click();
  await cloud.getByLabel("WebDAV 服务器地址").fill("https://storage.example.test/dav");
  await cloud.getByLabel("WebDAV 账号").fill("fixture-user");
  await password.fill("non-sensitive-fixture");
  await cloud.getByRole("button", { name: "显示WebDAV 密码", exact: true }).click();
  await expect(password).toHaveAttribute("type", "text");
  expect((await calls(page)).some(call => call.command === "cloud_sync_reveal_secret")).toBe(false);
  await cloud.getByRole("button", { name: "隐藏WebDAV 密码", exact: true }).click();
  await expect(password).toHaveAttribute("type", "password");
  await cloud.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(password).toHaveValue("");
  await cloud.getByRole("button", { name: "显示WebDAV 密码", exact: true }).click();
  await expect(cloud.getByLabel("已保存的WebDAV 密码", { exact: true })).toHaveValue("non-sensitive-saved-fixture");
  await expect(cloud.getByRole("button", { name: "上传到云端", exact: true })).toBeEnabled();
  await cloud.getByRole("button", { name: "隐藏WebDAV 密码", exact: true }).click();
  await expect(cloud.getByLabel("已保存的WebDAV 密码", { exact: true })).toHaveCount(0);
  await expect(password).toHaveValue("");
  await cloud.getByRole("button", { name: "显示WebDAV 密码", exact: true }).click();
  await expect(cloud.getByLabel("已保存的WebDAV 密码", { exact: true })).toBeVisible();
  await cloud.getByLabel("WebDAV 账号").fill("another-fixture-user");
  await expect(cloud.getByLabel("已保存的WebDAV 密码", { exact: true })).toHaveCount(0);
  await expect(password).toHaveAttribute("type", "password");
});

test("cloud configuration saves redacted credentials and requires confirmation before upload", async ({ page }) => {
  await openSettings(page);
  const cloud = page.getByRole("region", { name: "云同步", exact: true });
  await cloud.locator(".cloud-sync-toggle").click();
  await expect(cloud.getByLabel("同步方式")).toBeEnabled();
  await expect(cloud.getByRole("button", { name: "上传到云端", exact: true })).toBeDisabled();
  await cloud.getByLabel("WebDAV 服务器地址").fill("https://storage.example.test/dav");
  await cloud.getByLabel("WebDAV 账号").fill("fixture-user");
  await cloud.getByLabel("WebDAV 密码", { exact: true }).fill("non-sensitive-fixture");
  await expect(cloud.getByRole("switch", { name: "自动上传" })).not.toBeChecked();
  await expect(cloud.getByRole("checkbox", { name: "使用密码保护云备份" })).not.toBeChecked();
  await cloud.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(cloud.getByRole("alert")).toBeVisible();
  await expect(cloud.getByLabel("WebDAV 账号")).toHaveValue("fixture-user");
  await cloud.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(cloud.getByRole("status")).toContainText("连接成功");
  await cloud.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(cloud.getByLabel("WebDAV 密码", { exact: true })).toHaveValue("");
  await expect(cloud.getByRole("button", { name: "上传到云端", exact: true })).toBeEnabled();
  await cloud.getByRole("button", { name: "上传到云端", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "上传云备份", exact: true });
  expect((await calls(page)).some(call => call.command === "cloud_sync_upload")).toBe(false);
  await page.locator(".modal-backdrop").last().click({ position: { x: 2, y: 2 }, force: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "确认上传", exact: true }).click();
  await expect(cloud.getByRole("status")).toContainText("已上传");
  await cloud.getByLabel("同步配置名").fill("another-profile");
  await expect(cloud.getByRole("button", { name: "从云端下载", exact: true })).toBeDisabled();
  await cloud.getByLabel("同步配置名").fill("default");
  await cloud.getByRole("button", { name: "从云端下载", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "确认恢复业务数据", exact: true })).toBeVisible();
  expect((await calls(page)).some(call => call.command === "confirm_database_import")).toBe(false);
});

for (const theme of ["light", "dark"]) test(`cloud S3 options and password protection stay compact across viewports in ${theme}`, async ({ page }) => {
  await page.addInitScript(value => localStorage.setItem("cloudhub-tools-ui-theme", value), theme);
  await openSettings(page);
  const cloud = page.getByRole("region", { name: "云同步", exact: true });
  await cloud.locator(".cloud-sync-toggle").click();
  await cloud.getByLabel("同步方式").selectOption("s3");
  await expect(cloud.getByLabel("WebDAV 账号")).toHaveCount(0);
  await expect(cloud.getByLabel("S3 服务地址")).toBeVisible();
  await expect(cloud.getByLabel("Secret Access Key", { exact: true })).toHaveAttribute("type", "password");
  await cloud.getByRole("checkbox", { name: "使用密码保护云备份" }).check();
  await expect(cloud.getByLabel("备份密码", { exact: true })).toHaveAttribute("type", "password");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await cloud.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const control of await cloud.locator("input,select").all()) expect(await control.evaluate(el => el.getBoundingClientRect().right <= el.closest(".cloud-sync-panel")!.getBoundingClientRect().right)).toBe(true);
  }
  await cloud.screenshot({ path: `test-results/cloud-sync-s3-${theme}.png` });
});

test("scope disclosure stays in place and its text stays left aligned", async ({ page }) => {
  await openSettings(page);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const summary = page.locator(".data-settings-scope summary");
    await summary.scrollIntoViewIfNeeded();
    const position = () => summary.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const parent = el.closest(".data-settings-notes")!.getBoundingClientRect();
      return { x: rect.x - parent.x, y: rect.y - parent.y };
    });
    const before = await position();
    await summary.click();
    expect(await position()).toEqual(before);
    const scope = page.locator(".data-settings-scope");
    expect(await scope.locator("p").first().evaluate(el =>
      Math.abs(el.getBoundingClientRect().left - el.closest(".data-settings-notes")!.getBoundingClientRect().left)
    )).toBeLessThan(1);
    expect(await scope.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await summary.click();
    expect(await position()).toEqual(before);
  }
});

test("SQL export requires acknowledgement and import previews conflict mode", async ({ page }) => {
  await openSettings(page);
  await expect(page.getByLabel("CloudHub 数据目录")).toHaveValue("C:\\fixture\\CloudHubTools-Dev");
  await page.getByRole("button", { name: "打开目录", exact: true }).click();
  await page.getByRole("button", { name: "导出明文 SQL", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出明文 SQL", exact: true });
  await expect(dialog.getByRole("button", { name: "导出明文 SQL", exact: true })).toBeDisabled();
  await dialog.getByLabel("我了解文件未加密，且包含明文凭据").check();
  await dialog.getByLabel("流水线连接", { exact: true }).uncheck();
  await dialog.getByRole("button", { name: "导出明文 SQL", exact: true }).click();
  await expect(dialog).toBeHidden();
  const exported = (await calls(page)).find(call => call.command === "export_database_file")!;
  expect(exported.format).toBe("sql"); expect(exported.tables).toContain("cloud_accounts"); expect(exported.tables).not.toContain("flow_connections");
  await page.getByLabel("导入冲突处理").selectOption("overwrite");
  await page.getByRole("button", { name: "导入 SQL", exact: true }).click();
  const preview = page.getByRole("alertdialog", { name: "确认导入 SQL", exact: true });
  await expect(preview).toContainText("覆盖重复记录");
  await preview.getByRole("button", { name: "取消导入", exact: true }).click();
  await expect.poll(async () => (await calls(page)).some(c => c.command === "cancel_database_import")).toBe(true);
  expect((await calls(page)).some(c => c.command === "confirm_database_import")).toBe(false);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const panel of await page.locator(".data-settings-panel").all()) expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.locator(".utility-page").screenshot({ path: "test-results/data-settings.png" });
});

test("ordinary backups create import and preview without a password", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "管理加密备份", exact: true }).click();
  const backups = page.getByRole("dialog", { name: "备份与恢复", exact: true });
  await expect(backups).toContainText("密码备份"); await expect(backups).toContainText("内含恢复密钥 · 无需密码");
  await backups.getByRole("button", { name: "打开位置", exact: true }).first().click();
  await expect.poll(async () => (await calls(page)).some(c => c.command === "open_app_data_directory")).toBe(true);
  await backups.getByRole("button", { name: "创建备份", exact: true }).click();
  const create = page.getByRole("dialog", { name: "创建备份", exact: true });
  await expect(create.getByLabel("使用密码保护", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("备份密码", { exact: true })).toHaveCount(0);
  await create.getByRole("button", { name: "保存备份", exact: true }).click();
  await expect(create).toBeHidden();
  await expect(backups.locator(".backup-record")).toHaveCount(3);
  const created = (await calls(page)).find(c => c.command === "create_database_backup")!;
  expect(created.protected).toBe(false); expect(created.sourceId).toBeUndefined();
  await backups.getByRole("button", { name: "导入备份", exact: true }).click();
  await expect(backups.locator(".backup-record")).toHaveCount(4);
  expect((await calls(page)).find(c => c.command === "import_database_backup")!.protected).toBe(false);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await backups.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await backups.screenshot({ path: "test-results/data-backups.png" });
  await backups.locator(".backup-record").filter({ hasText: "legacy-fixture.chdb" }).getByRole("button", { name: "恢复", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "确认恢复业务数据", exact: true })).toBeVisible();
  await expect(page.getByLabel("备份密码", { exact: true })).toHaveCount(0);
  expect((await calls(page)).find(c => c.command === "prepare_database_backup_restore")!.protected).toBe(false);
  await page.getByRole("button", { name: "取消导入", exact: true }).click();
});

test("restore submits selected modules and explicit merge mode", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "管理加密备份", exact: true }).click();
  await page.locator(".backup-record").filter({ hasText: "legacy-fixture.chdb" }).getByRole("button", { name: "恢复", exact: true }).click();
  const review=page.getByRole("alertdialog",{name:"确认恢复业务数据",exact:true});
  await review.getByRole("button",{name:"清空选择"}).click();
  await expect(review.getByRole("button",{name:"确定导入"})).toBeDisabled();
  await review.getByRole("checkbox",{name:"云账号（1 条）",exact:true}).check();
  await review.getByLabel("恢复方式",{exact:true}).selectOption("merge");
  await review.getByRole("button",{name:"确定导入"}).click();
  await expect.poll(async()=> (await calls(page)).find(c=>c.command==="confirm_database_import")?.mode).toBe("merge");
  expect((await calls(page)).find(c=>c.command==="confirm_database_import")?.tables).toEqual(["cloud_accounts"]);
});

test("password backup is optional validates confirmation and resets to no password", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "管理加密备份", exact: true }).click();
  const backups = page.getByRole("dialog", { name: "备份与恢复", exact: true });
  await backups.getByRole("button", { name: "创建备份", exact: true }).click();
  const create = page.getByRole("dialog", { name: "创建备份", exact: true });
  await create.getByLabel("使用密码保护", { exact: true }).check();
  await create.getByLabel("备份密码", { exact: true }).fill("short");
  await create.getByRole("button", { name: "保存备份", exact: true }).click();
  await expect(create.getByRole("alert")).toContainText("至少 8 个字符");
  await create.getByLabel("备份密码", { exact: true }).fill("fixture-password");
  await create.getByLabel("确认备份密码", { exact: true }).fill("different-fixture");
  await create.getByRole("button", { name: "保存备份", exact: true }).click();
  await expect(create.getByRole("alert")).toContainText("不一致");
  expect((await calls(page)).some(c => c.command === "create_database_backup")).toBe(false);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await create.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await create.getByLabel("确认备份密码", { exact: true }).fill("fixture-password");
  await create.getByRole("button", { name: "保存备份", exact: true }).click();
  await expect(create).toBeHidden();
  expect((await calls(page)).find(c => c.command === "create_database_backup")!.protected).toBe(true);
  await expect(backups.locator(".backup-record").filter({ hasText: "protected-new-fixture.chdb" })).toContainText("密码备份");
  await backups.getByRole("button", { name: "创建备份", exact: true }).click();
  await expect(create.getByLabel("使用密码保护", { exact: true })).not.toBeChecked();
  await create.getByLabel("使用密码保护", { exact: true }).check();
  await expect(create.getByLabel("备份密码", { exact: true })).toHaveValue("");
  await create.getByLabel("备份密码", { exact: true }).fill("fixture-password");
  await create.getByLabel("使用密码保护", { exact: true }).uncheck();
  await create.getByRole("button", { name: "保存备份", exact: true }).click();
  await expect(create).toBeHidden();
  const created = (await calls(page)).filter(c => c.command === "create_database_backup");
  expect(created.map(c => c.protected)).toEqual([true, false]);
});

test("failed backup unlock permits retry without exposing raw errors", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "管理加密备份", exact: true }).click();
  await page.locator(".backup-record").filter({ hasText: "encrypted-fixture.chdb" }).getByRole("button", { name: "恢复", exact: true }).click();
  const unlock = page.getByRole("dialog", { name: "解锁备份", exact: true });
  await unlock.getByLabel("备份密码", { exact: true }).fill("fixture-password");
  await unlock.getByRole("button", { name: "解锁并预览", exact: true }).click();
  await expect(unlock.getByRole("alert")).toContainText("无法读取备份");
  await expect(unlock).not.toContainText("fixture-failure");
  await unlock.getByRole("button", { name: "解锁并预览", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "确认恢复业务数据", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消导入", exact: true }).click();
});

test("light password dialog stays within compact widths and only explicit controls close it", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cloudhub-tools-ui-theme", "light"));
  await openSettings(page);
  await page.getByRole("button", { name: "管理加密备份", exact: true }).click();
  await page.getByRole("button", { name: "导入密码备份", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入密码备份", exact: true });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await dialog.screenshot({ path: "test-results/data-password-light.png" });
  await page.mouse.click(2, 2);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("备份密码", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect((await calls(page)).some(c => c.command === "create_database_backup")).toBe(false);
});

test("browser preview disables native SQL and backup operations", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "系统设置", exact: true }).first().click();
  await page.getByRole("tab", { name: "数据管理", exact: true }).click();
  await expect(page.getByRole("button", { name: "导入 SQL", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "导出明文 SQL", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "管理加密备份", exact: true })).toBeDisabled();
  await expect(page.getByRole("region", { name: "云同步", exact: true }).getByText("展开后填写连接配置、上传或下载数据。", { exact: true })).toBeVisible();
  await page.locator(".cloud-sync-toggle").click();
  await expect(page.getByRole("button", { name: "测试连接", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "上传到云端", exact: true })).toBeDisabled();
  await expect(page.getByRole("region", { name: "云同步", exact: true }).getByRole("status")).toHaveText("云同步仅在原生客户端中可用，浏览器预览不连接远端存储。");
});
