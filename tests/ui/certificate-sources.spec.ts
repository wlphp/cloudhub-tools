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
        if (command === "remove_baota_site_domain") {
          if ((window as any).__failDomainRemove) throw { code: "network", message: "移除失败，请核对宝塔绑定" };
          const target = sites.find(item => item.id === args.id);
          if (!target) throw { code: "validation", message: "站点不存在" };
          if (target.siteDomains.length <= 1) throw { code: "validation", message: "站点至少保留一个域名" };
          target.siteDomains = target.siteDomains.filter(domain => domain !== args.domain);
          return { ...target };
        }
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
  await page.getByRole("button", { name: "宝塔站点管理", exact: true }).click();
  await expect(page.getByLabel("选择宝塔面板")).toHaveValue("");
  const button = page.getByRole("button", { name: "获取站点", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator(".baota-certificate-manager").getByRole("status", { includeHidden: true })).toContainText(fail ? "2/3 个面板成功" : "3/3 个面板成功");
  const calls = await page.evaluate(() => (window as any).__certificateCalls.filter((call: any) => call.command === "sync_baota_site_certificates"));
  expect(calls.map((call: any) => call.args.panelId)).toEqual([4, 5, 6]);
  if (fail) {
    const errors = page.getByRole("dialog", { name: "站点拉取失败详情", exact: true });
    await expect(errors.locator("li")).toContainText("第二面板");
    await errors.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("1 个面板拉取失败");
  }
  await expect(page.locator(".baota-certificate-manager tbody")).toContainText("site.test");
  await page.getByLabel("选择宝塔面板").selectOption("6");
  await button.click();
  await expect(page.locator(".baota-certificate-manager").getByRole("status")).toContainText("1/1 个面板成功");
  const ids = await page.evaluate(() => (window as any).__certificateCalls.filter((call: any) => call.command === "sync_baota_site_certificates").map((call: any) => call.args.panelId));
  expect(ids).toEqual([4, 5, 6, 6]);
});

test("sync failures open separate rows with actionable guidance and can be reopened", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    (window as any).__addSyncPanels(false);
    const bridge = (window as any).__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (command: string, args: any) => {
      if (command === "sync_baota_site_certificates") throw { code: "network", message: args.panelId === 4
        ? "当前面板地址不是 HTTPS，站点管理需要 HTTPS 连接"
        : args.panelId === 5 ? "站点名称不符合当前域名校验规则（站点 ID：21）"
        : "无法建立宝塔连接，可能为地址或端口不可达、DNS 解析失败或 TLS 握手失败" };
      return invoke(command, args);
    };
  });
  await page.getByRole("button", { name: "宝塔站点管理", exact: true }).click();
  await page.getByRole("button", { name: "获取站点", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "站点拉取失败详情", exact: true });
  await expect(dialog.locator("li")).toHaveCount(3);
  await expect(dialog.locator("li").nth(0)).toContainText("此选项不能用于 HTTP 地址");
  await expect(dialog.locator("li").nth(1)).toContainText("与 HTTPS 无关");
  await expect(dialog.locator("li").nth(2)).toContainText("TLS 配置");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await dialog.screenshot({ path: "test-results/baota-sync-failures.png" });
  await page.locator(".shared-dialog-backdrop").click({ position: { x: 2, y: 2 } });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "查看失败详情（3）", exact: true }).click();
  await expect(dialog.locator("li")).toHaveCount(3);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".baota-certificate-manager tbody tr")).toHaveCount(3);
});

