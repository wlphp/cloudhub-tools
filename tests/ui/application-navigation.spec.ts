import { expect, test, type Page } from "@playwright/test";

const key = "cloudhub.application-navigation";
async function openStore(page: Page) {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args?: any) => {
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") {
          if (localStorage.getItem("fixture.load-failure")) throw new Error("unavailable");
          return JSON.parse(localStorage.getItem("fixture.preferences") ?? "{}");
        }
        if (command === "save_client_preference") {
          if ((window as any).__saveFails) throw new Error("unavailable");
          const values = JSON.parse(localStorage.getItem("fixture.preferences") ?? "{}");
          values[args.key] = args.value;
          localStorage.setItem("fixture.preferences", JSON.stringify(values));
          return null;
        }
        if (command === "wechat_plugin_status") return { supported: true, detectedPath: null, runningProcesses: 0 };
        if (command === "ai_list_profiles") return [];
        if (command === "list_wsl_distributions") return [];
        if (command === "wsl_settings") return {};
        if (command === "notes_snapshot") return { notes: [], trashed: [], groups: [], reminders: [] };
        if (command === "codex_get_state" || command === "codex_state") return { accounts: [], cliAvailable: false, desktopAvailable: false, profileHome: "", currentAccountId: null, canRestore: false };
        if (command === "codex_gateway_state") return { running: false, address: null, accountIds: [], completed: 0, failed: 0, active: 0, settings: { loggingEnabled: false, strategy: "quota_first", cooldownSeconds: 60 }, configuredPort: 0 };
        if (command === "codex_remote_logs") return { enabled: false, logs: [] };
        if (command === "codex_tunnel_state") return {};
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await page.getByRole("region", { name: "软件列表", exact: true }).getByLabel("每页条数").selectOption("20");
  await expect(row(page, "备忘录").getByRole("button", { name: "设置", exact: true })).toBeVisible();
}
const row = (page: Page, name: string) => page.locator(".store-table tbody tr").filter({ has: page.locator(".store-app-name strong", { hasText: name }) });
async function openSettings(page: Page, appName: string) {
  await row(page, appName).getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "应用设置", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function expandRow(page: Page, name: string) {
  const details = row(page, name).getByRole("button", { name: "展开详情" });
  if (await details.isVisible()) await details.click();
}
const nav = (page: Page) => page.locator("#app-main-navigation");

test("catalog contains menu apps and opens the five store-managed feature pages", async ({ page }) => {
  await openStore(page);
  await page.getByRole("region", { name: "软件列表", exact: true }).getByLabel("每页条数").selectOption("20");
  await expect(page.locator(".store-table tbody tr")).toHaveCount(19);
  await expect(row(page, "云盘挂载")).toHaveCount(1);
  await expect(nav(page).locator("[data-application-id]")).toHaveText(["云效流水线", "HTTPS 证书", "身份验证器", "Claude 管理", "Codex 管理", "内网穿透", "备忘录", "指纹浏览器"]);
  for (const name of ["云效流水线", "HTTPS 证书", "身份验证器", "Codex 管理", "内网穿透"]) {
    await expandRow(page, name);
    await row(page, name).getByRole("button", { name: "管理", exact: true }).click();
    await expect(page.locator(".software-store-page")).toHaveCount(0);
    const pluginPage = page.locator(".plugin-page-host");
    await expect(pluginPage).toContainText(name);
    await pluginPage.getByRole("button", { name: "返回软件商店" }).click();
    await expect(page.locator(".software-store-page")).toBeVisible();
  }
});

test("hiding a home shortcut keeps its store entry usable and persists across reload", async ({ page }) => {
  await openStore(page);
  let settings = await openSettings(page, "备忘录");
  await settings.getByLabel("在首页显示应用", { exact: true }).uncheck();
  await settings.getByRole("button", { name: "完成" }).click();
  await nav(page).getByRole("button", { name: "首页", exact: true }).click();
  await expect(page.getByRole("button", { name: "打开备忘录", exact: true })).toHaveCount(0);
  await nav(page).getByRole("button", { name: "软件商店", exact: true }).click();
  await row(page, "备忘录").getByRole("button", { name: "管理", exact: true }).click();
  await expect(page.locator(".notes-panel")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  settings = await openSettings(page, "备忘录");
  await expect(settings.getByLabel("在首页显示应用", { exact: true })).not.toBeChecked();
  await settings.getByRole("button", { name: "完成" }).click();
  await nav(page).getByRole("button", { name: "首页", exact: true }).click();
  await expect(page.getByRole("button", { name: "打开备忘录", exact: true })).toHaveCount(0);
});

test("order is shared by the store and sidebar with stable ties and restart persistence", async ({ page }) => {
  await openStore(page);
  let settings = await openSettings(page, "备忘录");
  const position = settings.getByLabel("应用列表序号", { exact: true });
  await position.selectOption("10");
  await settings.getByRole("button", { name: "完成" }).click();
  await expect(row(page, "备忘录").locator(".store-serial-number")).toHaveText("10");
  await expect(nav(page).getByRole("button", { name: "备忘录", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  settings = await openSettings(page, "备忘录");
  await expect(settings.getByLabel("应用列表序号", { exact: true })).toHaveValue("10");
  await settings.getByRole("button", { name: "完成" }).click();
  await expect(nav(page).getByRole("button", { name: "备忘录", exact: true })).toBeVisible();
});

test("optional software can be shown on the home page independently of enablement", async ({ page }) => {
  await openStore(page);
  const settings = await openSettings(page, "WSL 管理");
  await settings.getByLabel("在首页显示应用", { exact: true }).check();
  await settings.getByRole("button", { name: "完成" }).click();
  await nav(page).getByRole("button", { name: "首页", exact: true }).click();
  await expect(page.getByRole("button", { name: "打开WSL 管理", exact: true })).toBeVisible();
  await nav(page).getByRole("button", { name: "软件商店", exact: true }).click();
  await expect(page.locator(".store-table")).toBeVisible();
  await expect(row(page, "微信多开").getByRole("button", { name: "设置", exact: true })).toBeVisible();
});

test("save failure preserves confirmed navigation and read failure can be retried", async ({ page }) => {
  await openStore(page);
  await page.evaluate(() => { (window as any).__saveFails = true; });
  let settings = await openSettings(page, "备忘录");
  await settings.getByLabel("在首页显示应用", { exact: true }).click();
  await expect(page.locator(".store-settings-notification")).toContainText("菜单设置保存失败");
  await expect(nav(page).getByRole("button", { name: "备忘录", exact: true })).toBeVisible();
  await expect(settings.getByLabel("在首页显示应用", { exact: true })).toBeChecked();
  await settings.getByRole("button", { name: "完成" }).click();
  await page.evaluate(() => localStorage.setItem("fixture.load-failure", "1"));
  await page.reload();
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  settings = await openSettings(page, "备忘录");
  await expect(settings.getByLabel("在首页显示应用", { exact: true })).toBeDisabled();
  await settings.getByRole("button", { name: "完成" }).click();
  await page.evaluate(() => localStorage.removeItem("fixture.load-failure"));
  await page.getByRole("button", { name: "重试读取" }).click();
  settings = await openSettings(page, "备忘录");
  await expect(settings.getByLabel("在首页显示应用", { exact: true })).toBeEnabled();
  await settings.getByRole("button", { name: "完成" }).click();
});

test("browser preview stores only UI preferences and tolerates damaged values", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ key }) => localStorage.setItem(key, '{"cloudhub.notes":{"order":-3,"sidebar":"false"}}'), { key });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  const settings = await openSettings(page, "备忘录");
  await expect(settings.getByLabel("应用列表序号", { exact: true })).toHaveValue("7");
  const home = settings.getByLabel("在首页显示应用", { exact: true });
  await expect(home).toBeChecked();
  await home.uncheck();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!)["cloudhub.notes"], key)).toEqual({ order: 7, home: false, sidebar: true });
});

test("desktop preferences override an outdated browser cache", async ({ page }) => {
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({ "cloudhub.notes": { order: 0, sidebar: true } }));
    localStorage.setItem("fixture.preferences", JSON.stringify({ [key]: JSON.stringify({ "cloudhub.notes": { order: 95, sidebar: false } }) }));
  }, { key });
  await openStore(page);
  const settings = await openSettings(page, "备忘录");
  await expect(settings.getByLabel("应用列表序号", { exact: true })).toHaveValue("19");
  await expect(nav(page).getByRole("button", { name: "备忘录", exact: true })).toHaveCount(0);
});

for (const width of [768, 1024, 1440]) {
  test(`catalog navigation controls stay within ${width}px`, async ({ page }) => {
    await openStore(page);
    await page.setViewportSize({ width, height: 900 });
    expect(await page.locator(".store-catalog").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const notesRow = row(page, "备忘录");
    await expect(notesRow.getByRole("button", { name: "设置", exact: true })).toBeVisible();
    const settings = await openSettings(page, "备忘录");
    await expect(settings.getByLabel("在首页显示应用", { exact: true })).toBeVisible();
    if (width === 1440) await page.locator(".software-store-page").screenshot({ path: "test-results/application-navigation-desktop.png" });
  });
}
