import { expect, test } from "@playwright/test";

test("orders the personal quick links and renames the accounts tab to home", async ({ page }) => {
  await page.route("**/api/accounts**", route => route.fulfill({ json: [] }));
  await page.route("**/api/local-assets**", route => route.fulfill({ json: [] }));
  await page.goto("/");
  const navigation = page.locator(".mobile-tab-bar");
  await navigation.getByRole("button", { name: "我的", exact: true }).click();
  await expect(page.locator(".mobile-more-shortcuts button")).toHaveText(["我的账号", "我的资产", "我的收藏", "运维面板", "SSH 终端"]);
  await expect(page.locator(".mobile-more-feature").first()).toContainText("域名与 DNS");
  await expect(page.locator(".mobile-more-feature").nth(1)).toContainText("对象存储");
  await page.locator(".mobile-more-shortcuts").getByRole("button", { name: "我的账号" }).click();
  await expect(page.getByRole("heading", { name: "云账号", exact: true })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "我的", exact: true })).toHaveAttribute("aria-current", "page");
});

async function openMemberFromSettings(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "我的", exact: true }).click();
  await page.getByRole("button", { name: "系统设置" }).click();
  await page.getByRole("button", { name: /登录 \/ 注册|云端访客/ }).click();
}

test("opens the member login screen from settings and supports browser preview on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route("**/api/accounts**", route => route.fulfill({ json: [] }));
  await page.route("**/api/local-assets**", route => route.fulfill({ json: [] }));
  await page.goto("/");
  await openMemberFromSettings(page);

  const memberPage = page.locator(".mobile-member-page");
  await expect(memberPage.getByRole("heading", { name: "登录 / 注册", exact: true })).toBeVisible();
  await expect(memberPage.getByRole("button", { name: "获取验证码" })).toBeEnabled();
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 320);
  await memberPage.getByRole("button", { name: "返回", exact: true }).click();
  await expect(memberPage).toHaveCount(0);
});

test("sending a mobile verification code keeps login stable and remembers the email", async ({ page }) => {
  await page.route("**/api/accounts**", route => route.fulfill({ json: [] }));
  await page.route("**/api/local-assets**", route => route.fulfill({ json: [] }));
  await page.route("**/api/member", async route => {
    const { op } = route.request().postDataJSON();
    if (op === "me") return route.fulfill({ json: null });
    if (op === "send_code") {
      await new Promise(resolve => setTimeout(resolve, 500));
      return route.fulfill({ json: 60 });
    }
    return route.fulfill({ json: true });
  });
  await page.goto("/");
  await openMemberFromSettings(page);

  const memberPage = page.locator(".mobile-member-page");
  const emailInput = memberPage.getByLabel("邮箱", { exact: true });
  await emailInput.fill("member@example.test");
  const loginButton = memberPage.getByRole("button", { name: "登录 / 注册" });
  await memberPage.getByRole("button", { name: "获取验证码" }).click();
  await expect(loginButton).toBeEnabled();
  await expect(loginButton).toHaveText("登录 / 注册");
  await expect(memberPage.getByRole("button", { name: "发送中…" })).toBeDisabled();
  await expect(memberPage.getByRole("button", { name: /60 秒/ })).toBeVisible();
  await expect(emailInput).toHaveValue("member@example.test");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cloudhub-tools-member-email"))).toBe("member@example.test");
  await memberPage.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: /登录 \/ 注册/ }).click();
  await expect(page.locator("#mobile-member-email")).toHaveValue("member@example.test");
});

test("restores browser membership after reloading the mobile page", async ({ page }) => {
  const member = {
    id: 42,
    email: "member@example.test",
    nickname: "云端访客",
    bio: "",
    avatar_key: 3,
    is_vip: false,
    is_experience_officer: false,
    is_admin: false,
    status: "active",
    created_at: "2026-10-01 10:00:00",
    last_login_at: null,
  };
  await page.route("**/api/accounts**", route => route.fulfill({ json: [] }));
  await page.route("**/api/local-assets**", route => route.fulfill({ json: [] }));
  await page.route("**/api/member", route => {
    const input = route.request().postDataJSON();
    if (input.op === "send_code") return route.fulfill({ json: 60 });
    if (input.op === "login") return route.fulfill({ json: { member, session_id: "a".repeat(64) } });
    if (input.op === "me") return route.fulfill({ json: input.session_id ? member : null });
    if (input.op === "login_logs") return route.fulfill({ json: [] });
    return route.fulfill({ json: true });
  });
  await page.goto("/");
  await openMemberFromSettings(page);
  const profile = page.locator(".mobile-member-page");
  await profile.getByLabel("邮箱", { exact: true }).fill(member.email);
  await profile.getByRole("button", { name: "获取验证码" }).click();
  await profile.getByLabel("邮箱验证码", { exact: true }).fill("123456");
  await profile.getByRole("button", { name: "登录 / 注册" }).click();
  await expect(profile).toHaveCount(0);
  await expect(page.locator(".mobile-settings-profile-name")).toContainText("云端访客");

  await page.reload();
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的", exact: true }).click();
  const homeProfile = page.locator(".mobile-profile-header");
  await expect(homeProfile).toContainText("云端访客");
  await expect(homeProfile).toContainText("member@example.test");
  await expect(homeProfile).toContainText("注册日期：2026-10-01");
  await expect(homeProfile.getByRole("button", { name: "查看 VIP 身份卡" })).toBeVisible();
});

