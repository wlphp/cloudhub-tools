import type { Page } from "@playwright/test";

/** Follow the same catalog and personal-page entry points as a mobile user. */
export async function openMobileFeature(page: Page, name: string) {
  if (name === "服务器") {
    await page.locator(".mobile-tab-bar").getByRole("button", { name: "首页", exact: true }).click();
    await page.locator(".mobile-home-app-grid button").filter({ has: page.getByText("服务器", { exact: true }) }).click();
    return;
  }
  const apps: Record<string, string> = { "验证器": "cloudhub.authenticator", "身份验证器": "cloudhub.authenticator", "证书管理": "cloudhub.certificates", "云效流水线": "cloudhub.flow", "模型供应商": "cloudhub.model-suppliers" };
  if (name === "证书管理") {
    await page.locator(".mobile-tab-bar").getByRole("button", { name: "首页", exact: true }).click();
    await page.getByRole("button", { name: "打开HTTPS 证书", exact: true }).click();
    return;
  }
  if (apps[name]) {
    await page.locator(".mobile-tab-bar").getByRole("button", { name: "软件商店", exact: true }).click();
    const search = page.getByRole("searchbox", { name: "应用搜索" });
    await search.fill(name === "验证器" ? "身份验证器" : name === "证书管理" ? "HTTPS" : name);
    await page.locator(`[data-plugin-entry="${apps[name]}"]`).click();
    return;
  }
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "我的", exact: true }).click();
  if (name === "系统设置") { await page.getByRole("button", { name, exact: true }).click(); return; }
  const label = name === "域名与 DNS" ? "域名" : name;
  await page.locator(".mobile-more-shortcuts button, .mobile-more-feature").filter({ has: page.getByText(label, { exact: true }) }).click();
}
