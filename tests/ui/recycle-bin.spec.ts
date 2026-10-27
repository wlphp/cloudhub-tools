import { expect, test, type Page } from "@playwright/test";

const TRASH = [
  { kind: "panel_connections", label: "面板连接", items: [{ kind: "panel_connections", id: "4", title: "生产运维面板", deletedAt: 1_700_000_300_000 }] },
  { kind: "managed_hosts", label: "SSH 主机", items: [{ kind: "managed_hosts", id: "7", title: "旧测试机", deletedAt: 1_700_000_100_000 }] },
  { kind: "flow_connections", label: "云效流水线", items: [] },
  { kind: "memo_notes", label: "备忘录", items: [{ kind: "memo_notes", id: "9", title: "旧版部署说明", deletedAt: 1_700_000_200_000 }] },
  { kind: "cloud_accounts", label: "云账号", items: [{ kind: "cloud_accounts", id: "2", title: "阿里云生产账号", deletedAt: 1_700_000_400_000 }] },
  { kind: "certificates", label: "HTTPS 证书", items: [{ kind: "certificates", id: "5", title: "example.test", deletedAt: 1_700_000_500_000 }] },
  // Text-keyed table: the id stays a string all the way through the UI.
  { kind: "authenticator_entries", label: "身份验证器", items: [{ kind: "authenticator_entries", id: "key-abc", title: "GitHub · octocat", deletedAt: 1_700_000_600_000 }] },
  { kind: "codex_accounts", label: "Codex 账号", items: [] },
];

async function openSettings(page: Page) {
  await page.addInitScript((seed: unknown) => {
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args?: any) => {
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        if (command === "ai_list_profiles") return [{ id: "f", name: "T", protocol: "openai_chat", model: "m", enabled: true, isDefault: true, visionStatus: "supported" }];
        if (command === "trash_list") return { groups: seed, scrubDays: 30, scrubbedNow: 0 };
        if (command === "trash_set_scrub_days") return args?.days ?? 30;
        if (command === "trash_scrub_now") return 0;
        if (command === "trash_restore") {
          const calls = (window as any).__restoreCalls ??= [];
          calls.push(args);
          if ((window as any).__restoreFailKind === args.kind) throw new Error("恢复失败");
          for (const group of seed as any[]) if (group.kind === args.kind) group.items = group.items.filter((item: any) => !args.ids.includes(item.id));
          return args.ids.length;
        }
        if (command === "trash_purge" || command === "trash_empty") return 1;
        return [];
      },
    };
  }, TRASH);
  await page.goto("/");
  // Narrow windows collapse the sidebar; expand it so the nav item is clickable.
  const expand = page.getByRole("button", { name: "展开主导航" });
  if (await expand.count()) await expand.first().click();
  await page.getByRole("button", { name: "系统设置", exact: true }).first().click();
  await page.getByRole("tab", { name: "数据管理" }).click();
}

test("settings exposes the recycle bin and groups every deleted type", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);

  const entry = page.getByRole("button", { name: /回收站/ }).first();
  await expect(entry).toBeVisible();
  await expect(entry).toContainText("6 项已删除数据");
  // The entry is a full-width card whose copy stays left-aligned like its
  // siblings; it must not collapse into centered text.
  const layout = await entry.evaluate(element => {
    const style = getComputedStyle(element);
    const copy = element.querySelector(".settings-copy")!.getBoundingClientRect();
    const icon = element.querySelector(".settings-icon")!.getBoundingClientRect();
    return { align: style.textAlign, width: element.getBoundingClientRect().width, copyLeft: copy.left, iconLeft: icon.left, iconRight: icon.right };
  });
  expect(layout.align).toBe("left");
  expect(layout.copyLeft).toBeGreaterThanOrEqual(layout.iconRight);
  expect(layout.width).toBeGreaterThan(400);

  await entry.click();
  const bin = page.locator("body > .modal-backdrop .recycle-bin");
  await expect(bin).toBeVisible();
  // Every type appears with its own group heading; empty ones are hidden.
  await expect(bin.locator(".recycle-bin-kind", { hasText: "面板连接" })).toBeVisible();
  await expect(bin.locator(".recycle-bin-kind", { hasText: "SSH 主机" })).toBeVisible();
  await expect(bin.locator(".recycle-bin-kind", { hasText: "备忘录" })).toBeVisible();
  await expect(bin.locator(".recycle-bin-kind", { hasText: "云效流水线" })).toHaveCount(0);
  await expect(bin.locator(".recycle-bin-kind", { hasText: "Codex 账号" })).toHaveCount(0);
  // The four newly covered types appear with their own labels and titles.
  await expect(bin.locator(".recycle-bin-kind", { hasText: "云账号" })).toBeVisible();
  await expect(bin.locator(".recycle-bin-kind", { hasText: "HTTPS 证书" })).toBeVisible();
  await expect(bin.locator(".recycle-bin-kind", { hasText: "身份验证器" })).toBeVisible();
  await expect(bin).toContainText("阿里云生产账号");
  await expect(bin).toContainText("example.test");
  await expect(bin).toContainText("GitHub · octocat");
  await expect(bin).toContainText("生产运维面板");
  await expect(bin).toContainText("永久保留");

  await page.keyboard.press("Escape");
  await expect(page.locator(".recycle-bin")).toHaveCount(0);
});

