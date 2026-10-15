import { expect, test } from "@playwright/test";

test.describe("已保存配置批量启动", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const profiles = ["工作号", "个人号", "备用号"].map((label, i) => ({ id: `batch-${i}`, label, family: "微信 4.x", dataPath: "C:\\Data\\xwechat_files", createdAt: 1700000000 - i, recovery: false }));
      Object.assign(window, { batchCalls: [], batchActive: 0, batchPeak: 0, batchFail: "", batchRunning: 0, __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string, args: any) => {
          const state = window as any;
          if (command === "wechat_plugin_status") return { supported: true, detectedPath: "C:\\Tencent\\Weixin.exe", runningProcesses: state.batchRunning };
          if (command === "wechat_sessions_list") return [...profiles,
            { id: "legacy", label: "旧版本", family: "微信 3.x", dataPath: "C:\\Old", createdAt: 1700000000, recovery: false },
            { id: "backup", label: "备份", family: "微信 4.x", dataPath: "C:\\Data", createdAt: 1700000000, recovery: true }];
          if (command === "wechat_sessions_launch") {
            state.batchCalls.push(args);
            state.batchActive++;
            state.batchPeak = Math.max(state.batchPeak, state.batchActive);
            try {
              await new Promise<void>(resolve => { state.batchResolve = resolve; });
              if (state.batchFail === args.id) throw { code: "local-plugin", message: "微信配置被占用或不可写，请退出微信后重试" };
            } finally { state.batchActive--; }
            return;
          }
          if (command === "authenticator_status") return { configured: false, unlocked: false };
          if (command === "plugin:updater|check") return null;
          return [];
        },
      } });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
    await page.locator(".software-store-page").getByRole("button", { name: "设置", exact: true }).click();
  });

  test("按列表串行准备兼容配置，整个过程禁用其他操作", async ({ page }) => {
    const panel = page.getByRole("dialog", { name: "微信多开设置" });
    await panel.getByLabel("启动节奏").selectOption("wait");
    await panel.getByRole("button", { name: "批量启动已保存配置", exact: true }).click();
    for (let index = 0; index < 3; index++) {
      await expect(panel.getByRole("button", { name: `正在准备 ${index + 1}/3…`, exact: true })).toBeDisabled();
      await expect(panel.getByRole("button", { name: "刷新配置", exact: true })).toBeDisabled();
      expect(await page.evaluate(() => (window as any).batchCalls.length)).toBe(index + 1);
      await page.evaluate(() => { (window as any).batchResolve(); });
    }
    await expect(page.locator(".store-notification")).toContainText("已准备 3/3 个微信窗口");
    expect(await page.evaluate(() => (window as any).batchPeak)).toBe(1);
    expect(await page.evaluate(() => (window as any).batchCalls)).toEqual([0, 1, 2].map(index => ({ id: `batch-${index}`, path: "C:\\Tencent\\Weixin.exe" })));
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await panel.locator(".wechat-session-batch").screenshot({ path: "test-results/wechat-saved-batch.png" });
  });

  test("第二个配置失败时报告部分结果，不启动第三个", async ({ page }) => {
    await page.evaluate(() => { (window as any).batchFail = "batch-1"; });
    const panel = page.getByRole("dialog", { name: "微信多开设置" });
    await panel.getByLabel("启动节奏").selectOption("wait");
    await panel.getByRole("button", { name: "批量启动已保存配置", exact: true }).click();
    await expect(panel.getByRole("button", { name: "正在准备 1/3…", exact: true })).toBeVisible();
    await page.evaluate(() => { (window as any).batchResolve(); });
    await expect(panel.getByRole("button", { name: "正在准备 2/3…", exact: true })).toBeVisible();
    await page.evaluate(() => { (window as any).batchResolve(); });
    await expect(page.getByRole("alert")).toContainText("已准备 1/3 个窗口，在“个人号”处失败");
    await expect(page.getByRole("alert")).toContainText("微信配置被占用");
    expect(await page.evaluate(() => (window as any).batchCalls.length)).toBe(2);
    await expect(panel.getByRole("button", { name: "批量启动已保存配置", exact: true })).toBeEnabled();
  });

  test("已运行时不开始批量，关闭设置后停止后续启动", async ({ page }) => {
    const panel = page.getByRole("dialog", { name: "微信多开设置" });
    await panel.getByLabel("启动节奏").selectOption("wait");
    await page.evaluate(() => { (window as any).batchRunning = 1; });
    await panel.getByRole("button", { name: "批量启动已保存配置", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("请先从托盘退出所有微信");
    expect(await page.evaluate(() => (window as any).batchCalls.length)).toBe(0);
    await page.evaluate(() => { (window as any).batchRunning = 0; });
    await panel.getByRole("button", { name: "批量启动已保存配置", exact: true }).click();
    await expect(panel.getByRole("button", { name: "正在准备 1/3…", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "关闭微信多开设置" }).click();
    await page.evaluate(() => { (window as any).batchResolve(); });
    await expect(page.getByRole("alert")).toContainText("已停止后续启动，已准备 1/3 个窗口");
    expect(await page.evaluate(() => (window as any).batchCalls.length)).toBe(1);
  });

  test("快速模式默认50毫秒，可设为0，结果只报告已提交请求", async ({ page }) => {
    const panel = page.getByRole("dialog", { name: "微信多开设置" });
    await expect(panel.getByLabel("启动节奏")).toHaveValue("50");
    for (const interval of [50, 0]) {
      await panel.getByLabel("启动节奏").selectOption(String(interval));
      await panel.getByRole("button", { name: "批量启动已保存配置", exact: true }).click();
      for (let index = 0; index < 3; index++) {
        await expect(panel.getByRole("button", { name: `正在提交 ${index + 1}/3…`, exact: true })).toBeDisabled();
        await expect(panel.getByLabel("启动节奏")).toBeDisabled();
        await page.evaluate(() => { (window as any).batchResolve(); });
      }
      await expect(page.locator(".store-notification")).toContainText(`已提交 3/3 个快速启动请求，额外间隔 ${interval} 毫秒`);
      await expect(page.locator(".store-notification")).toContainText("不代表多开或登录成功");
      expect(await page.evaluate(() => (window as any).batchCalls.slice(-3))).toEqual([0, 1, 2].map(index => ({ id: `batch-${index}`, path: "C:\\Tencent\\Weixin.exe", quickIntervalMs: interval })));
    }
    expect(await page.evaluate(() => (window as any).batchPeak)).toBe(1);
    await page.setViewportSize({ width: 375, height: 1000 });
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await panel.locator(".wechat-session-batch").screenshot({ path: "test-results/wechat-quick-batch.png" });
  });
});

test("删除旧配置需要确认，取消和失败保留记录，成功只移除目标", async ({ page }) => {
  await page.addInitScript(() => {
    const items = ["个人号", "工作号"].map((label, index) => ({ id: `old-${index}`, label, family: "微信 3.x", dataPath: "C:\\Old\\WeChat Files", createdAt: 1700000000, recovery: false }));
    Object.assign(window, { deletedSessions: [], deleteFail: true, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: any) => {
        if (command === "wechat_plugin_status") return { supported: true, detectedPath: "C:\\Tencent\\Weixin.exe", runningProcesses: 0 };
        if (command === "wechat_sessions_list") return items;
        if (command === "wechat_sessions_delete") {
          if ((window as any).deleteFail) throw { code: "local-plugin", message: "删除微信配置失败，请刷新列表后重试" };
          (window as any).deletedSessions.push(args.id);
          return;
        }
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "plugin:updater|check") return null;
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await page.locator(".software-store-page").getByRole("button", { name: "设置", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "微信多开设置" });
  const remove = panel.getByRole("button", { name: "删除配置 个人号", exact: true });
  await expect(remove).toBeEnabled();
  page.once("dialog", dialog => dialog.dismiss());
  await remove.click();
  await expect(panel.locator(".wechat-session-list li")).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).deletedSessions)).toEqual([]);
  page.once("dialog", dialog => dialog.accept());
  await remove.click();
  await expect(page.getByRole("alert")).toContainText("删除微信配置失败");
  await expect(panel.locator(".wechat-session-list li")).toHaveCount(2);
  await page.setViewportSize({ width: 375, height: 1000 });
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.evaluate(() => { (window as any).deleteFail = false; });
  page.once("dialog", async dialog => {
    expect(dialog.message()).toContain("不影响微信数据、聊天记录");
    await dialog.accept();
  });
  await remove.click();
  await expect(panel.locator(".wechat-session-list li")).toHaveCount(1);
  await expect(panel.locator(".wechat-session-list li")).toContainText("工作号");
  await expect(page.locator(".store-notification")).toContainText("已删除所选配置快照");
  expect(await page.evaluate(() => (window as any).deletedSessions)).toEqual(["old-0"]);
});

test("旧版配置显示版本并阻止交叉启动，保存失败时保留原配置", async ({ page }) => {
  await page.addInitScript(() => {
    const calls: { command: string; args: any }[] = [];
    Object.assign(window, { familyCalls: calls, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: any) => {
        calls.push({ command, args });
        if (command === "wechat_plugin_status") return { supported: true, detectedPath: "C:\\Tencent\\Weixin.exe", runningProcesses: 0 };
        if (command === "wechat_sessions_list") return [{ id: "legacy", label: "旧账号", family: "微信 3.x", dataPath: "C:\\Old\\WeChat Files", createdAt: 1700000000, recovery: false }];
        if (command === "wechat_sessions_select") return "C:\\Old\\WeChat Files";
        if (command === "wechat_sessions_capture") throw { code: "local-plugin", message: "当前客户端是微信 4.x，所选配置属于微信 3.x；请重新检测当前版本的数据目录" };
        if (command === "wechat_plugin_select") return "C:\\Tencent\\WeChat.exe";
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "plugin:updater|check") return null;
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await page.locator(".software-store-page").getByRole("button", { name: "设置", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "微信多开设置" });
  const row = panel.locator(".wechat-session-list li");
  await expect(row).toContainText("微信 3.x");
  await expect(row).toContainText("与当前客户端版本不匹配");
  await expect(row.getByRole("button", { name: "恢复并启动" })).toBeDisabled();
  await panel.getByRole("button", { name: "选择数据目录" }).click();
  await panel.getByLabel("配置名称").fill("错误版本");
  await panel.getByRole("button", { name: "保存当前配置" }).click();
  await expect(page.getByRole("alert")).toContainText("所选配置属于微信 3.x");
  await expect(row).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).familyCalls.filter((call: any) => call.command === "wechat_sessions_launch"))).toEqual([]);
  expect(await page.evaluate(() => (window as any).familyCalls.find((call: any) => call.command === "wechat_sessions_capture").args)).toEqual({ dataPath: "C:\\Old\\WeChat Files", label: "错误版本", path: "C:\\Tencent\\Weixin.exe" });
  await panel.getByRole("button", { name: "选择文件" }).click();
  await expect(row.getByRole("button", { name: "恢复并启动" })).toBeEnabled();
});

test("自动匹配数据目录，多个结果手动选择、单个自动填入、空结果保留原设置", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { detectionMode: "multiple", detectionCalls: [], __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: any) => {
        if (command === "wechat_plugin_status") return { supported: true, detectedPath: "C:\\Tencent\\Weixin.exe", runningProcesses: 0 };
        if (command === "wechat_sessions_detect") {
          (window as any).detectionCalls.push(args);
          const mode = (window as any).detectionMode;
          if (mode === "error") throw { code: "local-plugin", message: "检测微信数据目录失败，请重试" };
          if (mode === "cancel") return null;
          const paths = mode === "multiple" ? ["D:\\微信资料\\xwechat_files", "E:\\备份\\xwechat_files"] : mode === "single" ? ["D:\\微信资料\\xwechat_files"] : mode === "legacy" ? ["C:\\Old\\WeChat Files"] : [];
          return { candidates: paths.map(path => ({ path, family: mode === "legacy" ? "微信 3.x" : "微信 4.x", source: "路径设置" })), limited: mode === "limited" };
        }
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "plugin:updater|check") return null;
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await page.locator(".software-store-page").getByRole("button", { name: "设置", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "微信多开设置" });
  const detect = panel.getByRole("button", { name: "自动检测数据目录" });
  const path = panel.getByLabel("微信数据根目录");
  await detect.click();
  await expect(page.locator(".store-notification")).toContainText("找到 2 个");
  await expect(path).toHaveValue("");
  await panel.getByLabel("匹配的数据目录").selectOption("E:\\备份\\xwechat_files");
  await expect(path).toHaveValue("E:\\备份\\xwechat_files");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.evaluate(() => { (window as any).detectionMode = "single"; });
  await detect.click();
  await expect(path).toHaveValue("D:\\微信资料\\xwechat_files");
  await expect(page.locator(".store-notification")).toContainText("已匹配微信数据目录并填入");
  await page.evaluate(() => { (window as any).detectionMode = "legacy"; });
  await detect.click();
  await expect(page.locator(".store-notification")).toContainText("其他微信版本");
  await expect(path).toHaveValue("D:\\微信资料\\xwechat_files");
  await expect(panel.getByLabel("匹配的数据目录").locator('option[value="C:\\\\Old\\\\WeChat Files"]')).toBeDisabled();
  await page.evaluate(() => { (window as any).detectionMode = "limited"; });
  await panel.getByRole("button", { name: "选择位置查找" }).click();
  await expect(page.locator(".store-notification")).toContainText("达到范围或时间上限");
  await expect(path).toHaveValue("D:\\微信资料\\xwechat_files");
  expect(await page.evaluate(() => (window as any).detectionCalls)).toEqual([{ browse: false }, { browse: false }, { browse: false }, { browse: true }]);
  await page.evaluate(() => { (window as any).detectionMode = "error"; });
  await detect.click();
  await expect(page.getByRole("alert")).toContainText("检测微信数据目录失败，请重试");
  await expect(path).toHaveValue("D:\\微信资料\\xwechat_files");
  await page.evaluate(() => { (window as any).detectionMode = "cancel"; });
  await panel.getByRole("button", { name: "选择位置查找" }).click();
  await expect(path).toHaveValue("D:\\微信资料\\xwechat_files");
  await panel.screenshot({ path: "test-results/wechat-data-detection.png" });
});

