import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.addInitScript(() => {
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    const names = ["Ubuntu", "Debian", "Alpine"];
    const kernel = { version: "155.0.8059.84", installed: true, phase: "ready", downloaded: 0, total: 0 };
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string, args: any) => {
        if (command === "list_client_preferences") return JSON.parse(localStorage.getItem("sort-fixture") || "{}");
        if (command === "save_client_preference") {
          if ((window as any).failSort) throw new Error("write failed");
          const values = JSON.parse(localStorage.getItem("sort-fixture") || "{}");
          values[args.key] = args.value; localStorage.setItem("sort-fixture", JSON.stringify(values)); return;
        }
        if (command === "wsl_dashboard_list") return names.map(name => ({ name, state: "Stopped", version: 2, isDefault: false, installedAt: null, lastStartedAt: null, remark: "" }));
        if (command === "wsl_dashboard_runtime_info") return { currentVersion: "3.0.5.0", minimumSupportedVersion: "2.6.3", compatible: true, components: [] };
        if (command === "wsl_dashboard_settings_get") return { defaultInstallLocation: "" };
        if (command === "browser_snapshot") return { supported: true, kernel, kernels: [kernel], environments: names.map((name, i) => ({ id: String(i), config: { name, group: i === 1 ? "hidden" : "visible", tags: "", note: "", proxy: { kind: "direct" }, kernelVersion: kernel.version }, deletedAt: null, running: false, lastOpenedAt: null })) };
        if (command === "wechat_plugin_status") return { supported: true, detectedPath: null, runningProcesses: 0 };
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
}
async function open(page: Page, name: string) {
  await page.getByRole("searchbox", { name: "应用搜索" }).fill(name);
  await page.locator(".store-table tbody tr").getByRole("button", { name: "管理", exact: true }).click();
}
const order = (page: Page, attr: string) => page.locator(`[${attr}]`).evaluateAll((rows, key) => rows.map(row => row.getAttribute(key)), attr);
async function drag(page: Page, attr: string) {
  const rows = page.locator(`[${attr}]`);
  const from = (await rows.first().locator(".list-sort-handle").boundingBox())!;
  const to = (await rows.nth(2).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}
for (const target of [{ name: "WSL 管理", label: "发行版", attr: "data-wsl-sort-id", initial: ["Ubuntu", "Debian", "Alpine"] }, { name: "指纹浏览器", label: "环境", attr: "data-browser-sort-id", initial: ["0", "1", "2"] }]) {
  test(`${target.name}拖拽、键盘、失败回滚与重载持久化`, async ({ page }) => {
    await fixture(page); await open(page, target.name);
    await page.getByRole("button", { name: `${target.label}排序`, exact: true }).click();
    await drag(page, target.attr);
    await expect(page.locator("[data-sortable-settling]")).toHaveCount(0);
    if (target.attr === "data-wsl-sort-id") {
      const title = (await page.locator(".wsl-distro-title").first().boundingBox())!;
      const tools = (await page.locator(".wsl-row-tools").first().boundingBox())!;
      expect(tools.x).toBeGreaterThan(title.x + title.width - 1);
      expect(Math.abs(tools.y + tools.height / 2 - title.y - title.height / 2)).toBeLessThan(2);
    }
    await page.screenshot({ path: `test-results/plugin-sort-${target.label}.png` });
    await expect.poll(() => order(page, target.attr)).toEqual([target.initial[1], target.initial[2], target.initial[0]]);
    await expect(page.locator(".list-sort-handle").first()).toBeEnabled();
    await page.locator(".list-sort-handle").first().press("ArrowDown");
    await expect.poll(() => order(page, target.attr)).toEqual([target.initial[2], target.initial[1], target.initial[0]]);
    await expect(page.locator(".list-sort-handle").first()).toBeEnabled();
    await page.evaluate(() => { (window as any).failSort = true; });
    await page.locator(".list-sort-handle").first().press("ArrowDown");
    await expect(page.getByRole("alert").filter({ hasText: "排序保存失败，已恢复原顺序，请重试。" })).toBeVisible();
    expect(await order(page, target.attr)).toEqual([target.initial[2], target.initial[1], target.initial[0]]);
    await page.reload();
    await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
    await open(page, target.name);
    await expect.poll(() => order(page, target.attr)).toEqual([target.initial[2], target.initial[1], target.initial[0]]);
  });
}
test("商店分页排序保存完整列表，重新进入保留顺序", async ({ page }) => {
  await fixture(page);
  const initial = await order(page, "data-store-sort-id");
  await page.getByRole("button", { name: "应用排序", exact: true }).click();
  await drag(page, "data-store-sort-id");
  await expect.poll(async () => (await order(page, "data-store-sort-id")).slice(0, 3)).toEqual([initial[1], initial[2], initial[0]]);
  await page.reload();
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await expect.poll(async () => (await order(page, "data-store-sort-id")).slice(0, 3)).toEqual([initial[1], initial[2], initial[0]]);
});

test("环境分组筛选排序保留隐藏环境，单项结果仍可退出排序", async ({ page }) => {
  await fixture(page); await open(page, "指纹浏览器");
  await page.getByRole("button", { name: "环境排序", exact: true }).click();
  await page.getByLabel("筛选分组", { exact: true }).selectOption("visible");
  await page.locator(".list-sort-handle").first().press("ArrowDown");
  await expect.poll(() => order(page, "data-browser-sort-id")).toEqual(["2", "0"]);
  await page.getByLabel("筛选分组", { exact: true }).selectOption("");
  await expect.poll(() => order(page, "data-browser-sort-id")).toEqual(["1", "2", "0"]);
  await page.getByLabel("搜索浏览器环境", { exact: true }).fill("Alpine");
  await page.getByRole("button", { name: "退出环境排序", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "选择 Alpine", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "环境排序", exact: true })).toBeDisabled();
});
