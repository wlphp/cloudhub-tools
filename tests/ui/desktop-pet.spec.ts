import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const fishFrames: number[][] = JSON.parse(readFileSync(new URL("../../src/features/desktop-pet/assets/fish-frames.json", import.meta.url), "utf8"));
const penguinFrames: number[][] = JSON.parse(readFileSync(new URL("../../src/features/desktop-pet/assets/penguin-frames.json", import.meta.url), "utf8"));
const dogFrames: number[][] = JSON.parse(readFileSync(new URL("../../src/features/desktop-pet/assets/dog-frames.json", import.meta.url), "utf8"));
const defaultPetLife = { enabled: false, province: "", city: "", weather: false, schedule: true, workStart: "09:00", lunchStart: "12:00", lunchEnd: "13:30", workEnd: "18:00", leaveBefore: 10, ignoreHolidays: true, restDates: [] as string[], workDates: [] as string[], water: true, waterMinutes: 60, waterRoam: true, stretch: false, stretchMinutes: 90 };

async function lifeNotice(page: Page, kind = "water", level = 0) {
  await expect.poll(() => page.evaluate(() => (window as any).petCalls.some((c: any) => c.command === "pet_settings"))).toBe(true);
  await page.evaluate(async ({ kind, level }) => {
    const bridge = (window as any).__TAURI_INTERNALS__;
    const settings = await bridge.invoke("pet_settings", {});
    const next = { ...settings, life: { ...settings.life, enabled: true, weather: true, province: "河北省", city: "保定" } };
    await bridge.invoke("pet_save_settings", { settings: next });
    (window as any).petEvent("pet-settings-changed", next);
    const now = Math.floor(Date.now() / 1000);
    (window as any).petEvent("pet-life-changed", { notices: [{ id: `test-${kind}`, kind, title: kind === "weather" ? "河北省保定市暴雨红色预警" : "主人，该喝水啦！", detail: "这是宠物的生活提醒。", createdAt: now, dueAt: now, expiresAt: now + 900, acknowledged: false, level, url: kind === "weather" ? "https://www.nmc.cn/publish/alarm/130600.html" : null }], weatherCheckedAt: now, weatherAttemptAt: now, weatherError: null, region: "河北省保定", calendarYear: 2026, calendarSupported: true });
  }, { kind, level });
}

test("life settings save region schedule and multiline calendar overrides atomically", async ({ page }) => {
  await fixture(page); await page.goto("/");
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  const section = page.getByRole("region", { name: "桌宠与运维预警" });
  await section.getByRole("button", { name: "展开", exact: true }).click();
  await section.locator("summary").filter({ hasText: "地区与生活提醒" }).click();
  await section.getByLabel("开启生活提醒").check();
  await section.getByLabel("灾害天气预警").check();
  await section.getByRole("button", { name: "保存生活提醒" }).click();
  await expect(section.getByRole("alert")).toContainText("选择天气预警的省份");
  await section.getByRole("combobox", { name: "省份", exact: true }).selectOption("河北省");
  await section.getByLabel("城市 / 区县", { exact: true }).fill("保定");
  await section.getByLabel("上班时间", { exact: true }).fill("08:30");
  await section.getByLabel("午休开始", { exact: true }).fill("12:10");
  await section.getByRole("combobox", { name: "喝水间隔", exact: true }).selectOption("45");
  await section.locator("summary").filter({ hasText: "自定义休息与补班" }).click();
  await section.getByLabel("额外休息日", { exact: true }).fill("2026-10-16\n2026-10-19");
  await section.getByRole("button", { name: "保存生活提醒" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_save_settings").at(-1)?.args.settings.life)).toMatchObject({ enabled: true, weather: true, province: "河北省", city: "保定", workStart: "08:30", lunchStart: "12:10", waterMinutes: 45, restDates: ["2026-10-16", "2026-10-19"] });
  await expect(section.getByRole("button", { name: "保存生活提醒" })).toBeDisabled();
  for (const width of [1440,1024,768,375]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await section.locator(".pet-life-settings").screenshot({ path: "test-results/pet-life-settings.png" });
});

test("life settings retain a rejected draft and explain unsupported holiday years", async ({ page }) => {
  await fixture(page); await page.goto("/");
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  const section = page.getByRole("region", { name: "桌宠与运维预警" });
  await section.getByRole("button", { name: "展开", exact: true }).click();
  await section.locator("summary").filter({ hasText: "地区与生活提醒" }).click();
  await section.getByLabel("开启生活提醒").check();
  await section.getByLabel("上班时间", { exact: true }).fill("14:00");
  await section.getByRole("button", { name: "保存生活提醒" }).click();
  await expect(section.getByRole("alert")).toContainText("顺序设置时间");
  await section.getByLabel("上班时间", { exact: true }).fill("08:30");
  await page.evaluate(() => { (window as any).failPetSave = true; (window as any).petEvent("pet-life-changed", { notices: [], calendarYear: 2027, calendarSupported: false }); });
  await section.getByRole("button", { name: "保存生活提醒" }).click();
  await expect(section.getByText("设置保存失败", { exact: true })).toBeVisible();
  await expect(section.getByLabel("上班时间", { exact: true })).toHaveValue("08:30");
  await expect(section.getByText(/尚未内置 2027 年法定日历/)).toBeVisible();
});

test("water bubble roams briefly and acknowledging it stops native movement", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 });
  await fixture(page); await page.goto("/?desktopPet=1"); await lifeNotice(page);
  const bubble = page.getByRole("status", { name: "宠物生活提醒" });
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveAttribute("data-roaming", "true");
  await expect.poll(() => page.evaluate(() => (window as any).petCalls.some((c: any) => c.command === "pet_move" && Math.abs(c.args.dx) === 9 && Math.abs(c.args.dy) === 5))).toBe(true);
  await page.screenshot({ path: "test-results/pet-water-reminder.png" });
  await bubble.getByRole("button", { name: "喝过啦", exact: true }).click();
  await expect(bubble).not.toBeVisible();
  const count = await page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_move").length);
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_move").length)).toBeLessThanOrEqual(count + 1);
});

test("reduced motion preserves water bubble and snooze without roaming", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page); await page.goto("/?desktopPet=1"); await lifeNotice(page);
  const bubble = page.getByRole("status", { name: "宠物生活提醒" });
  await expect(bubble).toHaveAttribute("data-roaming", "false");
  await bubble.getByRole("button", { name: "10 分钟后", exact: true }).click();
  await expect(bubble).not.toBeVisible();
  expect(await page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_move" && c.args.dx))).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).petCalls.find((c: any) => c.command === "pet_life_action").args)).toMatchObject({ action: "snooze", id: "test-water" });
});

test("life weather waits for chat and ops messages and opens a native official detail action", async ({ page }) => {
  await fixture(page); await page.goto("/?desktopPet=1");
  await page.getByRole("button", { name: "双击嘴巴，和宠物聊天", exact: true }).dblclick();
  await lifeNotice(page, "weather", 3);
  const bubble = page.getByRole("status", { name: "宠物生活提醒" });
  await expect(bubble).not.toBeVisible();
  await page.getByRole("dialog", { name: "和宠物聊天" }).getByRole("button", { name: "关闭", exact: true }).click();
  await expect(bubble).toBeVisible();
  await bubble.getByRole("button", { name: "查看预警原文" }).click();
  expect(await page.evaluate(() => (window as any).petCalls.find((c: any) => c.command === "pet_life_action").args)).toEqual({ id: "test-weather", action: "openWeather" });
  await page.evaluate(() => (window as any).petEvent("pet-notification", { key: "test", title: "紧急运维提醒", detail: "需要处理", active: true, severity: "emergency", section: "panels" }));
  await expect(bubble).not.toBeVisible();
  await page.getByRole("button", { name: "关闭消息气泡", exact: true }).click();
  await expect(bubble).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bubble).not.toBeVisible();
});