test("账号配置分别保存、按标识启动并恢复备份，提示使用右上角通知", async ({ page }) => {
  await page.addInitScript(() => {
    const calls: { command: string; args: any }[] = [];
    const items: any[] = [];
    Object.assign(window, { sessionCalls: calls, sessionFail: false, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: any) => {
        calls.push({ command, args });
        if (command === "wechat_plugin_status") return { supported: true, detectedPath: "C:\\Tencent\\Weixin.exe", runningProcesses: 0 };
        if (command === "wechat_sessions_select") return "C:\\Users\\fixture\\xwechat_files";
        if (command === "wechat_sessions_list") return items.map(item => ({ ...item }));
        if (command === "wechat_sessions_capture") {
          const item = { id: `profile-${items.length}`, label: args.label, dataPath: args.dataPath, createdAt: 1700000000 + items.length, recovery: false, family: "微信 4.x" };
          items.push(item);
          return item;
        }
        if (command === "wechat_sessions_launch") {
          if ((window as any).sessionFail) throw { code: "local-plugin", message: "微信配置被占用或不可写，请退出微信后重试" };
          await new Promise<void>(resolve => { (window as any).finishSessionLaunch = resolve; });
          items.unshift({ id: "backup-1", label: "恢复前备份", dataPath: items[0].dataPath, createdAt: 1700000010, recovery: true });
          return;
        }
        if (command === "wechat_sessions_restore") return;
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "plugin:updater|check") return null;
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await page.locator(".software-store-page").getByRole("button", { name: "设置", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "微信多开设置" });
  await panel.getByRole("button", { name: "选择数据目录" }).click();
  for (const name of ["工作号", "个人号"]) {
    await panel.getByLabel("配置名称").fill(name);
    await panel.getByRole("button", { name: "保存当前配置" }).click();
    await expect(page.locator(".store-notification")).toContainText("当前账号登录配置已加密保存");
  }
  const rows = panel.locator(".wechat-session-list li");
  await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: "个人号" }).getByRole("button", { name: "恢复并启动" }).click();
  await expect(panel.locator(".wechat-setting-row > .primary")).toBeDisabled();
  await page.evaluate(() => { (window as any).finishSessionLaunch(); });
  await expect(page.locator(".store-notification")).toContainText("请核对头像与账号");
  expect(await page.evaluate(() => (window as any).sessionCalls.filter((call: any) => call.command === "wechat_sessions_launch"))).toEqual([{ command: "wechat_sessions_launch", args: { id: "profile-1", path: "C:\\Tencent\\Weixin.exe" } }]);
  await panel.getByRole("button", { name: "恢复备份", exact: true }).click();
  await expect(page.locator(".store-notification")).toContainText("已恢复所选备份");
  await page.evaluate(() => { (window as any).sessionFail = true; });
  await rows.filter({ hasText: "工作号" }).getByRole("button", { name: "恢复并启动" }).click();
  await expect(page.getByRole("alert")).toContainText("微信配置被占用或不可写");
  await expect(panel).not.toContainText("微信配置被占用或不可写");
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await panel.locator(".wechat-session-settings").screenshot({ path: "test-results/wechat-sessions.png" });
});

test("浏览器预览禁用本地启动且插件页面适应不同宽度", async ({ page }) => {
  await page.route("http://127.0.0.1:1430/**", route => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await page.locator(".software-store-page").getByRole("button", { name: "设置", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "微信多开设置" });
  await expect(panel).toContainText("浏览器预览不支持启动本地软件");
  await expect(panel.getByRole("button", { name: "批量启动", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "选择文件" })).toBeDisabled();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await panel.screenshot({ path: "test-results/official-plugins.png" });
  await panel.getByRole("button", { name: "最大化弹层" }).click();
  await expect(panel).toHaveClass(/dialog-size-expanded/);
  await panel.getByRole("button", { name: "缩小弹层" }).click();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  const settings = page.locator(".software-store-page").getByRole("button", { name: "设置", exact: true });
  await expect(settings).toBeFocused();
  await settings.click();
  await expect(panel).toBeVisible();
  await page.locator(".modal-backdrop").click({ position: { x: 2, y: 2 } });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "关闭微信多开设置" }).click();
  await expect(panel).toHaveCount(0);
});

