import { expect, test } from "@playwright/test";

test("account and panel groups suggest local groups and accept new names", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string) => {
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        if (command === "list_accounts") return [1, 2].map(id => ({ id, account_name: `测试账号${id}`, cloud_type: "aliyun", group_name: "账号生产", access_key_id: "test-only-id", enabled: true }));
        if (command === "list_panel_connections") return [1, 2].map(id => ({ id, name: `测试面板${id}`, panel_url: "https://example.test", group_name: "面板生产", sort_order: id, status: "unknown", summary: {}, api_key_saved: true }));
        return [];
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "添加云账号", exact: true }).click();
  const account = page.getByRole("dialog", { name: "添加云账号" });
  const accountGroup = account.getByLabel("分组", { exact: true });
  await expect(accountGroup).toHaveAttribute("placeholder", "选择已有分组或输入新分组");
  await expect.poll(() => accountGroup.evaluate((el: HTMLInputElement) => Array.from(el.list!.options, option => option.value))).toEqual(["账号生产"]);
  await accountGroup.fill("账号生产");
  await expect(accountGroup).toHaveValue("账号生产");
  await accountGroup.fill("新账号分组");
  await expect(accountGroup).toHaveValue("新账号分组");
  await account.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "面板管理", exact: true }).first().click();
  const card=page.locator(".panel-monitor-row").first();
  await expect(card.locator(".panel-row-details").getByRole("button",{name:"AI 分析面板指标",exact:true})).toBeVisible();
  await expect(card.locator(".panel-row-status .ai-assist-button")).toHaveCount(0);
  const layout=await card.locator(".panel-row-details").evaluate(el=>{
    const group=el.querySelector(".panel-row-group")!.getBoundingClientRect();
    const button=el.querySelector(".ai-assist-button")!.getBoundingClientRect();
    return {groupRight:group.right,buttonLeft:button.left,groupCenter:group.top+group.height/2,buttonCenter:button.top+button.height/2};
  });
  expect(layout.buttonLeft).toBeGreaterThanOrEqual(layout.groupRight);
  expect(Math.abs(layout.groupCenter-layout.buttonCenter)).toBeLessThanOrEqual(1);
  await page.screenshot({path:"test-results/panel-ai-action-position.png"});
  await page.getByRole("button", { name: "添加面板", exact: true }).click();
  const panel = page.locator(".panel-bind-modal");
  const panelGroup = panel.getByLabel("分组", { exact: true });
  await expect.poll(() => panelGroup.evaluate((el: HTMLInputElement) => Array.from(el.list!.options, option => option.value))).toEqual(["面板生产"]);
  await panelGroup.fill("新面板分组");
  await expect(panelGroup).toHaveValue("新面板分组");
  await panel.screenshot({ path: "test-results/panel-group-input.png" });
});
