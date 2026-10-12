import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, accessType: "NS" | "CNAME" = "NS") {
  await page.addInitScript(({ accessType }) => {
    const calls: { command: string; args: any }[] = [];
    let certificateId = 9;
    let failDeploy = false;
    let holdRequest = false;
    let cancelPending: ((reason: Error) => void) | null = null;
    const accounts = [{ id: 7, account_name: "Fixture ESA", cloud_type: "aliyun", access_key_id: "test-only-id", enabled: true, sort_order: 0, created_at: 1, updated_at: 1 }, { id: 8, account_name: "Fixture DNS", cloud_type: "aliyun", access_key_id: "test-only-dns", enabled: true, sort_order: 1, created_at: 1, updated_at: 1 }];
    const assets = [{ account_id: 7, resource_type: "esa", asset_key: "123", payload: { SiteId: 123, SiteName: "example.test", AccessType: accessType, Status: "active" }, fetched_at: 1 }, { account_id: 8, resource_type: "domain", asset_key: "example.test", payload: { DomainName: "example.test" }, fetched_at: 1 }];
    const context = () => ({ site: { siteId: 123, siteName: "example.test", accessType }, candidates: [
      { id: certificateId, domains: ["example.test", "*.example.test"], status: "issued", deployable: true, matchesSite: true, reason: null, notBefore: Date.now() / 1000 - 3600, notAfter: Date.now() / 1000 + 86400 },
      { id: 8, domains: ["other.test"], status: "issued", deployable: true, matchesSite: false, reason: "域名与当前 ESA 站点不匹配", notBefore: Date.now() / 1000 - 3600, notAfter: Date.now() / 1000 + 86400 },
      { id: 6, domains: ["old.test"], status: "issued", deployable: false, matchesSite: false, reason: "证书已过期", notBefore: Date.now() / 1000 - 7200, notAfter: Date.now() / 1000 - 3600 },
    ], remote: [] });
    Object.assign(window, { __esaCalls: calls, __holdEsaRequest: () => { holdRequest = true; }, __failEsaDeployment: () => { failDeploy = true; }, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: any = {}) => {
        calls.push({ command, args });
        if (command === "list_accounts") return accounts;
        if (command === "list_local_assets") return assets.filter(asset => !args.resourceType || asset.resource_type === args.resourceType);
        if (command === "esa_certificate_context") return context();
        if (command === "esa_deploy_certificate") { if (failDeploy) { failDeploy = false; throw new Error("Fixture ESA upload failed"); } return { remoteId: "fixture-remote", status: "OK", verified: true, message: "已上传到 ESA，证书状态正常" }; }
        if (command === "cancel_certificate_request") { cancelPending?.(new Error("已取消证书申请")); return; }
        if (command === "request_certificate") { if (holdRequest) return new Promise((_, reject) => { cancelPending = reject; }); certificateId = 10; return { id: 10, primaryDomain: "example.test", domains: ["example.test", "*.example.test"], notAfter: Date.now() / 1000 + 86400, status: "issued" }; }
        if (command === "plugin:event|listen") return 1;
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        return [];
      },
    } });
  }, { accessType });
  await page.goto("/");
  await page.getByRole("button", { name: /查看 Fixture ESA 边缘安全加速资产/ }).click();
  await page.getByRole("button", { name: "站点列表", exact: true }).click();
  await page.getByRole("button", { name: "证书部署", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "example.test · ESA 证书", exact: true })).toBeVisible();
}

