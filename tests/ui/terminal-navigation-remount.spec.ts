import { expect, test } from "@playwright/test";

test("reattaches the existing terminal canvas when returning to terminal management", async ({ page }) => {
  await page.addInitScript(() => {
    const host = { id: 1, name: "导航恢复测试", host: "192.0.2.20", platform: "linux", username: "operator", port: 22, group_name: "测试", status: "online", password_saved: true };
    (window as any).__terminalOutputDelivered = false;
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
      if (command === "list_managed_hosts") return [host];
      if (command === "list_client_preferences") return {};
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      if (command === "ssh_connect") return { sessionId: "navigation-remount-session" };
      if (command === "ssh_read") {
        if ((window as any).__terminalOutputDelivered) return "";
        (window as any).__terminalOutputDelivered = true;
        return "navigation-remount-prompt";
      }
      if (command === "probe_managed_host") return host;
      return [];
    } };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "终端管理", exact: true }).click();
  await page.getByRole("button", { name: /选择服务器 导航恢复测试/ }).dblclick();
  const viewport = page.locator(".ssh-terminal-viewport");
  await expect(viewport.locator(".terminal-session-buffer")).toHaveCount(1);
  await expect(viewport.locator(".xterm-rows")).toContainText("navigation-remount-prompt");

  await page.getByRole("button", { name: "账号管理", exact: true }).click();
  await expect(page.locator(".terminal-stage")).toHaveCount(0);
  await page.getByRole("button", { name: "终端管理", exact: true }).click();

  const restoredViewport = page.locator(".ssh-terminal-viewport");
  await expect(restoredViewport.locator(".terminal-session-buffer")).toHaveCount(1);
  await expect(restoredViewport.locator(".xterm-rows")).toContainText("navigation-remount-prompt");
});
