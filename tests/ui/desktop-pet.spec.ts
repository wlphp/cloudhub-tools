import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, enabled = true) {
  await page.addInitScript(({ enabled }) => {
    let settings = { enabled, monitoring: false, panels: false, certificates: true, servers: true, size: 160, roam: "still", activity: 0, sound: false, reducedMotion: false, quiet: false, intervalSeconds: 300, expiryDays: 30, cpuThreshold: 90, diskThreshold: 90, keepInTray: false };
    let id = 0;
    const callbacks: Record<number, (v: unknown) => void> = {};
    const events: Record<string, number[]> = {};
    (window as any).petCalls = [];
    (window as any).petEvent = (event: string, payload: unknown) => (events[event] || []).forEach(n => callbacks[n]?.({ event, payload }));
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "desktop-pet" }, currentWebview: { label: "desktop-pet" } },
      transformCallback: (cb: (v: unknown) => void) => { callbacks[++id] = cb; return id; },
      unregisterCallback: (n: number) => { delete callbacks[n]; },
      invoke: async (command: string, args: any) => {
        if (command.startsWith("pet_")) (window as any).petCalls.push({ command, args });
        if (command === "plugin:event|listen") { (events[args.event] ||= []).push(args.handler); return args.handler; }
        if (command === "pet_settings") return settings;
        if (command === "list_panel_connections") return [{id:7,name:"测试面板",panel_url:"https://example.test:8888",status:"unknown",summary:{},sort_order:0,api_key_saved:false,allow_insecure_tls:false,last_checked_at:null,last_error:null}];
        if (command === "pet_notice") return { key: "cert:1", title: "证书即将到期", detail: "剩余 7 天", section: "certificates", active: true, severity: "critical" };
        if (command === "pet_snapshot") return { alerts: [], checkedAt: 0, lastError: null };
        if (command === "pet_save_settings") { if ((window as any).failPetSave) throw { kind: "platform-error", code: "unknown", message: "设置保存失败", retryable: false }; settings = args.settings; return; }
        if (command === "list_client_preferences") return {};
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        return [];
      },
    };
  }, { enabled });
}

test("pet has transparent canvas, explicit menu close and water interaction", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 });
  await fixture(page); await page.goto("/?desktopPet=1");
  const avatar = page.getByRole("button", { name: /^羊驼：/ });
  await expect(avatar).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  expect(await page.locator(".pet-stage").evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await avatar.click({ button: "right" });
  const menu = page.getByRole("dialog", { name: "羊驼快捷菜单" });
  await expect(menu).toBeVisible();
  await expect(menu.locator(".pet-menu button")).toHaveCount(7);
  expect(await menu.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
  await page.screenshot({ path: "test-results/alpaca-quick-menu.png", animations: "disabled", omitBackground: true });
  await page.mouse.click(350, 20);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "喷水玩一下" }).click();
  await expect(page.locator(".pet-water")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).petCalls.some((c: any) => c.command === "pet_regions"))).toBe(true);
  await page.screenshot({ path: "test-results/alpaca-spray.png", animations: "disabled", omitBackground: true });
});

test("alerts interrupt play and offer snooze and real section navigation", async ({ page }) => {
  await fixture(page); await page.goto("/?desktopPet=1");
  await expect(page.getByRole("button", { name: /^羊驼：/ })).toBeVisible();
  await page.evaluate(() => (window as any).petEvent("pet-notification", { key: "cert:1", title: "example.test 证书即将到期", detail: "剩余 7 天", section: "certificates", severity: "critical", active: true, updatedAt: 100, firstSeen: 100, snoozedUntil: 0, notifiedAt: 0, occurrences: 1 }));
  await expect(page.getByText("example.test 证书即将到期")).toBeVisible();
  await page.getByRole("button", { name: "查看详情", exact: true }).click();
  expect(await page.evaluate(() => (window as any).petCalls.find((c: any) => c.command === "pet_open").args.section)).toBe("certificates");
  expect(await page.evaluate(() => (window as any).petCalls.find((c: any) => c.command === "pet_open").args.key)).toBe("cert:1");
  await page.getByRole("button", { name: "一小时后提醒" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).petCalls.find((c: any) => c.command === "pet_snooze").args)).toEqual({ key: "cert:1", minutes: 60 });
});