async function fixture(page: Page, enabled = true) {
  await page.addInitScript(({ enabled, life }) => {
    let settings = { enabled, life, appearance: "alpaca", monitoring: false, panels: false, panelAccess: true, certificates: true, servers: true, size: 160, roam: "still", activity: 0, sound: false, reducedMotion: false, quiet: false, intervalSeconds: 300, expiryDays: 30, cpuThreshold: 90, diskThreshold: 90, keepInTray: false };
    let lifeState = { notices: [] as any[], weatherCheckedAt: 0, weatherAttemptAt: 0, weatherError: null as string | null, region: "", calendarYear: 2026, calendarSupported: true };
    let id = 0;
    const callbacks: Record<number, (v: unknown) => void> = {};
    const events: Record<string, number[]> = {};
    let petSnapshot: { alerts: any[]; checkedAt: number; lastError: string | null } = { alerts: [], checkedAt: 0, lastError: null };
    (window as any).petCalls = [];
    (window as any).petEvent = (event: string, payload: any) => { if (event === "pet-alerts-changed") petSnapshot = payload; if (event === "pet-life-changed") lifeState = payload; (events[event] || []).forEach(n => callbacks[n]?.({ event, payload })); };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "desktop-pet" }, currentWebview: { label: "desktop-pet" } },
      transformCallback: (cb: (v: unknown) => void) => { callbacks[++id] = cb; return id; },
      unregisterCallback: (n: number) => { delete callbacks[n]; },
      invoke: async (command: string, args: any) => {
        if (command.startsWith("pet_") || command === "plugin:window|start_dragging") (window as any).petCalls.push({ command, args });
        if (command === "plugin:event|listen") { (events[args.event] ||= []).push(args.handler); return args.handler; }
        if (command === "pet_settings") return settings;
        if (command === "pet_layout" && args.expanded) { (window as any).petEvent("pet-docked", false); return; }
        if (command === "pet_move" && (args.reveal || args.reset)) { (window as any).petEvent("pet-docked", false); return; }
        if (command === "pet_move" && args.dock && (window as any).holdPetDrop) return new Promise(resolve => { (window as any).finishPetDrop = () => { (window as any).petEvent("pet-docked",true); resolve(undefined); }; });
        if (command === "pet_life_state") return lifeState;
        if (command === "pet_life_weather") return lifeState;
        if (command === "pet_life_action") {
          if (args.action === "ack" || args.action === "snooze") lifeState = { ...lifeState, notices: lifeState.notices.map(n => n.id !== args.id ? n : { ...n, acknowledged: args.action === "ack", dueAt: args.action === "snooze" ? Date.now() / 1000 + 600 : n.dueAt }) };
          (window as any).petEvent("pet-life-changed", lifeState);
          return lifeState;
        }
        if (command === "pet_chat_services") return (window as any).noPetChatService ? [] : [{ id: "test-service", name: "测试 AI", model: "test-model", revision: 1, supportsImages: !(window as any).noPetVision }];
        if (command === "pet_chat_read_image") return (window as any).petDropImage;
        if (command === "pet_chat") {
          if ((window as any).failPetChat) throw { kind: "ai", code: "ai", message: "AI服务暂不可用，请稍后重试", retryable: true };
          if ((window as any).holdPetChat) return new Promise((_, reject) => { (window as any).rejectPetChat = reject; });
          return "我在呢，有什么想和我聊的？";
        }
        if (command === "pet_chat_cancel") { (window as any).rejectPetChat?.("聊天已停止"); return; }
        if (command === "pet_computer_action") { if ((window as any).failComputerAction) throw "系统操作失败"; return; }
        if (command === "list_panel_connections") return [{id:7,name:"测试面板",panel_url:"https://example.test:8888",status:"unknown",summary:{},sort_order:0,api_key_saved:false,allow_insecure_tls:false,last_checked_at:null,last_error:null}];
        if (command === "pet_notice") return { key: "cert:1", title: "证书即将到期", detail: "剩余 7 天", section: "certificates", active: true, severity: "critical" };
        if (command === "pet_snapshot") return petSnapshot;
        if (command === "pet_ignore") {
          if ((window as any).failPetIgnore) throw "忽略保存失败";
          petSnapshot = { ...petSnapshot, alerts: petSnapshot.alerts.map(a => args.keys.includes(a.key) ? { ...a, ignored: args.ignored } : a) };
          (window as any).petEvent("pet-alerts-changed", petSnapshot);
          return petSnapshot;
        }
        if (command === "pet_save_settings") { if ((window as any).failPetSave) throw { kind: "platform-error", code: "unknown", message: "设置保存失败", retryable: false }; settings = args.settings; return; }
        if (command === "list_client_preferences") return {};
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        return [];
      },
    };
  }, { enabled, life: defaultPetLife });
}

test("four dock directions stay transparent and support click and keyboard reveal", async ({ page }) => {
  await fixture(page); await page.goto("/?desktopPet=1");
  await expect(page.locator(".pet-avatar")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const edge of ["left", "right", "top", "bottom"]) {
    await page.evaluate(edge => {
      (window as any).petEvent("pet-dock-edge", edge);
      (window as any).petEvent("pet-docked", true);
    }, edge);
    await page.setViewportSize(edge === "top" || edge === "bottom" ? { width: 24, height: 64 } : { width: 64, height: 24 });
    await expect(page.locator(".pet-docked-stage")).toHaveAttribute("data-edge", edge);
    const head = page.getByRole("button", { name: "拉出宠物", exact: true });
    await expect(head.locator("svg")).toBeVisible();
    await expect(head).toHaveCSS("background-image", "none");
    const angle = { left: "-90deg", right: "90deg", top: "0deg", bottom: "180deg" }[edge];
    expect(await page.locator(".pet-dock-rope").evaluate(el => getComputedStyle(el).transform)).not.toBe("none");
    if (angle !== "0deg") expect(await head.evaluate(el => getComputedStyle(el).getPropertyValue("--pet-rope-angle").trim())).toBe(angle);
    await expect(head).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(head).toHaveCSS("animation-name", "none");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "normal");
    await page.screenshot({ path: `test-results/pet-dock-${edge}.png`, omitBackground: true });
    if (edge === "top") { await head.focus(); await page.keyboard.press("Enter"); }
    else await head.click();
    await expect(head).toHaveCount(0);
    await page.setViewportSize({ width: 360, height: 480 });
  }
});

test("top dock opens its notification and panel below the pet", async ({ page }) => {
  await fixture(page); await page.goto("/?desktopPet=1");
  await expect(page.locator(".pet-avatar")).toBeVisible();
  await page.evaluate(() => {
    (window as any).petEvent("pet-dock-edge", "top");
    (window as any).petEvent("pet-docked", true);
    (window as any).petEvent("pet-notification", {key:"top-test",title:"顶部提醒",detail:"向下展开",active:true,severity:"warning",section:"panels"});
  });
  await page.setViewportSize({ width: 360, height: 480 });
  const bubble = page.getByRole("status", { name: "运维消息气泡" });
  await expect(bubble).toBeVisible();
  const avatar = await page.locator(".pet-avatar").boundingBox();
  expect((await bubble.boundingBox())!.y).toBeGreaterThan(avatar!.y + avatar!.height);
  await page.getByRole("button", { name: "查看运维消息：顶部提醒" }).click();
  const panel = page.locator(".pet-floating-card");
  await expect(panel).toBeVisible();
  const bounds = (await panel.boundingBox())!;
  expect(bounds.y).toBeGreaterThan(avatar!.y + avatar!.height);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(480);
  await page.screenshot({ path: "test-results/pet-top-notification.png" });
});

