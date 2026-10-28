import { expect, test, type Page } from "@playwright/test";

async function openMail(page: Page, native = true) {
 await page.route("**/api/**", route => route.fulfill({ json: [] }));
 if (native) await page.addInitScript(() => {
  const account = { id: "mail-1", name: "测试邮箱", email: "reader@example.test", username: "reader@example.test", imapHost: "imap.example.test", imapPort: 993, smtpHost: "smtp.example.test", smtpPort: 465, smtpSecurity: "tls" };
  (window as any).__mailCalls = [];
  (window as any).__TAURI_INTERNALS__ = {
   metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {},
   invoke: async (command: string, args?: any) => {
    if (command.startsWith("mail_")) (window as any).__mailCalls.push({ command, args });
    if (command === "mail_accounts") return [account];
    if (command === "mail_reveal_secret") return "模拟回显内容";
    if (command === "mail_save") { const { password, ...result } = args.input; return { ...result, id: result.id || "mail-2" }; }
    if (command === "mail_folders") {
     if ((window as any).__mailFolderFail) throw new Error("读取邮件文件夹时邮件后台任务异常退出");
     return ["INBOX", "Sent"];
    }
    if (command === "mail_test") return (window as any).__mailTestFailed
     ? { imap: false, smtp: false, imapError: "IMAP 检测遇到无法识别的服务器响应", smtpError: "SMTP 连接失败，请检查服务器、端口和网络" }
     : { imap: true, smtp: false };
    if (command === "mail_list") {
     if ((window as any).__mailFail) throw new Error("IMAP 登录失败，请检查授权码");
     return { validity: 23, total: 1, messages: [{ uid: 41, subject: "上线通知", from: "Sender <sender@example.test>", date: "2026-10-28", unread: true, size: 800 }] };
    }
    if (command === "mail_read") return { subject: "上线通知", from: "Sender <sender@example.test>", to: account.email, date: "2026-10-28", body: (window as any).__mailMessageBody ?? "服务已上线。<script>alert(1)</script>", attachments: [{ index: 1, name: "说明.txt", size: 20 }] };
    if (command === "mail_attachment") return true;
    if (command === "mail_send") {
     if ((window as any).__sendFails) throw new Error("发送未获确认，请先检查邮箱已发送记录");
     return null;
    }
    if (command === "list_client_preferences") return {};
    if (command === "authenticator_status") return { configured: false, unlocked: false };
    if (command === "wechat_plugin_status") return { supported: true, detectedPath: null, runningProcesses: 0 };
    return [];
   },
  };
 });
 await page.goto("/");
 await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
 await page.getByRole("searchbox").fill("邮件管理");
 await page.locator(".store-table tbody tr").getByRole("button", { name: "打开", exact: true }).click();
 await expect(page.locator(".mail-app")).toBeVisible();
}

test("receive, read safely, download, reply, and report independent connection results", async ({ page }) => {
 await openMail(page);
 await page.getByRole("button", { name: "检测连接", exact: true }).click();
 await expect(page.getByRole("status")).toContainText("IMAP 收信：通过；SMTP 发信：失败");
 await page.getByRole("button", { name: "收取邮件", exact: true }).click();
 await page.getByRole("button", { name: /上线通知/ }).click();
 await expect(page.locator(".mail-body")).toContainText("<script>alert(1)</script>");
 await expect(page.locator(".mail-body script")).toHaveCount(0);
 await page.getByRole("button", { name: /说明.txt/ }).click();
 await expect(page.getByRole("status")).toContainText("附件已保存");
 await page.getByRole("button", { name: "回复", exact: true }).click();
 const dialog = page.getByRole("dialog", { name: "写邮件", exact: true });
 await expect(dialog.getByLabel("收件人", { exact: true })).toHaveValue("sender@example.test");
 await expect(dialog.getByLabel("主题", { exact: true })).toHaveValue("Re: 上线通知");
 await dialog.getByRole("button", { name: "发送邮件", exact: true }).click();
 await expect(dialog).toHaveCount(0);
 await expect(page.getByRole("status")).toContainText("已提交给 SMTP 服务器");
 const calls = await page.evaluate(() => (window as any).__mailCalls);
 expect(calls.find((c: any) => c.command === "mail_read").args).toEqual({ id: "mail-1", folder: "INBOX", validity: 23, uid: 41 });
 expect(calls.filter((c: any) => c.command === "mail_send")).toHaveLength(1);
});

test("shows separate safe IMAP and SMTP failure reasons", async ({ page }) => {
 await openMail(page);
 await page.evaluate(() => { (window as any).__mailTestFailed = true; });
 await page.getByRole("button", { name: "检测连接", exact: true }).click();
 const status = page.getByRole("status");
 await expect(status).toContainText("IMAP 收信：失败（IMAP 检测遇到无法识别的服务器响应）");
 await expect(status).toContainText("SMTP 发信：失败（SMTP 连接失败，请检查服务器、端口和网络）");
 await expect(page.getByRole("alert")).toHaveCount(0);
});