test("微信插件传递启动参数、保留取消选择并防止重复启动", async ({ page }) => {
  await page.addInitScript(() => {
    const calls: { command: string; args: any }[] = [];
    let running = 0;
    Object.assign(window, { pluginCalls: calls, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: any) => {
        calls.push({ command, args });
        if (command === "wechat_plugin_status") return { supported: true, detectedPath: "C:\\Program Files\\Tencent\\Weixin\\Weixin.exe", runningProcesses: running };
        if (command === "wechat_plugin_select") return null;
        if (command === "wechat_plugin_launch") {
          running = 2;
          return { requested: args.count, started: args.count, failed: 0 };
        }
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "plugin:updater|check") return null;
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await page.locator(".software-store-page").getByRole("button", { name: "设置", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "微信多开设置" });
  await expect(panel.getByLabel("客户端路径")).toHaveValue("C:\\Program Files\\Tencent\\Weixin\\Weixin.exe");
  await panel.getByRole("button", { name: "选择文件" }).click();
  await expect(panel.getByLabel("客户端路径")).toHaveValue("C:\\Program Files\\Tencent\\Weixin\\Weixin.exe");
  await panel.getByLabel("启用微信多开").uncheck();
  await expect(panel.getByRole("button", { name: "批量启动", exact: true })).toBeDisabled();
  await panel.getByLabel("启用微信多开").check();
  await panel.getByRole("button", { name: "自动检测", exact: true }).click();
  const notice = page.locator(".store-notification");
  await expect(notice).toContainText("已检测到微信客户端。");
  await expect(panel).not.toContainText("已检测到微信客户端。");
  await expect(page.locator(".store-catalog")).not.toContainText("已检测到微信客户端。");
  const position = await notice.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, right: window.innerWidth - rect.right };
  });
  expect(position.top).toBeLessThan(120);
  expect(position.right).toBeGreaterThanOrEqual(0);
  expect(position.right).toBeLessThan(50);
  await notice.getByRole("button", { name: "关闭操作提示" }).click();
  await expect(notice).toHaveCount(0);
  await panel.getByLabel("启动数量").selectOption("3");
  await panel.getByRole("button", { name: "批量启动", exact: true }).click();
  await expect(page.locator(".store-notification")).toContainText("已提交 3/3 个启动请求");
  await expect(page.locator(".store-notification")).toContainText("启动请求数不代表多开成功");
  await expect(panel.getByRole("button", { name: "批量启动", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "批量启动", exact: true }).click();
  await expect(page.locator(".store-notification")).toContainText("请先从微信托盘菜单退出所有微信");
  expect(await page.evaluate(() => (window as any).pluginCalls.filter((call: any) => call.command === "wechat_plugin_launch"))).toEqual([
    { command: "wechat_plugin_launch", args: { path: "C:\\Program Files\\Tencent\\Weixin\\Weixin.exe", count: 3 } },
  ]);
});

test("软件商店支持来源切换、搜索和启用筛选", async ({ page }) => {
  await page.route("http://127.0.0.1:1430/**", route => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  const store = page.locator(".software-store-page");
  const appRow = store.locator("tbody tr");
  await expect(appRow).toHaveCount(3);
  await store.getByLabel("应用搜索").fill("不存在的工具");
  await expect(appRow).toHaveCount(0);
  await expect(store).toContainText("没有符合条件的应用");
  await store.getByLabel("应用搜索").fill("wechat");
  await expect(appRow).toHaveCount(1);
  await store.getByRole("button", { name: "第三方应用", exact: true }).click();
  await expect(store).toContainText("暂无第三方应用");
  await expect(store.getByRole("button", { name: "一键部署", exact: true })).toHaveCount(0);
  await store.getByRole("button", { name: "查看全部官方应用" }).click();
  await store.getByLabel("启用微信多开").uncheck();
  await store.getByRole("button", { name: "已启用", exact: true }).click();
  await expect(appRow).toHaveCount(2);
  await expect(appRow.filter({ hasText: "微信多开" })).toHaveCount(0);
  await store.getByRole("button", { name: "全部", exact: true }).click();
  await expect(appRow.filter({ hasText: "微信多开" })).toContainText("已停用");
  await store.getByLabel("启用微信多开").check();
  await store.getByRole("button", { name: "已启用", exact: true }).click();
  await expect(appRow).toHaveCount(3);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const alignment = await store.evaluate(element => {
    const center = (selector: string) => {
      const box = element.querySelector(selector)!.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    return {
      search: Math.abs(center('label[for="store-search"]') - center('#store-search')),
      toggle: Math.abs(center('.store-switch > span') - center('.store-state')),
    };
  });
  expect(alignment.search).toBeLessThanOrEqual(1);
  expect(alignment.toggle).toBeLessThanOrEqual(1);
  await store.screenshot({ path: "test-results/software-store-desktop.png" });
  await page.setViewportSize({ width: 375, height: 900 });
  await store.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "微信多开设置" }).getByLabel("客户端路径")).toBeVisible();
  await page.getByRole("button", { name: "关闭微信多开设置" }).click();
  await page.locator("#main-content").evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: "test-results/software-store-mobile.png" });
});

