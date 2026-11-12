import { expect, test } from "@playwright/test";

for (const width of [375, 768, 1024, 1440]) {
  test(`OSS file actions and metadata at ${width}px`, async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      (window as any).ossCalls = [];
      (window as any).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1, unregisterCallback: () => {},
        invoke: async (command: string, args: any) => {
          if (command === "authenticator_status") return { configured: false, unlocked: false };
          if (command === "list_client_preferences") return {};
          if (command === "list_accounts") return [{ id: 7, account_name: "测试账号", cloud_type: "aliyun", access_key_id: "fixture-id", enabled: true }];
          if (command === "list_local_assets") return [{ account_id: 7, resource_type: "oss", asset_key: "fixture-bucket", fetched_at: 1, payload: { Name: "fixture-bucket", Location: "oss-cn-beijing" } }];
          if (command === "get_oss_acl") return "private";
          if (command === "list_oss_objects") return { prefixes: ["documents/"], objects: [
            { Key: "index.html", Size: "1024", LastModified: "2026-11-01T08:00:00Z", ETag: '"' + "ABCDEF0123456789".repeat(8) + '"' },
            { Key: "archive.zip", Size: "2048", LastModified: "2026-11-01T08:00:00Z", ETag: "example-etag" },
          ], isTruncated: false, nextMarker: "" };
          if (command === "read_oss_text_object") { (window as any).ossCalls.push({ command, args }); return "<h1>Example</h1>"; }
          if (command === "download_oss_object") { (window as any).ossCalls.push({ command, args }); return null; }
          return [];
        },
      };
    });
    await page.goto("/");
    await page.getByRole("button", { name: "资产管理", exact: true }).click();
    await page.getByRole("button", { name: "文件列表", exact: true }).click();
    await page.setViewportSize({ width, height: 900 });
    const dialog = page.getByRole("dialog", { name: "文件列表", exact: true });
    const row = dialog.getByRole("row").filter({ hasText: "index.html" });
    if (width === 1440) {
      expect(await dialog.locator(".oss-browser-toolbar").evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(48);
      expect(await row.evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(40);
    }
    await expect(dialog.locator(".oss-drop-zone")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "下载", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "查看", exact: true })).toBeVisible();
    const more = row.getByRole("button", { name: "更多操作：index.html", exact: true });
    await more.click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "在线编辑" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "复制临时链接" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(more).toBeFocused();
    await more.click();
    await menu.getByRole("menuitem", { name: "在线编辑" }).click();
    const editor = page.getByRole("dialog", { name: "在线编辑", exact: true });
    await expect(editor.getByRole("textbox")).toHaveValue("<h1>Example</h1>");
    await editor.getByRole("button", { name: "返回文件列表" }).click();
    await row.getByRole("button", { name: "下载", exact: true }).click();
    expect(await page.evaluate(() => (window as any).ossCalls.map((call: any) => call.command))).toEqual(["read_oss_text_object", "download_oss_object"]);
    expect(await row.locator(".oss-object-etag").evaluate(el => el.scrollWidth > el.clientWidth && el.getBoundingClientRect().right <= el.parentElement!.getBoundingClientRect().right)).toBe(true);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await dialog.getByRole("textbox", { name: "按名称筛选文件" }).fill("archive");
    await expect(dialog.getByRole("row").filter({ hasText: "index.html" })).toHaveCount(0);
    await expect(dialog.getByRole("row").filter({ hasText: "archive.zip" }).getByRole("button", { name: "查看", exact: true })).toHaveCount(0);
    await dialog.getByRole("textbox", { name: "按名称筛选文件" }).fill("");
    await row.getByRole("button", { name: "更多操作：index.html" }).click();
    await page.screenshot({ path: `test-results/oss-files-${width}.png` });
  });
}

for (const width of [375, 1440]) {
  test(`OSS directory navigation preserves current dialog size at ${width}px`, async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      (window as any).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1, unregisterCallback: () => {},
        invoke: async (command: string, args: any) => {
          if (command === "authenticator_status") return { configured: false, unlocked: false };
          if (command === "list_client_preferences") return {};
          if (command === "list_accounts") return [{ id: 7, account_name: "测试账号", cloud_type: "aliyun", access_key_id: "fixture-id", enabled: true }];
          if (command === "list_local_assets") return [{ account_id: 7, resource_type: "oss", asset_key: "fixture-bucket", fetched_at: 1, payload: { Name: "fixture-bucket", Location: "oss-cn-beijing" } }];
          if (command === "get_oss_acl") return "private";
          if (command === "list_oss_objects") return {
            prefixes: !args.prefix ? ["documents/", ...Array.from({ length: 40 }, (_, index) => `folder-${index}/`)] : args.prefix === "documents/" ? ["documents/nested/"] : [],
            objects: [], isTruncated: false, nextMarker: "",
          };
          return [];
        },
      };
    });
    await page.goto("/");
    await page.getByRole("button", { name: "资产管理", exact: true }).click();
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "文件列表", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "文件列表", exact: true });
    const dimensions = () => dialog.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return [rect.width, rect.height].map(Math.round);
    });
    await expect(dialog.getByRole("button", { name: "documents", exact: true })).toBeVisible();
    const original = await dimensions();
    for (const maximized of [false, true]) {
      if (maximized) {
        await dialog.getByRole("button", { name: "最大化弹层", exact: true }).click();
        await expect.poll(async () => (await dimensions())[0]).toBe(Math.round(width * .95));
      }
      const current = await dimensions();
      await dialog.getByRole("button", { name: "documents", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "nested", exact: true })).toBeVisible();
      await expect.poll(dimensions).toEqual(current);
      await dialog.getByRole("button", { name: "nested", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(dialog.getByText("此目录暂无对象", { exact: true })).toBeVisible();
      await expect.poll(dimensions).toEqual(current);
      await dialog.getByRole("button", { name: "刷新当前目录", exact: true }).click();
      await expect(dialog.getByText("此目录暂无对象", { exact: true })).toBeVisible();
      await expect.poll(dimensions).toEqual(current);
      await dialog.getByRole("button", { name: "向上一级", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "nested", exact: true })).toBeVisible();
      await expect.poll(dimensions).toEqual(current);
      await dialog.getByRole("button", { name: "返回存储桶根目录", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "documents", exact: true })).toBeVisible();
      await expect.poll(dimensions).toEqual(current);
      if (maximized) {
        await dialog.getByRole("button", { name: "缩小弹层", exact: true }).click();
        await expect.poll(dimensions).toEqual(original);
      }
    }
  });
}
