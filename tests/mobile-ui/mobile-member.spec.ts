import { expect, test } from "@playwright/test";

test("opens the member management page from More and keeps it usable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route("**/api/accounts**", route => route.fulfill({ json: [] }));
  await page.route("**/api/local-assets**", route => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "更多" }).click();

  const entry = page.locator(".mobile-more-member");
  await expect(entry).toContainText("会员登录 / 注册");
  await entry.click();

  const memberPage = page.locator(".mobile-member-page");
  await expect(memberPage.getByRole("heading", { name: "会员管理", exact: true })).toBeVisible();
  await expect(memberPage).toContainText("当前为浏览器预览，请使用原生客户端登录。");
  await expect(memberPage.getByRole("button", { name: "获取验证码" })).toBeDisabled();
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 320);

  await memberPage.getByRole("button", { name: "返回更多管理" }).click();
  await expect(memberPage).toHaveCount(0);
});

test("shows the signed-in nickname and VIP identity and saves a nickname change", async ({ page }) => {
  const member = {
    id: 42,
    email: "member@example.test",
    nickname: "云端访客",
    avatar_key: 3,
    is_vip: true,
    is_admin: false,
    status: "active",
    created_at: "2026-10-01 10:00:00",
    last_login_at: null,
  };
  await page.addInitScript((initialMember) => {
    const current = { ...initialMember };
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: any) => {
        if (command === "member_me") return current;
        if (command === "member_login_logs") return [];
        if (command === "member_nickname") return { ...current, nickname: args.nickname };
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        return [];
      },
    };
  }, member);
  await page.route("**/api/accounts**", route => route.fulfill({ json: [] }));
  await page.route("**/api/local-assets**", route => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "更多" }).click();

  const entry = page.locator(".mobile-more-member");
  await expect(entry).toContainText("云端访客");
  await expect(entry).toContainText("member@example.test");
  await expect(entry).toContainText("VIP");
  await entry.click();
  const profile = page.locator(".mobile-member-page");
  await expect(profile.getByRole("heading", { name: "会员管理", exact: true })).toBeVisible();
  await expect(profile).toContainText("云端访客");
  await expect(profile).toContainText("member@example.test");
  await expect(profile).toContainText("VIP");
  await profile.getByRole("button", { name: "修改昵称" }).click();

  await profile.getByLabel("修改昵称", { exact: true }).fill("移动端昵称");
  await profile.getByRole("button", { name: "保存", exact: true }).click();
  await expect(profile).toContainText("移动端昵称");
  await profile.getByRole("button", { name: "返回更多管理" }).click();
  await expect(page.locator(".mobile-more-member")).toContainText("移动端昵称");
});
