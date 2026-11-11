import { expect, test } from "@playwright/test";

test("certificate browser-preview warning uses a soft light-theme palette", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cloudhub-tools-ui-theme", "light"));
  await page.goto("/");
  await page.getByRole("button", { name: "HTTPS 证书", exact: true }).first().click();

  const warning = page.locator(".certificate-preview-warning");
  await expect(warning).toBeVisible();
  const colors = await warning.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color, border: style.borderTopColor };
  });
  expect(colors.background).not.toBe("rgb(43, 33, 21)");
  expect(colors.color).toBe("rgb(118, 80, 13)");
  expect(colors.border).not.toBe("rgb(110, 79, 48)");
});