test("edge head stays tucked on hover and wakes for a message or a deliberate drag", async ({ page }) => {
  await fixture(page); await page.goto("/?desktopPet=1");
  await expect(page.locator(".pet-avatar")).toBeVisible();
  await page.evaluate(() => (window as any).petEvent("pet-docked", true));
  await page.setViewportSize({ width: 104, height: 95 });
  const head = page.getByRole("button", { name: "拉出宠物", exact: true });
  await expect(head).toBeVisible();
  await expect(page.locator(".pet-avatar")).toHaveCount(0);
  await head.hover(); await page.waitForTimeout(300); await expect(head).toBeVisible();
  await page.screenshot({ path: "test-results/pet-docked-head.png", omitBackground: true });
  await page.evaluate(() => (window as any).petEvent("pet-notification", {key:"test",title:"新消息",detail:"应自动展开",active:true,severity:"warning",section:"panels",snoozedUntil:0}));
  await page.setViewportSize({ width: 360, height: 480 });
  await expect(head).toHaveCount(0);
  await expect(page.getByRole("status", { name: "运维消息气泡" })).toBeVisible();
  await page.getByRole("button", { name: "关闭消息气泡", exact: true }).click();
  await expect(page.locator(".pet-avatar")).toBeVisible();
  await page.evaluate(() => (window as any).petEvent("pet-docked", true));
  await page.setViewportSize({ width: 104, height: 95 });
  await expect(head).toBeVisible();
  await page.mouse.move(45,35); await page.mouse.down(); await page.mouse.move(65,40); await page.mouse.up();
  await expect(head).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).petCalls.some((c:any) => c.command === "pet_move" && c.args.reveal))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).petCalls.some((c:any) => c.command === "pet_move" && c.args.dock && c.args.remember))).toBe(true);
});

test("drag waits for the native drop and hides existing panels without reopening them", async ({page}) => {
  await fixture(page); await page.setViewportSize({width:360,height:480}); await page.goto("/?desktopPet=1");
  const avatar=page.locator(".pet-avatar");await expect(avatar).toBeVisible();
  await page.evaluate(()=>{(window as any).holdPetDrop=true;});
  await avatar.click();await expect(page.getByRole("dialog")).toBeVisible();
  await avatar.dispatchEvent("pointerdown",{button:0,screenX:80,screenY:400});
  await avatar.dispatchEvent("pointermove",{button:0,screenX:95,screenY:400});
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).finishPetDrop)).toBe("function");
  await avatar.dispatchEvent("pointerup",{button:0,screenX:95,screenY:400});
  await page.evaluate(()=>(window as any).finishPetDrop());
  await page.setViewportSize({width:104,height:95});
  await expect(page.locator(".pet-dock-handle")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>(window as any).petCalls.filter((c:any)=>c.command==="pet_layout").at(-1)?.args.expanded)).toBe(false);
  await page.evaluate(()=>(window as any).petEvent("pet-notification",{key:"new",title:"新的提醒",detail:"新消息唤醒",active:true,severity:"warning",section:"panels"}));
  await expect(page.locator(".pet-dock-handle")).toHaveCount(0);
});

test("a new life reminder reveals a docked pet", async ({ page }) => {
  await fixture(page); await page.goto("/?desktopPet=1");
  await expect(page.locator(".pet-avatar")).toBeVisible();
  await page.evaluate(() => (window as any).petEvent("pet-docked", true));
  await lifeNotice(page);
  await expect(page.locator(".pet-dock-handle")).toHaveCount(0);
  await expect(page.getByRole("status", { name: "宠物生活提醒" })).toBeVisible();
});

test("pet has transparent canvas, explicit menu close and water interaction", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 });
  await fixture(page); await page.goto("/?desktopPet=1");
  const avatar = page.getByRole("button", { name: /^宠物：/ });
  await expect(avatar).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  expect(await page.locator(".pet-stage").evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await avatar.click({ button: "right" });
  const menu = page.getByRole("dialog", { name: "宠物快捷菜单" });
  await expect(menu).toBeVisible();
  await expect(menu.locator(".pet-menu button")).toHaveCount(13);
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

test("status panel and reminder items use readable light surfaces", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cloudhub-tools-ui-theme", "light"));
  await fixture(page); await page.goto("/?desktopPet=1");
  await expect(page.getByRole("button", { name: /^宠物：/ })).toBeVisible();
  await page.evaluate(() => (window as any).petEvent("pet-alerts-changed", { checkedAt: 100, lastError: null, alerts: [{ key: "panel:1", title: "生产面板访问异常", detail: "连续两次无法通过配置的接口访问面板。请检查本机网络、面板地址、权限与 API 白名单。", section: "panels", severity: "emergency", active: true, ignored: false, updatedAt: 100, snoozedUntil: 0 }] }));
  await page.locator(".pet-avatar").click();
  const panel = page.getByRole("dialog", { name: "宠物运维状态" });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(panel).toHaveCSS("color", "rgb(29, 29, 31)");
  await expect(panel.locator(":scope > header")).toHaveCSS("background-color", "rgb(243, 243, 244)");
  await expect(panel.locator(".pet-alert-item")).toHaveCSS("background-color", "rgb(255, 244, 243)");
  await expect(panel.locator(".pet-alert-item p")).toHaveCSS("color", "rgb(103, 103, 108)");
  await expect(panel.locator("footer")).toHaveCSS("background-color", "rgb(255, 255, 255)");
});


test("detached pet uses the saved light theme without duplicating sprite frames", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cloudhub-tools-ui-theme", "light"));
  await fixture(page); await page.goto("/?desktopPet=1");
  await expect.poll(() => page.locator("body").evaluate(el => el.classList.contains("theme-light"))).toBe(true);
  await page.locator(".pet-avatar").click({ button: "right" });
  const menu = page.getByRole("dialog", { name: "宠物快捷菜单" });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
  const sprite = page.locator(".pet-sprite");
  await expect(sprite).toHaveCount(1);
  expect(await sprite.evaluate(el => getComputedStyle(el).backgroundRepeat)).toBe("no-repeat");
  expect(await sprite.evaluate(el => getComputedStyle(el).backgroundImage.startsWith("url("))).toBe(true);
  await page.screenshot({ path: "test-results/alpaca-light-quick-menu.png", animations: "disabled", omitBackground: true });
});

test("alerts interrupt play and offer snooze and real section navigation", async ({ page }) => {
  await fixture(page); await page.goto("/?desktopPet=1");
  await expect(page.getByRole("button", { name: /^宠物：/ })).toBeVisible();
  await page.evaluate(() => (window as any).petEvent("pet-notification", { key: "cert:1", title: "example.test 证书即将到期", detail: "剩余 7 天", section: "certificates", severity: "critical", active: true, updatedAt: 100, firstSeen: 100, snoozedUntil: 0, notifiedAt: 0, occurrences: 1 }));
  await expect(page.getByText("example.test 证书即将到期")).toBeVisible();
  await expect(page.getByRole("status", { name: "运维消息气泡" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "查看运维消息：example.test 证书即将到期" }).click();
  await page.getByRole("button", { name: "查看详情", exact: true }).click();
  expect(await page.evaluate(() => (window as any).petCalls.find((c: any) => c.command === "pet_open").args.section)).toBe("certificates");
  expect(await page.evaluate(() => (window as any).petCalls.find((c: any) => c.command === "pet_open").args.key)).toBe("cert:1");
  await page.getByRole("button", { name: "一小时后提醒" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).petCalls.find((c: any) => c.command === "pet_snooze").args)).toEqual({ key: "cert:1", minutes: 60 });
});

test("alert speech bubble is clickable, dismissible and waits until chat closes", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 });
  await fixture(page); await page.goto("/?desktopPet=1");
  await expect(page.locator(".pet-avatar")).toBeVisible();
  const notify = () => page.evaluate(() => (window as any).petEvent("pet-notification", { key: "cert:2", title: "example.test 证书即将到期", detail: "剩余 14 天，请核对续费或签发结果。", section: "certificates", severity: "warning", active: true, updatedAt: 100, firstSeen: 100, snoozedUntil: 0, notifiedAt: 0, occurrences: 1 }));
  await notify();
  const bubble = page.getByRole("status", { name: "运维消息气泡" });
  await expect(bubble).toBeInViewport();
  await page.screenshot({ path: "test-results/alpaca-alert-bubble.png", animations: "disabled", omitBackground: true });
  await page.mouse.click(350, 10); await expect(bubble).toBeVisible();
  await page.getByRole("button", { name: "关闭消息气泡", exact: true }).click();
  await expect(bubble).toHaveCount(0);
  await page.getByRole("button", { name: "双击嘴巴，和宠物聊天" }).dblclick();
  await notify();
  const chat = page.getByRole("dialog", { name: "和宠物聊天", exact: true });
  await expect(chat).toBeVisible(); await expect(bubble).toHaveCount(0);
  await chat.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(bubble).toBeVisible();
  await page.keyboard.press("Escape"); await expect(bubble).toHaveCount(0);
  await page.evaluate(async () => {
    const settings = await (window as any).__TAURI_INTERNALS__.invoke("pet_settings", {});
    (window as any).petEvent("pet-settings-changed", { ...settings, quiet: true });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await notify(); await expect(bubble).toHaveCount(0);
});

