import { expect, test } from "@playwright/test";

test("PC 主导航与商店应用逐页检查浅深色布局", async ({ page }, info) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = [];
    if (path === "/api/member") json = null;
    if (path === "/api/preferences") json = {};
    if (path === "/api/notes") json = { notes: [], groups: [], reminders: [], trashed: [] };
    if (path === "/api/authenticator") json = route.request().postDataJSON()?.op === "status" ? { initialized: true, unlocked: true, passwordRequired: false } : [];
    if (path === "/api/claude-providers") json = { providers: [], currentId: null, settingsPath: "", settingsExists: false, backups: [] };
    return route.fulfill({ json });
  });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  await expect(nav.getByRole("button", { name: "首页", exact: true })).toBeVisible();
  const names = await nav.locator('button[aria-label]:not([aria-expanded])').evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")!));
  for (const [index, name] of names.entries()) {
    const entry = nav.getByRole("button", { name, exact: true });
    if (!await entry.isVisible() || !await entry.isEnabled()) continue;
    await entry.click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: info.outputPath(`nav-${index}.png`), animations: "disabled" });
  }
  await nav.getByRole("button", { name: "软件商店", exact: true }).click();
  await page.getByRole("region", { name: "软件列表" }).getByLabel("每页条数", { exact: true }).selectOption("50");
  const ids = await page.locator("[data-plugin-entry]").evaluateAll(nodes => nodes.filter(node => !(node as HTMLButtonElement).disabled).map(node => node.getAttribute("data-plugin-entry")!));
  expect(ids.length).toBe(20);
  for (const id of ids) {
    await page.locator(`[data-plugin-entry="${id}"]`).click();
    const host = page.locator(".plugin-page-host");
    await expect(host).toBeVisible();
    await host.getByText(/^正在加载/).waitFor({ state: "hidden" });
    for (const light of [true, false]) {
      await page.evaluate(value => { document.body.classList.toggle("theme-light", value); document.querySelector(".app-shell")?.classList.toggle("theme-light", value); }, light);
      for (const width of [1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await host.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
      await page.screenshot({ path: info.outputPath(`${id}-${light ? "light" : "dark"}.png`), animations: "disabled" });
    }
    await host.getByRole("button", { name: "返回软件商店", exact: true }).click();
  }
  expect(errors).toEqual([]);
});