test("combined site domain list removes only the confirmed site binding through native API", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const bridge = (window as any).__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (command: string, args: any) => {
      const result = await invoke(command, args);
      return command === "list_baota_site_certificates" ? result.map((site: any) => site.id === 13 ? { ...site, siteDomains: ["plain.test", "www.site.test"] } : site) : result;
    };
  });
  await page.getByRole("button", { name: "宝塔站点管理", exact: true }).click();
  await page.getByRole("button", { name: "站点域名（5）", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "当前条件下的站点域名", exact: true });
  const remove = dialog.getByRole("button", { name: "移除 site.test 的域名 www.site.test", exact: true });
  await remove.click();
  const confirm = page.getByRole("alertdialog", { name: "移除站点域名", exact: true });
  await expect(confirm).toContainText("面板 测试宝塔 的站点 site.test");
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__certificateCalls.filter((call: any) => call.command === "remove_baota_site_domain"))).toHaveLength(0);
  await page.evaluate(() => { (window as any).__failDomainRemove = true; });
  await remove.click();
  await confirm.getByRole("button", { name: "确认移除", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("移除失败");
  await expect(remove).toBeEnabled();
  await page.evaluate(() => { (window as any).__failDomainRemove = false; });
  await remove.click();
  await confirm.getByRole("button", { name: "确认移除", exact: true }).click();
  await expect(remove).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "移除 plain.test 的域名 www.site.test", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "移除 site.test 的域名 site.test", exact: true })).toBeDisabled();
  await expect(dialog.locator("tbody tr")).toHaveCount(4);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(dialog.getByRole("button", { name: "移除 plain.test 的域名 www.site.test", exact: true })).toBeInViewport();
  }
  await dialog.screenshot({ path: "test-results/baota-domain-remove-list.png" });
  expect(await page.evaluate(() => (window as any).__certificateCalls.filter((call: any) => call.command === "remove_baota_site_domain").map((call: any) => call.args))).toEqual([{ id: 12, domain: "www.site.test" }, { id: 12, domain: "www.site.test" }]);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("button", { name: "站点域名（4）", exact: true })).toBeVisible();
});

test("site domain removal confirms native write and preserves failed binding", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "宝塔站点管理", exact: true }).click();
  await page.getByRole("button", { name: "查看 site.test 的全部域名（2 个）", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "site.test · 全部域名", exact: true });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const positions = await dialog.locator(".export-selection-row").evaluateAll(rows => rows.map(row => { const r = row.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left }; }));
    expect(positions[1].top).toBeGreaterThanOrEqual(positions[0].bottom);
    expect(positions[1].left).toBe(positions[0].left);
  }
  const remove = dialog.getByRole("button", { name: "移除域名 www.site.test", exact: true });
  await remove.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__certificateCalls.filter((c: any) => c.command === "remove_baota_site_domain"))).toHaveLength(0);
  await page.evaluate(() => { (window as any).__failDomainRemove = true; });
  await remove.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认移除", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("移除失败");
  await expect(remove).toBeEnabled();
  await page.evaluate(() => { (window as any).__failDomainRemove = false; });
  await remove.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认移除", exact: true }).click();
  await expect(remove).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "移除域名 site.test", exact: true })).toBeDisabled();
  await expect(dialog).toContainText("全部域名 · 1 个");
  expect(await page.evaluate(() => (window as any).__certificateCalls.filter((c: any) => c.command === "remove_baota_site_domain").map((c: any) => c.args))).toEqual([{ id: 12, domain: "www.site.test" }, { id: 12, domain: "www.site.test" }]);
});

