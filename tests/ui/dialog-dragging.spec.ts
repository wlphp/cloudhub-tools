import { expect, test } from "@playwright/test";

test("account dialog moves when dragging blank space in its header", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string) => {
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        return [];
      },
    };
  });
  await page.goto(process.env.CLOUDHUB_TEST_BASE_URL || "/");
  await page.getByRole("button", { name: "添加云账号" }).click();

  const dialog = page.locator("form.modal-form-layout");
  const header = dialog.locator(".modal-head");
  const before = await dialog.boundingBox();
  const headerBox = await header.boundingBox();
  expect(before).not.toBeNull();
  expect(headerBox).not.toBeNull();

  const startX = headerBox!.x + headerBox!.width * 0.62;
  const startY = headerBox!.y + headerBox!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 90, startY + 55, { steps: 5 });
  await page.mouse.up();

  const after = await dialog.boundingBox();
  expect(after!.x).toBeGreaterThan(before!.x + 50);
  expect(after!.y).toBeGreaterThanOrEqual(before!.y);
});
