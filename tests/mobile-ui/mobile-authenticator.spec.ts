import { expect, test } from "@playwright/test";

test("mobile browser uses the local authenticator API", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  await page.route("**/api/authenticator", route => {
    const { op } = route.request().postDataJSON();
    return route.fulfill({ json: op === "status" ? { initialized: true, unlocked: true, passwordRequired: false } : [] });
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
  await page.locator(".mobile-more-feature").filter({ hasText: "验证器" }).click();
  await expect(page.getByRole("button", { name: "新增", exact: true })).toBeVisible();
  await expect(page.locator(".auth-card")).toHaveCount(0);
});

test("mobile authenticator follows Flow and copies all fields without moving cards", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 Android CloudHub" });
    const entries = [
      { id: "fixture-one", issuer: "Google", account: "demo@example.test", kind: "totp", algorithm: "SHA1", digits: 6, period: 30, counter: "0", group: "", note: "", pinned: false, order: 0 },
      { id: "fixture-two", issuer: "OpenAI", account: "other@example.test", kind: "totp", algorithm: "SHA1", digits: 6, period: 30, counter: "0", group: "", note: "", pinned: false, order: 1 },
    ];
    (window as any).authCalls = [];
    let permissionRequests = 0;
    let locked = false;
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      (window as any).authCalls.push({ command, args });
      if (command === "authenticator_status") { locked = false; return { initialized: true, unlocked: true, passwordRequired: false }; }
      if (command === "authenticator_lock") { locked = true; return null; }
      if (command.startsWith("authenticator_") && locked) throw new Error("验证器已锁定");
      if (command === "authenticator_list") return entries;
      if (command === "authenticator_codes") return entries.filter(item => args.ids.includes(item.id)).map(item => ({ id: item.id, current: "287082", next: "359152", remaining: 17, period: 30 }));
      if (command.endsWith("|request_permissions")) return { camera: permissionRequests++ === 0 ? "denied" : "granted" };
      if (command.endsWith("|scan")) {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        await new Promise(resolve => setTimeout(resolve, 50));
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
        return { content: "otpauth://totp/Example:demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", format: "QR_CODE" };
      }
      if (command === "authenticator_prepare") return { token: "fixture-stage", format: "Ente 明文", errors: [], items: [{ entry: { ...entries[0], id: "incoming-one" }, duplicateId: entries[0].id, conflict: false }, { entry: { ...entries[1], id: "incoming-two" }, duplicateId: null, conflict: false }] };
      if (command === "authenticator_import") return { added: 1, updated: 0, skipped: 1 };
      if (command === "authenticator_export") return "系统选择的备份文件";
      return [];
    } };
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
  const features = await page.locator(".mobile-more-feature").allTextContents();
  expect(features.findIndex(text => text.includes("验证器"))).toBe(features.findIndex(text => text.includes("流水线")) + 1);
  await page.locator(".mobile-more-feature").filter({ hasText: "验证器" }).click();
  await expect(page.locator(".auth-card")).toHaveCount(2);
  const card = page.locator(".auth-card").first();
  await expect(page.getByRole("button", { name: "复制 demo@example.test 验证码", exact: true })).toBeEnabled();
  const box = await card.boundingBox();
  for (const [name, text] of [["复制 demo@example.test 验证码", "验证码复制成功"], ["复制账号 demo@example.test", "账号复制成功"], ["复制 demo@example.test 下一个验证码", "下一个验证码复制成功"]]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".auth-copy-toast")).toContainText(text);
    expect(await card.boundingBox()).toEqual(box);
  }
  const calls = await page.evaluate(() => (window as any).authCalls.filter((item: any) => item.command === "authenticator_copy"));
  expect(calls.map((item: any) => item.args.target)).toEqual(["current", "account", "next"]);
  expect(await page.locator(".mobile-content").evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
  await page.screenshot({ path: "test-results/mobile-authenticator.png" });
  for (const width of [768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.locator(".mobile-content").evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByLabel("选择 Google demo@example.test").check();
  for (const width of [375, 450, 650]) {
    await page.setViewportSize({ width, height: 812 });
    await page.getByRole("button", { name: "卡片视图", exact: true }).click();
    const cardHeight = (await card.boundingBox())!.height;
    await page.getByRole("button", { name: "列表视图", exact: true }).click();
    await expect(page.getByRole("button", { name: "列表视图", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect((await card.boundingBox())!.height).toBeLessThan(cardHeight * 0.85);
    await expect(page.locator(".auth-card")).toHaveCount(2);
    await expect(page.getByLabel("选择 Google demo@example.test")).toBeChecked();
    await expect(page.getByRole("button", { name: "复制账号 demo@example.test", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "复制 demo@example.test 下一个验证码", exact: true })).toBeEnabled();
    expect(await page.locator(".mobile-content").evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: "test-results/mobile-authenticator-list.png" });
  await page.getByRole("button", { name: "卡片视图", exact: true }).click();
  await expect(page.getByRole("button", { name: "列表视图", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByLabel("选择 Google demo@example.test").uncheck();
  await page.getByLabel("搜索验证码").fill("other");
  await expect(page.locator(".auth-card")).toHaveCount(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".auth-card")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).authCalls.some((item: any) => item.command === "authenticator_lock"))).toBeTruthy();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".auth-card")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "复制 other@example.test 验证码", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.getByRole("button", { name: "扫描二维码", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("相机权限");
  await page.getByRole("button", { name: "扫描二维码", exact: true }).click();
  await expect(page.getByLabel("导入操作 demo@example.test")).toHaveValue("skip");
  await page.getByRole("button", { name: "重新选择", exact: true }).click();
  await page.getByRole("button", { name: "选择导入文件", exact: true }).click();
  await expect(page.getByLabel("导入操作 demo@example.test")).toHaveValue("skip");
  await expect(page.getByLabel("导入操作 other@example.test")).toHaveValue("add");
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("新增 1，更新 0，跳过 1");
  await page.getByLabel("选择 OpenAI other@example.test").check();
  await page.getByRole("button", { name: "导出所选", exact: true }).click();
  await page.getByLabel("导出密码", { exact: true }).fill("fixture-backup-password");
  await page.getByLabel("确认导出密码", { exact: true }).fill("fixture-backup-password");
  await page.getByRole("button", { name: "选择位置并导出" }).click();
  await expect(page.getByRole("status")).toContainText("已导出 1 项");
  expect(await page.evaluate(() => (window as any).authCalls.find((item: any) => item.command === "authenticator_export").args.ids)).toEqual(["fixture-two"]);
});
