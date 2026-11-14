import { expect, test, type Page } from "@playwright/test";

async function storeFixture(page: Page) {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const op = route.request().method() === "POST" ? route.request().postDataJSON()?.op : "";
    let data: unknown = [];
    if (path === "/api/flow-connections") data = [{ id: 1, name: "示例连接", edition: "central", tokenSaved: true }];
    if (path === "/api/flow-pipelines") data = [{ pipelineId: "one", pipelineName: "示例流水线" }];
    if (path === "/api/flow-pipeline-cache") data = { pipelines: [], updatedAt: null };
    if (path === "/api/flow-latest-run") data = { pipelineRunId: "one", status: "SUCCESS", stages: [], startTime: 1700000000000 };
    if (path === "/api/claude-providers") data = { providers: [], currentId: null, settingsPath: "/fixture/.claude/settings.json", settingsExists: true, hasBackup: false, backups: [] };
    if (path === "/api/notes") data = { notes: [], groups: [], reminders: [], trashed: [] };
    if (path === "/api/authenticator" && op === "status") data = { initialized: true, unlocked: true, passwordRequired: false };
    await route.fulfill({ json: data });
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "软件商店", exact: true }).click();
  await page.getByLabel("每页条数", { exact: true }).selectOption("50");
}

async function fits(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  const sizes = await page.locator(".plugin-page-host").evaluate(el => ({ page: document.documentElement.scrollWidth, viewport: innerWidth, width: el.clientWidth, scroll: el.scrollWidth, content: el.closest(".mobile-content")!.scrollWidth }));
  expect(sizes.page, JSON.stringify(sizes)).toBeLessThanOrEqual(width);
  expect(sizes.scroll, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.width);
  expect(sizes.content, JSON.stringify(sizes)).toBeLessThanOrEqual(width);
}

test("验证器有数据时筛选与两种视图在手机和平板保持对齐", async ({ page }) => {
  await storeFixture(page);
  const entries = ["Google", "GitHub", "OpenAI"].map((issuer, index) => ({ id: `layout-${index}`, issuer, account: `demo-${index}@example.test`, kind: "totp", algorithm: "SHA1", digits: 6, period: 30, counter: "0", group: index ? "工作" : "个人", note: "演示账户", pinned: false, order: index }));
  await page.route("**/api/authenticator", async route => {
    const { op } = route.request().postDataJSON();
    await route.fulfill({ json: op === "status" ? { initialized: true, unlocked: true, passwordRequired: false } : op === "list" ? entries : op === "codes" ? entries.map(entry => ({ id: entry.id, current: "123456", next: "654321", remaining: 17, period: 30, counter: "0" })) : null });
  });
  await page.locator('[data-plugin-entry="cloudhub.authenticator"]').click();
  await expect(page.locator(".auth-card")).toHaveCount(3);
  for (const layout of ["列表视图", "卡片视图"]) {
    await page.getByRole("button", { name: layout, exact: true }).click();
    for (const width of [320, 375, 520, 768]) {
      await fits(page, width);
      const card = page.locator(".auth-card").first();
      expect((await card.boundingBox())!.height).toBeLessThan(270);
    }
  }
  await page.getByLabel("验证码分组", { exact: true }).selectOption("g:工作");
  await expect(page.locator(".auth-card")).toHaveCount(2);
  await page.getByLabel("验证码分组", { exact: true }).selectOption("all");
  await page.setViewportSize({ width: 520, height: 838 });
  await page.screenshot({ path: "test-results/authenticator-mobile-refined.png" });
});

test("逐项打开移动商店应用，页面无溢出且全部渲染真实界面", async ({ page }) => {
  test.setTimeout(120000);
  await storeFixture(page);
  const ids = await page.locator("[data-plugin-entry]").evaluateAll(nodes => nodes.filter(n => !(n as HTMLButtonElement).disabled).map(n => n.getAttribute("data-plugin-entry")!));
  expect(ids).toHaveLength(20);
  for (const id of ids) {
    await test.step(id, async () => {
      await page.locator(`[data-plugin-entry="${id}"]`).click();
      await expect(page.getByRole("button", { name: "返回软件商店", exact: true })).toBeVisible();
      await page.locator(".plugin-page-body").getByText(/^正在加载/).waitFor({ state: "hidden" });
      // 手机端不再展示“请在桌面客户端使用”占位，所有应用都渲染真实业务界面。
      await expect(page.locator(".plugin-mobile-unavailable")).toHaveCount(0);
      if (id === "cloudhub.frp") {
        await expect(page.getByText("内网穿透仅在桌面客户端可用。", { exact: true })).toHaveCount(0);
        await page.getByRole("button", { name: "新增服务端", exact: true }).first().click();
        await expect(page.locator(".frp-server-settings")).toBeVisible();
      }
      if (id === "cloudhub.cloud-drive") await expect(page.getByRole("button", { name: "新增连接", exact: true })).toBeVisible();
      if (id === "cloudhub.flow") {
        await expect(page.locator(".flow-mobile-card")).toHaveCount(1);
        await expect(page.locator(".flow-pipeline-table")).toHaveCount(0);
      }
      if (id === "cloudhub.claude-providers") {
        await expect(page.locator(".claude-config-disclosure")).not.toHaveAttribute("open", "");
        const search = page.getByRole("searchbox", { name: "搜索供应商", exact: true });
        await search.focus();
        expect(await search.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe("0px");
        expect(await search.evaluate(el => getComputedStyle(el.parentElement!).outlineStyle)).not.toBe("none");
      }
      if (["cloudhub.wsl-dashboard", "cloudhub.hardware-info"].includes(id)) {
        const tabs = page.locator(".plugin-page-body [role=tab]");
        const count = await tabs.count();
        expect(count).toBe(4);
        for (let index = 0; index < count; index++) {
          await tabs.nth(index).click();
          for (const width of [375, 520, 768]) await fits(page, width);
        }
        await tabs.first().click();
      }
      for (const width of [320, 375, 390, 768]) await fits(page, width);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator(".mobile-content").evaluate(el => el.scrollTo(0, 0));
      await expect(page.getByRole("button", { name: "返回软件商店", exact: true })).toBeInViewport();
      await page.screenshot({ path: `test-results/mobile-store-${id.replace("cloudhub.", "")}.png` });
      await page.getByRole("button", { name: "返回软件商店", exact: true }).click();
    });
  }
});

test("移动应用表单复用公共弹层，窄屏操作和遮罩行为正常", async ({ page }) => {
  await storeFixture(page);
  for (const [id, trigger, dialogName] of [["cloud-drive", "新增连接", "新增云盘连接"], ["mail", "添加邮箱", "添加邮箱"], ["flow", "添加连接", "云效连接"], ["notes", "新建备忘录", "新建备忘录"], ["authenticator", "新增", "新增验证码"]]) {
    await page.locator(`[data-plugin-entry="cloudhub.${id}"]`).click();
    const button = page.getByRole("button", { name: trigger, exact: true }).first();
    if (id === "flow") await expect(page.locator(".flow-mobile-card")).toHaveCount(1);
    await button.click();
    const dialog = page.getByRole("dialog").last();
    await expect(dialog, dialogName).toBeVisible();
    await expect(dialog).toHaveClass(/modal-form-layout/);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 740 });
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    await page.locator(".modal-backdrop").last().click({ position: { x: 1, y: 1 }, force: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "返回软件商店", exact: true }).click();
  }
});
