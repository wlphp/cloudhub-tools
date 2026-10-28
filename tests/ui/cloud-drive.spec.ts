import { expect, test, type Page } from "@playwright/test";

async function openTool(page: Page, native = true) {
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  if (native) await page.addInitScript(() => {
    const state = window as any;
    state.driveCalls = [];
    state.driveSnapshot = { dependency: { supported: true, installed: true, winfsp: true, version: "1.75.2", source: "已校验引擎", progress: { phase: "ready", downloaded: 0, total: 0 } }, connections: [], mounts: [] };
    state.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: any) => {
        if (command === "cloud_drive_snapshot") return structuredClone(state.driveSnapshot);
        if (command.startsWith("cloud_drive_")) {
          // Never retain credential-bearing payloads in test diagnostics.
          state.driveCalls.push(command);
          if (command === "cloud_drive_list_buckets") {
            state.driveListUsedDraftCredentials = !!args.input.accessKeyId && !!args.input.secretKey;
            state.driveListWithoutBucket = args.input.bucket === "";
            state.driveListReusedSavedCredentials = args.reuseSavedCredentials === true;
            state.driveListSecretWasBlank = args.input.secretKey === "";
            if (state.driveHoldList) await new Promise<void>(resolve => { state.driveReleaseList = resolve; });
            if (state.driveFailList) throw new Error("读取存储桶失败：请检查 Endpoint、区域、凭据有效期和列桶权限，也可手动填写已授权桶名");
            return state.driveBucketItems ?? ["sample-bucket", "other-bucket"];
          }
          if (command === "cloud_drive_save") {
            if (state.driveFailSave) throw new Error("Endpoint 必须为 HTTPS 地址");
            const { accessKeyId, secretKey, sessionToken, ...view } = args.input;
            state.driveSavedSecretWasBlank = secretKey === "";
            state.driveReusedSavedCredentials = args.reuseSavedCredentials === true;
            state.driveClearedSessionToken = args.clearSessionToken === true;
            state.driveSnapshot.connections = [{ ...view, accessKeyId, id: "fixture-id", hasCredentials: true, hasSessionToken: false }];
            state.driveSnapshot.mounts = [{ id: "fixture-id", phase: "idle", queued: 0, uploading: 0, errors: 0, bytesUsed: 0, outOfSpace: false, dirty: false, message: "" }];
          }
          if (command === "cloud_drive_mount") state.driveSnapshot.mounts[0].phase = "mounted";
          if (command === "cloud_drive_unmount") state.driveSnapshot.mounts[0].phase = "idle";
          if (command === "cloud_drive_probe") return args.kind === "buckets" ? ["other-bucket"] : ["子目录"];
          if (command === "cloud_drive_reveal_secret") {
            if (state.driveFailReveal) throw new Error("untrusted provider response");
            return state.driveTestSecret ??= crypto.randomUUID();
          }
          return [];
        }
        if (command === "list_client_preferences") return {};
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "wechat_plugin_status") return { supported: true, detectedPath: null, runningProcesses: 0 };
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await page.getByRole("searchbox").fill("云盘挂载");
  await page.locator(".store-table tbody tr").getByRole("button", { name: "打开", exact: true }).click();
}
async function createConnection(page: Page) {
  await page.getByRole("button", { name: "新增连接" }).click();
  const dialog = page.getByRole("dialog", { name: "新增云盘连接" });
  await dialog.getByLabel("连接名称", { exact: true }).fill("测试资料盘");
  await dialog.getByLabel("Bucket / 存储桶", { exact: false }).fill("sample-bucket");
  await dialog.getByLabel("Access Key ID", { exact: true }).fill(crypto.randomUUID());
  await dialog.getByLabel("Secret Access Key", { exact: true }).fill(crypto.randomUUID());
  return dialog;
}

test("unsaved credentials list and select buckets without requiring name or bucket", async ({ page }) => {
  await openTool(page);
  await page.getByRole("button", { name: "新增连接" }).click();
  const editor = page.getByRole("dialog", { name: "新增云盘连接" });
  await editor.getByLabel("Access Key ID", { exact: true }).fill(crypto.randomUUID());
  await editor.getByLabel("Secret Access Key", { exact: true }).fill(crypto.randomUUID());
  await page.evaluate(() => { (window as any).driveHoldList = true; });
  await editor.getByRole("button", { name: "读取存储桶", exact: true }).click();
  await expect(editor.getByRole("button", { name: "正在读取存储桶…" })).toBeDisabled();
  await expect(editor.getByRole("button", { name: "保存连接", exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => typeof (window as any).driveReleaseList)).toBe("function");
  await page.evaluate(() => { (window as any).driveReleaseList(); });
  const bucket = editor.getByRole("combobox", { name: "Bucket / 存储桶", exact: false });
  await expect(bucket).toBeVisible();
  expect(await page.evaluate(() => (window as any).driveListUsedDraftCredentials && (window as any).driveListWithoutBucket)).toBe(true);
  await bucket.selectOption("other-bucket");
  expect(await page.evaluate(() => (window as any).driveCalls.includes("cloud_drive_save"))).toBe(false);
  await editor.getByLabel("连接名称", { exact: true }).fill("选择桶测试");
  await editor.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).driveSnapshot.connections[0].bucket)).toBe("other-bucket");
});