test("site domain batch removal protects the last binding and requires confirmation", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "宝塔站点管理", exact: true }).click();
  await page.getByRole("button", { name: /^站点域名（\d+）$/ }).click();
  const dialog = page.getByRole("dialog", { name: "当前条件下的站点域名", exact: true });
  await dialog.getByLabel("全选当前筛选范围的可移除域名", { exact: true }).check();
  await dialog.getByRole("button", { name: "批量移除（2）", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("至少取消勾选一个域名");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await dialog.getByLabel("选择 site.test 的域名 site.test", { exact: true }).uncheck();
  await dialog.getByRole("button", { name: "批量移除（1）", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "批量移除站点域名", exact: true });
  await expect(confirm).toContainText("www.site.test");
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__certificateCalls.filter((call: any) => call.command === "remove_baota_site_domain"))).toHaveLength(0);
  await dialog.getByRole("button", { name: "批量移除（1）", exact: true }).click();
  await confirm.getByRole("button", { name: "确认移除 1 个域名", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("成功 1 个，失败 0 个");
  await expect(dialog.getByLabel("选择 site.test 的域名 www.site.test", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("选择 site.test 的域名 site.test", { exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__certificateCalls.filter((call: any) => call.command === "remove_baota_site_domain").map((call: any) => call.args))).toEqual([{ id: 12, domain: "www.site.test" }]);
});

test("site domain batch removal isolates shared domains and reports partial failures", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const bridge = (window as any).__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (command: string, args: any) => {
      if (command === "remove_baota_site_domain" && args.id === 13) {
        (window as any).__certificateCalls.push({ command, args });
        throw { code: "network", message: "测试面板连接失败，请核对绑定" };
      }
      const result = await invoke(command, args);
      if (command === "list_baota_site_certificates") {
        const target = result.find((site: any) => site.id === 13);
        target.siteDomains = ["plain.test", "www.site.test"];
      }
      return result;
    };
  });
  await page.getByRole("button", { name: "宝塔站点管理", exact: true }).click();
  await page.getByRole("button", { name: /^站点域名（\d+）$/ }).click();
  const dialog = page.getByRole("dialog", { name: "当前条件下的站点域名", exact: true });
  await dialog.getByLabel("模糊搜索站点域名").fill("www.site.test");
  await dialog.getByLabel("全选当前筛选范围的可移除域名", { exact: true }).check();
  await dialog.getByRole("button", { name: "批量移除（2）", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认移除 2 个域名", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("成功 1 个，失败 1 个");
  await expect(dialog.getByRole("alert")).toContainText("www.site.test · plain.test：测试面板连接失败");
  await expect(dialog.getByLabel("选择 site.test 的域名 www.site.test", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("选择 plain.test 的域名 www.site.test", { exact: true })).toBeChecked();
  expect(await page.evaluate(() => (window as any).__certificateCalls.filter((call: any) => call.command === "remove_baota_site_domain").map((call: any) => call.args))).toEqual([{ id: 13, domain: "www.site.test" }, { id: 12, domain: "www.site.test" }]);
});

test("site domain batch selection is restricted to the current filters", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "宝塔站点管理", exact: true }).click();
  await page.getByRole("button", { name: /^站点域名（\d+）$/ }).click();
  const dialog = page.getByRole("dialog", { name: "当前条件下的站点域名", exact: true });
  await dialog.getByLabel("选择 site.test 的域名 www.site.test", { exact: true }).check();
  await dialog.getByLabel("搜索所属站点").fill("plain.test");
  await expect(dialog.getByText("已选 0 个", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "批量移除（0）", exact: true })).toBeDisabled();
  await dialog.getByLabel("搜索所属站点").fill("");
  await expect(dialog.getByLabel("选择 site.test 的域名 www.site.test", { exact: true })).not.toBeChecked();
});

async function siteDomainsFixture(page: Page, extraRoots = 0) {
  await fixture(page);
  await page.evaluate((extraRoots) => {
    const bridge = (window as any).__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (command: string, args: any) => {
      const result = await invoke(command, args);
      if (command !== "list_baota_site_certificates") return result;
      return Array.from({ length: 13 }, (_, index) => ({ ...result[0], id: 100 + index, siteId: 100 + index, siteName: `site${index}.test`, siteRemark: index === 11 ? "最后一个正式站点" : "测试站点", siteDomains: index === 0
        ? ["*.example.com", "api.example.com", "api.example.com", "app.example.co.uk", "www.city.kawasaki.jp", "foo.bar.ck", "www.ck", "a.foo.github.io", "b.bar.github.io", "127.0.0.1", "www.食狮.公司.cn"]
        : [`child${index}.example.com`, ...(index === 1 ? Array.from({ length: extraRoots }, (_, root) => `app.project${String(root + 1).padStart(3, "0")}.com`) : [])], fingerprint: index === 12 ? null : "fixture", certificateDomains: index === 12 ? [] : ["example.com"], notAfter: index === 12 ? null : 2000000000 }));
    };
  }, extraRoots);
  await page.getByRole("button", { name: "宝塔站点管理", exact: true }).click();
  await page.getByLabel("是否有 HTTPS 证书").selectOption("yes");
}

