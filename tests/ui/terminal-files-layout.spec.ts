import { expect, test } from "@playwright/test";

test("detached file list fits the window and reveals the entire final filename", async ({ page }) => {
  await page.addInitScript(() => {
    const host = { id: 1, name: "文件列表测试", host: "192.0.2.10", platform: "linux", username: "operator", port: 22, group_name: "测试", status: "online", password_saved: true };
    (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
      if (command === "list_managed_hosts") return [host];
      if (command === "list_client_preferences") return {};
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      if (command === "ssh_connect") return { sessionId: "files-test" };
      if (command === "probe_managed_host") return host;
      if (command === "ssh_read") return "";
      if (command === "ssh_list_files") return { path: "/", entries: Array.from({ length: 50 }, (_, index) => ({ name: index === 49 ? "最后一个目录名称很长需要完整显示-abcdefghijklmnopqrstuvwxyz" : `directory-${index}`, path: `/directory-${index}`, isDir: true, isFile: false, size: 0, mode: "755", owner: "operator" })) };
      return [];
    } };
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto("/?detachedTerminalHostId=1");
  await expect(page.locator(".ssh-terminal-viewport .xterm")).toBeVisible();
  await page.getByRole("tab", { name: "文件管理", exact: true }).click();
  const list = page.locator(".ssh-file-list");
  const last = list.locator(".ssh-file-name").last();
  await expect(list.locator(".ssh-file-name")).toHaveCount(50);
  for (const height of [600, 450]) {
    await page.setViewportSize({ width: 1000, height });
    await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const listBox = (await list.boundingBox())!;
    const lastBox = (await last.boundingBox())!;
    expect(listBox.y + listBox.height).toBeLessThanOrEqual(height);
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(listBox.y + listBox.height);
    const name = last.locator("span");
    expect(await name.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: "test-results/terminal-files-layout.png" });
});
