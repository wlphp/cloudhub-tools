import { test, expect } from "@playwright/test";

test("manual panel SSH password is revealed on demand and blank edits preserve it", async ({ page }) => {
  await page.addInitScript(() => {
    const panel = { id: 7, name: "Fixture panel", panel_url: "https://192.0.2.20:8888", sort_order: 0, allow_insecure_tls: false, api_key_saved: true, status: "online", summary: {}, created_at: 1, updated_at: 1 };
    const host = { id: 9, name: "Fixture host", host: "192.0.2.20", port: 2222, username: "fixture", platform: "linux", auth_method: "password", password_saved: true, private_key_saved: false, status: "unknown", metrics: {}, created_at: 1, updated_at: 1 };
    const calls: { command: string; args: unknown }[] = [];
    Object.assign(window, { __panelCalls: calls, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: unknown) => {
        calls.push({ command, args });
        if (command === "list_panel_connections") return [panel];
        if (command === "list_managed_hosts") return [host];
        if (command === "reveal_ssh_password") return "test-only-saved-password";
        if (command === "save_panel_connection") return panel;
        if (command === "save_managed_host") return host;
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "面板管理", exact: true }).first().click();
  await page.getByRole("button", { name: "配置 Fixture panel", exact: true }).click();
  await page.getByRole("button", { name: "面板配置", exact: true }).click();
  await expect(page.getByRole("button", { name: "显示SSH 密码", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __panelCalls: {command:string}[] }).__panelCalls.some(call => call.command === "reveal_ssh_password"))).toBe(false);
  await page.getByRole("button", { name: "显示SSH 密码", exact: true }).click();
  await expect(page.getByLabel("已保存的SSH 密码", { exact: true })).toHaveValue("test-only-saved-password");
  expect(await page.evaluate(() => (window as unknown as { __panelCalls: {command:string;args:{managedHostId:number}}[] }).__panelCalls.find(call => call.command === "reveal_ssh_password")?.args.managedHostId)).toBe(9);
  await page.getByRole("button", { name: "隐藏SSH 密码", exact: true }).click();
  await page.getByRole("button", { name: "验证并保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "编辑面板", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __panelCalls: {command:string;args:{input:{id:number;password:string;port:number}}}[] }).__panelCalls.find(call => call.command === "save_managed_host")?.args.input)).toMatchObject({ id: 9, password: "", port: 2222 });
  await page.getByRole("button", { name: "配置 Fixture panel", exact: true }).click();
  await page.getByRole("button", { name: "面板配置", exact: true }).click();
  await page.getByLabel("SSH 密码", { exact: true }).fill("test-only-replacement-password");
  await page.getByRole("button", { name: "验证并保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "编辑面板", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __panelCalls: {command:string;args:{input:{password:string}}}[] }).__panelCalls.filter(call => call.command === "save_managed_host").at(-1)?.args.input.password)).toBe("test-only-replacement-password");
  expect(await page.evaluate(() => (window as unknown as { __panelCalls: {command:string}[] }).__panelCalls.some(call => call.command === "ssh_connect"))).toBe(false);

});

for (const existing of [false, true]) {
  test(`adding panel SSH ${existing ? "reuses existing terminal" : "creates terminal"}`, async ({ page }) => {
    await page.addInitScript(({ existing }) => {
      let hosts = existing ? [{ id: 9, name: "Fixture terminal", host: "192.0.2.20", port: 22, username: "root", platform: "linux", auth_method: "password", password_saved: true, private_key_saved: false, status: "unknown", metrics: {}, created_at: 1, updated_at: 1 }] : [];
      const calls: { command: string; args: unknown }[] = [];
      Object.assign(window, { __panelCalls: calls, __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string, args: { input?: Record<string, unknown> }) => {
          calls.push({ command, args });
          if (command === "list_managed_hosts") return hosts;
          if (command === "save_panel_connection") return { id: 7 };
          if (command === "save_managed_host") {
            const saved = { ...args.input, id: 9, password: undefined, password_saved: true, private_key_saved: false, status: "unknown", metrics: {} } as typeof hosts[number];
            hosts = [saved];
            return saved;
          }
          if (command === "authenticator_status") return { configured: false, unlocked: false };
          return [];
        },
      } });
    }, { existing });
    await page.goto("/");
    await page.getByRole("button", { name: "面板管理", exact: true }).first().click();
    await page.getByRole("button", { name: "添加面板", exact: true }).click();
    const form = page.locator(".panel-bind-modal");
    await form.getByLabel("名称", { exact: true }).fill("Fixture panel");
    await form.getByLabel("面板 URL", { exact: true }).fill("https://192.0.2.20:8888");
    await form.getByLabel("API 密钥", { exact: true }).fill("test-only-panel-key");
    const section = form.getByRole("group", { name: "SSH 终端连接（可选）", exact: true });
    await expect(section).toContainText("不重复添加");
    await expect(section.getByLabel("SSH 端口", { exact: true })).toBeVisible();
    await expect(section.getByLabel("SSH 用户名", { exact: true })).toBeVisible();
    await section.getByLabel("SSH 密码", { exact: true }).fill("test-only-password");
    await section.screenshot({ path: `test-results/panel-ssh-section-${existing}.png` });
    await page.getByRole("button", { name: "绑定面板", exact: true }).click();
    await expect(form).toHaveCount(0);
    const input = await page.evaluate(() => (window as unknown as { __panelCalls: { command: string; args: { input: { id?: number; host: string; port: number; username: string } } }[] }).__panelCalls.find(call => call.command === "save_managed_host")?.args.input);
    expect(input).toMatchObject({ host: "192.0.2.20", port: 22, username: "root" });
    expect(input?.id).toBe(existing ? 9 : undefined);
    await page.getByRole("button", { name: "终端管理", exact: true }).first().click();
    await expect(page.locator(".terminal-host-card")).toHaveCount(1);
  });
}
