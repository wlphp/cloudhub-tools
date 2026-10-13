import { test, expect, type Page } from "@playwright/test";

test("local certificate source filter combines with search and supports legacy sources", async ({ page }) => {
  await fixture(page, true);
  await page.evaluate(() => {
    const bridge = (window as any).__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (command: string, args: any) => {
      const result = await invoke(command, args);
      return command === "list_certificates" ? [...result, { ...result[0], id: 11, primaryDomain: "baota.test", domains: ["baota.test"], sourceKind: undefined, provider: "baota" }] : result;
    };
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  const source = page.getByLabel("来源", { exact: true });
  const search = page.getByLabel("搜索证书", { exact: true });
  const rows = page.locator(".certificate-panel tbody tr");
  await expect(rows).toHaveCount(3);
  for (const [kind, label] of [["manual", "手动导入"], ["baota", "宝塔导入"], ["acme", "申请签发"]]) {
    await source.selectOption(kind);
    await expect(rows).toHaveCount(1);
    await expect(rows.locator(".certificate-source-label")).toHaveText(label);
    await expect(page.locator(".certificate-count")).toHaveText("共 1 张");
  }
  await search.fill("baota.test");
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("没有匹配的证书", { exact: true })).toBeVisible();
  await source.selectOption("baota");
  await expect(rows).toHaveCount(1);
  await source.selectOption("all");
  await search.fill("手动导入");
  await expect(rows).toHaveCount(1);
  await search.fill("");
  await expect(rows).toHaveCount(3);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await source.evaluate(element => {
      const control = element.getBoundingClientRect();
      const toolbar = element.closest(".certificate-toolbar")!;
      const bounds = toolbar.getBoundingClientRect();
      return { width: window.innerWidth, left: control.left >= bounds.left, right: control.right <= bounds.right, overflow: toolbar.scrollWidth - toolbar.clientWidth };
    })).toMatchObject({ width, left: true, right: true, overflow: 0 });
  }
  await page.locator(".certificate-toolbar").screenshot({ path: "test-results/certificate-source-filter.png" });
});

async function fixture(page: Page, manyDomains = false) {
  await page.addInitScript((manyDomains) => {
    const calls: { command: string; args: any }[] = [];
    const certificate = { id: 9, accountId: null, sourceKind: "manual", provider: "manual", primaryDomain: "site.test", domains: ["site.test"], status: "issued", issuer: "Fixture CA", notBefore: 1, notAfter: 2000000000, dnsZone: "", createdAt: 1, updatedAt: 1 };
    let imported = manyDomains;
    let failRenew = false;
    let domainExportResult: string | null = "fixture-domains.txt";
    const panels = [{ id: 4, name: "测试宝塔", panel_url: "https://panel.test", api_key_saved: true }];
    let failedPanel: number | null = null;
    const site = { id: 12, panelId: 4, panelName: "测试宝塔", siteId: 21, siteName: "site.test", siteDomains: ["site.test", "www.site.test"], certificateDomains: ["site.test"], enabled: true, issuer: "Fixture CA", notAfter: 2000000000, fingerprint: "test-fingerprint", certificateId: null, canRenew: true, canImport: true, capabilityReason: "由宝塔原订单续签", checkedAt: 1, error: null };
    const sites = [site,
      { ...site, id: 13, siteName: "plain.test", siteDomains: ["plain.test"], certificateDomains: [], enabled: false, issuer: null, notAfter: null, fingerprint: null, canRenew: false, canImport: false },
      { ...site, id: 14, siteName: "expired.test", siteDomains: ["expired.test"], certificateDomains: ["expired.test"], enabled: false, notAfter: 1, canRenew: false },
    ];
    Object.assign(window, { __addSyncPanels: (fail: boolean) => { panels.push({ id: 5, name: "第二面板", panel_url: "https://second.test", api_key_saved: true }, { id: 6, name: "第三面板", panel_url: "https://third.test", api_key_saved: true }); if (fail) failedPanel = 5; }, __addExpiryFixtures: () => {
      for (const [index, days] of [30, 7, 0.5, 31, null].entries()) sites.push({ ...site, id: 30 + index, siteName: `expiry${index}.test`, notAfter: days === null ? null : Date.now() / 1000 + days * 86400 });
    }, __certificateCalls: calls, __setDomainExportResult: (result: string | null) => { domainExportResult = result; }, __failRenew: () => { failRenew = true; }, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {}, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: any = {}) => {
        calls.push({ command, args: command === "prepare_certificate_import_text" ? { suppliedCertificate: !!args.certificate, suppliedKey: !!args.privateKey } : args });
        if (command === "list_accounts" || command === "list_local_assets") return [];
        if (command === "export_certificate_domains") return domainExportResult;
        if (command === "list_certificates") return imported ? manyDomains ? [{ ...certificate, domains: ["site.test", "www.site.test", ...Array.from({length: 20}, (_, index) => `domain${index}.site.test`)] }, { ...certificate, id: 10, primaryDomain: "issued.test", sourceKind: "acme", provider: "letsencrypt" }] : [certificate] : [];
        if (command === "prepare_certificate_import_text" || command === "select_certificate_import_files") return { token: "fixture-token", candidates: [{ id: "candidate-one", primaryDomain: "site.test", domains: ["site.test"], issuer: "Fixture CA", serialNumber: "01", notBefore: 1, notAfter: 2000000000, fingerprint: "fixture-fingerprint", warnings: [] }] };
        if (command === "confirm_certificate_import") { imported = true; return certificate; }
        if (command === "list_panel_connections") return panels;
        if (command === "list_baota_site_certificates" ) return sites;
        if (command === "confirm_baota_certificate_retry") { Object.assign(site, { pendingRenewal: false, canRenew: false }); return; }
        if (command === "sync_baota_site_certificates") { if (args.panelId === failedPanel) throw { code: "network", message: "面板连接失败" }; site.canRenew = true; return [site]; }
        if (command === "renew_baota_site_certificate" && failRenew) { Object.assign(site, { pendingRenewal: true, canRenew: false }); throw { code: "certificate", message: "面板操作结果待确认，请先刷新站点确认结果，再决定是否重试", retryable: false }; }
        if (command === "renew_baota_site_certificate") return { renewed: true, deployed: true, message: "证书已续签并验证站点部署", site };
        if (command === "import_baota_site_certificate") { imported = true; return certificate; }
        if (command === "plugin:event|listen") return 1;
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        return [];
      },
    } });
  }, manyDomains);
  await page.goto("/");
  await page.getByRole("button", { name: "HTTPS 证书", exact: true }).first().click();
}