test("system reduced motion and hidden pets stop frame advancement", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await fixture(page); await page.goto("/?desktopPet=1");
  const avatar = page.getByRole("button", { name: /^羊驼：/ }); await expect(avatar).toBeVisible();
  await avatar.click({ button: "right" }); await page.getByRole("button", { name: "喷水玩一下" }).click();
  await expect(page.locator(".pet-water")).toHaveCount(0);
  await page.evaluate(() => (window as any).petEvent("pet-visibility", false));
  await expect(page.locator(".pet-sprite")).toHaveClass(/pet-pose-idle/);
  const initial = await page.locator(".pet-sprite").getAttribute("style");
  await page.waitForTimeout(700);
  expect(await page.locator(".pet-sprite").getAttribute("style")).toBe(initial);
});

test("browser settings explicitly disable native companion functionality", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  await page.goto("/"); await page.getByRole("button", { name: "系统设置", exact: true }).click();
  const expand = page.locator(".pet-settings-section").getByRole("button", { name: "展开" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expand.click();
  await expect(page.getByText("桌宠、后台巡检和托盘驻留仅支持桌面应用，浏览器预览不可用。")).toBeVisible();
  await expect(page.getByLabel("启用羊驼桌宠")).toHaveCount(0);
});

test("settings keep monitoring independent and do not accept a failed enable", async ({ page }) => {
  await fixture(page, false); await page.goto("/");
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  const petSection = page.locator(".pet-settings-section");
  const expand = petSection.getByRole("button", { name: "展开" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(petSection.getByRole("checkbox")).toHaveCount(0);
  await expect(petSection.getByText("桌宠 已关闭")).toBeVisible();
  await expect(petSection.getByText("运维预警 已关闭")).toBeVisible();
  await page.screenshot({ path: "test-results/alpaca-settings-collapsed.png" });
  await expand.click();
  const pet=page.getByRole("checkbox",{name:/启用羊驼桌宠/});
  const monitoring=page.getByRole("checkbox",{name:/启用运维预警/});
  await expect(pet).not.toBeChecked(); await expect(monitoring).not.toBeChecked();
  await expect(page.locator(".pet-settings-disclosure[open]")).toHaveCount(0);
  await expect(page.locator(".pet-control-card")).toHaveCount(2);
  await monitoring.check(); await expect(monitoring).toBeChecked(); await expect(pet).not.toBeChecked();
  await expect(petSection.getByText("运维预警 已启用")).toBeVisible();
  await page.evaluate(() => { (window as any).failPetSave=true; });
  await pet.click(); await expect(page.locator(".pet-settings-section [role=alert]")).toBeVisible(); await expect(pet).not.toBeChecked();
  await page.getByRole("button",{name:/提醒记录（/}).click();
  await expect(page.getByRole("dialog",{name:"运维提醒记录"})).toBeVisible();
  await page.mouse.click(5,5); await expect(page.getByRole("dialog",{name:"运维提醒记录"})).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog",{name:"运维提醒记录"})).toHaveCount(0);
});

test("desktop notification remains usable when the companion is disabled", async ({ page }) => {
  await fixture(page,false); await page.setViewportSize({width:360,height:240}); await page.goto("/?desktopPetAlerts=1");
  await expect(page.getByRole("dialog",{name:"CloudHub 运维提醒"})).toBeVisible();
  await expect(page.getByText("证书即将到期",{exact:true})).toBeVisible();
  await expect(page.locator(".pet-avatar")).toHaveCount(0);
  await page.getByRole("button",{name:"一小时后提醒"}).click();
  expect(await page.evaluate(() => (window as any).petCalls.filter((c:any) => ["pet_snooze","pet_dismiss"].includes(c.command)).map((c:any)=>c.command))).toEqual(["pet_snooze","pet_dismiss"]);
});

test("main window routes a panel alert to the matching panel filter", async ({page})=>{
  await fixture(page,false); await page.goto("/");
  await page.getByRole("button",{name:"系统设置",exact:true}).click();
  await page.locator(".pet-settings-section").getByRole("button",{name:"展开"}).click();
  await expect(page.getByRole("checkbox",{name:/启用羊驼桌宠/})).toBeVisible();
  await page.evaluate(()=> (window as any).petEvent("pet-open-section",{section:"panels",key:"panel:7:service:web"}));
  await expect(page.getByRole("textbox",{name:"搜索面板",exact:true})).toHaveValue("测试面板");
});
