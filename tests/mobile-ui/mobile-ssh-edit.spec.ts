import { expect, test } from "@playwright/test";

for (const auth of ["password", "private_key"] as const) {
  test(`mobile edits an existing ${auth} host without replacing saved credentials`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await page.addInitScript(method => {
      let host = { id: 7, name: "演示主机", host: "host.example.test", port: 2222, username: "operator", platform: "linux", auth_method: method, password_saved: method === "password", private_key_saved: method === "private_key", group_name: "保留分组", tags: "demo", remark: "原备注", source_account_id: 2, source_asset_key: "demo-server", status: "unknown", metrics: {}, created_at: 1, updated_at: 1 };
      const saves: Record<string, unknown>[] = [];
      Object.assign(window, { __sshSaves: saves, __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        invoke: async (command: string, args?: { input: Record<string, unknown> }) => {
          if (command === "list_managed_hosts") return [host];
          if (command === "list_client_preferences") return {};
          if (command === "authenticator_status") return { configured: false, unlocked: false };
          if (command === "save_managed_host") {
            saves.push(JSON.parse(JSON.stringify(args!.input)));
            if (saves.length === 1) throw new Error("模拟保存失败");
            host = { ...host, ...args!.input } as typeof host;
            return host;
          }
          return [];
        },
      } });
    }, auth);
    await page.goto("/");
    await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多" }).click();
    await page.locator(".mobile-more-feature").filter({ hasText: "SSH 终端" }).click();
    await page.getByRole("button", { name: "编辑主机 演示主机", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "编辑 SSH 主机", exact: true });
    await expect(dialog.getByLabel("主机地址", { exact: true })).toHaveValue("host.example.test");
    await expect(dialog.getByLabel("SSH 端口", { exact: true })).toHaveValue("2222");
    await expect(dialog.getByLabel("用户名", { exact: true })).toHaveValue("operator");
    await expect(dialog.locator('[name="password"], [name="privateKey"]')).toHaveValue("");
    await dialog.getByLabel("显示名称", { exact: true }).fill("更新后的主机");
    await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("显示名称", { exact: true })).toHaveValue("更新后的主机");
    await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "编辑主机 更新后的主机", exact: true })).toBeVisible();
    const saves = await page.evaluate(() => (window as unknown as { __sshSaves: Record<string, unknown>[] }).__sshSaves);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({ id: 7, name: "更新后的主机", password: "", private_key: "", auth_method: auth, group_name: "保留分组", tags: "demo", remark: "原备注", source_account_id: 2, source_asset_key: "demo-server" });
    expect(saves[1]).not.toHaveProperty("key_passphrase");
    await page.getByRole("button", { name: "添加主机", exact: true }).click();
    const add = page.getByRole("dialog", { name: "添加 SSH 主机", exact: true });
    await expect(add.getByLabel("显示名称", { exact: true })).toHaveValue("");
    await expect(add.locator('[name="password"]')).toHaveAttribute("required", "");
  });
}