test("bucket failure and empty list retain manual input and changed credentials discard old results", async ({ page }) => {
  await openTool(page);
  const editor = await createConnection(page);
  await page.evaluate(() => { (window as any).driveFailList = true; });
  await editor.getByRole("button", { name: "读取存储桶", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("列桶权限");
  await expect(editor.getByLabel("Bucket / 存储桶", { exact: false })).toHaveValue("sample-bucket");
  await page.evaluate(() => { (window as any).driveFailList = false; (window as any).driveBucketItems = []; });
  await editor.getByRole("button", { name: "读取存储桶", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("未返回存储桶");
  await page.evaluate(() => { (window as any).driveBucketItems = ["other-bucket"]; });
  await editor.getByRole("button", { name: "读取存储桶", exact: true }).click();
  const bucket = editor.getByRole("combobox", { name: "Bucket / 存储桶", exact: false });
  await expect(bucket).toHaveValue("sample-bucket");
  await editor.getByRole("button", { name: "手动填写桶名", exact: true }).click();
  await expect(editor.getByLabel("Bucket / 存储桶", { exact: false })).toHaveValue("sample-bucket");
  await editor.getByRole("button", { name: "从列表选择", exact: true }).click();
  await editor.getByLabel("Access Key ID", { exact: true }).fill(crypto.randomUUID());
  await expect(bucket).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "从列表选择", exact: true })).toHaveCount(0);
  await expect(editor.getByLabel("Bucket / 存储桶", { exact: false })).toHaveValue("sample-bucket");
});

test("saved credentials list without reveal and require confirmation for a changed destination", async ({ page }) => {
  await openTool(page);
  const create = await createConnection(page);
  await create.getByRole("button", { name: "保存连接", exact: true }).click();
  await page.getByRole("button", { name: "配置", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑云盘连接" });
  await editor.getByRole("button", { name: "读取存储桶", exact: true }).click();
  await expect(editor.getByRole("combobox", { name: "Bucket / 存储桶", exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as any).driveListSecretWasBlank && !(window as any).driveCalls.includes("cloud_drive_reveal_secret"))).toBe(true);
  await editor.getByLabel("Endpoint", { exact: false }).fill("https://oss-cn-beijing.aliyuncs.com");
  await expect(editor.getByRole("combobox", { name: "Bucket / 存储桶", exact: false })).toHaveCount(0);
  await editor.getByRole("button", { name: "读取存储桶", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "确认读取存储桶" });
  await expect(confirm).toContainText("https://oss-cn-beijing.aliyuncs.com");
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => (window as any).driveCalls.filter((c: string) => c === "cloud_drive_list_buckets").length)).toBe(1);
  await editor.getByRole("button", { name: "读取存储桶", exact: true }).click();
  await confirm.getByRole("button", { name: "确认", exact: true }).click();
  await expect(editor.getByRole("combobox", { name: "Bucket / 存储桶", exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as any).driveListReusedSavedCredentials && (window as any).driveListSecretWasBlank)).toBe(true);
  expect(await page.evaluate(() => (window as any).driveCalls.filter((c: string) => c === "cloud_drive_save").length)).toBe(1);
});

test("preview refuses mounting without invoking native commands", async ({ page }) => {
  await openTool(page, false);
  await expect(page.getByText("云盘挂载仅支持 Windows x64 桌面客户端", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "新增连接" })).toHaveCount(0);
});