for (const fail of [false, true]) test(`all panels synchronize without a selection and continue after failures (${fail})`, async ({ page }) => {
  await fixture(page);
  await page.evaluate(fail => (window as any).__addSyncPanels(fail), fail);
  await page.getByRole("button", { name: "宝塔站点证书", exact: true }).click();
  await expect(page.getByLabel("选择宝塔面板")).toHaveValue("");
  const button = page.getByRole("button", { name: "获取站点证书", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator(".baota-certificate-manager").getByRole("status")).toContainText(fail ? "2/3 个面板成功" : "3/3 个面板成功");
  const calls = await page.evaluate(() => (window as any).__certificateCalls.filter((call: any) => call.command === "sync_baota_site_certificates"));
  expect(calls.map((call: any) => call.args.panelId)).toEqual([4, 5, 6]);
  if (fail) await expect(page.getByRole("alert")).toContainText("第二面板");
  await expect(page.locator(".baota-certificate-manager tbody")).toContainText("site.test");
  await page.getByLabel("选择宝塔面板").selectOption("6");
  await button.click();
  await expect(page.locator(".baota-certificate-manager").getByRole("status")).toContainText("1/1 个面板成功");
  const ids = await page.evaluate(() => (window as any).__certificateCalls.filter((call: any) => call.command === "sync_baota_site_certificates").map((call: any) => call.args.panelId));
  expect(ids).toEqual([4, 5, 6, 6]);
});

test("baota HTTPS filter defaults to certificates and combines with text search", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "宝塔站点证书", exact: true }).click();
  const filter = page.getByLabel("是否有 HTTPS 证书");
  const rows = page.locator(".baota-certificate-manager tbody tr");
  await expect(filter).toHaveValue("yes");
  await expect(rows).toHaveCount(2);
  await expect(rows).toContainText(["site.test", "expired.test"]);
  await filter.selectOption("no");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("plain.test");
  await filter.selectOption("all");
  await expect(rows).toHaveCount(3);
  await page.getByLabel("搜索宝塔站点").fill("plain.test");
  await expect(rows).toHaveCount(1);
  await filter.selectOption("yes");
  await expect(rows).toHaveCount(0);
  await expect(page.locator(".baota-certificate-manager")).toContainText("没有符合检索条件的站点");
  await page.getByLabel("搜索宝塔站点").fill("");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await filter.evaluate(element => {
      const control = element.getBoundingClientRect();
      const toolbar = element.closest(".certificate-toolbar")!.getBoundingClientRect();
      return control.left >= toolbar.left && control.right <= toolbar.right;
    })).toBe(true);
  }
  await page.locator(".certificate-page").screenshot({ path: "test-results/baota-https-filter.png" });
});

