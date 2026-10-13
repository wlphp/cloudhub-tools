import { expect, test } from "@playwright/test";

test("server tree uses compact rows while retaining grouping, selection and menus", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
    if (command === "list_managed_hosts") return [
      { id: 1, name: "个人测试 Linux", host: "192.0.2.10", platform: "linux", username: "operator", port: 22, group_name: "个人", status: "online" },
      { id: 2, name: "Windows 测试", host: "192.0.2.11", platform: "windows", username: "operator", port: 3389, group_name: "公司客户", status: "unknown" },
      { id: 3, name: "用于检查名称截断及完整信息访问的服务器名称", host: "192.0.2.12", platform: "windows", username: "operator", port: 3389, group_name: "公司客户", status: "offline" },
    ];
    if (command === "list_client_preferences") return {};
    if (command === "authenticator_status") return { configured: false, unlocked: false };
    if (command === "ssh_connect") { (window as any).failedSsh = true; throw new Error("模拟连接失败"); }
    return [];
    } };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "终端管理", exact: true }).click();
  const tree = page.locator(".terminal-host-tree");
  const recent = tree.locator('[data-recent-hosts="true"]');
  await expect(tree.locator(".terminal-host-group").first()).toContainText("最近");
  await expect(recent.getByRole("button", { name: "最近（0 台服务器）", exact: true })).toBeVisible();
  await expect(tree.locator(".terminal-host-card")).toHaveCount(3);
  const company = tree.getByRole("button", { name: "公司客户（2 台服务器）", exact: true });
  await company.click();
  await expect(company).toHaveAttribute("aria-expanded", "false");
  await expect(tree.locator(".terminal-host-card")).toHaveCount(1);
  await company.focus();
  await page.keyboard.press("Enter");
  await expect(company).toHaveAttribute("aria-expanded", "true");
  const previousRow = (await tree.locator('[data-managed-host-group="个人"] .terminal-host-card').last().boundingBox())!;
  const nextGroup = (await tree.locator('[data-managed-host-group="公司客户"] .terminal-host-group-head').boundingBox())!;
  expect(nextGroup.y - previousRow.y - previousRow.height).toBeLessThanOrEqual(4);
  const host = tree.getByRole("button", { name: /选择服务器 Windows 测试/ });
  await host.click();
  await expect(tree.locator('.terminal-host-card[data-managed-host-id="2"]')).toHaveClass(/active/);
  await tree.getByRole("button", { name: "Windows 测试 的更多操作", exact: true }).click();
  await expect(tree.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
  await tree.getByRole("button", { name: "Windows 测试 的更多操作", exact: true }).click();
  await expect(tree.locator(".terminal-group-icon")).toHaveCount(1);
  await host.dblclick();
  await expect(recent.locator(".terminal-host-card")).toHaveCount(1);
  await expect(recent).toContainText("Windows 测试");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cloudhub-recent-managed-hosts"))).toBe('["2"]');
  await page.reload();
  await page.getByRole("button", { name: "终端管理", exact: true }).click();
  await expect(recent.locator(".terminal-host-card")).toHaveCount(1);
  const regularWindows = tree.locator('[data-managed-host-group="公司客户"]').getByRole("button", { name: /选择服务器 Windows 测试/ });
  await regularWindows.dblclick();
  await expect(recent.locator(".terminal-host-card")).toHaveCount(1);
  await tree.locator('[data-managed-host-group="公司客户"]').getByRole("button", { name: /选择服务器 用于检查名称截断/ }).dblclick();
  await expect(recent.locator(".terminal-host-card")).toHaveCount(2);
  await expect(recent.locator(".terminal-host-card").first()).toHaveAttribute("data-managed-host-id", "3");
  await regularWindows.dblclick();
  await expect(recent.locator(".terminal-host-card").first()).toHaveAttribute("data-managed-host-id", "2");
  await tree.locator('[data-managed-host-group="个人"]').getByRole("button", { name: /选择服务器 个人测试 Linux/ }).dblclick();
  await expect.poll(() => page.evaluate(() => (window as any).failedSsh)).toBe(true);
  await expect(recent.locator(".terminal-host-card")).toHaveCount(2);
  await recent.getByRole("button", { name: "最近（2 台服务器）", exact: true }).click();
  await expect(recent.locator(".terminal-host-card")).toHaveCount(0);
  await recent.getByRole("button", { name: "最近（2 台服务器）", exact: true }).click();
  await expect(recent.locator(".terminal-host-card")).toHaveCount(2);
  for (const width of [768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await tree.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect((await regularWindows.boundingBox())!.height).toBeLessThanOrEqual(30);
  }
  await page.locator(".terminal-host-sidebar").screenshot({ path: "test-results/terminal-host-tree.png" });
});