test("mouth requires double click, sends bounded conversation and supports stop and close", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 720 });
  await fixture(page); await page.goto("/?desktopPet=1");
  await page.getByRole("button", { name: "双击嘴巴，和宠物聊天" }).click();
  await expect(page.getByRole("dialog", { name: "和宠物聊天", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "双击嘴巴，和宠物聊天" }).dblclick();
  const chat = page.getByRole("dialog", { name: "和宠物聊天", exact: true });
  await expect(chat).toBeVisible();
  const input = chat.getByLabel("和宠物说句话");
  await expect(input).toBeEnabled();
  await input.fill("你好，小羊驼"); await input.press("Enter");
  await expect(chat.getByText("我在呢，有什么想和我聊的？", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).petCalls.find((c: any) => c.command === "pet_chat").args.messages)).toEqual([{ role: "user", text: "你好，小羊驼" }]);
  await page.screenshot({ path: "test-results/alpaca-chat.png", animations: "disabled", omitBackground: true });
  await page.evaluate(() => { (window as any).holdPetChat = true; });
  await input.fill("再聊一句"); await chat.getByRole("button", { name: "发送", exact: true }).click();
  await expect(chat.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await chat.getByRole("button", { name: "停止", exact: true }).click();
  await expect(input).toHaveValue("再聊一句");
  await expect(chat.getByRole("alert")).toBeVisible();
  await chat.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(chat).toHaveCount(0);
  await expect(page.locator(".pet-avatar")).toBeVisible();
});

test("pet chat without a configured service offers settings instead of a fake reply", async ({ page }) => {
  await fixture(page); await page.goto("/?desktopPet=1");
  await page.evaluate(() => { (window as any).noPetChatService = true; });
  await page.getByRole("button", { name: "双击嘴巴，和宠物聊天" }).dblclick();
  await expect(page.getByLabel("和宠物说句话")).toBeDisabled();
  await page.getByRole("button", { name: "去设置 AI 服务" }).click();
  expect(await page.evaluate(() => (window as any).petCalls.find((c: any) => c.command === "pet_open").args.section)).toBe("settings");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("pet chat images require preparation and send only the reviewed current image", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 720 });
  await fixture(page); await page.goto("/?desktopPet=1");
  await page.getByRole("button", { name: "双击嘴巴，和宠物聊天" }).dblclick();
  const chat = page.getByRole("dialog", { name: "和宠物聊天", exact: true });
  await expect(chat.getByRole("button", { name: "图片", exact: true })).toBeEnabled();
  await page.screenshot({ path: "test-results/alpaca-chat-refined.png", animations: "disabled", omitBackground: true });
  await page.setViewportSize({ width: 375, height: 720 });
  expect(await chat.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(chat.getByRole("button", { name: "图片", exact: true })).toBeInViewport();
  await page.screenshot({ path: "test-results/alpaca-chat-refined-375.png", animations: "disabled", omitBackground: true });
  await page.setViewportSize({ width: 520, height: 720 });
  const data = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 200; canvas.height = 120; const ctx = canvas.getContext("2d")!; ctx.fillStyle = "blue"; ctx.fillRect(0, 0, 200, 120); return canvas.toDataURL("image/png").split(",")[1]; });
  await chat.getByLabel("选择聊天图片").setInputFiles({ name: "test.png", mimeType: "image/png", buffer: Buffer.from(data, "base64") });
  const editor = chat.getByRole("region", { name: "图片遮罩处理", exact: true });
  await expect(editor.locator("canvas")).toHaveAttribute("width", "200");
  expect(await page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_chat").length)).toBe(0);
  const bounds = (await editor.locator("canvas").boundingBox())!;
  await page.mouse.move(bounds.x + 20, bounds.y + 20); await page.mouse.down(); await page.mouse.move(bounds.x + 60, bounds.y + 20); await page.mouse.up();
  await editor.getByRole("button", { name: "使用处理后的图片" }).click();
  await expect(chat.getByAltText("待发送的处理后图片")).toBeVisible();
  await page.screenshot({ path: "test-results/alpaca-chat-image-ready.png", animations: "disabled", omitBackground: true });
  await page.evaluate(() => { (window as any).failPetChat = true; });
  await chat.getByRole("button", { name: "发送", exact: true }).click();
  await expect(chat.getByRole("alert")).toBeVisible();
  await expect(chat.getByAltText("待发送的处理后图片")).toBeVisible();
  await page.evaluate(() => { (window as any).failPetChat = false; });
  await chat.getByRole("button", { name: "发送", exact: true }).click();
  await expect(chat.getByText("我在呢，有什么想和我聊的？", { exact: true })).toBeVisible();
  const sent = await page.evaluate(() => (window as any).petCalls.find((c: any) => c.command === "pet_chat").args);
  expect(sent.image.reviewed).toBe(true);
  expect(sent.image.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  expect(sent.image.dataUrl).not.toContain(data);
  expect(sent.messages).toEqual([{ role: "user", text: "请看看这张图片。" }]);
  await chat.getByLabel("和宠物说句话").fill("继续聊聊");
  await chat.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_chat").length)).toBe(3);
  const next = await page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_chat").at(-1).args);
  expect(next.image).toBeNull(); expect(next.messages.every((message: any) => !("image" in message))).toBe(true);
});

test("pet chat accepts paste and native image drop, and preserves send blocking for invalid files", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 720 });
  await fixture(page); await page.goto("/?desktopPet=1");
  await page.getByRole("button", { name: "双击嘴巴，和宠物聊天" }).dblclick();
  const chat = page.getByRole("dialog", { name: "和宠物聊天", exact: true });
  const input = chat.getByLabel("和宠物说句话");
  await expect(input).toBeEnabled();
  await input.evaluate(async el => {
    const c = document.createElement("canvas"); c.width = 100; c.height = 80;
    const blob = await new Promise<Blob>(resolve => c.toBlob(b => resolve(b!), "image/png"));
    (window as any).petDropImage = c.toDataURL("image/png");
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], "paste.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  const editor = chat.getByRole("region", { name: "图片遮罩处理", exact: true });
  await expect(editor.locator("canvas")).toHaveAttribute("width", "100");
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  const box = (await chat.locator(".pet-chat").boundingBox())!;
  await page.evaluate(({ x, y }) => (window as any).petEvent("tauri://drag-drop", { paths: ["C:/fixture/image.png"], position: { x: x * devicePixelRatio, y: y * devicePixelRatio } }), { x: box.x + 20, y: box.y + 60 });
  await expect(editor.locator("canvas")).toHaveAttribute("width", "100");
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await chat.getByLabel("选择聊天图片").setInputFiles({ name: "invalid.png", mimeType: "image/png", buffer: Buffer.from("invalid") });
  await expect(editor.getByRole("alert")).toBeVisible();
  expect(await page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_chat").length)).toBe(0);
});

test("pet chat disables image attachment until the service has verified vision support", async ({ page }) => {
  await fixture(page); await page.goto("/?desktopPet=1");
  await page.evaluate(() => { (window as any).noPetVision = true; });
  await page.getByRole("button", { name: "双击嘴巴，和宠物聊天" }).dblclick();
  await expect(page.getByRole("button", { name: "图片", exact: true })).toBeDisabled();
  await expect(page.getByLabel("和宠物说句话")).toBeEnabled();
  await expect(page.getByRole("button", { name: "启用识图", exact: true })).toBeVisible();
});

