import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page) {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string) => {
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "list_client_preferences") return {};
        if (command === "ai_list_profiles") return [{ id: "fixture-ai", name: "测试服务", protocol: "openai_chat", model: "fixture", enabled: true, isDefault: true, visionStatus: "supported" }];
        return [];
      },
    };
  });
  await page.goto("/");
}

for (const width of [375, 768, 1024, 1440]) {
  test(`panel and server dialog chrome stays visible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await setup(page);
    await page.getByRole("button", { name: "面板管理", exact: true }).first().click();
    await page.getByRole("button", { name: "添加面板", exact: true }).click();
    for (const kind of ["panel", "server"]) {
      if (kind === "server") {
        await page.setViewportSize({width:1280,height:600});
        await page.getByRole("button", { name: "终端管理", exact: true }).first().click();
        await page.locator(".terminal-add-host").click();
      }
      await page.setViewportSize({width,height:600});
      const dialog = page.locator(kind === "panel" ? ".panel-bind-modal" : ".managed-host-modal");
      await expect(dialog.locator(".ai-assist-button")).toBeVisible();
      const originalBox = await dialog.boundingBox();
      const field = dialog.locator('.modal-body > label input').first();
      await field.fill("保留填写内容");
      await dialog.getByRole("button", {name:"最大化弹层",exact:true}).click();
      const expandedBox = await dialog.boundingBox();
      expect(expandedBox!.width).toBeCloseTo(width * .95, 0);
      expect(expandedBox!.height).toBeCloseTo(600 * .95, 0);
      await expect(field).toHaveValue("保留填写内容");
      await dialog.getByRole("button", {name:"缩小弹层",exact:true}).click();
      expect((await dialog.boundingBox())!.width).toBeCloseTo(originalBox!.width, 0);

      const initial = await dialog.evaluate(el => {
        const body = el.querySelector(".modal-body")!;
        const field = body.querySelector("label input")!.getBoundingClientRect();
        const ai = body.querySelector(".ai-assist-button")!.getBoundingClientRect();
        const head = el.querySelector(".modal-head")!.getBoundingClientRect();
        const footer = el.querySelector(".modal-actions")!.getBoundingClientRect();
        return { field: field.left, ai: ai.left, head: head.top, footer: footer.top };
      });
      expect(Math.abs(initial.ai - initial.field)).toBeLessThanOrEqual(1);
      const result = await dialog.evaluate(el => {
        const body = el.querySelector(".modal-body")!;
        body.scrollTop = body.scrollHeight;
        const head = el.querySelector(".modal-head")!.getBoundingClientRect();
        const footer = el.querySelector(".modal-actions")!.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return { head: head.top, footer: footer.top, footerBottom: footer.bottom, width: box.width, overflow: el.scrollWidth > el.clientWidth, bg: getComputedStyle(el).backgroundColor, footerBg: getComputedStyle(el.querySelector(".modal-actions")!).backgroundColor };
      });
      expect(result.head).toBeCloseTo(initial.head, 0);
      expect(result.footer).toBeCloseTo(initial.footer, 0);
      expect(result.head).toBeGreaterThanOrEqual(0);
      expect(result.footerBottom).toBeLessThanOrEqual(600);
      expect(result.width).toBeLessThanOrEqual(width);
      expect(result.overflow).toBe(false);
      expect(result.footerBg).toBe(result.bg);
      if (kind === "panel") await page.screenshot({ path: `test-results/panel-dialog-scroll-${width}.png` });
      await dialog.getByRole("button", { name: kind === "panel" ? "关闭面板配置" : "关闭服务器配置", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
  });
}