test("site domain dialog covers all filtered pages and supports site and domain searches", async ({ page }) => {
  await siteDomainsFixture(page);
  await expect(page.locator(".baota-certificate-manager tbody tr")).toHaveCount(10);
  await expect(page.getByRole("button", { name: "站点域名（21）", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^站点域名（\d+）$/ }).click();
  const dialog = page.getByRole("dialog", { name: "当前条件下的站点域名", exact: true });
  await expect(dialog).toContainText("共 12 个站点");
  await expect(dialog.locator("tbody")).toContainText("child11.example.com");
  await expect(dialog.locator("tbody")).not.toContainText("child12.example.com");
  await expect(dialog.locator("tbody tr").filter({ hasText: "api.example.com" })).toHaveCount(1);
  await dialog.getByLabel("搜索所属站点").fill("最后一个正式");
  await expect(dialog.locator("tbody tr")).toHaveCount(1);
  await expect(dialog.locator("tbody")).toContainText("child11.example.com");
  await dialog.getByLabel("模糊搜索站点域名").fill("no-match");
  await expect(dialog.getByText("没有匹配的域名", { exact: true })).toBeVisible();
  await dialog.getByLabel("搜索所属站点").fill("");
  await dialog.getByLabel("模糊搜索站点域名").fill("");
  for (const name of ["模糊搜索站点域名", "搜索所属站点"]) {
    const input = dialog.getByLabel(name);
    await input.focus();
    expect(await input.evaluate(element => {
      const style = getComputedStyle(element);
      return { border: style.borderTopWidth, shadow: style.boxShadow, outline: style.outlineStyle };
    })).toEqual({ border: "0px", shadow: "none", outline: "none" });
    expect(await input.evaluate(element => getComputedStyle(element.parentElement!).outlineStyle)).toBe("solid");
  }
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
    const columns = await dialog.locator("thead th").evaluateAll(elements => elements.map(element => ({ text: element.textContent, width: getComputedStyle(element).width, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, display: getComputedStyle(element).display })));
    expect(columns.at(-1)!.right, JSON.stringify(columns)).toBeLessThanOrEqual(width);
    const copyBounds = await dialog.locator("tbody tr").first().getByRole("button", { name: /^复制域名 / }).evaluate(element => {
      const cell = element.closest("td")!;
      return { button: element.getBoundingClientRect().right, cell: cell.getBoundingClientRect().right };
    });
    expect(copyBounds.button).toBeLessThanOrEqual(copyBounds.cell);
    await expect(dialog.getByRole("button", { name: "汇总主域名", exact: true })).toBeInViewport();
  }
  await dialog.screenshot({ path: "test-results/baota-site-domain-list.png" });
  expect(await dialog.locator("tbody tr").first().evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(48);
  await dialog.locator(".table-wrap").evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(dialog.getByRole("columnheader", { name: "操作", exact: true })).toBeInViewport();
  await expect(dialog.getByLabel("每页条数")).toBeInViewport();
  await expect(dialog.getByLabel("模糊搜索站点域名")).toBeInViewport();
  await page.locator("body > .shared-dialog-backdrop").click({ position: { x: 2, y: 2 } });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByLabel("是否有 HTTPS 证书").selectOption("no");
  await expect(page.getByRole("button", { name: "站点域名（1）", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^站点域名（\d+）$/ }).click();
  await expect(dialog.locator("tbody tr")).toHaveCount(1);
  await expect(dialog.locator("tbody")).toContainText("child12.example.com");
});

test("main domain summary handles suffix rules, private suffixes, search and multiple exclusions", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await siteDomainsFixture(page);
  await page.getByRole("button", { name: /^站点域名（\d+）$/ }).click();
  const list = page.getByRole("dialog", { name: "当前条件下的站点域名", exact: true });
  await list.getByRole("button", { name: "汇总主域名", exact: true }).click();
  const summary = page.getByRole("dialog", { name: "汇总主域名", exact: true });
  await expect(summary.locator("tbody tr td:nth-child(2)")).toHaveText(["bar.github.io", "city.kawasaki.jp", "example.co.uk", "example.com", "foo.bar.ck", "foo.github.io", "www.ck", "xn--85x722f.xn--55qx5d.cn"]);
  await summary.getByLabel("模糊搜索主域名").fill("example");
  await expect(summary.locator("tbody tr")).toHaveCount(2);
  await summary.getByLabel("排除多个主域名").fill("example.com，example.co.uk\nfoo.github.io");
  await expect(summary.getByText("没有匹配的主域名", { exact: true })).toBeVisible();
  await summary.getByLabel("模糊搜索主域名").fill("");
  await expect(summary.locator("tbody tr")).toHaveCount(5);
  await summary.getByRole("button", { name: "复制结果", exact: true }).click();
  await expect(summary.getByRole("status")).toHaveText("已复制主域名");
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe("bar.github.io\ncity.kawasaki.jp\nfoo.bar.ck\nwww.ck\nxn--85x722f.xn--55qx5d.cn");
  await summary.getByRole("button", { name: "加入排除 foo.bar.ck", exact: true }).click();
  await expect(summary.getByLabel("排除多个主域名")).toHaveValue("example.com，example.co.uk\nfoo.github.io\nfoo.bar.ck");
  await expect(summary.getByLabel("排除多个主域名")).toBeFocused();
  await expect(summary.locator("tbody tr")).toHaveCount(4);
  await summary.getByRole("button", { name: "复制结果", exact: true }).click();
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).not.toContain("foo.bar.ck");
  await summary.getByLabel("排除多个主域名").fill("example.com，example.co.uk\nfoo.github.io");
  await expect(summary.locator("tbody tr")).toHaveCount(5);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await summary.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
    await expect(summary.getByRole("button", { name: "复制主域名 bar.github.io", exact: true })).toBeInViewport();
    await expect(summary.getByLabel("排除多个主域名")).toBeInViewport();
    const exclude = summary.getByRole("button", { name: "加入排除 bar.github.io", exact: true });
    await expect(exclude).toBeInViewport();
    expect(await exclude.evaluate(element => element.getBoundingClientRect().right <= element.closest("td")!.getBoundingClientRect().right)).toBe(true);
  }
  expect((await summary.boundingBox())!.width).toBeLessThanOrEqual(860);
  expect(await summary.locator("tbody tr").first().evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(40);
  await summary.screenshot({ path: "test-results/baota-main-domain-summary.png" });
  await summary.getByRole("button", { name: "最大化弹层", exact: true }).click();
  await expect(summary).toHaveClass(/dialog-size-expanded/);
  await page.keyboard.press("Escape");
  await expect(summary).toHaveCount(0);
  await expect(list).toBeVisible();
  await expect(list.getByRole("button", { name: "汇总主域名", exact: true })).toBeFocused();
  await list.getByLabel("搜索所属站点").fill("site11.test");
  await list.getByRole("button", { name: "汇总主域名", exact: true }).click();
  await expect(summary.locator("tbody tr td:nth-child(2)")).toHaveText(["example.com"]);
});