test("shows the signed-in nickname and VIP identity and saves a nickname change", async ({ page }) => {
  const member = {
    id: 42,
    email: "member@example.test",
    nickname: "云端访客",
    bio: "",
    avatar_key: 3,
    is_vip: true,
    is_experience_officer: false,
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
  await page.getByRole("button", { name: "我的", exact: true }).click();
  const homeProfile = page.locator(".mobile-profile-header");
  await expect(homeProfile).toContainText("云端访客");
  await expect(homeProfile).toContainText("member@example.test");
  await expect(homeProfile).toContainText("注册日期：2026-10-01");
  await expect(homeProfile.getByRole("button", { name: "查看 VIP 身份卡" })).toBeVisible();
  await expect(homeProfile.getByText("体验官", { exact: true })).toHaveCount(0);
  await expect(homeProfile.getByText("超级管理", { exact: true })).toHaveCount(0);
  await expect(homeProfile.getByLabel("产品体验馆")).toHaveCount(0);
  await expect(homeProfile.getByLabel("产品体验官")).toHaveCount(0);
  await openMemberFromSettings(page);

  const profile = page.locator(".mobile-personal-profile");
  await expect(page.getByRole("heading", { name: "个人资料", exact: true })).toBeVisible();
  await expect(profile).toContainText("云端访客");
  await profile.getByRole("button", { name: "云端访客" }).click();
  await profile.getByLabel("昵称", { exact: true }).fill("移动端昵称");
  await profile.getByRole("button", { name: "保存昵称" }).click();
  await expect(profile).toContainText("移动端昵称");
  await page.getByRole("button", { name: "返回设置" }).click();
  const settingsProfile = page.locator(".mobile-settings-profile");
  await expect(settingsProfile).toContainText("移动端昵称");
  await expect(settingsProfile).toContainText("member@example.test");
  await expect(settingsProfile).toContainText("注册日期：2026-10-01");
  await expect(settingsProfile.getByText("VIP", { exact: true })).toBeVisible();
  await expect(settingsProfile.getByText("体验官", { exact: true })).toHaveCount(0);
});

test("shows the experience officer badge for administrator ID 1", async ({ page }) => {
  const member = {
    id: 1,
    email: "admin@example.test",
    nickname: "超级管理员",
    bio: "",
    avatar_key: 1,
    is_vip: true,
    is_experience_officer: false,
    is_admin: true,
    status: "active",
    created_at: "2026-10-01 10:00:00",
    last_login_at: null,
  };
  await page.addInitScript((initialMember) => {
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string) => command === "member_me" ? initialMember : [],
    };
  }, member);
  await page.route("**/api/accounts**", route => route.fulfill({ json: [] }));
  await page.route("**/api/local-assets**", route => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的", exact: true }).click();

  const homeProfile = page.locator(".mobile-profile-header");
  await expect(homeProfile.getByRole("button", { name: "查看超级管理员身份卡" })).toBeVisible();
  await expect(homeProfile.getByRole("button", { name: "查看产品体验官身份卡" })).toBeVisible();
  await expect(homeProfile.locator(".mobile-member-status-badges")).toBeVisible();
  await expect(homeProfile.locator(".mobile-profile-header-main").locator("xpath=following-sibling::span").first()).toHaveClass(/mobile-member-status-badges/);
  await homeProfile.getByRole("button", { name: "查看产品体验官身份卡" }).click();
  const identityDialog = page.getByRole("dialog", { name: "产品体验官" });
  await expect(identityDialog).toBeVisible();
  await expect(identityDialog.getByRole("button", { name: "保存到相册" })).toBeVisible();
  await identityDialog.getByRole("button", { name: "关闭产品体验官" }).click();
  await expect(identityDialog).toHaveCount(0);
  await homeProfile.getByRole("button", { name: "查看 VIP 身份卡" }).click();
  await expect(page.getByRole("dialog", { name: "VIP 会员" })).toBeVisible();
  await page.getByRole("button", { name: "关闭VIP 会员" }).click();
  await homeProfile.getByRole("button", { name: "查看超级管理员身份卡" }).click();
  await expect(page.getByRole("dialog", { name: "超级管理员" })).toBeVisible();
});
