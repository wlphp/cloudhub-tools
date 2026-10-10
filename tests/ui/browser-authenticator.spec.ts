import { test, expect } from "@playwright/test";

test("browser authenticator copies and imports/exports with browser file controls", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const entry = { id: "fixture-web", issuer: "Example", account: "web@example.test", kind: "totp", algorithm: "SHA1", digits: 6, period: 30, counter: "0", group: "", note: "", pinned: false, order: 0 };
  const calls: any[] = [];
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  await page.route("**/api/authenticator", async route => {
    const body = route.request().postDataJSON(); calls.push(body);
    const results: Record<string, unknown> = {
      status: { initialized: true, unlocked: true, passwordRequired: false }, list: [entry],
      codes: [{ id: entry.id, current: "287082", next: "359152", remaining: 17, period: 30, counter: "0" }],
      prepare: { token: "web-stage", format: "OTP 明文", errors: [], items: [{ entry, duplicateId: null, conflict: false }] },
      import: { added: 1, updated: 0, skipped: 0 }, export: { content: "fixture-encrypted-content", filename: "fixture-backup.json" },
    };
    await route.fulfill({ json: results[body.op] ?? null });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "验证器", exact: true }).first().click();
  const card = page.locator(".auth-card").first();
  await expect(page.getByRole("button", { name: "复制 web@example.test 验证码", exact: true })).toBeEnabled();
  const before = await card.boundingBox();
  for (const [name, expected] of [["复制 web@example.test 验证码", "287082"], ["复制账号 web@example.test", "web@example.test"], ["复制 web@example.test 下一个验证码", "359152"]]) {
    await page.getByRole("button", { name, exact: true }).click();
    const message = name.includes("复制账号") ? "账号复制成功" : name.includes("下一个") ? "下一个验证码复制成功" : "验证码复制成功";
    await expect(page.locator(".auth-copy-toast")).toHaveText(`Example · web@example.test：${message}`);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
    expect(await card.boundingBox()).toEqual(before);
  }
  await page.getByRole("button", { name: "导入", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "选择导入文件", exact: true }).click();
  await (await chooser).setFiles({ name: "fixture.txt", mimeType: "text/plain", buffer: Buffer.from("otpauth://totp/Example:web?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ") });
  await expect(page.getByLabel("导入操作 web@example.test")).toHaveValue("add");
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await page.getByLabel("选择 Example web@example.test").check();
  await page.getByRole("button", { name: "导出所选", exact: true }).click();
  await page.getByLabel("导出密码", { exact: true }).fill("fixture-backup-password");
  await page.getByLabel("确认导出密码", { exact: true }).fill("fixture-backup-password");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "选择位置并导出" }).click();
  expect((await downloaded).suggestedFilename()).toBe("fixture-backup.json");
  expect(calls.find(call => call.op === "export").args.ids).toEqual([entry.id]);
});