test("computer shortcuts use fixed actions and require explicit power confirmation", async ({page}) => {
  await page.setViewportSize({width:520,height:720});
  await fixture(page);await page.goto("/?desktopPet=1");
  await page.getByRole("button",{name:/^宠物：/}).click({button:"right"});
  const menu=page.getByRole("dialog",{name:"宠物快捷菜单"});
  for (const [name,action] of [["任务管理器","taskManager"],["文件资源管理器","explorer"],["锁定电脑","lock"]]) {
    await menu.getByRole("button",{name,exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).petCalls.filter((c:any)=>c.command==="pet_computer_action").at(-1)?.args.action)).toBe(action);
  }
  for (const [name,action,label] of [["关闭电脑","shutdown","确认关机"],["重启电脑","restart","确认重启"]]) {
    const before=await page.evaluate(()=>(window as any).petCalls.filter((c:any)=>c.command==="pet_computer_action").length);
    await menu.getByRole("button",{name,exact:true}).click();
    const confirm=page.getByRole("alertdialog",{name,exact:true});
    await expect(confirm).toBeVisible();await expect(confirm).toHaveClass(/dialog-common-theme/);
    await page.mouse.click(2,2);await expect(confirm).toBeVisible();
    await page.keyboard.press("Escape");await expect(confirm).toHaveCount(0);
    expect(await page.evaluate(()=>(window as any).petCalls.filter((c:any)=>c.command==="pet_computer_action").length)).toBe(before);
    await menu.getByRole("button",{name,exact:true}).click();
    await confirm.getByRole("button",{name:"取消",exact:true}).click();
    expect(await page.evaluate(()=>(window as any).petCalls.filter((c:any)=>c.command==="pet_computer_action").length)).toBe(before);
    await menu.getByRole("button",{name,exact:true}).click();
    await confirm.getByRole("button",{name:label,exact:true}).click();
    await expect(confirm).toHaveCount(0);
    await expect.poll(()=>page.evaluate(()=>(window as any).petCalls.filter((c:any)=>c.command==="pet_computer_action").at(-1)?.args.action)).toBe(action);
  }
  await page.evaluate(()=>{(window as any).failComputerAction=true;});
  await menu.getByRole("button",{name:"关闭电脑",exact:true}).click();
  const confirm=page.getByRole("alertdialog",{name:"关闭电脑",exact:true});
  await confirm.getByRole("button",{name:"确认关机",exact:true}).click();
  await expect(confirm.getByRole("alert")).toContainText("系统操作失败");
  await confirm.getByRole("button",{name:"取消",exact:true}).click();
  await expect(menu).toBeVisible();
  await page.screenshot({path:"test-results/pet-computer-shortcuts.png",omitBackground:true});
});

test("status list scrolls within a fixed panel and keeps actions accessible", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 });
  await fixture(page); await page.goto("/?desktopPet=1");
  const avatar = page.getByRole("button", { name: /^宠物：/ });
  await expect(avatar).toBeVisible();
  await avatar.click({ button: "right" });
  await page.getByRole("button", { name: /查看提醒/ }).click();
  await page.evaluate(() => (window as any).petEvent("pet-alerts-changed", {
    checkedAt: 1792063371, lastError: null,
    alerts: Array.from({ length: 12 }, (_, i) => ({ key: `cert:${i}`, title: `service-${i + 1}.example.test 即将到期`, detail: "剩余 14 天：请核对续费或签发结果。", section: "certificates", severity: i === 0 ? "critical" : "warning", active: true, updatedAt: 1792063371, firstSeen: 1792063371, snoozedUntil: 0, notifiedAt: 0, occurrences: 1 })),
  }));
  const panel = page.getByRole("dialog", { name: "宠物运维状态" });
  await expect(panel.getByText("12 项待处理", { exact: true })).toBeVisible();
  expect(await panel.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
  expect(await panel.locator(".pet-alert-list").evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.screenshot({ path: "test-results/alpaca-status-list.png", animations: "disabled", omitBackground: true });
  const last = panel.locator("article").last();
  await last.getByRole("button", { name: "一小时后提醒" }).click();
  expect(await page.evaluate(() => (window as any).petCalls.find((c: any) => c.command === "pet_snooze").args.key)).toBe("cert:11");
  await expect(panel.locator("footer")).toBeInViewport();
  await page.mouse.click(350, 5); await expect(panel).toBeVisible();
  await page.keyboard.press("Escape"); await expect(panel).toHaveCount(0);
});

for (const size of [80,120,160,200]) test(`long status list keeps titlebar inside the native window at size ${size}`, async ({page}) => {
  await page.setViewportSize({width:360,height:480});
  await fixture(page); await page.goto("/?desktopPet=1");
  await expect(page.locator(".pet-avatar")).toBeVisible();
  await page.evaluate(async size => {
    const settings = await (window as any).__TAURI_INTERNALS__.invoke("pet_settings",{});
    (window as any).petEvent("pet-settings-changed",{...settings,size});
    (window as any).petEvent("pet-alerts-changed",{checkedAt:200,lastError:null,alerts:Array.from({length:20},(_,i)=>({key:`panel:${i}`,title:`测试面板 ${i} 面板访问异常`,detail:"连续两次无法通过配置的接口访问面板。请检查本机网络、面板地址、权限与 API 白名单。",section:"panels",severity:"emergency",active:true,updatedAt:200,snoozedUntil:0}))});
  },size);
  await page.getByRole("button",{name:/^宠物：/}).click();
  const panel=page.getByRole("dialog",{name:"宠物运维状态"});
  const close=panel.getByRole("button",{name:"关闭",exact:true});
  for (const enlarged of [false,true,false]) {
    await page.setViewportSize(enlarged ? {width:520,height:720} : {width:360,height:480});
    await panel.locator(".pet-alert-list").evaluate(el=>{el.scrollTop=el.scrollHeight;});
    await expect(panel.locator(":scope > header")).toBeInViewport({ratio:1});
    await expect(close).toBeInViewport({ratio:1});
    await expect(panel.locator("footer")).toBeInViewport({ratio:1});
    const title=await panel.locator("header strong").boundingBox();
    await page.mouse.move(title!.x+3,title!.y+3);await page.mouse.down();await page.mouse.up();
    if (enlarged) await panel.getByRole("button",{name:"缩小弹层",exact:true}).click();
    else await panel.getByRole("button",{name:"最大化弹层",exact:true}).click();
  }
  await page.screenshot({path:`test-results/pet-status-header-size-${size}.png`,omitBackground:true});
  await close.click(); await expect(panel).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).petCalls.some((c:any)=>c.command==="plugin:window|start_dragging"))).toBe(true);
});

