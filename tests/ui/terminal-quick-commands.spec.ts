import { expect, test } from "@playwright/test";

test("quick command add buttons open the editor", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
      if (command === "list_managed_hosts") return [];
      if (command === "list_client_preferences") return {};
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      return [];
    } };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "终端管理", exact: true }).click();
  await page.getByRole("button", { name: "常用命令", exact: true }).click();

  await page.getByRole("button", { name: "添加命令", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "添加常用命令" })).toBeVisible();
  await page.getByRole("dialog", { name: "添加常用命令" }).getByRole("button", { name: /^关闭/ }).click();

  await page.getByRole("button", { name: "添加第一条命令", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "添加常用命令" })).toBeVisible();
});
