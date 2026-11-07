import { expect, test } from "@playwright/test";

test("software store stays within narrow mobile viewports", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "软件商店", exact: true }).click();
  const store = page.locator(".software-store-page");
  await expect(store).toBeVisible();

  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 740 });
    for (const expanded of [false, true]) {
      const toggle = store.getByRole("button", { name: expanded ? "展开详情" : "收起详情" }).first();
      if (await toggle.count()) await toggle.click();
      else expect(expanded, "the first store card must expose its details toggle").toBe(false);

      const dimensions = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        const storeElement = document.querySelector<HTMLElement>(".software-store-page")!;
        const content = storeElement.closest<HTMLElement>(".mobile-content")!;
        return {
          viewport,
          document: document.documentElement.scrollWidth,
          contentClient: content.clientWidth,
          contentScroll: content.scrollWidth,
          storeClient: storeElement.clientWidth,
          storeScroll: storeElement.scrollWidth,
          offenders: [...storeElement.querySelectorAll<HTMLElement>("*")]
            .filter(element => element.getBoundingClientRect().right > viewport + 1)
            .slice(0, 8)
            .map(element => ({ tag: element.tagName, className: String(element.className), left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })),
        };
      });

      expect(dimensions.document, JSON.stringify({ width, expanded, ...dimensions })).toBeLessThanOrEqual(dimensions.viewport);
      expect(dimensions.contentScroll, JSON.stringify({ width, expanded, ...dimensions })).toBeLessThanOrEqual(dimensions.contentClient);
      expect(dimensions.storeScroll, JSON.stringify({ width, expanded, ...dimensions })).toBeLessThanOrEqual(dimensions.storeClient);
    }
  }
});
