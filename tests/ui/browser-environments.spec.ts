import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("cloudhub.plugin-presentation", JSON.stringify({
      "cloudhub.fingerprint-browser": { mode: "modal", size: "large" },
    }));
  });
});

async function fixture(page: Page) {
  await page.addInitScript(() => {
    const recommended = { version: "155.0.8059.84", label: "推荐版本", recommended: true, experimental: false, installed: false, phase: "idle", downloaded: 0, total: 206114888, error: null };
    const compatibility = { ...recommended, version: "155.0.8059.79", label: "兼容测试版本", recommended: false, total: 207516446 };
    const experimental = { ...recommended, version: "clearcote-150.0.7871.114", label: "Clearcote 150 · 实验版", recommended: false, experimental: true, total: 245936073 };
    const snapshot = { supported: true, kernel: recommended, kernels: [recommended, compatibility, experimental], environments: [] as any[] };
    let sequence = 0;
    Object.assign(window, { browserCalls: [], __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: any) => {
        if (command.startsWith("browser_")) (window as any).browserCalls.push({ command, args });
        if (command === "browser_snapshot") return structuredClone(snapshot);
        if (command === "browser_save") {
          const input = args.input; const id = input.id || `00000000-0000-4000-8000-${String(++sequence).padStart(12,"0")}`;
          const old = snapshot.environments.find(i => i.id === id);
          const value = { id, config: input.config, passwordSaved: false, createdAt: Date.now(), lastOpenedAt: old?.lastOpenedAt ?? null, deletedAt: null, running: false };
          snapshot.environments = [...snapshot.environments.filter(i => i.id !== id), value]; return structuredClone(value);
        }
        if (command === "browser_install_kernel") { const kernel = snapshot.kernels.find(k => k.version === args.version)!; kernel.installed = true; kernel.phase = "ready"; return; }
        if (command === "browser_launch") { if ((window as any).browserLaunchError) throw (window as any).browserLaunchError; const item = snapshot.environments.find(i => i.id === args.id); item.running = true; item.lastOpenedAt = Date.now(); return; }
        if (command === "browser_cookie_list") return [{ name: "ASP.NET_SessionId", domain: "vipgl.lizengtong.com", path: "/", value: "secret-session-value", expires: null, secure: false, httpOnly: true, sameSite: null, session: true }];
        if (command === "browser_stop") { snapshot.environments.find(i => i.id === args.id).running = false; return; }
        if (command === "browser_set_deleted") { snapshot.environments.find(i => i.id === args.id).deletedAt = args.deleted ? Date.now() : null; return; }
        if (command === "browser_move_group") { snapshot.environments.filter(i => args.ids.includes(i.id)).forEach(i => { i.config.group = args.group; }); return; }
        if (command === "browser_remove") { snapshot.environments = snapshot.environments.filter(i => i.id !== args.id); return; }
        if (command === "browser_uninstall_kernel") { const kernel = snapshot.kernels.find(k => k.version === args.version)!; kernel.installed = false; kernel.phase = "idle"; return; }
        if (command === "browser_check_proxy") return "192.0.2.42";
        if (command === "browser_cookie_file") return false;
        if (command === "wechat_plugin_status") return { supported: true, detectedPath: null, runningProcesses: 0 };
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "plugin:updater|check") return null;
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await page.locator(".store-table tr,.software-store-page tr").filter({ hasText: "指纹浏览器" }).getByRole("button", { name: "管理", exact: true }).click();
}

test("实验内核明确限制并保存种子；切回普通内核清除不支持参数", async ({ page }) => {
  await fixture(page);
  const dialog=page.getByRole("dialog",{name:"指纹浏览器",exact:true});
  await dialog.getByRole("button",{name:"新建环境",exact:true}).click();
  await dialog.getByLabel("名称",{exact:true}).fill("实验环境");
  await dialog.getByLabel("浏览器内核",{exact:true}).selectOption("clearcote-150.0.7871.114");
  await expect(dialog.getByText(/实验版 Chromium 150 落后于推荐内核/)).toBeVisible();
  await dialog.getByRole("tab",{name:"环境参数"}).click();
  await dialog.getByLabel("User-Agent 模板",{exact:true}).selectOption("windows10");
  await dialog.getByLabel("指纹种子",{exact:true}).fill("172904001");
  await dialog.getByLabel("CPU 逻辑核数",{exact:true}).fill("4");
  await dialog.getByLabel("设备内存（GB）",{exact:true}).selectOption("8");
  await dialog.getByLabel("Canvas",{exact:true}).selectOption("real");
  await dialog.screenshot({path:"test-results/browser-experimental-editor.png"});
  await dialog.getByRole("button",{name:"保存环境",exact:true}).click();
  await dialog.getByRole("button",{name:"刷新浏览器环境",exact:true}).click();
  const row=dialog.locator("tbody tr").filter({hasText:"实验环境"});
  await row.getByRole("button",{name:"编辑",exact:true}).click();
  await dialog.getByRole("tab",{name:"环境参数"}).click();
  await expect(dialog.getByLabel("指纹种子",{exact:true})).toHaveValue("172904001");
  await expect(dialog.getByLabel("User-Agent 模板",{exact:true})).toHaveValue("windows10");
  await expect(dialog.getByLabel("Canvas",{exact:true})).toHaveValue("real");
  await dialog.getByRole("tab",{name:"基础设置"}).click();
  await dialog.getByLabel("浏览器内核",{exact:true}).selectOption("155.0.8059.84");
  await dialog.getByRole("button",{name:"保存环境",exact:true}).click();
  const last=await page.evaluate(()=>(window as any).browserCalls.filter((c:any)=>c.command==="browser_save").at(-1));
  expect(last.args.input.config.fingerprint).toBeNull();
  await dialog.getByRole("button",{name:"内核管理",exact:true}).click();
  await dialog.getByLabel("管理内核版本").selectOption("clearcote-150.0.7871.114");
  await expect(dialog.getByText(/Clearcote 官方 GitHub Release/)).toBeVisible();
  await expect(dialog.getByText(/基于 Chromium 150，落后于推荐内核/)).toBeVisible();
});

test("环境从创建、按需安装、运行到回收恢复；入口不自动下载", async ({ page }) => {
  await fixture(page);
  const dialog = page.getByRole("dialog", { name: "指纹浏览器", exact: true });
  await expect(dialog.getByText("创建第一个浏览器环境", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).browserCalls.some((c: any) => c.command === "browser_install_kernel"))).toBe(false);
  await dialog.getByRole("button", { name: "新建环境", exact: true }).click();
  await dialog.getByLabel("名称", { exact: true }).fill("工作环境");
  await dialog.getByLabel("分组", { exact: true }).fill("日常运维");
  await dialog.getByLabel("启动网址", { exact: true }).fill("https://example.test");
  await dialog.getByRole("tab", { name: "环境参数" }).click();
  await dialog.getByLabel("语言", { exact: true }).fill("en-US");
  await dialog.getByLabel("时区", { exact: true }).fill("America/New_York");
  await dialog.getByRole("button", { name: "保存环境", exact: true }).click();
  const row = dialog.locator("tbody tr").filter({ hasText: "工作环境" });
  await expect(row).toBeVisible(); await expect(row.getByRole("button", { name: "打开", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "内核管理", exact: true }).click();
  await dialog.getByRole("button", { name: "下载并安装", exact: true }).click();
  await expect(dialog.getByText("浏览器内核已校验并安装，各环境共用此内核", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "环境列表", exact: true }).click();
  await row.getByRole("button", { name: "打开", exact: true }).click();
  await expect(row.getByText("运行中", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "编辑", exact: true })).toBeDisabled();
  await row.getByRole("button", { name: "关闭", exact: true }).click();
  await row.getByRole("button", { name: "回收", exact: true }).click();
  await expect(row).toHaveCount(0);
  await dialog.getByRole("button", { name: "回收站", exact: true }).click();
  await row.getByRole("button", { name: "恢复", exact: true }).click();
  await dialog.getByRole("button", { name: "环境列表", exact: true }).click();
  await expect(row).toBeVisible();
  const calls = await page.evaluate(() => (window as any).browserCalls);
  const saved = calls.find((c: any) => c.command === "browser_save");
  expect(saved.args.input).toMatchObject({ proxyPassword: null, config: { language: "en-US", timezone: "America/New_York", startUrls: ["https://example.test"] } });
  await dialog.screenshot({ path: "test-results/browser-environments-list.png" });
});

test("公共弹层支持键盘和窄屏，遮罩点击不关闭", async ({ page }) => {
  await fixture(page);
  const dialog = page.getByRole("dialog", { name: "指纹浏览器", exact: true });
  await page.locator(".modal-backdrop").click({ position: { x: 2, y: 2 } });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "新建环境", exact: true }).click();
  await dialog.getByLabel("名称", { exact: true }).fill("配置预览");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await dialog.screenshot({ path: "test-results/browser-environments-editor.png" });
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("button", { name: "新建环境", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("浏览器预览明确限制原生操作", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await page.locator(".software-store-page tr").filter({ hasText: "指纹浏览器" }).getByRole("button", { name: "管理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "指纹浏览器", exact: true });
  await expect(dialog.getByText("此功能需要 Windows x64 桌面客户端，浏览器预览不能下载或启动本机浏览器。", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "新建环境", exact: true })).toBeDisabled();
});

test("批量分组、出口检测和永久删除均使用明确操作", async ({ page }) => {
  await fixture(page);
  const dialog = page.getByRole("dialog", { name: "指纹浏览器", exact: true });
  await dialog.getByRole("button", { name: "新建环境", exact: true }).click();
  await dialog.getByLabel("名称", { exact: true }).fill("隔离测试环境");
  await dialog.getByRole("button", { name: "保存环境", exact: true }).click();
  const row = dialog.locator("tbody tr").filter({ hasText: "隔离测试环境" });
  await row.getByRole("checkbox").check();
  await dialog.getByLabel("目标分组", { exact: true }).fill("测试分组");
  await dialog.getByRole("button", { name: "移动分组", exact: true }).click();
  await expect(row.locator('[data-label="分组 / 标签"]')).toContainText("测试分组");
  await row.getByRole("button", { name: "检测出口 IP", exact: true }).click();
  await expect(row.getByText("192.0.2.42", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "回收", exact: true }).click();
  await dialog.getByRole("button", { name: "回收站", exact: true }).click();
  await row.getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "确认永久删除", exact: true })).toBeDisabled();
  await dialog.getByLabel("确认环境名称", { exact: true }).fill("隔离测试环境");
  await dialog.getByRole("button", { name: "确认永久删除", exact: true }).click();
  await expect(row).toHaveCount(0);
});

test("环境绑定所选内核，多版本安装卸载互不覆盖", async ({ page }) => {
  await fixture(page);
  const dialog=page.getByRole("dialog",{name:"指纹浏览器",exact:true});
  await dialog.getByRole("button",{name:"新建环境",exact:true}).click();
  await dialog.getByLabel("名称",{exact:true}).fill("兼容环境");
  await dialog.getByRole("combobox").filter({has:page.locator('option[value="155.0.8059.79"]')}).selectOption("155.0.8059.79");
  await dialog.getByRole("button",{name:"保存环境",exact:true}).click();
  const row=dialog.locator("tbody tr").filter({hasText:"兼容环境"});
  await expect(row.getByRole("button",{name:"打开",exact:true})).toBeDisabled();
  await dialog.getByRole("button",{name:"内核管理",exact:true}).click();
  await dialog.getByLabel("管理内核版本",{exact:true}).selectOption("155.0.8059.79");
  await dialog.getByRole("button",{name:"下载并安装",exact:true}).click();
  await dialog.getByLabel("管理内核版本",{exact:true}).selectOption("155.0.8059.84");
  await dialog.getByRole("button",{name:"下载并安装",exact:true}).click();
  await dialog.getByRole("button",{name:"清理 / 卸载内核",exact:true}).click();
  await expect(dialog.getByRole("heading",{name:"卸载浏览器内核 155.0.8059.84",exact:true})).toBeVisible();
  await dialog.getByRole("button",{name:"确认卸载内核",exact:true}).click();
  await dialog.getByRole("button",{name:"环境列表",exact:true}).click();
  await expect(row.getByRole("button",{name:"打开",exact:true})).toBeEnabled();
  await row.getByRole("button",{name:"打开",exact:true}).click();
  await row.getByRole("button",{name:"关闭",exact:true}).click();
  await row.getByRole("button",{name:"编辑",exact:true}).click();
  await expect(dialog.getByRole("combobox").filter({has:page.locator('option[value="155.0.8059.79"]')})).toBeDisabled();
  const calls=await page.evaluate(()=>(window as any).browserCalls);
  expect(calls.filter((c:any)=>c.command==="browser_install_kernel").map((c:any)=>c.args.version)).toEqual(["155.0.8059.79","155.0.8059.84"]);
  expect(calls.find((c:any)=>c.command==="browser_uninstall_kernel").args.version).toBe("155.0.8059.84");
});

test("浏览器启动失败时显示安全诊断信息而非通用错误", async ({ page }) => {
  await fixture(page);
  const dialog = page.getByRole("dialog", { name: "指纹浏览器", exact: true });
  await dialog.getByRole("button", { name: "新建环境", exact: true }).click();
  await dialog.getByLabel("名称", { exact: true }).fill("诊断环境");
  await dialog.getByRole("button", { name: "保存环境", exact: true }).click();
  await dialog.getByRole("button", { name: "内核管理", exact: true }).click();
  await dialog.getByRole("button", { name: "下载并安装", exact: true }).click();
  await dialog.getByRole("button", { name: "环境列表", exact: true }).click();
  await page.evaluate(() => { (window as any).browserLaunchError = { kind: "platform-error", code: "browser", message: "无法启动浏览器，请检查内核文件和系统权限", retryable: false }; });
  await dialog.locator("tbody tr").filter({ hasText: "诊断环境" }).getByRole("button", { name: "打开", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("无法启动浏览器，请检查内核文件和系统权限");
});

test("列表、内核与回收站在不同宽度下保持布局边界", async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const invoke = (window as any).__TAURI_INTERNALS__.invoke;
    for (const name of ["日常工作环境", "兼容性测试环境", "较长名称的独立浏览器环境"]) {
      await invoke("browser_save", { input: { id: null, config: { name, group: "测试分组", tags: "工作,测试", note: "仅用于界面回归", kernelVersion: "155.0.8059.84", startUrls: [], proxy: { kind: "direct", host: "", port: 8080, username: "" }, language: "zh-CN", timezone: "Asia/Shanghai", width: 1280, height: 900, geolocation: null, fingerprint: null, identity: "native" } } });
    }
  });
  const dialog = page.getByRole("dialog", { name: "指纹浏览器", exact: true });
  await dialog.getByRole("button", { name: "刷新浏览器环境", exact: true }).click();
  await expect(dialog.locator("tbody tr")).toHaveCount(3);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [name, slug] of [["环境列表", "list"], ["内核管理", "kernel"], ["回收站", "trash"]]) {
      await dialog.getByRole("button", { name, exact: true }).click();
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await dialog.locator(".browser-body").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await dialog.screenshot({ path: `test-results/browser-${slug}-${width}.png` });
    }
  }
});

