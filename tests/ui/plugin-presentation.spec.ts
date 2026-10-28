import { expect, test, type Page } from "@playwright/test";

async function openStore(page: Page) {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string) => {
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        if (command === "ai_list_profiles") return [{ id: "f", name: "T", protocol: "openai_chat", model: "m", enabled: true, isDefault: true, visionStatus: "supported" }];
        if (command === "list_wsl_distributions") return [];
        if (command === "wsl_settings") return {};
        if (command === "browser_snapshot") {
          const kernel = { version: "155.0.8059.84", label: "推荐版本", recommended: true, experimental: false, installed: false, phase: "idle", downloaded: 0, total: 206114888, error: null };
          const environment = { id: "fixture-environment", config: { name: "回归环境", group: "", tags: "", note: "", kernelVersion: kernel.version, startUrls: [], proxy: { kind: "direct", host: "", port: 8080, username: "" }, language: "zh-CN", timezone: "Asia/Shanghai", width: 1280, height: 900, geolocation: null, fingerprint: null, identity: "native" }, passwordSaved: false, createdAt: 0, lastOpenedAt: null, deletedAt: null, running: false };
          return { supported: true, kernel, kernels: [kernel], environments: [environment] };
        }
        if (command === "browser_cookie_list") return [];
        if (command === "hardware_info_get") return { model: "Example Laptop", os: "Windows", uptime: "1 小时", updatedAt: "2026-10-17", wifiPasswordSupported: true, sections: [{ title: "网络与代理", rows: [{ label: "当前 Wi-Fi", value: "Example SSID" }] }] };
        if (command === "hardware_wifi_password_reveal") return { ssid: "Example SSID", password: "test-only-value" };
        if (command === "claude_provider_list") return { providers: [], currentId: null, settingsPath: "", settingsExists: false, hasBackup: false };
        if (command === "notes_snapshot") return { notes: [], trashed: [], groups: ["个人"], reminders: [] };
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await expect(page.locator(".software-store-page tbody tr").first()).toBeVisible();
  await page.getByRole("combobox", { name: "每页条数" }).selectOption("90");
}

test("every plugin defaults to opening as a page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStore(page);
  const triggers = page.locator(".plugin-presentation-trigger");
  await expect(triggers).toHaveCount(9);
  for (let index = 0; index < 9; index += 1) {
    await expect(triggers.nth(index)).toHaveText("设置");
    await expect(triggers.nth(index)).toHaveAttribute("title", "设置，当前打开方式：页面");
    await expect(triggers.nth(index).locator("xpath=ancestor::div[contains(@class, 'store-row-actions')]").getByRole("button").first()).toHaveAccessibleName("设置");
  }
});

test("the presentation dialog switches a plugin between page and modal", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStore(page);
  await page.locator(".software-store-page tbody tr", { hasText: "WSL 管理" }).locator(".plugin-presentation-trigger").click();

  const dialog = page.locator(".plugin-presentation-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("WSL 管理");
  // 默认选中「页面」，弹层大小因此不可用。
  await expect(dialog.getByRole("button", { name: /^页面/ })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "大弹窗" })).toBeDisabled();

  await dialog.getByRole("button", { name: /^弹层/ }).click();
  await expect(dialog.getByRole("button", { name: "大弹窗" })).toBeEnabled();
  await dialog.getByRole("button", { name: "小弹窗" }).click();
  await expect(dialog.getByRole("button", { name: "小弹窗" })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "完成" }).click();

  // 设置入口保持固定文案，工具提示显示当前模式，刷新后仍然保留。
  const trigger = page.locator(".software-store-page tbody tr", { hasText: "WSL 管理" }).locator(".plugin-presentation-trigger");
  await expect(trigger).toHaveAttribute("title", "设置，当前打开方式：小弹窗");
  await page.reload();
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await expect(page.locator(".software-store-page tbody tr", { hasText: "WSL 管理" }).locator(".plugin-presentation-trigger")).toHaveAttribute("title", "设置，当前打开方式：小弹窗");
});