test("alert status defaults to unresolved and recovered alerts remain available separately", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 });
  await fixture(page); await page.goto("/?desktopPet=1");
  await page.getByRole("button", { name: /^宠物：/ }).click();
  await page.evaluate(() => (window as any).petEvent("pet-alerts-changed", { checkedAt: 100, lastError: null, alerts: [
    { key: "panel:1:metric:cpu", title: "CPU 已恢复", detail: "使用率已下降", section: "panels", severity: "warning", active: false, updatedAt: 100, snoozedUntil: 0 },
  ] }));
  const panel = page.getByRole("dialog", { name: "宠物运维状态" });
  const active = panel.getByRole("button", { name: /^未解除/ });
  const recovered = panel.getByRole("button", { name: /^已解除/ });
  await expect(active).toHaveAttribute("aria-pressed", "true");
  await expect(active).toContainText("0");
  await expect(panel.locator("article")).toHaveCount(0);
  await expect(panel.getByText("暂无未解除提醒")).toBeVisible();
  await recovered.click();
  await expect(recovered).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator("article")).toHaveCount(1);
  await expect(panel.locator("article")).toContainText("CPU 已恢复");
  await expect(panel.getByRole("button", { name: "全部忽略", exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/alpaca-recovered-filter.png", animations: "disabled", omitBackground: true });
  await active.click(); await expect(panel.locator("article")).toHaveCount(0);
});

test("ignore one and all update the status list and pet badge without deleting history", async ({ page }) => {
  await fixture(page); await page.goto("/?desktopPet=1");
  await page.getByRole("button", { name: /^宠物：/ }).click();
  await page.evaluate(() => (window as any).petEvent("pet-alerts-changed", { checkedAt: 100, lastError: null, alerts: [1, 2].map(i => ({ key: `cert:${i}`, title: `测试提醒 ${i}`, detail: "即将到期", section: "certificates", severity: "warning", active: true, ignored: false, updatedAt: 100, snoozedUntil: 0 })) }));
  const panel = page.getByRole("dialog", { name: "宠物运维状态" });
  await expect(page.getByRole("button", { name: "2项待处理提醒", exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).failPetIgnore = true; });
  await panel.locator("article").first().getByRole("button", { name: "忽略", exact: true }).click();
  await expect(page.locator(".pet-inline-error")).toBeVisible();
  await expect(panel.locator("article")).toHaveCount(2);
  await page.evaluate(() => { (window as any).failPetIgnore = false; });
  await panel.locator("article").first().getByRole("button", { name: "忽略", exact: true }).click();
  await expect(panel.locator("article")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "1项待处理提醒", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "全部忽略", exact: true }).click();
  await expect(panel.locator("article")).toHaveCount(0);
  await expect(page.locator(".pet-alert-badge")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_ignore").at(-1).args)).toEqual({ keys: ["cert:2"], ignored: true });
  expect(await page.evaluate(async () => (await (window as any).__TAURI_INTERNALS__.invoke("pet_snapshot", {})).alerts.length)).toBe(2);
});

test("ignored alerts can be restored from settings history", async ({ page }) => {
  await fixture(page); await page.goto("/");
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.locator(".pet-settings-section").getByRole("button", { name: "展开" }).click();
  await expect(page.getByLabel("启用桌宠")).toBeVisible();
  await page.evaluate(() => (window as any).petEvent("pet-alerts-changed", { checkedAt: 100, lastError: null, alerts: [{ key: "cert:1", title: "被忽略的提醒", detail: "即将到期", section: "certificates", severity: "warning", active: true, ignored: true, updatedAt: 100, snoozedUntil: 0 }] }));
  await page.getByRole("button", { name: /提醒记录（/ }).click();
  const history = page.getByRole("dialog", { name: "运维提醒记录" });
  await expect(history.getByText("已忽略", { exact: true })).toBeVisible();
  await history.getByRole("button", { name: "恢复提醒", exact: true }).click();
  await expect(history.getByText("已忽略", { exact: true })).toHaveCount(0);
  await expect(history.getByRole("button", { name: "忽略", exact: true })).toBeVisible();
  await expect(history).toHaveClass(/dialog-common-theme/);
  await history.getByRole("button", { name: "最大化弹层" }).click();
  await expect(history).toHaveClass(/dialog-size-expanded/);
  await history.getByRole("button", { name: "缩小弹层" }).click();
  await expect(history).not.toHaveClass(/dialog-size-expanded/);
  await page.evaluate(() => (window as any).petEvent("pet-alerts-changed", { checkedAt: 100, lastError: null, alerts: Array.from({ length: 30 }, (_, i) => ({ key: `cert:${i}`, title: `测试证书 ${i} 即将到期`, detail: "请刷新资源核对续费或续签结果。", section: "certificates", severity: "warning", active: true, updatedAt: 100, snoozedUntil: 0 })) }));
  const body = history.locator(".modal-body");
  await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(history.getByRole("heading", { name: "运维提醒记录" })).toBeVisible();
  await expect(history.locator("footer").getByRole("button", { name: "关闭", exact: true })).toBeInViewport();
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await history.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  }
  const before = await history.boundingBox();
  const header = await history.locator("header").boundingBox();
  await page.mouse.move(header!.x + 100, header!.y + 22); await page.mouse.down();
  await page.mouse.move(header!.x + 125, header!.y + 32); await page.mouse.up();
  expect((await history.boundingBox())!.x).toBeGreaterThan(before!.x);
  await body.evaluate(el => { el.scrollTop = 0; });
  await history.screenshot({ path: "test-results/pet-history-shared-dialog.png" });
});

test("emergency alerts sort first and show explicit severity in list and speech bubble", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 });
  await fixture(page); await page.goto("/?desktopPet=1");
  await page.getByRole("button", { name: /^宠物：/ }).click();
  await page.evaluate(() => (window as any).petEvent("pet-alerts-changed", { checkedAt: 200, lastError: null, alerts: [
    { key: "asset:1", title: "普通提醒", detail: "资源即将到期", section: "resources", severity: "warning", active: true, updatedAt: 200, snoozedUntil: 0 },
    { key: "panel:1:metric:disk", title: "测试面板 磁盘空间不足", detail: "当前使用率 95%，请释放空间或扩容。", section: "panels", severity: "emergency", active: true, updatedAt: 100, snoozedUntil: 0 },
  ] }));
  const panel = page.getByRole("dialog", { name: "宠物运维状态" });
  await expect(panel.locator("article").first()).toContainText("磁盘空间不足");
  await expect(panel.locator("article").first()).toContainText("超级严重");
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(() => (window as any).petEvent("pet-notification", { key: "panel:1:connection", title: "测试面板 面板访问异常", detail: "连续两次无法访问，请检查网络与权限。", section: "panels", severity: "emergency", active: true, updatedAt: 201, snoozedUntil: 0 }));
  await expect(page.getByRole("status", { name: "运维消息气泡" })).toContainText("超级严重，请尽快处理");
  await page.screenshot({ path: "test-results/alpaca-emergency-bubble.png", animations: "disabled", omitBackground: true });
});

test("panel access check is independently configurable", async ({ page }) => {
  await fixture(page); await page.goto("/");
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  const section = page.locator(".pet-settings-section");
  await section.getByRole("button", { name: "展开" }).click();
  await section.getByRole("checkbox", { name: "启用运维预警", exact: true }).check();
  await section.getByText("检查范围与提醒规则", { exact: true }).click();
  const access = section.getByRole("checkbox", { name: "面板访问异常", exact: true });
  await expect(access).toBeChecked();
  await access.uncheck();
  await expect(access).not.toBeChecked();
  const saved = await page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_save_settings").at(-1).args.settings);
  expect(saved.panelAccess).toBe(false);
  expect(saved.certificates).toBe(true);
  expect(saved.panels).toBe(false);
});

