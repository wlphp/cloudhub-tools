import { test, expect } from "@playwright/test";

test("mobile channel scope recovers in place and saves only selected modules", async ({ page }) => {
  let catalogFailed = true;
  let saved: { tables?: string[] } | undefined;
  const categories = [
    { table: "cloud_accounts", label: "云账号", count: 0 },
    { table: "ssh_connections", label: "云主机 SSH", count: 0 },
    { table: "certificates", label: "HTTPS 证书与私钥", count: 0 },
    { table: "memo_notes", label: "备忘录", count: 0 },
  ];
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/database-import/catalog") return route.fulfill(catalogFailed
      ? { status: 400, json: { error: "读取数据范围失败，请更新本机调试程序后重试。" } }
      : { json: categories });
    if (path === "/api/cloud-sync/save") {
      saved = route.request().postDataJSON().config;
      return route.fulfill({ json: { configured: true, config: { ...saved, id: "fixture", name: "测试备份", method: "webdav" }, status: { busy: false, paused: false } } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "更多", exact: true }).click();
  await page.locator(".mobile-more-feature").filter({ hasText: "系统设置" }).click();
  await page.getByRole("button", { name: /导入数据/ }).click();
  await page.getByRole("button", { name: "添加同步渠道", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加同步渠道", exact: true });
  await dialog.locator("summary").click();
  await expect(dialog.getByRole("alert")).toContainText("读取数据范围失败");
  await expect(dialog.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("checkbox", { name: "选择全部数据", exact: true })).toHaveCount(0);
  catalogFailed = false;
  await dialog.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(dialog.getByLabel("云账号", { exact: true })).toBeChecked();
  const selectAll = dialog.getByRole("checkbox", { name: "选择全部数据", exact: true });
  await expect(selectAll).toBeChecked();
  await selectAll.uncheck();
  await expect(dialog.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
  await dialog.getByLabel("云账号", { exact: true }).check();
  await expect(selectAll).toHaveJSProperty("indeterminate", true);
  await expect(dialog.getByRole("checkbox", { name: "全选云账号与连接", exact: true })).toHaveJSProperty("indeterminate", true);
  await dialog.getByRole("checkbox", { name: "全选云账号与连接", exact: true }).check();
  await expect(dialog.getByLabel("云主机 SSH", { exact: true })).toBeChecked();
  await dialog.getByRole("checkbox", { name: "全选云账号与连接", exact: true }).uncheck();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const positions = await dialog.locator('.data-transfer-all input, .data-transfer-group-heading input').evaluateAll(inputs => inputs.map(input => input.getBoundingClientRect().left));
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(2);
    const childLeft = await dialog.locator('.data-transfer-check input').first().evaluate(input => input.getBoundingClientRect().left);
    expect(childLeft - positions[0]).toBeCloseTo(32, 0);
    const items = await dialog.locator('.data-transfer-check').evaluateAll(labels => labels.slice(0, 2).map(label => ({ left: label.getBoundingClientRect().left, top: label.getBoundingClientRect().top })));
    if (width <= 600) {
      expect(Math.abs(items[0].left - items[1].left)).toBeLessThan(2);
      expect(items[1].top).toBeGreaterThan(items[0].top);
    } else {
      expect(items[1].left).toBeGreaterThan(items[0].left);
      expect(Math.abs(items[0].top - items[1].top)).toBeLessThan(2);
    }
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await dialog.getByLabel("备忘录", { exact: true }).check();
  await dialog.getByLabel("渠道名称", { exact: true }).fill("测试备份");
  await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(saved?.tables).toEqual(["memo_notes"]);
});
