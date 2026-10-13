import { expect, test } from "@playwright/test";

test("managed server drag sorting uses the upper and lower halves of the target row", async ({ page }) => {
  await page.addInitScript(() => {
    const host = (id: number, name: string, group_name: string) => ({ id, name, host: `192.0.2.${id}`, platform: "linux", username: "operator", port: 22, group_name, status: "unknown" });
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
      if (command === "list_managed_hosts") return [
        host(1, "Alpha 第一台", "Alpha"), host(2, "Beta 主机", "Beta"), host(3, "Gamma 主机", "Gamma"),
        host(4, "同组第一台", "Hosts"), host(5, "同组第二台", "Hosts"), host(6, "同组第三台", "Hosts"),
      ];
      if (command === "list_client_preferences") return {};
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      return [];
    } };
  });
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.goto("/");
  await page.getByRole("button", { name: "终端管理", exact: true }).click();
  const tree = page.locator(".terminal-host-tree");
  await page.getByRole("button", { name: "排序", exact: true }).click();

  const alphaHandle = tree.locator('.terminal-group-drag-handle[aria-label="拖动分组排序 Alpha"]');
  const alphaHandleBox = (await alphaHandle.boundingBox())!;
  await page.mouse.move(alphaHandleBox.x + alphaHandleBox.width / 2, alphaHandleBox.y + alphaHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(tree.locator("[data-managed-host-group]").first()).toHaveAttribute("data-managed-host-group", "Alpha");
  await expect(tree.locator("[data-managed-host-group=Alpha]")).not.toHaveClass(/is-dragging/);

  const dragToTarget = async (handle: ReturnType<typeof page.locator>, target: ReturnType<typeof page.locator>, targetPosition = 0.75) => {
    await target.scrollIntoViewIfNeeded();
    await handle.scrollIntoViewIfNeeded();
    const sourceHost = handle.locator("xpath=ancestor::article[@data-managed-host-id]");
    const sourceBox = (await handle.boundingBox())!;
    const targetBox = (await target.boundingBox())!;
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height * targetPosition, { steps: 8 });
    if (await sourceHost.count()) await expect(sourceHost).toHaveClass(/is-dragging/);
    const dropTarget = target.locator("xpath=ancestor-or-self::*[@data-managed-host-group or @data-managed-host-id][1]");
    await expect(dropTarget).toHaveClass(targetPosition >= 0.5 ? /is-drop-after/ : /is-drop-before/);
    await page.mouse.up();
  };

  await dragToTarget(
    tree.locator('.terminal-group-drag-handle[aria-label="拖动分组排序 Alpha"]'),
    tree.locator('[data-managed-host-group="Gamma"] .terminal-host-group-head'),
  );
  await expect(tree.locator("[data-managed-host-group]").nth(0)).toHaveAttribute("data-managed-host-group", "Beta");
  await expect(tree.locator("[data-managed-host-group]").nth(1)).toHaveAttribute("data-managed-host-group", "Gamma");
  await expect(tree.locator("[data-managed-host-group]").nth(2)).toHaveAttribute("data-managed-host-group", "Alpha");

  await dragToTarget(
    tree.locator('.terminal-host-drag-handle[aria-label="拖动排序 同组第一台"]'),
    tree.locator('[data-managed-host-group="Hosts"] [data-managed-host-id="6"]'),
  );
  const hostIds = await tree.locator('[data-managed-host-group="Hosts"] .terminal-host-card').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-managed-host-id")));
  expect(hostIds).toEqual(["5", "6", "4"]);

  await dragToTarget(
    tree.locator('.terminal-host-drag-handle[aria-label="拖动排序 同组第一台"]'),
    tree.locator('[data-managed-host-group="Hosts"] [data-managed-host-id="5"]'),
    0.25,
  );
  const restoredHostIds = await tree.locator('[data-managed-host-group="Hosts"] .terminal-host-card').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-managed-host-id")));
  expect(restoredHostIds).toEqual(["4", "5", "6"]);
});