for (const theme of ["dark", "light"] as const) for (const kind of ["status", "menu", "chat"] as const) test(`pet ${kind} uses the common dialog theme in ${theme} mode`, async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 720 });
  await fixture(page);
  await page.addInitScript(theme => localStorage.setItem("cloudhub-tools-ui-theme", theme), theme);
  await page.goto("/?desktopPet=1");
  const avatar = page.getByRole("button", { name: /^宠物：/ });
  if (kind === "chat") await page.getByRole("button", { name: "双击嘴巴，和宠物聊天" }).dblclick();
  else await avatar.click(kind === "menu" ? { button: "right" } : {});
  const panel = page.getByRole("dialog");
  await expect(panel).toHaveClass(/modal-form-layout/);
  await expect(panel).toHaveClass(/dialog-common-theme/);
  await expect(panel).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(29, 29, 29)");
  await expect(panel.locator(":scope > header")).toHaveCSS("background-color", theme === "light" ? "rgb(243, 243, 244)" : "rgb(36, 36, 36)");
  await expect(panel).toHaveCSS("color", theme === "light" ? "rgb(29, 29, 31)" : "rgb(230, 230, 230)");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "normal");
  await expect(page.locator("body")).toHaveClass(theme === "light" ? /theme-light/ : /^(?!.*theme-light)/);
  await expect(page.locator("body")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(panel.locator(".dialog-header-actions")).toBeVisible();
  if (kind === "status") await expect(panel.locator("footer")).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(29, 29, 29)");
  await page.screenshot({ path: `test-results/pet-common-${kind}-${theme}.png`, animations: "disabled", omitBackground: true });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("pet windows follow cross-window theme storage changes and keep bubbles readable", async ({ page, context }) => {
  await fixture(page); await page.goto("/?desktopPet=1");
  await expect(page.locator(".pet-avatar")).toBeVisible();
  // A real same-origin storage event, rather than a synthetic event on the pet page.
  const preferences = await context.newPage();
  await preferences.goto("/?desktopPetAlerts=1");
  const notification = preferences.getByRole("dialog", { name: "CloudHub 运维提醒" });
  await expect(notification).toBeVisible();
  for (const theme of ["light", "dark", "light"] as const) {
    await preferences.evaluate(theme => localStorage.setItem("cloudhub-tools-ui-theme", theme), theme);
    await expect(page.locator("html")).toHaveCSS("color-scheme", "normal");
    await expect.poll(() => page.locator("body").evaluate(el => el.classList.contains("theme-light"))).toBe(theme === "light");
    await page.evaluate(() => (window as any).petEvent("pet-notification", { key: "theme", title: "主题回归提醒", detail: "检查消息文字与背景", active: true, severity: "emergency", section: "panels" }));
    const bubble = page.getByRole("status", { name: "运维消息气泡" });
    await expect(bubble).toBeVisible();
    await expect(bubble).toHaveCSS("color", theme === "light" ? "rgb(29, 29, 31)" : "rgb(230, 230, 230)");
    await expect(bubble.locator(".pet-speech-detail")).toHaveCSS("color", theme === "light" ? "rgb(103, 103, 108)" : "rgb(160, 160, 160)");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.getByRole("button", { name: "关闭消息气泡", exact: true }).click();
  }
  // The independent notification also reads the persisted preference at startup.
  await preferences.reload();
  await expect(notification).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(notification.locator("header")).toHaveCSS("background-color", "rgb(243, 243, 244)");
  await page.evaluate(() => localStorage.removeItem("cloudhub-tools-ui-theme"));
  await expect(notification).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "normal");
  await preferences.close();
});

test("alpaca frames contain no detached neighbouring-pose fragments", async ({ page }) => {
  await fixture(page); await page.goto("/?desktopPet=1");
  const sprite = page.locator(".pet-sprite");
  await expect(sprite).toBeVisible();
  for (const selector of [".pet-avatar-wrap", ".pet-avatar", ".pet-sprite"]) {
    await expect(page.locator(selector)).toHaveCSS("filter", "none");
    await expect(page.locator(selector)).toHaveCSS("box-shadow", "none");
  }
  const fragments = await sprite.evaluate(async el => {
    const image = new Image();
    image.src = getComputedStyle(el).backgroundImage.slice(5, -2);
    await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 1536; canvas.height = 1024;
    const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
    const fragments: { frame: number; pixels: number }[] = [];
    for (let frame = 0; frame < 24; frame++) {
      const data = ctx.getImageData(frame % 6 * 256, Math.floor(frame / 6) * 256, 256, 256).data;
      const seen = new Uint8Array(256 * 256); const components: number[] = [];
      for (let pixel = 0; pixel < seen.length; pixel++) {
        if (seen[pixel] || data[pixel * 4 + 3] <= 32) continue;
        const queue = [pixel]; seen[pixel] = 1;
        for (let i = 0; i < queue.length; i++) {
          const p = queue[i]; const x = p % 256; const y = Math.floor(p / 256);
          for (const n of [x > 0 ? p - 1 : -1, x < 255 ? p + 1 : -1, y > 0 ? p - 256 : -1, y < 255 ? p + 256 : -1]) {
            if (n >= 0 && !seen[n] && data[n * 4 + 3] > 32) { seen[n] = 1; queue.push(n); }
          }
        }
        components.push(queue.length);
      }
      components.sort((a, b) => b - a);
      for (const pixels of components.slice(1)) if (pixels >= 8) fragments.push({ frame, pixels });
    }
    return fragments;
  });
  expect(fragments).toEqual([]);
  await expect(sprite).toHaveCSS("background-size", "600% 400%");
  await expect(sprite).toHaveCSS("background-repeat", "no-repeat");
});

test("status titlebar drags the native window and supports enlarge restore and close", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 });
  await fixture(page); await page.goto("/?desktopPet=1");
  await page.getByRole("button", { name: /^宠物：/ }).click();
  const panel = page.getByRole("dialog", { name: "宠物运维状态" });
  await panel.getByRole("button", { name: "最大化弹层", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_layout").at(-1)?.args)).toEqual({ expanded: true, enlarged: true });
  await page.setViewportSize({ width: 520, height: 720 });
  await expect(panel.getByRole("button", { name: "缩小弹层", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/alpaca-status-enlarged.png", animations: "disabled", omitBackground: true });
  const title = await panel.locator("header strong").boundingBox();
  await page.mouse.move(title!.x + 10, title!.y + 8); await page.mouse.down(); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).petCalls.some((c: any) => c.command === "plugin:window|start_dragging"))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).petCalls.some((c: any) => c.command === "pet_move" && c.args.remember))).toBe(true);
  await panel.getByRole("button", { name: "缩小弹层", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_layout").at(-1)?.args)).toEqual({ expanded: true, enlarged: false });
  // Window control clicks must not initiate dragging.
  expect(await page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "plugin:window|start_dragging").length)).toBe(1);
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^宠物：/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_layout").at(-1)?.args)).toEqual({ expanded: false, enlarged: false });
});

test("system reduced motion and hidden pets stop frame advancement", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await fixture(page); await page.goto("/?desktopPet=1");
  const avatar = page.getByRole("button", { name: /^宠物：/ }); await expect(avatar).toBeVisible();
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
  await expect(page.getByLabel("启用桌宠")).toHaveCount(0);
});