test("main domain summary keeps filters and pagination visible with many roots", async ({ page }) => {
  await siteDomainsFixture(page, 70);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: /^站点域名（\d+）$/ }).click();
  await page.getByRole("button", { name: "汇总主域名", exact: true }).click();
  const summary = page.getByRole("dialog", { name: "汇总主域名", exact: true });
  await expect(summary.locator("tbody tr")).toHaveCount(60);
  await summary.screenshot({ path: "test-results/baota-main-domain-summary-many.png" });
  await summary.locator(".table-wrap").evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(summary.getByLabel("模糊搜索主域名")).toBeInViewport();
  await expect(summary.getByRole("columnheader", { name: "主域名", exact: true })).toBeInViewport();
  await expect(summary.getByLabel("每页条数")).toBeInViewport();
});

test("baota sort preserves the fetched panel order through filtering and refresh", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const bridge = (window as any).__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (command: string, args: any) => {
      const result = await invoke(command, args);
      if (command !== "list_baota_site_certificates") return result;
      return result.map((site: any, index: number) => ({ ...site, panelOrder: [2, 0, 1][index] }));
    };
  });
  await page.getByRole("button", { name: "宝塔站点管理", exact: true }).click();
  const manager = page.locator(".baota-certificate-manager");
  const names = manager.locator("tbody tr td:first-child strong");
  const sort = manager.getByRole("button", { name: "宝塔排序", exact: true });
  await page.getByLabel("是否有 HTTPS 证书").selectOption("yes");
  await expect(sort).toHaveAttribute("aria-pressed", "true");
  await expect(sort.locator("xpath=..").getByRole("button").first()).toHaveText("宝塔排序");
  await expect(names).toHaveText(["expired.test", "site.test"]);
  await page.getByLabel("是否有 HTTPS 证书").selectOption("all");
  await expect(names).toHaveText(["plain.test", "expired.test", "site.test"]);
  await manager.getByRole("button", { name: "获取站点", exact: true }).click();
  await expect(manager.getByRole("status")).toContainText("已更新");
  await expect(names).toHaveText(["plain.test", "expired.test", "site.test"]);
  await manager.getByRole("button", { name: "名称排序", exact: true }).click();
  await expect(names).toHaveText(["site.test", "plain.test", "expired.test"]);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(sort).toBeInViewport();
    expect(await sort.evaluate(element => {
      const row = element.parentElement!;
      return row.scrollWidth - row.clientWidth;
    })).toBe(0);
  }
});