test("connection editor reuses modal, keeps outside clicks open and fits host widths", async ({ page }) => {
  await openTool(page);
  const dialog = await createConnection(page);
  await expect(dialog.getByLabel("只读挂载", { exact: false })).toBeChecked();
  await expect(dialog.getByLabel("CloudHub 启动时自动挂载")).not.toBeChecked();
  expect(await dialog.evaluate(el => el.parentElement?.parentElement === document.body || el.closest(".modal-backdrop")?.parentElement === document.body)).toBe(true);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    expect(await dialog.locator(".drive-fields").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.mouse.click(2, 2);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("failed save retains form and successful save supports mount and safe unmount", async ({ page }) => {
  await openTool(page);
  const dialog = await createConnection(page);
  await page.evaluate(() => { (window as any).driveFailSave = true; });
  await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("HTTPS");
  await expect(dialog.getByLabel("连接名称", { exact: true })).toHaveValue("测试资料盘");
  await page.evaluate(() => { (window as any).driveFailSave = false; });
  await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "挂载", exact: true }).click();
  await expect(page.getByRole("button", { name: "打开", exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).driveSnapshot.mounts[0].queued = 1; });
  await page.locator(".cloud-drive").getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("button", { name: "安全卸载", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "配置", exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as any).driveSnapshot.mounts[0].queued = 0; });
  await page.locator(".cloud-drive").getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("button", { name: "安全卸载", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByRole("button", { name: "挂载", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).driveCalls.filter((v: string) => v === "cloud_drive_unmount").length)).toBe(1);
});

test("unknown recovery state prevents ordinary unmount or deleting configuration", async ({ page }) => {
  await openTool(page);
  const dialog = await createConnection(page);
  await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
  await page.evaluate(() => { (window as any).driveSnapshot.mounts[0].phase = "recovery"; });
  await page.locator(".cloud-drive").getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("button", { name: "恢复挂载" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "安全卸载", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "删除配置" })).toBeDisabled();
  await page.getByRole("button", { name: "保留缓存停止", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("尚未备份到云端");
  await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
  expect(await page.evaluate(() => (window as any).driveCalls.includes("cloud_drive_suspend"))).toBe(true);
  await page.getByRole("button", { name: "更新凭据", exact: true }).click();
  const repair = page.getByRole("dialog", { name: "更新云盘凭据" });
  await expect(repair.getByLabel("Access Key ID", { exact: true })).toHaveAttribute("type", "text");
  await expect(repair.locator('input[type="password"]')).toHaveCount(2);
  await repair.getByLabel("Access Key ID", { exact: true }).fill(crypto.randomUUID());
  await repair.getByLabel("Secret Access Key", { exact: true }).fill(crypto.randomUUID());
  await repair.getByRole("button", { name: "保存凭据", exact: true }).click();
  await expect(repair).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).driveCalls.includes("cloud_drive_credentials"))).toBe(true);
});