test("默认检测路径可直接启动，已运行提示后退出无需手动刷新", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { wechatRunning: 2, wechatLaunches: 0, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: any) => {
        if (command === "wechat_plugin_status") return { supported: true, detectedPath: "C:\\Program Files\\Tencent\\Weixin\\Weixin.exe", runningProcesses: (window as any).wechatRunning };
        if (command === "wechat_plugin_launch") {
          (window as any).wechatLaunches++;
          (window as any).wechatRunning = args.count;
          return { requested: args.count, started: args.count, failed: 0 };
        }
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "plugin:updater|check") return null;
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  await page.locator(".software-store-page").getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "微信多开设置" });
  const start = dialog.getByRole("button", { name: "批量启动", exact: true });
  await expect(start).toBeEnabled();
  const alignment = await dialog.evaluate(element => {
    const center = (selector: string) => {
      const box = element.querySelector(selector)!.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    const label = center('label[for="wechat-window-count"]');
    const left = (selector: string) => element.querySelector(selector)!.getBoundingClientRect().left;
    return [
      Math.abs(label - center('#wechat-window-count')),
      Math.abs(label - center('.official-plugin-actions > .primary')),
      Math.abs(left('.wechat-setting-row > .primary') - left('.wechat-setting-row > .secondary')),
      Math.abs(left('label[for="wechat-window-count"]') - left('.wechat-setting-label')),
    ];
  });
  for (const difference of alignment) expect(difference).toBeLessThanOrEqual(1);
  await start.click();
  await expect(page.locator(".store-notification")).toContainText("请先从微信托盘菜单退出所有微信");
  expect(await page.evaluate(() => (window as any).wechatLaunches)).toBe(0);
  await page.evaluate(() => { (window as any).wechatRunning = 0; });
  await start.click();
  await expect(page.locator(".store-notification")).toContainText("已提交 2/2 个启动请求");
  expect(await page.evaluate(() => (window as any).wechatLaunches)).toBe(1);
  await dialog.screenshot({ path: "test-results/wechat-settings-aligned.png" });
});