test("baota HTTPS filter defaults to all sites and combines with text search", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "宝塔站点管理", exact: true }).click();
  const filter = page.getByLabel("是否有 HTTPS 证书");
  const rows = page.locator(".baota-certificate-manager tbody tr");
  await expect(filter).toHaveValue("all");
  await expect(rows).toHaveCount(3);
  await expect(rows).toContainText(["expired.test", "plain.test", "site.test"]);
  await filter.selectOption("yes");
  await expect(rows).toHaveCount(2);
  await expect(rows).toContainText(["expired.test", "site.test"]);
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
  await page.getByRole("button", { name: "宝塔站点管理", exact: true }).click();
  await page.getByLabel("是否有 HTTPS 证书").selectOption("yes");
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
    expect(await manager.getByLabel("宝塔证书到期预警").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await manager.screenshot({ path: "test-results/baota-expiry-warning.png" });
});

test("manual certificate import clears pasted material and saves only after confirmation", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "导入证书", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入 HTTPS 证书" });
  const dialogChrome = await dialog.evaluate(element => ({
    background: getComputedStyle(element).backgroundColor,
    header: getComputedStyle(element.querySelector("header")!).backgroundColor,
    inset: element.querySelector("header")!.getBoundingClientRect().left - element.getBoundingClientRect().left,
    padding: getComputedStyle(element).padding,
    headerMargin: getComputedStyle(element.querySelector("header")!).margin,
    drop: getComputedStyle(element.querySelector(".certificate-file-drop")!).backgroundColor,
  }));
  await page.screenshot({ path: "test-results/certificate-import-dialog.png" });
  expect(dialogChrome.background).toBe("rgb(40, 40, 40)");
  expect(dialogChrome.header).toBe("rgb(48, 48, 48)");
  expect(dialogChrome.inset, JSON.stringify(dialogChrome)).toBeLessThanOrEqual(1);
  expect(dialogChrome.drop).toBe("rgb(54, 54, 54)");
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
  await page.getByRole("button", { name: "宝塔站点管理", exact: true }).click();
  await page.getByLabel("选择宝塔面板").selectOption("4");
  await page.getByRole("button", { name: "获取站点", exact: true }).click();
  await expect(page.locator(".baota-certificate-manager tbody")).toContainText("测试宝塔");
  await expect(page.locator(".baota-certificate-manager tbody")).toContainText("www.site.test");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".certificate-page").screenshot({ path: "test-results/certificate-compact-header.png" });
  await page.getByRole("button", { name: "续签站点 site.test", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("测试宝塔");
  await expect(confirm).toContainText("site.test");
  await confirm.locator(".modal-actions .primary").click();
  await expect(page.locator(".baota-certificate-manager").getByRole("status")).toContainText("已续签并验证站点部署");
  const calls = await page.evaluate(() => (window as any).__certificateCalls);
  expect(calls.find((call: any) => call.command === "renew_baota_site_certificate").args).toEqual({ id: 12 });
  await page.locator(".baota-certificate-manager").screenshot({ path: "test-results/baota-site-certificates.png" });
});

