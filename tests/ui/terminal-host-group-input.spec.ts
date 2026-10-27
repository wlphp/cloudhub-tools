import { expect, test } from "@playwright/test";

test("server group field suggests existing groups and creates a group from free text", async ({ page }) => {
  await page.addInitScript(() => {
    const hosts = [
      { id: 1, name: "现有服务器", host: "192.0.2.10", platform: "linux", username: "operator", port: 22, group_name: "生产", status: "unknown" },
      { id: 2, name: "另一台服务器", host: "192.0.2.11", platform: "linux", username: "operator", port: 22, group_name: "测试", status: "unknown" },
    ];
    (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args?: { input?: Record<string, unknown> }) => {
      if (command === "list_managed_hosts") return hosts;
      if (command === "list_client_preferences") return {};
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      if (command === "save_managed_host") {
        const input = args?.input || {};
        (window as any).savedManagedHostGroup = input.group_name;
        return { ...input, id: 3, status: "unknown" };
      }
      return [];
    } };
  });

  await page.goto("/");
  await page.getByRole("button", { name: "终端管理", exact: true }).click();
  const tree = page.locator(".terminal-host-tree");
  await page.locator(".terminal-add-host").click();

  const dialog = page.locator(".managed-host-modal");
  const group = dialog.getByRole("combobox", { name: "分组，可选择或输入新分组" });
  await expect(page.locator("#managed-host-group-options option")).toHaveCount(2);
  await expect(page.locator('#managed-host-group-options option[value="生产"]')).toHaveCount(1);
  await expect(page.locator('#managed-host-group-options option[value="测试"]')).toHaveCount(1);

  await dialog.getByLabel("服务器名称").fill("新分组服务器");
  await dialog.getByLabel("主机 / IP").fill("192.0.2.13");
  await dialog.getByRole("button", { name: "Windows", exact: true }).click();
  await group.fill("新建分组");
  await dialog.getByRole("button", { name: "加入服务器管理", exact: true }).click();

  await expect.poll(() => page.evaluate(() => (window as any).savedManagedHostGroup)).toBe("新建分组");
  await expect(tree.locator('[data-managed-host-group="新建分组"]')).toBeVisible();
});
