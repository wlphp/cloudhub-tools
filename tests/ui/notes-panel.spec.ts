import { expect, test, type Page } from "@playwright/test";

const NOTES = [
  { id: 1, title: "生产环境 SSH 账号", body: "跳板机 10.0.0.9\nroot / 见密码框", group: "运维", tags: ["服务器", "生产"], account: "root@10.0.0.9", password: "fixture-secret", pinned: true, remindAt: null, remindRepeat: "none", remindDoneAt: null, createdAt: 1, updatedAt: 1_700_000_000_000, deletedAt: null },
  { id: 2, title: "内部 Wiki 账号", body: "只读账号", group: "公司", tags: ["账号密码"], account: "wiki-reader", password: "", pinned: false, remindAt: null, remindRepeat: "none", remindDoneAt: null, createdAt: 2, updatedAt: 1_700_000_100_000, deletedAt: null },
];

async function openNotes(page: Page) {
  await page.addInitScript((seed: any[]) => {
    const NOTES = seed as { id: number; title: string }[];
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: any) => {
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        const store = (window as any).__notesStore ??= { live: new Set([1, 2]), trash: new Map([[9, "旧版部署说明"]]) };
        const trashed = (id: number, title: string) => ({ id, title, body: "已废弃", group: "运维", tags: [] as string[], account: "", password: "", pinned: false, remindAt: null, remindRepeat: "none", remindDoneAt: null, createdAt: 3, updatedAt: 3, deletedAt: 1_700_000_200_000 });
        if (command === "notes_delete") {
          for (const id of args?.ids ?? []) { const key = Number(id); const note = NOTES.find((n) => n.id === key); if (store.live.delete(key) && note) store.trash.set(key, note.title); }
          return (args?.ids ?? []).length;
        }
        if (command === "notes_restore") {
          let count = 0;
          for (const id of args?.ids ?? []) if (store.trash.delete(Number(id))) { store.live.add(Number(id)); count++; }
          return count;
        }
        if (command === "notes_purge") {
          let count = 0;
          for (const id of args?.ids ?? []) if (store.trash.delete(Number(id))) count++;
          return count;
        }
        if (command === "notes_snapshot") return {
          notes: [...store.live].map((id: number) => ({ ...NOTES.find((n) => n.id === id)!, deletedAt: null })),
          trashed: [...store.trash].map(([id, title]) => trashed(id as number, title as string)),
          groups: ["公司", "运维"],
          reminders: [],
        };
        if (command === "notes_save") return 3;
        if (command === "notes_open") return null;
        return [];
      },
    };
  }, NOTES);
  await page.goto("/");
  await page.getByRole("button", { name: "备忘录", exact: true }).first().click();
  await expect(page.locator(".notes-card").first()).toBeVisible();
}

test("note editor reuses the shared dialog base instead of a bespoke overlay", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openNotes(page);
  await page.getByRole("button", { name: "新建备忘录", exact: true }).first().click();

  const dialog = page.locator("body > .modal-backdrop .notes-dialog");
  await expect(dialog).toBeVisible();
  // Portalled to document.body, not nested inside the panel content flow.
  await expect(page.locator(".notes-panel .notes-dialog")).toHaveCount(0);
  await expect(dialog).toHaveClass(/modal-form-layout/);
  await expect(dialog).toHaveClass(/dialog-common-theme/);
  await expect(dialog.locator("> .modal-head")).toBeVisible();
  await expect(dialog.locator(".modal-form-content > .modal-body")).toBeVisible();
  await expect(dialog.locator(".modal-form-content > .modal-actions")).toBeVisible();

  // Header and footer stay pinned while the body scrolls.
  const pinned = await dialog.evaluate(element => {
    const head = element.querySelector(".modal-head")!.getBoundingClientRect();
    const footer = element.querySelector(".modal-actions")!.getBoundingClientRect();
    const body = element.querySelector(".modal-body")! as HTMLElement;
    return { headTop: head.top, footerBottom: footer.bottom, dialogBottom: element.getBoundingClientRect().bottom, scrollable: body.scrollHeight > body.clientHeight, bodyScroll: body.scrollTop, horizontalOverflow: element.scrollWidth > element.clientWidth };
  });
  expect(pinned.dialogBottom - pinned.footerBottom).toBeLessThanOrEqual(1);
  if (pinned.scrollable) {
    await dialog.locator(".modal-body").evaluate(body => { body.scrollTop = body.scrollHeight; });
    const after = await dialog.locator(".modal-head").evaluate(head => head.getBoundingClientRect().top);
    expect(after).toBeCloseTo(pinned.headTop, 0);
  }
  expect(pinned.horizontalOverflow).toBe(false);

  // Escape closes and returns focus to the opener.
  await dialog.locator(".modal-body").getByLabel("标题").fill("回归标题");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新建备忘录", exact: true }).first()).toBeFocused();
});