test("top mailbox search matches partial subject and sender text", async ({ page }) => {
 await openMail(page);
 const search = page.getByRole("searchbox", { name: "搜索邮箱" });
 await expect(search).toBeVisible();
 await expect(search.locator("xpath=ancestor::header")).toHaveClass(/mail-toolbar/);
 await page.getByRole("button", { name: "收取邮件", exact: true }).click();
 await search.fill("线通");
 await expect(page.getByRole("button", { name: /上线通知/ })).toBeVisible();
 await search.fill("SENDER@EXAMPLE");
 await expect(page.getByRole("button", { name: /上线通知/ })).toBeVisible();
 await search.fill("missing-message");
 await expect(page.getByRole("heading", { name: "没有匹配的邮件" })).toBeVisible();
});

test("extracts a context-labeled verification code and copies only that code", async ({ page }) => {
 await openMail(page);
 await page.evaluate(() => {
  (window as any).__mailMessageBody = "您的登录验证码：739204，请在5分钟内使用。工单编号：202610280123。";
  (window as any).__copiedText = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as any).__copiedText.push(value); } } });
 });
 await page.getByRole("button", { name: "收取邮件", exact: true }).click();
 await page.getByRole("button", { name: /上线通知/ }).click();
 await page.getByRole("button", { name: "复制验证码", exact: true }).click();
 await expect(page.getByRole("status")).toContainText("验证码已复制到剪贴板");
 expect(await page.evaluate(() => (window as any).__copiedText)).toEqual(["739204"]);
});

test("does not guess a code from unrelated numbers", async ({ page }) => {
 await openMail(page);
 await page.evaluate(() => {
  (window as any).__mailMessageBody = "订单编号 202610280123，联系电话 13800138000。";
  (window as any).__copiedText = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as any).__copiedText.push(value); } } });
 });
 await page.getByRole("button", { name: "收取邮件", exact: true }).click();
 await page.getByRole("button", { name: /上线通知/ }).click();
 await page.getByRole("button", { name: "复制验证码", exact: true }).click();
 await expect(page.getByRole("status")).toContainText("未能从当前邮件中识别到明确的验证码");
 expect(await page.evaluate(() => (window as any).__copiedText)).toEqual([]);
});

test("keeps mailbox controls aligned in a narrow desktop sidebar", async ({ page }) => {
 await page.setViewportSize({ width: 900, height: 900 });
 await openMail(page);
 const controls = page.locator(".mail-account-tools button");
 await expect(controls).toHaveCount(3);
 const layout = await controls.evaluateAll(buttons => ({
  tops: buttons.map(button => Math.round(button.getBoundingClientRect().top)),
  grid: getComputedStyle(buttons[0].parentElement!).gridTemplateColumns,
  width: buttons[0].parentElement!.getBoundingClientRect().width,
 }));
 expect(new Set(layout.tops).size, JSON.stringify(layout)).toBe(1);
});

test("continues receiving the inbox when listing other folders fails", async ({ page }) => {
 await openMail(page);
 await page.evaluate(() => { (window as any).__mailFolderFail = true; });
 await page.getByRole("button", { name: "收取邮件", exact: true }).click();
 await expect(page.getByRole("status")).toContainText("已更新收件箱");
 await expect(page.getByRole("status")).toContainText("读取其他文件夹失败");
 await expect(page.getByRole("button", { name: /上线通知/ })).toBeVisible();
 const calls = await page.evaluate(() => (window as any).__mailCalls);
 expect(calls.find((c: any) => c.command === "mail_list").args.folder).toBe("INBOX");
});