test("baota expiry warnings cover thresholds, unknown dates and combined filters", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-12T00:00:00Z"));
  await fixture(page);
  await page.evaluate(() => (window as any).__addExpiryFixtures());
  await page.getByRole("button", { name: "宝塔站点证书", exact: true }).click();
  const manager = page.locator(".baota-certificate-manager");
  const rows = manager.locator("tbody tr");
  await expect(rows).toHaveCount(7);
  await expect(manager.getByRole("button", { name: "30 天内到期（3）", exact: true })).toBeVisible();
  await expect(rows.filter({ hasText: "expiry0.test" })).toContainText("即将到期 30 天");
  await expect(rows.filter({ hasText: "expiry1.test" })).toContainText("紧急到期 7 天");
  await expect(rows.filter({ hasText: "expiry2.test" })).toContainText("紧急到期 1 天");
  await expect(rows.filter({ hasText: "expiry3.test" })).toContainText("剩余 31 天");
  await expect(rows.filter({ hasText: "expiry4.test" })).toContainText("未获取");
  expect(await rows.filter({ hasText: "expiry0.test" }).locator(".certificate-expiry-label").evaluate(element => getComputedStyle(element).color)).not.toEqual(await rows.filter({ hasText: "expiry1.test" }).locator(".certificate-expiry-label").evaluate(element => getComputedStyle(element).color));
  await manager.getByRole("button", { name: "30 天内到期（3）", exact: true }).click();
  await expect(rows).toHaveCount(3);
  await manager.getByRole("button", { name: "7 天内到期（2）", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await manager.getByRole("button", { name: "已过期（1）", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("已过期，请及时更换");
  await manager.getByRole("button", { name: "全部", exact: true }).click();
  await page.getByLabel("搜索宝塔站点").fill("expiry1");
  await expect(manager.getByRole("button", { name: "30 天内到期（1）", exact: true })).toBeVisible();
  await page.getByLabel("搜索宝塔站点").fill("");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await manager.locator(".certificate-expiry-summary").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await manager.screenshot({ path: "test-results/baota-expiry-warning.png" });
});

test("manual certificate import clears pasted material and saves only after confirmation", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "导入证书", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入 HTTPS 证书" });
  await dialog.getByLabel("证书或完整证书链", { exact: true }).fill("fixture-certificate-input");
  await dialog.getByLabel("导入私钥", { exact: true }).fill("fixture-key-input");
  await dialog.getByRole("button", { name: "校验粘贴内容" }).click();
  await expect(dialog.getByLabel("导入私钥", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("证书或完整证书链", { exact: true })).toHaveValue("");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => (window as any).__certificateCalls.filter((call: any) => call.command === "confirm_certificate_import"))).toHaveLength(0);
  await dialog.getByRole("button", { name: "确认导入并加密保存" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".certificate-panel tbody")).toContainText("手动导入");
  const calls = await page.evaluate(() => (window as any).__certificateCalls);
  expect(calls.find((call: any) => call.command === "confirm_certificate_import").args).toEqual({ token: "fixture-token", candidateId: "candidate-one" });
});

test("baota certificates use site names for renewal and keep domains and panel context", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "宝塔站点证书", exact: true }).click();
  await page.getByLabel("选择宝塔面板").selectOption("4");
  await page.getByRole("button", { name: "获取站点证书", exact: true }).click();
  await expect(page.locator(".baota-certificate-manager tbody")).toContainText("测试宝塔");
  await expect(page.locator(".baota-certificate-manager tbody")).toContainText("www.site.test");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".certificate-page").screenshot({ path: "test-results/certificate-compact-header.png" });
  await page.getByRole("button", { name: "续签站点 site.test", exact: true }).click();
  const confirm = page.locator(".app-confirm-dialog");
  await expect(confirm).toContainText("测试宝塔");
  await expect(confirm).toContainText("site.test");
  await confirm.locator(".app-confirm-primary").click();
  await expect(page.locator(".baota-certificate-manager").getByRole("status")).toContainText("已续签并验证站点部署");
  const calls = await page.evaluate(() => (window as any).__certificateCalls);
  expect(calls.find((call: any) => call.command === "renew_baota_site_certificate").args).toEqual({ id: 12 });
  await page.locator(".baota-certificate-manager").screenshot({ path: "test-results/baota-site-certificates.png" });
});

