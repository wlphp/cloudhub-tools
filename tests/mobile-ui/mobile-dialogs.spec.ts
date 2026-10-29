import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 320, height: 720 }, { width: 375, height: 844 }, { width: 768, height: 1024 }, { width: 844, height: 390 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
  for (const theme of ["light", "dark"]) {
    test(`shared mobile form fits ${viewport.width}x${viewport.height} in ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(value => localStorage.setItem("cloudhub-tools-ui-theme", value), theme);
      await page.route("**/api/**", route => route.fulfill({ json: [] }));
      await page.goto("/");
      await page.getByRole("button", { name: /添加云账号|添加账号/ }).first().click();
      const dialog = page.getByRole("dialog", { name: "添加云账号", exact: true });
      await expect(dialog).toBeVisible();
      await expect(page.getByRole("textbox", { name: "账号名称", exact: true })).toBeEditable();
      await expect(page.getByRole("textbox", { name: "AccessKey ID", exact: true })).toBeEditable();
      await expect(page.getByLabel("AccessKey Secret", { exact: true })).toHaveAttribute("type", "password");
      const geometry = await dialog.evaluate(element => {
        const box = element.getBoundingClientRect();
        const body = element.querySelector<HTMLElement>(".modal-body")!;
        const footer = element.querySelector(".modal-actions")!.getBoundingClientRect();
        return { inside: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight, fits: element.scrollWidth <= element.clientWidth, bodyHeight: body.clientHeight, footerVisible: footer.top >= 0 && footer.bottom <= innerHeight, portal: element.parentElement?.parentElement === document.body };
      });
      expect(geometry).toMatchObject({ inside: true, fits: true, footerVisible: true, portal: true });
      expect(geometry.bodyHeight).toBeGreaterThan(40);
      await page.getByLabel("备注", { exact: true }).fill("仅用于界面回归");
      await expect(dialog.locator(".modal-actions")).toBeInViewport();
      await expect(page.getByRole("button", { name: "保存到本机", exact: true })).toBeInViewport();
    });
  }
}

test("mobile shared dialog keeps drafts on backdrop, traps focus and restores opener", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  await page.goto("/");
  const opener = page.getByRole("button", { name: /添加云账号|添加账号/ }).first();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "添加云账号", exact: true });
  await page.getByRole("textbox", { name: "账号名称", exact: true }).fill("保留草稿");
  await page.mouse.click(2, 2);
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("textbox", { name: "账号名称", exact: true })).toHaveValue("保留草稿");
  expect(await page.locator("#root").evaluate(element => element.inert)).toBe(true);
  const first = dialog.getByRole("button", { name: "最大化弹层", exact: true });
  const last = dialog.getByRole("button", { name: "保存到本机", exact: true });
  await first.click();
  await expect(dialog).toHaveClass(/dialog-size-expanded/);
  await dialog.getByRole("button", { name: "缩小弹层", exact: true }).click();
  await expect(dialog).not.toHaveClass(/dialog-size-expanded/);
  await last.focus();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.locator("#root").evaluate(element => element.inert)).toBe(false);
});

for (const [feature, button, title, shell] of [["SSH 终端", "添加 SSH 主机", "添加 SSH 主机", ".mobile-ssh-dialog"], ["运维面板", "添加运维面板", "添加运维面板", ".mobile-panel-dialog"]]) {
  test(`${feature} uses the shared mobile shell`, async ({ page }) => {
    await page.route("**/api/**", route => route.fulfill({ json: [] }));
    await page.goto("/");
    await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
    await page.locator(".mobile-more-feature").filter({ hasText: feature }).click();
    await page.getByRole("button", { name: button, exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    await expect(dialog).toHaveClass(/shared-content-dialog/);
    await expect(page.locator(shell + " form.modal-form-content")).toHaveCount(1);
    await expect(dialog.locator(".modal-actions")).toBeInViewport();
    // Labels and controls use the same columns as the account form, including
    // fields that previously lived in two-column feature-specific groups.
    const columns = await dialog.locator(".dialog-field").evaluateAll(rows => rows.map(row => {
      const label = row.querySelector("label")!.getBoundingClientRect();
      const control = row.querySelector("input,select,textarea")!.getBoundingClientRect();
      return { labelLeft: label.left, controlLeft: control.left, controlRight: control.right, rowRight: row.getBoundingClientRect().right };
    }));
    expect(columns.length).toBeGreaterThan(3);
    expect(Math.max(...columns.map(row => row.controlLeft)) - Math.min(...columns.map(row => row.controlLeft))).toBeLessThan(2);
    expect(columns.every(row => row.labelLeft < row.controlLeft && row.controlRight <= row.rowRight)).toBe(true);
    if (feature === "SSH 终端") {
      const aiOpener = dialog.getByRole("button", { name: "AI 识别主机信息", exact: true });
      await aiOpener.click();
      const child = page.getByRole("dialog", { name: "AI 识别主机信息", exact: true });
      await expect(child).toBeVisible();
      expect(await dialog.evaluate(element => element.parentElement?.inert)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(child).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(aiOpener).toBeFocused();
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}