test("shared editor reveals saved value only on demand and keeps backdrop open", async ({ page }) => {
 await openMail(page);
 await page.getByRole("button", { name: "编辑邮箱", exact: true }).click();
 let dialog = page.getByRole("dialog", { name: "编辑邮箱", exact: true });
 await expect(dialog.getByLabel("授权码 / 应用专用密码", { exact: true })).toHaveValue("");
 expect(await page.evaluate(() => (window as any).__mailCalls.filter((c: any) => c.command === "mail_reveal_secret").length)).toBe(0);
 await dialog.getByRole("button", { name: "显示邮箱授权码", exact: true }).click();
 await expect(dialog.getByLabel("已保存的邮箱授权码", { exact: true })).toHaveValue("模拟回显内容");
 await expect(dialog.getByLabel("已保存的邮箱授权码", { exact: true })).toHaveAttribute("readonly", "");
 await dialog.getByRole("button", { name: "隐藏邮箱授权码", exact: true }).click();
 await expect(dialog.getByLabel("已保存的邮箱授权码", { exact: true })).toHaveCount(0);
 await expect(dialog.getByLabel("授权码 / 应用专用密码", { exact: true })).toHaveValue("");
 await page.locator("body > .modal-backdrop").click({ position: { x: 2, y: 2 } });
 await expect(dialog).toBeVisible();
 await page.keyboard.press("Escape");
 await expect(dialog).toHaveCount(0);
 await page.getByRole("button", { name: "添加邮箱", exact: true }).click();
 dialog = page.getByRole("dialog", { name: "添加邮箱", exact: true });
 await dialog.getByLabel("邮箱服务商").selectOption("1");
 await expect(dialog.getByLabel("IMAP 服务器")).toHaveValue("imap.163.com");
 await dialog.getByLabel("邮箱地址", { exact: true }).fill("second@example.test");
 // Check browser validation without ever creating fixture credentials.
 await dialog.getByRole("button", { name: "保存邮箱", exact: true }).click();
 await expect(dialog).toBeVisible();
 expect(await page.evaluate(() => (window as any).__mailCalls.filter((c: any) => c.command === "mail_save").length)).toBe(0);
 for (const width of [375, 768, 1024, 1440]) {
  await page.setViewportSize({ width, height: 1000 });
  expect(await dialog.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
 }
});

test("errors remain recoverable and unsent content requires explicit discard", async ({ page }) => {
 await openMail(page);
 await page.evaluate(() => { (window as any).__mailFail = true; });
 await page.getByRole("button", { name: "收取邮件", exact: true }).click();
 await expect(page.getByRole("alert")).toContainText("IMAP 登录失败");
 await page.evaluate(() => { (window as any).__mailFail = false; });
 await page.getByRole("button", { name: "收取邮件", exact: true }).click();
 await page.getByRole("button", { name: "写邮件", exact: true }).click();
 const compose = page.getByRole("dialog", { name: "写邮件", exact: true });
 await compose.getByLabel("收件人", { exact: true }).fill("sender@example.test");
 await compose.getByLabel("主题", { exact: true }).fill("测试");
 await compose.getByLabel("正文", { exact: true }).fill("保留内容");
 await page.evaluate(() => { (window as any).__sendFails = true; });
 await compose.getByRole("button", { name: "发送邮件", exact: true }).click();
 await expect(compose.getByRole("alert")).toContainText("发送未获确认");
 await expect(compose.getByRole("textbox", { name: "正文", exact: true })).toHaveValue("保留内容");
 await page.keyboard.press("Escape");
 const confirm = page.getByRole("alertdialog", { name: "放弃这封邮件？" });
 await expect(confirm).toBeVisible();
 await confirm.getByRole("button", { name: "取消", exact: true }).click();
 await expect(compose).toBeVisible();
 await compose.getByRole("button", { name: "取消", exact: true }).click();
 await page.getByRole("button", { name: "放弃邮件", exact: true }).click();
 await expect(compose).toHaveCount(0);
});

test("loaded messages and compose dialog fit desktop hosts", async ({ page }) => {
 await openMail(page);
 await page.getByRole("button", { name: "收取邮件", exact: true }).click();
 await page.getByRole("button", { name: /上线通知/ }).click();
 for (const width of [375, 768, 1024, 1440]) {
  await page.setViewportSize({ width, height: 1000 });
  expect(await page.locator(".mail-app").evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
 }
 await page.screenshot({ path: "test-results/mail-loaded.png", fullPage: true });
 await page.getByRole("button", { name: "写邮件", exact: true }).click();
 const compose = page.getByRole("dialog", { name: "写邮件", exact: true });
 for (const width of [375, 768, 1024, 1440]) {
  await page.setViewportSize({ width, height: 1000 });
  expect(await compose.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
 }
 await page.screenshot({ path: "test-results/mail-compose.png", fullPage: true });
});

test("compose body focus uses a single focus indicator", async ({ page }) => {
 await openMail(page);
 await page.getByRole("button", { name: "写邮件", exact: true }).click();
 const body = page.getByRole("textbox", { name: "正文", exact: true });
 await body.focus();
 await expect.poll(() => body.evaluate(element => getComputedStyle(element).boxShadow)).toBe("none");
 await expect.poll(() => body.evaluate(element => getComputedStyle(element).outlineWidth)).toBe("2px");
});

test("preview refuses connections and workspace fits supported widths", async ({ page }) => {
 await openMail(page, false);
 await expect(page.getByRole("button", { name: "添加邮箱", exact: true }).first()).toBeDisabled();
 await expect(page.locator(".mail-banner")).toContainText("浏览器预览不连接邮箱");
 for (const width of [375, 768, 1024, 1440]) {
  await page.setViewportSize({ width, height: 1000 });
  expect(await page.locator(".mail-app").evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
 }
 await page.screenshot({ path: "test-results/mail-desktop.png", fullPage: true });
});
