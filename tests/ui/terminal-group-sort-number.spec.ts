import { expect, test } from "@playwright/test";

test("editing a server group can set its numeric position", async ({ page }) => {
  await page.addInitScript(() => {
    const host = (id: number, name: string, group_name: string) => ({ id, name, host: `192.0.2.${id}`, platform: "linux", username: "operator", port: 22, group_name, status: "unknown" });
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
      if (command === "list_managed_hosts") return [host(1, "Alpha 主机", "Alpha"), host(2, "Beta 主机", "Beta"), host(3, "Gamma 主机", "Gamma")];
      if (command === "list_client_preferences") return {};
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      return [];
    } };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "终端管理", exact: true }).click();

  await page.locator('[data-managed-host-group="Beta"] .terminal-host-group-head').click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑分组" });
  await expect(dialog.getByLabel("分组名称")).toHaveValue("Beta");
  await expect(dialog.getByLabel("排序号")).toHaveValue("2");
  await dialog.getByLabel("排序号").fill("1");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();

  await expect(page.locator(".terminal-host-tree [data-managed-host-group]").first()).toHaveAttribute("data-managed-host-group", "Beta");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("cloudhub-tools-managed-host-group-order") || "[]"))).toEqual(["Beta", "Alpha", "Gamma"]);
});
