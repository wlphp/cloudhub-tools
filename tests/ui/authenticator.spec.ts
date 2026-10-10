import { expect, test } from "@playwright/test";

async function mockNative(page: import("@playwright/test").Page, legacy = false) {
  await page.addInitScript((legacyMode) => {
    let locked = legacyMode;
    let passwordRequired = legacyMode;
    let items = [
      { id: "fixture-totp", issuer: "Example", account: "demo@example.test", kind: "totp", algorithm: "SHA1", digits: 6, period: 30, counter: "0", group: "演示", note: "公开测试账户", pinned: false, order: 0 },
      { id: "fixture-hotp", issuer: "Counter", account: "counter@example.test", kind: "hotp", algorithm: "SHA1", digits: 6, period: 30, counter: "17", group: "", note: "", pinned: false, order: 1 },
    ];
    const calls: Array<{ command: string; args: any }> = [];
    (window as any).authCalls = calls;
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        calls.push({ command, args: command === "authenticator_unlock" ? { create: args.create } : args });
        if (command === "authenticator_status") { if (!passwordRequired) locked = false; return { initialized: true, unlocked: !locked, passwordRequired }; }
        if (command === "authenticator_unlock") { if (args.password !== "test-passphrase") throw { kind: "platform-error", code: "authenticator-error", message: "无法解密，请检查密码或文件完整性" }; locked = false; passwordRequired = false; return null; }
        if (command === "authenticator_lock") { locked = true; return null; }
        if (command.startsWith("authenticator_") && locked) throw { kind: "platform-error", code: "authenticator-locked", message: "验证器已锁定，请重新解锁" };
        if (command === "authenticator_list") return items;
        if (command === "authenticator_codes") return items.filter((item) => args.ids.includes(item.id)).map((item) => ({ id: item.id, current: "287082", next: item.kind === "hotp" ? null : "359152", remaining: 17, period: 30, counter: item.counter }));
        if (command === "authenticator_prepare") return { token: "fixture-stage", format: "Ente 加密 v1", errors: ["第 3 行：OTP 数字参数无效"], items: [{ entry: { ...items[0], id: "incoming-duplicate" }, duplicateId: "fixture-totp", conflict: false }, { entry: { ...items[0], id: "incoming-new", account: "new@example.test" }, duplicateId: null, conflict: false }] };
        if (command === "authenticator_import") return { added: 1, updated: 0, skipped: 1 };
        if (command === "authenticator_export") return "C:/fixture/backup.json";
        if (command === "authenticator_save") { const input = args.input; const { secret: _secret, ...summary } = input; if (summary.id) items = items.map((item) => item.id === summary.id ? summary : item); else items.push({ ...summary, id: "fixture-added" }); return null; }
        if (command === "authenticator_remove") { items = items.filter((item) => !args.ids.includes(item.id)); return null; }
        if (command === "authenticator_advance") { items = items.map((item) => item.id === args.id ? { ...item, counter: (BigInt(item.counter) + 1n).toString() } : item); return null; }
        if (command === "plugin:app|version") return "0.1.43";
        if (command === "plugin:event|listen") return 1;
        return [];
      },
    };
  }, legacy);
  await page.goto("/");
  await page.getByRole("button", { name: "验证器", exact: true }).first().click();
}

async function unlock(page: import("@playwright/test").Page) {
  await expect(page.getByRole("button", { name: "复制 demo@example.test 验证码" })).toBeEnabled();
  await expect(page.getByLabel("主密码", { exact: true })).toHaveCount(0);
}

test("browser uses the local authenticator API", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/authenticator", route => {
    const { op } = route.request().postDataJSON();
    return route.fulfill({ json: op === "status" ? { initialized: true, unlocked: true, passwordRequired: false } : [] });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "验证器", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "新增", exact: true })).toBeVisible();
  await expect(page.getByLabel("主密码", { exact: true })).toHaveCount(0);
});

test("opens without a master password, copy, HOTP, edit and reopen", async ({ page }) => {
  await mockNative(page);
  await unlock(page);
  const card = page.locator(".auth-card").first();
  const beforeCopy = await card.boundingBox();
  await page.getByRole("button", { name: "复制 demo@example.test 验证码" }).click();
  await expect(page.locator(".auth-copy-toast")).toHaveText("Example · demo@example.test：验证码复制成功");
  expect(await card.boundingBox()).toEqual(beforeCopy);
  await expect(page.locator(".auth-copy-toast")).toHaveCount(0, { timeout: 5000 });
  expect(await card.boundingBox()).toEqual(beforeCopy);
  await page.getByRole("button", { name: "复制账号 demo@example.test", exact: true }).click();
  await expect(page.locator(".auth-copy-toast")).toContainText("账号复制成功");
  expect(await card.boundingBox()).toEqual(beforeCopy);
  await page.getByRole("button", { name: "复制 demo@example.test 下一个验证码", exact: true }).click();
  await expect(page.locator(".auth-copy-toast")).toContainText("下一个验证码复制成功");
  expect(await card.boundingBox()).toEqual(beforeCopy);
  const copyCalls = await page.evaluate(() => (window as any).authCalls.filter((call: any) => call.command === "authenticator_copy"));
  expect(copyCalls.map((call: any) => call.args)).toEqual([
    { id: "fixture-totp", target: "current" }, { id: "fixture-totp", target: "account" }, { id: "fixture-totp", target: "next" },
  ]);
  await page.getByRole("button", { name: "下一码 · 计数 17" }).click();
  await expect(page.getByRole("button", { name: "下一码 · 计数 18" })).toBeVisible();
  await page.getByLabel("搜索验证码").fill("demo");
  await expect(page.locator(".auth-card")).toHaveCount(1);
  await page.getByRole("button", { name: "编辑 demo@example.test" }).click();
  await page.getByRole("textbox", { name: "备注", exact: true }).fill("修改的演示备注");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("修改的演示备注", { exact: false }).first()).toBeVisible();
  await page.getByLabel("选择 Example demo@example.test").check();
  await page.getByRole("button", { name: "删除所选" }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".auth-card")).toHaveCount(1);
  await page.getByRole("button", { name: "账号管理", exact: true }).first().click();
  await page.getByRole("button", { name: "验证器", exact: true }).first().click();
  await unlock(page);
});

