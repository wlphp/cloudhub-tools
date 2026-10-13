import { test, expect } from "@playwright/test";

test("DNS editor keeps input when backdrop is clicked and closes explicitly", async ({ page }) => {
  await page.route("**/api/accounts**", route => route.fulfill({ json: [{ id: 7, account_name: "Fixture DNS", cloud_type: "aliyun", access_key_id: "test-only-id", enabled: true, sort_order: 0, created_at: 1, updated_at: 1 }] }));
  await page.route("**/api/local-assets**", route => route.fulfill({ json: [{ account_id: 7, resource_type: "domain", asset_key: "example.test", payload: { DomainName: "example.test" }, fetched_at: 1 }] }));
  await page.route("**/api/dns-records**", route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.goto("/");
  await page.getByRole("button", { name: "资产管理", exact: true }).click();
  await page.getByRole("button", { name: "解析管理", exact: true }).click();
  const manager = page.locator(".domain-tool-modal");
  await page.locator(".domain-tool-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(manager).toBeVisible();
  await page.getByRole("button", { name: /添加记录/ }).click();
  const editor = page.getByRole("dialog", { name: "添加解析记录", exact: true });
  await editor.getByLabel("主机记录", { exact: true }).fill("www");
  await editor.getByLabel("记录值", { exact: true }).fill("192.0.2.10");
  await page.locator(".dns-editor-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("主机记录", { exact: true })).toHaveValue("www");
  await expect(editor.getByLabel("记录值", { exact: true })).toHaveValue("192.0.2.10");
  await editor.getByRole("button", { name: "关闭解析记录编辑", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.locator(".domain-tool-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(manager).toBeVisible();
  await manager.locator(".close-detail").click();
  await expect(manager).toHaveCount(0);
});