test("Cookie 查看弹层默认隐藏原始值，逐条揭示", async ({ page }) => {
  await fixture(page);
  const dialog = page.getByRole("dialog", { name: "指纹浏览器", exact: true });
  await dialog.getByRole("button", { name: "新建环境", exact: true }).click();
  await dialog.getByLabel("名称", { exact: true }).fill("查看环境");
  await dialog.getByRole("button", { name: "保存环境", exact: true }).click();
  await dialog.getByRole("button", { name: "内核管理", exact: true }).click();
  await dialog.getByRole("button", { name: "下载并安装", exact: true }).click();
  await dialog.getByRole("button", { name: "环境列表", exact: true }).click();
  const row = dialog.locator("tbody tr").filter({ hasText: "查看环境" });
  await row.getByRole("button", { name: "打开", exact: true }).click();
  // Native reads can finish after disabling the trigger has already blurred it.
  await page.evaluate(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
      if (command === "browser_cookie_list") await new Promise(resolve => setTimeout(resolve, 100));
      return original(command, args);
    };
  });
  await row.getByRole("button", { name: "查看数据", exact: true }).click();
  const inspector = page.locator(".cookie-view-dialog");
  await expect(inspector).toBeVisible();
  // A real overlay, not an inline block: it mounts on document.body behind a
  // modal backdrop, which is what the shared dialog pattern requires.
  const backdrop = page.locator("body > .shared-dialog-backdrop").filter({ has: inspector });
  await expect(backdrop).toHaveCount(1);
  await backdrop.click({ position: { x: 2, y: 2 } });
  await expect(inspector).toBeVisible();
  await expect(inspector).not.toContainText("secret-session-value");
  await inspector.getByRole("button", { name: "显示", exact: true }).click();
  await expect(inspector).toContainText("secret-session-value");
  await inspector.getByRole("button", { name: "全部隐藏", exact: true }).click();
  await expect(inspector).not.toContainText("secret-session-value");
  await expect(inspector).toContainText("vipgl.lizengtong.com");
  await expect(inspector).toContainText("会话结束时");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await inspector.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await inspector.screenshot({ path: `test-results/browser-cookie-${width}.png` });
  }
  await page.keyboard.press("Escape");
  await expect(inspector).toHaveCount(0);
  await expect(row.getByRole("button", { name: "查看数据", exact: true })).toBeFocused();
});