test("restoring from the settings bin closes the dialog and reloads the list", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);
  await page.getByRole("button", { name: /回收站/ }).first().click();

  const bin = page.locator("body > .modal-backdrop .recycle-bin");
  const panels = bin.locator(".recycle-bin-group", { hasText: "面板连接" });
  await panels.getByLabel("选择 生产运维面板").check();
  await panels.getByRole("button", { name: /^批量恢复/ }).click();
  await expect(page.locator(".recycle-bin")).toHaveCount(0);
});

test("all selected types restore together and a failed group remains selected for retry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);
  await page.getByRole("button", { name: /回收站/ }).first().click();
  const bin = page.locator(".recycle-bin");
  await bin.getByLabel("全选当前结果").check();
  await page.evaluate(() => { (window as any).__restoreFailKind = "managed_hosts"; });
  await bin.getByRole("button", { name: /^恢复所有选中项/ }).click();
  await expect(bin.getByRole("alert")).toContainText("批量恢复未全部完成");
  await expect(bin.getByLabel("选择 生产运维面板")).toHaveCount(0);
  await expect(bin.getByLabel("选择 旧测试机")).toBeChecked();
  await expect(bin.getByLabel("选择 GitHub · octocat")).toBeChecked();
  await page.evaluate(() => { (window as any).__restoreFailKind = null; });
  await bin.getByRole("button", { name: /^恢复所有选中项/ }).click();
  await expect(bin).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).__restoreCalls);
  expect(calls.filter((call: any) => call.kind === "panel_connections")).toHaveLength(1);
  expect(calls.at(-1)).toEqual({ kind: "authenticator_entries", ids: ["key-abc"] });
});

test("purging asks for confirmation because it cannot be undone", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);
  await page.getByRole("button", { name: /回收站/ }).first().click();

  const bin = page.locator("body > .modal-backdrop .recycle-bin");
  const hosts = bin.locator(".recycle-bin-group", { hasText: "SSH 主机" });
  await hosts.getByLabel("选择 旧测试机").check();
  // Declining the shared confirmation leaves the rows in place.
  await hosts.getByRole("button", { name: /^彻底删除/ }).click();
  const confirmation = page.getByRole("alertdialog", { name: "彻底删除回收站数据" });
  await expect(confirmation).toBeVisible();
  await expect(page.locator("body > .modal-backdrop")).toHaveCount(2);
  await confirmation.getByRole("button", { name: "取消" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(bin).toBeVisible();
  await expect(bin).toContainText("旧测试机");
});

test("short desktop windows keep settings accessible below the scrolling navigation", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 700 });
  await openSettings(page);
  const sidebar = page.locator(".app-main-sidebar");
  const nav = sidebar.locator("nav");
  await nav.evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => nav.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await nav.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => nav.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const settings = sidebar.getByRole("button", { name: "系统设置" });
  await expect(settings).toBeVisible();
  const visible = await settings.evaluate(element => {
    const button = element.getBoundingClientRect();
    const viewport = element.closest(".app-main-sidebar")!.getBoundingClientRect();
    return button.top >= viewport.top && button.bottom <= viewport.bottom;
  });
  expect(visible).toBe(true);
  await settings.click();
  await expect(page.getByRole("tab", { name: "数据管理" })).toBeVisible();
});

// 375px renders the mobile shell, which has no 系统设置 entry; the recycle bin
// is a desktop feature, so only the desktop breakpoints are covered here.
for (const width of [768, 1024, 1440]) {
  test(`recycle bin dialog stays within ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openSettings(page);
    await page.getByRole("button", { name: /回收站/ }).first().click();
    const dialog = page.locator("body > .modal-backdrop .trash-dialog");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    expect(await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
  });
}

test("credential retention can be changed and secrets cleared on demand", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const calls: string[] = [];
  await page.addInitScript((seed: unknown) => {
    (window as any).__trashCalls = [];
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args?: any) => {
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        if (command === "ai_list_profiles") return [{ id: "f", name: "T", protocol: "openai_chat", model: "m", enabled: true, isDefault: true, visionStatus: "supported" }];
        if (command === "trash_list") return { groups: seed, scrubDays: 30, scrubbedNow: 0 };
        if (command === "trash_set_scrub_days") { (window as any).__trashCalls.push(`set:${args?.days}`); return args?.days ?? 30; }
        if (command === "trash_scrub_now") { (window as any).__trashCalls.push("scrub"); return 3; }
        return [];
      },
    };
  }, TRASH);
  await page.goto("/");
  await page.getByRole("button", { name: "系统设置", exact: true }).first().click();
  await page.getByRole("tab", { name: "数据管理" }).click();
  await page.getByRole("button", { name: /回收站/ }).first().click();

  const bin = page.locator("body > .modal-backdrop .recycle-bin");
  const select = bin.getByLabel("凭据保留天数");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("30");
  await select.selectOption("7");
  await expect.poll(() => page.evaluate(() => (window as any).__trashCalls)).toContain("set:7");

  // Saving refreshes the snapshot and re-renders the panel, so re-resolve.
  await page.locator("body > .modal-backdrop .recycle-bin").getByRole("button", { name: "立即清理密钥" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__trashCalls)).toContain("scrub");
  await expect(bin).toContainText("缩小本机密钥留存面");
});