test("delete confirmation uses the shared ConfirmDialog and blocks backdrop dismissal", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openNotes(page);
  await page.getByRole("button", { name: "删除 生产环境 SSH 账号", exact: true }).click();

  const confirm = page.locator("body > .app-confirm-backdrop .app-confirm-dialog");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("生产环境 SSH 账号");

  await page.locator("body > .app-confirm-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(confirm).toBeVisible();

  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator(".notes-card")).toHaveCount(2);
});

test("deleting a note moves it to the recycle bin where it can be restored", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openNotes(page);
  await page.getByRole("button", { name: "删除 生产环境 SSH 账号", exact: true }).click();
  await page.locator(".app-confirm-dialog").getByRole("button", { name: "移到回收站", exact: true }).click();
  await expect(page.locator(".notes-card")).toHaveCount(1);

  await page.getByRole("button", { name: /^回收站/ }).click();
  const bin = page.locator(".recycle-bin");
  await expect(bin).toBeVisible();
  await expect(bin).toContainText("生产环境 SSH 账号");
  await bin.getByLabel("选择 生产环境 SSH 账号").check();
  await bin.getByRole("button", { name: /^恢复/ }).click();

  await expect(page.locator(".recycle-bin")).toHaveCount(0);
  await expect(page.locator(".notes-card")).toHaveCount(2);
});

test("note viewer shows the full body, revealed password and jumps into the editor", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openNotes(page);
  await page.getByRole("button", { name: "查看 生产环境 SSH 账号", exact: true }).click();

  const viewer = page.locator("body > .modal-backdrop .notes-dialog");
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText("跳板机 10.0.0.9");
  // The password stays masked until explicitly revealed.
  await expect(viewer.locator("code.is-masked")).toHaveText("••••••••");
  await viewer.getByRole("button", { name: /^显示密码/ }).click();
  await expect(viewer.locator("code.is-masked")).toHaveCount(0);
  await expect(viewer).toContainText("fixture-secret");

  await viewer.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.locator("body > .modal-backdrop .notes-dialog");
  await expect(editor.getByLabel("标题")).toHaveValue("生产环境 SSH 账号");
});

for (const width of [375, 768, 1024, 1440]) {
  test(`notes panel and editor stay within ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await openNotes(page);
    await page.getByRole("button", { name: "新建备忘录", exact: true }).first().click();
    const dialog = page.locator(".notes-dialog");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    const overflow = await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1);
    expect(overflow).toBe(false);
  });
}

test("group and tag filters narrow the visible notes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openNotes(page);
  await page.locator(".notes-filters").first().getByRole("button", { name: /^运维/ }).click();
  await expect(page.locator(".notes-card")).toHaveCount(1);
  await expect(page.locator(".notes-card").first()).toContainText("生产环境 SSH 账号");
  await page.locator(".notes-tag-filters").getByRole("button", { name: "账号密码", exact: true }).click();
  await expect(page.locator(".notes-card")).toHaveCount(0);
  await page.locator(".notes-tag-filters").getByRole("button", { name: "账号密码", exact: true }).click();
  await page.locator(".notes-filters").first().getByRole("button", { name: /^全部/ }).click();
  await expect(page.locator(".notes-card")).toHaveCount(NOTES.length);
});
