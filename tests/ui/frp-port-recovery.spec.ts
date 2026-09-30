import { test, expect } from "@playwright/test";

for (const recoverable of [true, false]) {
  test(`FRP port conflict ${recoverable ? "offers confirmed stale-process recovery" : "protects unrelated processes"}`, async ({ page }) => {
    await page.addInitScript((canTerminate) => {
      let terminated = false;
      let terminateCalls = 0;
      const state = { serverId: 1, installed: true, configPresent: true, configCurrent: true, running: false, connected: false, version: "0.71.0", proxies: [] };
      Object.assign(window, {
        __frpTerminateCalls: () => terminateCalls,
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
          invoke: async (command: string) => {
            if (command === "list_frp_servers") return [{ id: 1, name: "test-frp", serverAddr: "127.0.0.1", serverPort: 7000, tokenSaved: false, panelUrl: null, panelUsername: null, panelPasswordSaved: false, adminPort: 7400, proxies: [], updatedAt: 0 }];
            if (command === "get_frp_global_settings") return { adminUser: "admin", adminPasswordSaved: true };
            if (command === "get_frpc_runtime") return [state];
            if (command === "get_frp_local_paths") return { installed: true, version: "0.71.0", binaryPath: "frpc.exe", configPath: "frpc.toml" };
            if (command === "control_frpc") throw { kind: "platform-error", code: "frp-port-conflict", message: "ignored raw text", retryable: false };
            if (command === "get_frp_port_conflict") return { serverId: 1, port: 7400, owners: terminated ? [] : [{ pid: 12345, canTerminate, startedAt: "2026-09-30T00:00:00.0000000Z" }] };
            if (command === "terminate_stale_frpc") { terminateCalls++; terminated = true; return; }
            if (command === "get_frpc_logs") return ["面板端口 7400 已被占用"];
            if (command === "plugin:app|version") return "0.1.35";
            if (command === "plugin:updater|check") return null;
            if (command === "plugin:event|listen") return 1;
            return [];
          },
        },
      });
    }, recoverable);
    await page.goto("/");
    await page.getByRole("button", { name: "内网穿透", exact: true }).first().click();
    await page.getByRole("button", { name: "启动连接", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("本机 FRP 面板端口已被占用");
    await expect(page.getByRole("alert")).not.toContainText("网络或云服务");
    await expect(page.getByText("本机客户端面板端口 7400 被占用")).toBeVisible();
    await expect(page.getByText(/PID 12345/)).toBeVisible();
    if (recoverable) {
      for (const width of [375, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      await page.screenshot({ path: "test-results/frp-port-recovery.png" });
    }
    const terminate = page.getByRole("button", { name: "结束旧 frpc 进程", exact: true });
    if (!recoverable) {
      await expect(terminate).toHaveCount(0);
      return;
    }
    page.once("dialog", (dialog) => dialog.dismiss());
    await terminate.click();
    expect(await page.evaluate(() => (window as unknown as { __frpTerminateCalls: () => number }).__frpTerminateCalls())).toBe(0);
    page.once("dialog", (dialog) => dialog.accept());
    await terminate.click();
    await expect(page.getByText("结束旧 frpc 进程完成", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __frpTerminateCalls: () => number }).__frpTerminateCalls())).toBe(1);
    await expect(terminate).toHaveCount(0);
  });
}
