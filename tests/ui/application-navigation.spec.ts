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
  await expect(page.getByLabel("左侧菜单显示备忘录", { exact: true })).toBeEnabled();
}
const row = (page: Page, name: string) => page.locator(".store-table tbody tr").filter({ has: page.locator(".store-app-name strong", { hasText: name }) });
const nav = (page: Page) => page.locator("#app-main-navigation");

test("catalog contains all seven menu apps and opens the five existing feature pages", async ({ page }) => {
  await openStore(page);
  await page.getByRole("region", { name: "软件列表", exact: true }).getByLabel("每页条数").selectOption("20");
  await expect(page.locator(".store-table tbody tr")).toHaveCount(14);
  await expect(nav(page).locator("[data-application-id]")).toHaveText(["云效流水线", "HTTPS 证书", "身份验证器", "Claude 管理", "Codex 管理", "内网穿透", "备忘录"]);
  for (const name of ["云效流水线", "HTTPS 证书", "身份验证器", "Codex 管理", "内网穿透"]) {
    await row(page, name).getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.locator(".software-store-page")).toHaveCount(0);
    await expect(nav(page).getByRole("button", { name, exact: true })).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  }
});

test("hiding a menu keeps its store entry usable and persists across reload", async ({ page }) => {
  await openStore(page);
  await page.getByLabel("左侧菜单显示备忘录", { exact: true }).uncheck();
  await expect(nav(page).getByRole("button", { name: "备忘录", exact: true })).toHaveCount(0);
  await row(page, "备忘录").getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.locator(".notes-panel")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await expect(page.getByLabel("左侧菜单显示备忘录", { exact: true })).not.toBeChecked();
  await expect(nav(page).getByRole("button", { name: "备忘录", exact: true })).toHaveCount(0);
});

test("order is shared by the store and sidebar with stable ties and restart persistence", async ({ page }) => {
  await openStore(page);
  await expect(page.locator(".store-order-input")).toHaveCount(0);
  await page.getByRole("button", { name: "编辑备忘录排序号", exact: true }).click();
  await expect(page.locator(".store-order-input")).toHaveCount(0);
  await page.getByRole("button", { name: "编辑备忘录排序号", exact: true }).dblclick();
  const input = page.getByLabel("备忘录排序号", { exact: true });
  await expect(input).toBeFocused();
  await input.fill("10");
  await input.press("Enter");
  await expect(page.locator(".store-table tbody tr .store-app-name strong").nth(1)).toHaveText("备忘录");
  await expect(nav(page).locator("[data-application-id]").nth(1)).toHaveText("备忘录");
  await page.reload();
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "编辑备忘录排序号", exact: true })).toHaveText("10");
  await expect(nav(page).locator("[data-application-id]").nth(1)).toHaveText("备忘录");
  await page.getByRole("button", { name: "编辑备忘录排序号", exact: true }).dblclick();
  await page.getByLabel("备忘录排序号", { exact: true }).fill("-1");
  await page.getByLabel("备忘录排序号", { exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "编辑备忘录排序号", exact: true })).toHaveText("10");
  await page.getByRole("button", { name: "编辑备忘录排序号", exact: true }).press("F2");
  await input.fill("3");
  await input.press("Escape");
  await expect(page.getByRole("button", { name: "编辑备忘录排序号", exact: true })).toHaveText("10");
  await expect(page.locator(".store-order-input")).toHaveCount(0);
  await page.getByRole("button", { name: "编辑备忘录排序号", exact: true }).dblclick();
  await input.fill("5");
  await page.getByRole("heading", { name: "软件商店", exact: true }).click();
  await expect(page.getByRole("button", { name: "编辑备忘录排序号", exact: true })).toHaveText("5");
  await expect(nav(page).locator("[data-application-id]").first()).toHaveText("备忘录");
});

test("optional software gets a working sidebar entry independently of enablement", async ({ page }) => {
  await openStore(page);
  await page.getByLabel("左侧菜单显示WSL 管理", { exact: true }).check();
  await expect(nav(page).getByRole("button", { name: "WSL 管理", exact: true })).toBeVisible();
  await nav(page).getByRole("button", { name: "WSL 管理", exact: true }).click();
  await expect(page.getByRole("region", { name: "WSL 管理 页面", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回软件商店", exact: true }).click();
  await expect(page.locator(".store-table")).toBeVisible();
  await nav(page).getByRole("button", { name: "WSL 管理", exact: true }).click();
  await expect(page.getByRole("region", { name: "WSL 管理 页面", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await expect(page.locator(".store-table")).toBeVisible();
  await row(page, "微信多开").getByLabel("启用微信多开", { exact: true }).uncheck();
  await page.getByRole("button", { name: "已启用", exact: true }).click();
  await expect(row(page, "微信多开")).toHaveCount(0);
  await expect(row(page, "Codex 管理")).toHaveCount(1);
});

test("save failure preserves confirmed navigation and read failure can be retried", async ({ page }) => {
  await openStore(page);
  await page.evaluate(() => { (window as any).__saveFails = true; });
  await page.getByLabel("左侧菜单显示备忘录", { exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("菜单设置保存失败");
  await expect(nav(page).getByRole("button", { name: "备忘录", exact: true })).toBeVisible();
  await expect(page.getByLabel("左侧菜单显示备忘录", { exact: true })).toBeChecked();
  await page.evaluate(() => localStorage.setItem("fixture.load-failure", "1"));
  await page.reload();
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await expect(page.getByLabel("左侧菜单显示备忘录", { exact: true })).toBeDisabled();
  await page.evaluate(() => localStorage.removeItem("fixture.load-failure"));
  await page.getByRole("button", { name: "重试读取" }).click();
  await expect(page.getByLabel("左侧菜单显示备忘录", { exact: true })).toBeEnabled();
});

test("browser preview stores only UI preferences and tolerates damaged values", async ({ page }) => {
  await page.addInitScript(({ key }) => localStorage.setItem(key, '{"cloudhub.notes":{"order":-3,"sidebar":"false"}}'), { key });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "编辑备忘录排序号", exact: true })).toHaveText("70");
  await expect(page.getByLabel("左侧菜单显示备忘录", { exact: true })).toBeChecked();
  await page.getByLabel("左侧菜单显示备忘录", { exact: true }).uncheck();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!)["cloudhub.notes"], key)).toEqual({ order: 70, sidebar: false });
});

test("desktop preferences override an outdated browser cache", async ({ page }) => {
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({ "cloudhub.notes": { order: 0, sidebar: true } }));
    localStorage.setItem("fixture.preferences", JSON.stringify({ [key]: JSON.stringify({ "cloudhub.notes": { order: 95, sidebar: false } }) }));
  }, { key });
  await openStore(page);
  await expect(page.getByRole("button", { name: "编辑备忘录排序号", exact: true })).toHaveText("95");
  await expect(nav(page).getByRole("button", { name: "备忘录", exact: true })).toHaveCount(0);
});

for (const width of [768, 1024, 1440]) {
  test(`catalog navigation controls stay within ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openStore(page);
    expect(await page.locator(".store-catalog").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(row(page, "备忘录").getByLabel("左侧菜单显示备忘录", { exact: true })).toBeVisible();
    if (width === 1440) await page.locator(".software-store-page").screenshot({ path: "test-results/application-navigation-desktop.png" });
  });
}
