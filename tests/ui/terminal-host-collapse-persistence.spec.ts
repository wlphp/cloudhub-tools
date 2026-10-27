import { expect, test } from "@playwright/test";

test("terminal host group expansion state is restored after reopening", async ({ page }) => {
  await page.addInitScript(() => {
    const invoke = async (command: string, args?: { key?: string; value?: string }) => {
      if (command === "list_managed_hosts") return [
        { id: 1, name: "个人测试 Linux", host: "192.0.2.10", platform: "linux", username: "operator", port: 22, group_name: "个人", status: "online" },
        { id: 2, name: "Windows 测试", host: "192.0.2.11", platform: "windows", username: "operator", port: 3389, group_name: "公司客户", status: "unknown" },
      ];
      if (command === "list_client_preferences") return {
        "cloudhub-tools-managed-host-collapsed-groups": localStorage.getItem("cloudhub-tools-managed-host-collapsed-groups") || undefined,
        "cloudhub-tools-recent-managed-hosts-collapsed": localStorage.getItem("cloudhub-tools-recent-managed-hosts-collapsed") || undefined,
      };
      if (command === "save_client_preference" && args?.key && args.value !== undefined) {
        localStorage.setItem(args.key, args.value);
        return;
      }
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      return [];
    };
    (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke };
  });

  await page.goto("/");
  await page.getByRole("button", { name: "终端管理", exact: true }).click();
  const tree = page.locator(".terminal-host-tree");
  const company = tree.getByRole("button", { name: "公司客户（1 台服务器）", exact: true });
  await company.click();
  await expect(company).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cloudhub-tools-managed-host-collapsed-groups"))).toBe('["公司客户"]');

  const recent = tree.locator('[data-recent-hosts="true"]');
  const recentToggle = recent.getByRole("button", { name: "最近（0 台服务器）", exact: true });
  await recentToggle.click();
  await expect(recentToggle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cloudhub-tools-recent-managed-hosts-collapsed"))).toBe("1");

  await page.reload();
  await page.getByRole("button", { name: "终端管理", exact: true }).click();
  const restoredCompany = tree.getByRole("button", { name: "公司客户（1 台服务器）", exact: true });
  await expect(restoredCompany).toHaveAttribute("aria-expanded", "false");
  await expect(tree.locator('[data-managed-host-group="公司客户"] .terminal-host-card')).toHaveCount(0);
  await expect(tree.locator('[data-recent-hosts="true"] .terminal-host-group-toggle')).toHaveAttribute("aria-expanded", "false");
});