test("pet settings save dog appearance while retaining the alpaca option", async ({ page }) => {
  await fixture(page); await page.goto("/");
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  const section = page.locator(".pet-settings-section");
  await section.getByRole("button", { name: "展开" }).click();
  await section.getByText("桌宠外观与行为", { exact: true }).click();
  const appearance = section.getByLabel("宠物形象");
  await expect(appearance).toHaveValue("alpaca");
  await appearance.selectOption("dog");
  await expect(appearance).toHaveValue("dog");
  expect(await page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_save_settings").at(-1).args.settings.appearance)).toBe("dog");
  await expect(appearance.locator('option[value="alpaca"]')).toHaveText("羊驼");
  await appearance.selectOption("penguin");
  await expect(appearance).toHaveValue("penguin");
  await expect(appearance.locator('option[value="penguin"]')).toHaveText("企鹅");
  expect(await page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_save_settings").at(-1).args.settings.appearance)).toBe("penguin");
  await expect(section.locator('.pet-settings-portrait')).toHaveAttribute("data-appearance", "penguin");
  await appearance.selectOption("fish");
  await expect(appearance).toHaveValue("fish");
  await expect(appearance.locator('option[value="fish"]')).toHaveText("大鱼（DeepSeek）");
  await expect(section.locator('.pet-settings-portrait')).toHaveAttribute("data-appearance","fish");
  expect(await page.evaluate(() => (window as any).petCalls.filter((c:any)=>c.command==="pet_save_settings").at(-1).args.settings.appearance)).toBe("fish");
});

for (const appearance of ["dog", "penguin", "fish"] as const) test(`${appearance} appearance updates the sprite, native hit mask metadata and chat avatar`, async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 720 });
  await fixture(page); await page.goto("/?desktopPet=1");
  await expect.poll(() => page.evaluate(() => (window as any).petCalls.some((c: any) => c.command === "pet_sprite"))).toBe(true);
  await page.evaluate(async appearance => {
    const settings = await (window as any).__TAURI_INTERNALS__.invoke("pet_settings", {});
    const next = { ...settings, appearance };
    await (window as any).__TAURI_INTERNALS__.invoke("pet_save_settings", { settings: next });
    (window as any).petEvent("pet-settings-changed", next);
  }, appearance);
  await expect.poll(() => page.locator(".pet-sprite").evaluate(el => getComputedStyle(el).backgroundImage)).toContain(`${appearance}-sprites`);
  await expect.poll(() => page.evaluate(() => (window as any).petCalls.filter((c: any) => c.command === "pet_sprite").at(-1).args.appearance)).toBe(appearance);
  await page.screenshot({ path: `test-results/${appearance}-desktop-pet.png`, animations: "disabled" });
  await page.getByRole("button", { name: "双击嘴巴，和宠物聊天", exact: true }).dblclick();
  await expect(page.getByRole("dialog", { name: "和宠物聊天", exact: true })).toBeVisible();
  expect(await page.locator(".pet-chat-welcome-avatar").evaluate(el => getComputedStyle(el).backgroundImage)).toContain(`${appearance}-sprites`);
  await page.screenshot({ path: `test-results/${appearance}-chat.png`, animations: "disabled" });
  await page.keyboard.press("Escape");
  for (const [action, pose] of [[appearance !== "dog" ? "坐着玩耍" : "趴着陪伴", "lie_down"], ["陪我工作", "work"], ["喷水玩一下", "spray"], ["休息一下", "sleep"], ["起来活动", "idle"], [appearance === "fish" ? "游动一会" : "散步一会", "walk"]]) {
    await page.locator(".pet-avatar").click({ button: "right", position: { x: 8, y: 8 } });
    await page.getByRole("dialog", { name: "宠物快捷菜单", exact: true }).getByRole("button", { name: action, exact: true }).click();
    await page.mouse.move(500, 20);
    await expect(page.locator(".pet-sprite")).toHaveClass(new RegExp(`pet-pose-${pose}`));
  }
  if (appearance !== "dog") {
    await page.locator(".pet-avatar").click({ button: "right", position: { x: 8, y: 8 } });
    await page.getByRole("button", { name: "飞行玩一下", exact: true }).click();
    await expect(page.locator(".pet-sprite")).toHaveClass(/pet-pose-hanging/);
  }
  if (appearance === "fish") {
    await page.evaluate(() => (window as any).petEvent("pet-docked",true));
    await page.setViewportSize({width:75,height:68});
    const head=page.locator(".pet-dock-handle");
    await expect(head).toBeVisible();
    await expect(head.locator("svg")).toBeVisible();
    await expect(head).toHaveCSS("background-image", "none");
    await page.screenshot({path:"test-results/fish-head.png",omitBackground:true});
    await page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke("pet_move",{reveal:true}));
  }
  await page.setViewportSize({ width: 1200, height: 840 });
  const image = await page.locator(".pet-sprite").evaluate(el => getComputedStyle(el).backgroundImage);
  await page.evaluate(({ image, frames, appearance }) => {
    const gallery = document.createElement("div");
    gallery.style.cssText = "position:fixed;inset:0;z-index:99999;background:#282828;display:grid;grid-template-columns:repeat(6,1fr);gap:6px;padding:12px;color:#dedede";
    const names = ["待机", "眨眼", appearance !== "dog" ? "招手" : "摇尾", "走路1", "走路2", appearance !== "dog" ? "玩耍/坐下" : "趴下", ...Array.from({ length: 6 }, (_, i) => `跑动${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `喷水${i + 1}`), "睡眠", "开心", "好奇", appearance !== "dog" ? "飞行/提起" : "提起/攀爬", "工作", "担心/告警"];
    frames.forEach(([x, y, w, h], i) => {
      const item = document.createElement("div"); item.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;background:#202020;border:1px solid #414141";
      const sprite = document.createElement("span"); sprite.style.cssText = "display:block;width:160px;height:160px;background-repeat:no-repeat";
      sprite.style.backgroundImage = image; sprite.style.backgroundSize = `${1536 / w * 100}% ${1024 / h * 100}%`; sprite.style.backgroundPosition = `${x / (1536 - w) * 100}% ${y / (1024 - h) * 100}%`;
      const label = document.createElement("small"); label.textContent = names[i]; item.append(sprite, label); gallery.append(item);
    });
    document.body.append(gallery);
  }, { image, frames: appearance === "fish" ? fishFrames : appearance === "penguin" ? penguinFrames : dogFrames, appearance });
  await page.screenshot({ path: `test-results/${appearance === "dog" ? "corgi" : appearance}-all-frames.png`, animations: "disabled" });
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
  const pet=page.getByRole("checkbox",{name:/启用桌宠/});
  const monitoring=page.getByRole("checkbox",{name:/启用运维预警/});
  await expect(pet).not.toBeChecked(); await expect(monitoring).not.toBeChecked();
  await expect(page.locator(".pet-settings-disclosure[open]")).toHaveCount(0);
  await expect(page.locator(".pet-control-card")).toHaveCount(3);
  await monitoring.check(); await expect(monitoring).toBeChecked(); await expect(pet).not.toBeChecked();
  await expect(petSection.getByText("运维预警 已启用")).toBeVisible();
  await page.evaluate(() => { (window as any).failPetSave=true; });
  await pet.click(); await expect(page.locator(".pet-settings-section [role=alert]")).toBeVisible(); await expect(pet).not.toBeChecked();
  await page.getByRole("button",{name:/提醒记录（/}).click();
  await expect(page.getByRole("dialog",{name:"运维提醒记录"})).toBeVisible();
  await page.mouse.click(5,5); await expect(page.getByRole("dialog",{name:"运维提醒记录"})).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog",{name:"运维提醒记录"})).toHaveCount(0);
});

test("expanded pet settings stay compact and fit desktop and narrow widths", async ({ page }) => {
  await fixture(page); await page.goto("/");
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  const section = page.locator(".pet-settings-section");
  await section.getByRole("button", { name: "展开" }).click();
  await section.locator("summary").first().click();
  await section.locator("summary").filter({ hasText: "检查范围与提醒规则" }).click();
  await expect(section.getByLabel("活动范围")).toBeVisible();
  for (const width of [1440, 1024, 768, 375]) {
    await page.setViewportSize({ width, height: 1100 });
    await section.scrollIntoViewIfNeeded();
    expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    for (const select of await section.locator("select").all()) {
      expect(await select.evaluate(el => { const a = el.getBoundingClientRect(); const b = el.closest(".pet-settings-section")!.getBoundingClientRect(); return a.left >= b.left && a.right <= b.right; })).toBe(true);
    }
    await section.screenshot({ path: `test-results/alpaca-settings-expanded-${width}.png`, animations: "disabled" });
  }
});

test("desktop notification remains usable when the companion is disabled", async ({ page }) => {
  await fixture(page,false); await page.setViewportSize({width:360,height:240}); await page.goto("/?desktopPetAlerts=1");
  await expect(page.getByRole("dialog",{name:"CloudHub 运维提醒"})).toBeVisible();
  const notification = page.getByRole("dialog",{name:"CloudHub 运维提醒"});
  await expect(notification).toHaveClass(/dialog-common-theme/);
  await expect(notification).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(notification.locator("header")).toHaveCSS("background-color", "rgb(243, 243, 244)");
  await expect(page.getByText("证书即将到期",{exact:true})).toBeVisible();
  await expect(page.locator(".pet-avatar")).toHaveCount(0);
  await page.getByRole("button",{name:"一小时后提醒"}).click();
  expect(await page.evaluate(() => (window as any).petCalls.filter((c:any) => ["pet_snooze","pet_dismiss"].includes(c.command)).map((c:any)=>c.command))).toEqual(["pet_snooze","pet_dismiss"]);
});

test("main window routes a panel alert to the matching panel filter", async ({page})=>{
  await fixture(page,false); await page.goto("/");
  await page.getByRole("button",{name:"系统设置",exact:true}).click();
  await page.locator(".pet-settings-section").getByRole("button",{name:"展开"}).click();
  await expect(page.getByRole("checkbox",{name:/启用桌宠/})).toBeVisible();
  await page.evaluate(()=> (window as any).petEvent("pet-open-section",{section:"panels",key:"panel:7:service:web"}));
  await expect(page.getByRole("textbox",{name:"搜索面板",exact:true})).toHaveValue("测试面板");
});