test("legacy vault requires its original password only for migration", async ({ page }) => {
  await mockNative(page, true);
  await page.getByLabel("原主密码", { exact: true }).fill("incorrect-password");
  await page.getByRole("button", { name: "迁移并打开", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("无法解密");
  await page.getByLabel("原主密码", { exact: true }).fill("test-passphrase");
  await page.getByRole("button", { name: "迁移并打开", exact: true }).click();
  await unlock(page);
  await page.getByRole("button", { name: "账号管理", exact: true }).first().click();
  await page.getByRole("button", { name: "验证器", exact: true }).first().click();
  await unlock(page);
  await expect(page.getByLabel("原主密码", { exact: true })).toHaveCount(0);
});

test("import previews conflicts and export requires explicit passwords", async ({ page }) => {
  await mockNative(page); await unlock(page);
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.getByLabel("文件密码（明文和二维码留空）").fill("fixture-backup-password");
  await page.getByRole("button", { name: "选择导入文件", exact: true }).click();
  await expect(page.getByLabel("导入操作 demo@example.test")).toHaveValue("skip");
  await expect(page.getByLabel("导入操作 new@example.test")).toHaveValue("add");
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("新增 1，更新 0，跳过 1");
  await page.getByLabel("选择 Example demo@example.test").check();
  await expect(page.getByRole("button", { name: "导出所选（1）", exact: true })).toBeVisible();
  await expect(page.getByLabel("选择本页")).toHaveJSProperty("indeterminate", true);
  await page.getByRole("button", { name: "导出所选", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("所选 1 项");
  await expect(page.getByLabel("再次输入主密码")).toHaveCount(0);
  await page.getByLabel("导出密码", { exact: true }).fill("fixture-backup-password");
  await page.getByLabel("确认导出密码", { exact: true }).fill("fixture-backup-password");
  await page.getByRole("button", { name: "选择位置并导出" }).click();
  await expect(page.getByRole("status")).toContainText("已导出 1 项");
  const calls = await page.evaluate(() => (window as any).authCalls);
  expect(calls.find((call: any) => call.command === "authenticator_export").args.ids).toEqual(["fixture-totp"]);
  expect(calls.find((call: any) => call.command === "authenticator_import").args.choices).toEqual([{ id: "incoming-duplicate", action: "skip" }, { id: "incoming-new", action: "add" }]);
});

test("provider categories count entries and filter without losing export selections", async ({ page }) => {
  await mockNative(page); await unlock(page);
  const categories = page.getByRole("group", { name: "服务商分类统计" });
  await expect(categories.getByRole("button", { name: "全部服务商，共 2 项" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("选择 Example demo@example.test").check();
  await categories.getByRole("button", { name: "Counter，共 1 项" }).click();
  await expect(page.locator(".auth-card")).toHaveCount(1);
  await expect(page.getByLabel("选择 Counter counter@example.test")).toBeVisible();
  await expect(page.getByText("已选 1 项", { exact: true })).toBeVisible();
  await page.getByLabel("搜索验证码").fill("demo");
  await expect(page.locator(".auth-card")).toHaveCount(0);
  await expect(categories.getByRole("button", { name: "Counter，共 1 项" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("搜索验证码").fill("");
  await categories.getByRole("button", { name: "全部服务商，共 2 项" }).click();
  await expect(page.locator(".auth-card")).toHaveCount(2);
  await expect(page.getByLabel("选择 Example demo@example.test")).toBeChecked();
  await page.getByRole("button", { name: "导出所选", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("所选 1 项");
});

test("desktop card and list stay within the viewport", async ({ page }) => {
  await mockNative(page); await unlock(page);
  for (const [account, issuer] of [["demo@example.test", "Google"], ["counter@example.test", "OpenAI"]]) {
    await page.getByRole("button", { name: `编辑 ${account}` }).click();
    await page.getByRole("textbox", { name: "服务商", exact: true }).fill(issuer);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await expect(page.locator(".auth-provider-icon img")).toHaveCount(2);
  await page.getByLabel("选择 Google demo@example.test").check();
  for (const width of [1024, 1440, 768, 375]) {
    await page.setViewportSize({ width, height: 850 });
    for (const layout of ["卡片视图", "列表视图"]) {
      await page.getByRole("button", { name: layout }).click();
      const bounds = await page.locator(".auth-panel").evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "卡片视图" }).click();
  await page.screenshot({ path: "test-results/authenticator-desktop.png", fullPage: true });
});