test("key ID is visible and saved secret is revealed only on demand without becoming a form edit", async ({ page }) => {
  await openTool(page);
  const create = await createConnection(page);
  await expect(create.getByLabel("Access Key ID", { exact: true })).toHaveAttribute("type", "text");
  await create.getByRole("button", { name: "显示Secret Access Key", exact: true }).click();
  await expect(create.getByLabel("Secret Access Key", { exact: true })).toHaveAttribute("type", "text");
  await create.getByRole("button", { name: "隐藏Secret Access Key", exact: true }).click();
  await create.getByRole("button", { name: "保存连接", exact: true }).click();
  await page.getByRole("button", { name: "配置", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑云盘连接" });
  expect(await editor.getByLabel("Access Key ID", { exact: true }).inputValue()).not.toBe("");
  expect(await page.evaluate(() => (window as any).driveCalls.includes("cloud_drive_reveal_secret"))).toBe(false);
  await page.evaluate(() => { (window as any).driveFailReveal = true; });
  await editor.getByRole("button", { name: "显示Secret Access Key", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveText("无法读取已保存凭据，请在 App 内重试。");
  await page.evaluate(() => { (window as any).driveFailReveal = false; });
  await editor.getByRole("button", { name: "显示Secret Access Key", exact: true }).click();
  await expect(editor.getByLabel("已保存的Secret Access Key", { exact: true })).toBeVisible();
  // Revealed values must not be submitted as edits, even when saved while visible.
  expect(await editor.locator('input[name="secretKey"]').evaluate(el => new FormData((el as HTMLInputElement).form!).get("secretKey") === "")).toBe(true);
  await editor.getByRole("button", { name: "隐藏Secret Access Key", exact: true }).click();
  await expect(editor.getByLabel("已保存的Secret Access Key", { exact: true })).toHaveCount(0);
  await editor.getByRole("button", { name: "保存连接", exact: true }).click();
  expect(await page.evaluate(() => (window as any).driveSavedSecretWasBlank)).toBe(true);
});

test("selecting a listed directory opens the configuration for explicit save", async ({ page }) => {
  await openTool(page);
  const create = await createConnection(page);
  await create.getByRole("button", { name: "保存连接", exact: true }).click();
  await page.getByRole("button", { name: "查看子目录", exact: true }).click();
  const listing = page.getByRole("dialog", { name: "子目录列表" });
  await expect(listing).toContainText("子目录");
  await listing.getByRole("button", { name: "选择", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑云盘连接" });
  await expect(editor.getByLabel("桶内目录", { exact: false })).toHaveValue("子目录");
  // Selecting must not silently change the saved connection.
  expect(await page.evaluate(() => (window as any).driveCalls.filter((v: string) => v === "cloud_drive_save").length)).toBe(1);
  await editor.getByRole("button", { name: "取消", exact: true }).click();
});

test("endpoint correction reuses saved credentials only after confirmation and cancel preserves edits", async ({ page }) => {
  await openTool(page);
  const create = await createConnection(page);
  await create.getByRole("button", { name: "保存连接", exact: true }).click();
  await page.getByRole("button", { name: "配置", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑云盘连接" });
  const endpoint = "https://oss-cn-beijing.aliyuncs.com";
  await editor.getByLabel("Endpoint", { exact: false }).fill(endpoint);
  await editor.getByRole("button", { name: "显示Secret Access Key", exact: true }).click();
  await expect(editor.getByLabel("已保存的Secret Access Key", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "保存连接", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "确认沿用已保存凭据" });
  await expect(confirm).toContainText(endpoint);
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor.getByLabel("Endpoint", { exact: false })).toHaveValue(endpoint);
  expect(await page.evaluate(() => (window as any).driveCalls.filter((v: string) => v === "cloud_drive_save").length)).toBe(1);
  await editor.getByRole("button", { name: "隐藏Secret Access Key", exact: true }).click();
  await editor.getByLabel("清除已保存的 Session Token").check();
  await editor.getByRole("button", { name: "保存连接", exact: true }).click();
  await confirm.getByRole("button", { name: "确认", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).driveSavedSecretWasBlank && (window as any).driveReusedSavedCredentials && (window as any).driveClearedSessionToken)).toBe(true);
});

test("changed key ID needs a new secret and explicit new credentials need no reuse confirmation", async ({ page }) => {
  await openTool(page);
  const create = await createConnection(page);
  await create.getByRole("button", { name: "保存连接", exact: true }).click();
  await page.getByRole("button", { name: "配置", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑云盘连接" });
  await editor.getByLabel("Access Key ID", { exact: true }).fill(crypto.randomUUID());
  await editor.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveText("Access Key ID 已变更，请填写配套的 Secret Access Key");
  expect(await page.evaluate(() => (window as any).driveCalls.filter((v: string) => v === "cloud_drive_save").length)).toBe(1);
  await editor.getByLabel("Endpoint", { exact: false }).fill("https://oss-cn-beijing.aliyuncs.com");
  await editor.getByLabel("Secret Access Key", { exact: true }).fill(crypto.randomUUID());
  await editor.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).driveReusedSavedCredentials)).toBe(false);
});