test("unconfirmed renewal cannot repeat until the user checks the panel and resynchronizes", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "宝塔站点管理", exact: true }).click();
  await page.getByLabel("选择宝塔面板").selectOption("4");
  await page.evaluate(() => (window as any).__failRenew());
  await page.getByRole("button", { name: "续签站点 site.test", exact: true }).click();
  await page.getByRole("alertdialog").locator(".modal-actions .primary").click();
  await expect(page.getByRole("alert")).toContainText("结果待确认");
  await expect(page.getByRole("button", { name: "续签站点 site.test", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "核对后允许重试", exact: true }).click();
  await page.getByRole("alertdialog").locator(".modal-actions .primary").click();
  await expect(page.locator(".baota-certificate-manager").getByRole("status")).toContainText("重新获取站点");
  await expect(page.getByRole("button", { name: "续签站点 site.test", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "获取站点", exact: true }).click();
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
  await dialog.getByRole("button", { name: "最大化弹层" }).click();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return Math.abs(rect.width - window.innerWidth * .95) < 1 && Math.abs(rect.height - window.innerHeight * .95) < 1 && element.scrollWidth <= element.clientWidth;
    })).toBe(true);
  }
  await expect(dialog.getByRole("button", { name: "导出", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "全选", exact: true }).click();
  await dialog.getByRole("button", { name: "导出", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("已导出 22 个域名");
  await dialog.getByRole("button", { name: "取消全选", exact: true }).click();
  await dialog.getByLabel("搜索完整域名列表").fill("domain19");
  await dialog.getByRole("checkbox", { name: "domain19.site.test", exact: true }).check();
  await dialog.getByRole("button", { name: "导出", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("已导出 1 个域名");
  const calls = await page.evaluate(() => (window as any).__certificateCalls.filter((call: any) => call.command === "export_certificate_domains"));
  expect(calls[0].args.domains).toHaveLength(22);
  expect(calls[1].args).toEqual({ title: "site.test", domains: ["domain19.site.test"] });
  await page.evaluate(() => (window as any).__setDomainExportResult(null));
  await dialog.getByRole("button", { name: "导出", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await dialog.getByRole("button", { name: "取消全选", exact: true }).click();
  await dialog.getByLabel("搜索完整域名列表").fill("absent-domain");
  await expect(dialog.getByRole("button", { name: "导出", exact: true })).toBeDisabled();
  await dialog.getByLabel("搜索完整域名列表").fill("");
  await dialog.screenshot({ path: "test-results/certificate-domains-fullscreen.png" });
  await dialog.getByRole("button", { name: "缩小弹层" }).click();
  await expect(dialog).not.toHaveClass(/dialog-size-expanded/);
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
  await expect(dialog.getByRole("checkbox")).toHaveCount(22);
  await dialog.getByRole("textbox", { name: "搜索完整域名列表" }).fill("domain19");
  await expect(dialog.getByRole("checkbox")).toHaveCount(1);
  await expect(dialog.getByRole("checkbox", { name: "domain19.site.test", exact: true })).toBeVisible();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await dialog.screenshot({ path: "test-results/certificate-domain-list.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