test("reset restores the page default", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStore(page);
  const row = page.locator(".software-store-page tbody tr", { hasText: "电脑信息" });
  await row.locator(".plugin-presentation-trigger").click();
  const dialog = page.locator(".plugin-presentation-dialog");
  await dialog.getByRole("button", { name: /^弹层/ }).click();
  await dialog.getByRole("button", { name: "完成" }).click();
  await expect(row.locator(".plugin-presentation-trigger")).toHaveAttribute("title", "设置，当前打开方式：大弹窗");

  await row.locator(".plugin-presentation-trigger").click();
  await dialog.getByRole("button", { name: "恢复默认" }).click();
  await dialog.getByRole("button", { name: "完成" }).click();
  await expect(row.locator(".plugin-presentation-trigger")).toHaveAttribute("title", "设置，当前打开方式：页面");
});

test("page mode uses the main area and returns focus to the store", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStore(page);
  const cases = [
    { name: "微信多开", action: "管理", id: "cloudhub.wechat-multi", content: ".wechat-settings-dialog" },
    { name: "电脑信息", action: "查看", id: "cloudhub.hardware-info", content: ".hardware-info-dialog" },
    { name: "WSL 管理", action: "管理", id: "cloudhub.wsl-dashboard", content: ".wechat-settings-dialog" },
    { name: "指纹浏览器", action: "管理", id: "cloudhub.fingerprint-browser", content: ".browser-dialog" },
    { name: "Claude 管理", action: "管理", id: "cloudhub.claude-providers", content: ".claude-providers" },
    { name: "备忘录", action: "打开", id: "cloudhub.notes", content: ".notes-panel" },
  ];
  for (const item of cases) {
    const entry = page.locator(`[data-plugin-entry="${item.id}"]`);
    await page.locator(".software-store-page tbody tr", { hasText: item.name }).getByRole("button", { name: item.action, exact: true }).click();
    const host = page.getByRole("region", { name: `${item.name} 页面` });
    await expect(host).toBeVisible();
    await expect(host.locator(item.content)).toBeVisible();
    await expect(page.locator(".software-store-page")).toHaveCount(0);
    await expect(page.locator(".plugin-page-host")).toHaveCount(1);
    await expect(page.locator("body > .modal-backdrop")).toHaveCount(0);
    await expect(host.locator(".modal, .modal-form-layout, .dialog-header-actions")).toHaveCount(0);
    expect(await page.locator("#root").evaluate(element => (element as HTMLElement).inert)).toBe(false);
    await expect(host).toBeFocused();
    await page.keyboard.press("Tab");
    if (item.name === "电脑信息") {
      await expect(host.getByRole("button", { name: "刷新电脑信息" })).toBeFocused();
      await page.keyboard.press("Tab");
    }
    await expect(host.getByRole("button", { name: "返回软件商店" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(host).toBeVisible();
    await host.getByRole("button", { name: "返回软件商店" }).click();
    await expect(page.locator(".software-store-page")).toBeVisible();
    await expect(entry).toBeFocused();
  }
});

test("page mode keeps hardware Wi-Fi dialog open until its own Escape and restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStore(page);
  const entry = page.locator(".software-store-page tbody tr", { hasText: "电脑信息" }).getByRole("button", { name: "查看", exact: true });
  await entry.click();
  const host = page.getByRole("region", { name: "电脑信息 页面" });
  await host.getByRole("tab", { name: "网络" }).click();
  const trigger = host.getByRole("button", { name: "显示密码" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Example SSID 属性" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(host).toBeVisible();
  await expect(trigger).toBeFocused();
  await host.getByRole("button", { name: "返回软件商店" }).click();
  await expect(entry).toBeFocused();
});

test("page mode isolates browser Cookie dialog and restores its trigger", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStore(page);
  const entry = page.locator(".software-store-page tbody tr", { hasText: "指纹浏览器" }).getByRole("button", { name: "管理", exact: true });
  await entry.click();
  const host = page.getByRole("region", { name: "指纹浏览器 页面" });
  const trigger = host.getByRole("button", { name: "查看数据" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Cookie 原始数据" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "最大化弹层" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "关闭 Cookie 数据" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "最大化弹层" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(host).toBeVisible();
  await expect(trigger).toBeFocused();
  await host.getByRole("button", { name: "返回软件商店" }).click();
  await expect(entry).toBeFocused();
});

test("modal mode traps focus and Escape returns to the store", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStore(page);
  const row = page.locator(".software-store-page tbody tr", { hasText: "微信多开" });
  await row.locator(".plugin-presentation-trigger").click();
  const presentation = page.locator(".plugin-presentation-dialog");
  await presentation.getByRole("button", { name: /^弹层/ }).click();
  await presentation.getByRole("button", { name: "小弹窗" }).click();
  await presentation.getByRole("button", { name: "完成" }).click();
  const entry = row.getByRole("button", { name: "管理", exact: true });
  await entry.click();
  const dialog = page.getByRole("dialog", { name: "微信多开设置" });
  await expect(page.locator("body > .modal-backdrop").filter({ has: dialog })).toBeVisible();
  await expect(dialog).toHaveClass(/plugin-modal-small/);
  expect(await page.locator("#root").evaluate(element => (element as HTMLElement).inert)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(entry).toBeFocused();
});

test("modal mode still renders a backdrop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStore(page);
  const row = page.locator(".software-store-page tbody tr", { hasText: "电脑信息" });
  await row.locator(".plugin-presentation-trigger").click();
  const dialog = page.locator(".plugin-presentation-dialog");
  await dialog.getByRole("button", { name: /^弹层/ }).click();
  await dialog.getByRole("button", { name: "完成" }).click();

  await row.getByRole("button", { name: "查看" }).click();
  await expect(page.locator("body > .modal-backdrop .hardware-info-dialog")).toBeVisible();
});

for (const width of [375, 768, 1024, 1440]) {
  test(`presentation dialog stays within ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openStore(page);
    await page.locator(".software-store-page tbody tr", { hasText: "备忘录" }).locator(".plugin-presentation-trigger").click();
    const dialog = page.locator(".plugin-presentation-dialog");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    expect(await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
  });
}

const plugins = [
  { name: "微信多开", action: "管理", title: "微信多开设置", content: ".wechat-settings-dialog" },
  { name: "电脑信息", action: "查看", title: "电脑信息", content: ".hardware-info-dialog" },
  { name: "WSL 管理", action: "管理", title: "WSL 管理", content: ".wsl-tabs" },
  { name: "指纹浏览器", action: "管理", title: "指纹浏览器", content: ".browser-dialog" },
  { name: "Claude 管理", action: "管理", title: "Claude 管理", content: ".claude-providers" },
  { name: "备忘录", action: "打开", title: "备忘录", content: ".notes-panel" },
];

for (const plugin of plugins) {
  test(`${plugin.name} honors its modal setting, uses the shared shell and restores focus`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openStore(page);
    const row = page.locator(".software-store-page tbody tr", { hasText: plugin.name });
    await row.locator(".plugin-presentation-trigger").click();
    const settings = page.getByRole("dialog", { name: "打开方式", exact: true });
    await settings.getByRole("button", { name: /^弹层/ }).click();
    await settings.getByRole("button", { name: "小弹窗" }).click();
    await settings.getByRole("button", { name: "完成" }).click();
    const entry = row.getByRole("button", { name: plugin.action, exact: true });
    await entry.click();
    const dialog = page.getByRole("dialog", { name: plugin.title, exact: true });
    await expect(dialog).toHaveClass(/shared-content-dialog/);
    await expect(dialog.locator(plugin.content)).toBeVisible();
    await expect(dialog.locator(".modal, [role=dialog]")).toHaveCount(0);
    await expect(page.locator(".plugin-page-host")).toHaveCount(0);
    expect(await page.locator("#root").evaluate(element => (element as HTMLElement).inert)).toBe(true);
    await page.mouse.click(2, 2);
    await expect(dialog).toBeVisible();
    await dialog.focus();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "最大化弹层" })).toBeFocused();
    if (plugin.name === "WSL 管理") {
      const before = await dialog.boundingBox();
      const header = await dialog.locator(".modal-head h2").boundingBox();
      await page.mouse.move(header!.x + 10, header!.y + 10);
      await page.mouse.down();
      await page.mouse.move(header!.x + 70, header!.y + 40);
      await page.mouse.up();
      const after = await dialog.boundingBox();
      expect(after!.x - before!.x).toBeCloseTo(60, 0);
      expect(after!.y - before!.y).toBeCloseTo(30, 0);
    }
    await dialog.getByRole("button", { name: "最大化弹层" }).click();
    await expect(dialog).toHaveClass(/dialog-size-expanded/);
    await dialog.getByRole("button", { name: "缩小弹层" }).click();
    await expect(dialog).not.toHaveClass(/dialog-size-expanded/);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(entry).toBeFocused();
    expect(await page.locator("#root").evaluate(element => (element as HTMLElement).inert)).toBe(false);
  });
}

test("page navigation preserves store filters and leaves the sidebar reachable", async ({ page }) => {
  await openStore(page);
  await page.getByRole("searchbox", { name: "应用搜索" }).fill("WSL");
  await page.getByRole("button", { name: "已启用", exact: true }).click();
  await page.locator('[data-plugin-entry="cloudhub.wsl-dashboard"]').click();
  const host = page.getByRole("region", { name: "WSL 管理 页面" });
  await expect(host).toBeVisible();
  await host.getByRole("button", { name: "返回软件商店" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "系统设置", exact: true })).toBeFocused();
  await host.getByRole("button", { name: "返回软件商店" }).click();
  await expect(page.getByRole("searchbox", { name: "应用搜索" })).toHaveValue("WSL");
  await expect(page.getByRole("button", { name: "已启用", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-plugin-entry="cloudhub.wsl-dashboard"]').click();
  await page.getByRole("button", { name: "账号管理", exact: true }).first().click();
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await expect(page.locator(".software-store-page")).toBeVisible();
  await expect(page.locator(".plugin-page-host")).toHaveCount(0);
});

for (const name of ["备忘录", "Claude 管理"]) {
  test(`${name} nested editor closes one layer at a time`, async ({ page }) => {
    await openStore(page);
    const row = page.locator(".software-store-page tbody tr", { hasText: name });
    await row.locator(".plugin-presentation-trigger").click();
    const settings = page.locator(".plugin-presentation-dialog");
    await settings.getByRole("button", { name: /^弹层/ }).click();
    await settings.getByRole("button", { name: "完成" }).click();
    await row.getByRole("button", { name: name === "备忘录" ? "打开" : "管理", exact: true }).click();
    const parent = page.getByRole("dialog", { name, exact: true });
    const trigger = parent.getByRole("button", { name: name === "备忘录" ? "新建备忘录" : "添加供应商", exact: true }).first();
    await trigger.click();
    const editor = page.getByRole("dialog", { name: name === "备忘录" ? "新建备忘录" : "添加供应商", exact: true });
    await expect(editor).toBeVisible();
    expect(await parent.evaluate(element => !!element.closest("[inert]"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(parent).toBeVisible();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(parent).toHaveCount(0);
    expect(await page.locator("#root").evaluate(element => (element as HTMLElement).inert)).toBe(false);
  });
}

for (const width of [375, 768, 1024, 1440]) {
  test(`all plugin pages and small dialogs fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openStore(page);
    for (const plugin of plugins) {
      const row = page.locator(".software-store-page tbody tr", { hasText: plugin.name });
      await row.getByRole("button", { name: plugin.action, exact: true }).click();
      const host = page.getByRole("region", { name: `${plugin.name} 页面` });
      await expect(host.locator(plugin.content)).toBeVisible();
      expect(await host.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      if (plugin.name === "WSL 管理" && [375, 1440].includes(width)) await page.screenshot({ path: `test-results/plugin-page-${width}.png` });
      await host.getByRole("button", { name: "返回软件商店" }).click();
      await row.locator(".plugin-presentation-trigger").click();
      const settings = page.locator(".plugin-presentation-dialog");
      await settings.getByRole("button", { name: /^弹层/ }).click();
      await settings.getByRole("button", { name: "小弹窗" }).click();
      await settings.getByRole("button", { name: "完成" }).click();
      await row.getByRole("button", { name: plugin.action, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: plugin.title, exact: true });
      await expect(dialog.locator(plugin.content)).toBeVisible();
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      if (plugin.name === "WSL 管理" && [375, 1440].includes(width)) await page.screenshot({ path: `test-results/plugin-modal-${width}.png` });
      await page.keyboard.press("Escape");
      await row.locator(".plugin-presentation-trigger").click();
      await settings.getByRole("button", { name: "恢复默认" }).click();
      await settings.getByRole("button", { name: "完成" }).click();
    }
  });
}