test("ESA uploads only certificate IDs and can retry an existing local certificate", async ({ page }) => {
  await fixture(page);
  const dialog = page.getByRole("dialog", { name: "example.test · ESA 证书", exact: true });
  const select = dialog.getByLabel("选择本地证书", { exact: true });
  await expect(select.locator("option")).toHaveCount(2);
  await expect(select.locator('option[value="8"]')).toHaveCount(0);
  await expect(dialog.getByText("显示 1 / 共 3 个 · 1 个可部署", { exact: true })).toBeVisible();
  await dialog.getByLabel("显示全部本地证书").check();
  await expect(select.locator("option")).toHaveCount(4);
  await expect(select.locator('option[value="6"]')).toHaveAttribute("disabled", "");
  await expect(select.locator('option[value="8"]')).not.toHaveAttribute("disabled");
  await expect(dialog.getByText("显示 3 / 共 3 个 · 2 个可部署", { exact: true })).toBeVisible();
  await dialog.getByLabel("显示全部本地证书").uncheck();
  await expect(select.locator("option")).toHaveCount(2);
  await expect(select).toHaveValue("9");
  await dialog.getByLabel("显示全部本地证书").check();
  await page.evaluate(() => (window as any).__failEsaDeployment());
  await dialog.getByRole("button", { name: "部署已有证书", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "重试部署", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("已上传到 ESA");
  const calls = await page.evaluate(() => (window as any).__esaCalls);
  expect(calls.filter((call: any) => call.command === "esa_deploy_certificate")).toHaveLength(2);
  expect(calls.find((call: any) => call.command === "esa_deploy_certificate").args).toEqual({ accountId: 7, siteId: 123, certificateId: 9 });
  expect(calls.some((call: any) => call.command === "get_certificate_material")).toBe(false);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await dialog.screenshot({ path: "test-results/esa-certificate-deployment.png" });
});

test("ESA allows attempting deployment with a valid certificate whose domain does not match the site", async ({ page }) => {
  await fixture(page);
  const dialog = page.getByRole("dialog", { name: "example.test · ESA 证书", exact: true });
  const select = dialog.getByLabel("选择本地证书", { exact: true });
  await dialog.getByLabel("显示全部本地证书").check();
  await select.selectOption("8");
  await expect(dialog.getByRole("button", { name: "部署已有证书", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "部署已有证书", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("已上传到 ESA");
  const calls = await page.evaluate(() => (window as any).__esaCalls);
  expect(calls.find((call: any) => call.command === "esa_deploy_certificate").args.certificateId).toBe(8);
});

for (const accessType of ["NS", "CNAME"] as const) {
  test(`ESA ${accessType} request then deployment keeps the issued certificate after upload failure`, async ({ page }) => {
    await fixture(page, accessType);
    await page.getByRole("button", { name: "申请并部署", exact: true }).click();
    await expect(page.getByRole("heading", { name: "申请证书并部署到 ESA", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "@ + *", exact: true }).click();
    await page.evaluate(() => (window as any).__failEsaDeployment());
    await page.getByRole("button", { name: "开始申请", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "example.test · ESA 证书", exact: true });
    await expect(dialog.getByRole("button", { name: "重试部署", exact: true })).toBeEnabled();
    await expect(dialog.getByLabel("选择本地证书", { exact: true })).toHaveValue("10");
    await dialog.getByRole("button", { name: "重试部署", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("已上传到 ESA");
    const calls = await page.evaluate(() => (window as any).__esaCalls);
    const request = calls.find((call: any) => call.command === "request_certificate").args.input;
    expect(request.domains).toEqual(["example.test", "*.example.test"]);
    expect(request.accountId).toBe(accessType === "NS" ? 7 : 8);
    expect(request.esaSiteId).toBe(accessType === "NS" ? 123 : undefined);
    expect(calls.filter((call: any) => call.command === "request_certificate")).toHaveLength(1);
    expect(calls.filter((call: any) => call.command === "esa_deploy_certificate").every((call: any) => call.args.certificateId === 10 && call.args.accountId === 7)).toBe(true);
  });
}

test("cancelling an ESA certificate request never starts deployment", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "申请并部署", exact: true }).click();
  await page.evaluate(() => (window as any).__holdEsaRequest());
  await page.getByRole("button", { name: "开始申请", exact: true }).click();
  await expect(page.getByRole("button", { name: "申请中，等待 DNS 验证…", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("button", { name: "开始申请", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "example.test · ESA 证书", exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__esaCalls);
  expect(calls.filter((call: any) => call.command === "request_certificate")).toHaveLength(1);
  expect(calls.filter((call: any) => call.command === "cancel_certificate_request")).toHaveLength(1);
  expect(calls.filter((call: any) => call.command === "esa_deploy_certificate")).toHaveLength(0);
});