test("unconfirmed renewal cannot repeat until the user checks the panel and resynchronizes", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "宝塔站点证书", exact: true }).click();
  await page.getByLabel("选择宝塔面板").selectOption("4");
  await page.evaluate(() => (window as any).__failRenew());
  await page.getByRole("button", { name: "续签站点 site.test", exact: true }).click();
  await page.locator(".app-confirm-dialog .app-confirm-primary").click();
  await expect(page.getByRole("alert")).toContainText("结果待确认");
  await expect(page.getByRole("button", { name: "续签站点 site.test", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "核对后允许重试", exact: true }).click();
  await page.locator(".app-confirm-dialog .app-confirm-primary").click();
  await expect(page.locator(".baota-certificate-manager").getByRole("status")).toContainText("重新获取站点证书");
  await expect(page.getByRole("button", { name: "续签站点 site.test", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "获取站点证书", exact: true }).click();
  await expect(page.getByRole("button", { name: "续签站点 site.test", exact: true })).toBeEnabled();
});

test("cancelling a selected ZIP import destroys its staged handle without saving", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "导入证书", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入 HTTPS 证书" });
  await dialog.getByRole("button", { name: /选择证书与私钥/ }).click();
  await expect(dialog.getByLabel("选择导入证书")).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__certificateCalls.filter((call: any) => call.command === "cancel_certificate_import").length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__certificateCalls.filter((call: any) => call.command === "confirm_certificate_import").length)).toBe(0);
});

test("domain dialog supports fullscreen, filtered exports and cancelled saves", async ({ page }) => {
  await fixture(page, true);
  await page.locator(".certificate-panel tbody tr").first().getByRole("button", { name: "查看 site.test 的全部域名（22 个）", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "site.test · 全部域名", exact: true });
  await dialog.getByRole("button", { name: "全屏查看域名" }).click();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.width === window.innerWidth && rect.height === window.innerHeight && element.scrollWidth <= element.clientWidth;
    })).toBe(true);
  }
  await dialog.getByRole("button", { name: "导出", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("已导出 22 个域名");
  await dialog.getByLabel("搜索完整域名列表").fill("domain19");
  await dialog.getByRole("button", { name: "导出", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("已导出 1 个域名");
  const calls = await page.evaluate(() => (window as any).__certificateCalls.filter((call: any) => call.command === "export_certificate_domains"));
  expect(calls[0].args.domains).toHaveLength(22);
  expect(calls[1].args).toEqual({ title: "site.test", domains: ["domain19.site.test"] });
  await page.evaluate(() => (window as any).__setDomainExportResult(null));
  await dialog.getByRole("button", { name: "导出", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await dialog.getByLabel("搜索完整域名列表").fill("absent-domain");
  await expect(dialog.getByRole("button", { name: "导出", exact: true })).toBeDisabled();
  await dialog.getByLabel("搜索完整域名列表").fill("");
  await dialog.screenshot({ path: "test-results/certificate-domains-fullscreen.png" });
  await dialog.getByRole("button", { name: "退出全屏" }).click();
  await expect(dialog).not.toHaveClass(/is-fullscreen/);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("large domain lists stay compact and source labels distinguish issued and imported certificates", async ({ page }) => {
  await fixture(page, true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".certificate-page").screenshot({ path: "test-results/certificate-local-compact-header.png" });
  const row = page.locator(".certificate-panel tbody tr").first();
  await page.setViewportSize({ width: 1024, height: 900 });
  const operationVisible = await row.evaluate(element => {
    const viewport = element.closest(".table-wrap")!.getBoundingClientRect();
    const buttons = element.querySelectorAll<HTMLButtonElement>(".certificate-actions button");
    return [...buttons].every(button => { const rect = button.getBoundingClientRect(); return rect.left >= viewport.left && rect.right <= viewport.right + 1; });
  });
  expect(operationVisible).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".certificate-page").screenshot({ path: "test-results/certificate-local-compact-header.png" });
  await expect(row).toContainText("手动导入");
  await expect(page.locator(".certificate-panel tbody tr").nth(1)).toContainText("申请签发");
  await expect(row).not.toContainText("domain19.site.test");
  await row.getByRole("button", { name: "查看 site.test 的全部域名（22 个）", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "site.test · 全部域名", exact: true });
  await expect(dialog.locator("li")).toHaveCount(22);
  await dialog.getByRole("textbox", { name: "搜索完整域名列表" }).fill("domain19");
  await expect(dialog.locator("li")).toHaveCount(1);
  await expect(dialog.locator("li")).toHaveText("domain19.site.test");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await dialog.screenshot({ path: "test-results/certificate-domain-list.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
