import { expect, test } from "@playwright/test";
import { TerminalAuditStore } from "../../src/features/servers/terminalAudit";

test("terminal audit is bounded, output-only and redacts chunked sensitive data", () => {
  const store = new TerminalAuditStore();
  store.append("one", "not recording\n", [], 0);
  expect(store.recordings).toHaveLength(0);
  store.start("one", "测试会话", 0);
  const secret = crypto.randomUUID();
  store.append("other", "wrong session\n", [], 50);
  store.append("one", "正常输出\npassword=" + secret.slice(0, 8), [secret], 100);
  store.append("one", secret.slice(8) + "\n-----BEGIN " + "PRIVATE KEY-----\nfixture-key-body\n-----END " + "PRIVATE KEY-----\noperator$ echo input\n", [secret], 200);
  store.stop("手动停止", [secret], 300);
  const text = store.recordings[0].frames.map(frame => frame.text).join("");
  expect(text).toContain("正常输出");
  expect(text).not.toContain(secret);
  expect(text).not.toContain("fixture-key-body");
  expect(text).not.toContain("echo input");
  expect(text).not.toContain("wrong session");
  expect(store.recordings[0].duration).toBe(300);
  for (let index = 0; index < 12; index++) { store.start(String(index), "测试", index); store.stop("停止", [], index + 1); }
  expect(store.recordings).toHaveLength(10);
  store.start("bounded", "容量检查", 0);
  store.append("bounded", "短输出\n".repeat(9000), [], 10);
  expect(store.recording).toBeNull();
  expect(store.recordings[0].frames.length).toBeLessThanOrEqual(8000);
  expect(store.recordings[0].bytes).toBeLessThanOrEqual(512 * 1024);
});

test("terminal audit records and replays without sending commands", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("cloudhub-tools-terminal-theme", "blue");
    const queue: string[] = [];
    let sessionCount = 0;
    (window as any).auditQueue = queue;
    (window as any).auditWrites = 0;
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string) => {
      if (command === "list_managed_hosts") return [{ id: 1, name: "审计测试服务器", host: "192.0.2.10", platform: "linux", username: "operator", port: 22, group_name: "测试", status: "online", password_saved: true }];
      if (command === "list_client_preferences") return {};
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      if (command === "ssh_connect") return { sessionId: `audit-${++sessionCount}` };
      if (command === "probe_managed_host") return { id: 1, name: "审计测试服务器", host: "192.0.2.10", platform: "linux", username: "operator", port: 22, group_name: "测试", status: "online", password_saved: true };
      if (command === "ssh_read") return queue.shift() || "";
      if (command === "ssh_write") { (window as any).auditWrites++; return; }
      if (command === "ssh_list_files") return { path: "/", entries: [] };
      return [];
    } };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "终端管理", exact: true }).click();
  await page.locator('[data-managed-host-group="测试"]').getByRole("button", { name: /选择服务器 审计测试服务器/ }).dblclick();
  await expect(page.locator(".ssh-terminal-viewport .xterm")).toBeVisible();
  await expect(page.locator(".ssh-terminal-viewport .xterm-viewport")).toHaveCSS("background-color", "rgb(0, 0, 0)");
  const header = page.locator(".terminal-session-header");
  await expect(header).toBeVisible();
  await expect(header.getByRole("tab", { name: "审计测试服务器", exact: true })).toBeVisible();
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(32);
  const titlebar = (await page.locator(".ide-topbar").boundingBox())!;
  expect((await header.boundingBox())!.y).toBeGreaterThanOrEqual(titlebar.y + titlebar.height + 6);
  await expect(header.getByRole("button", { name: "命令补全 (Tab)", exact: true })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "终端配色", exact: true })).toBeVisible();
  await header.scrollIntoViewIfNeeded();
  await header.screenshot({ path: "test-results/terminal-compact-header.png" });
  await page.getByRole("tab", { name: "录像审计", exact: true }).click();
  const panel = page.getByRole("region", { name: "录像审计", exact: true });
  await panel.getByRole("button", { name: "开始录制", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("正在录制");
  await page.evaluate(() => (window as any).auditQueue.push("测试输出一\n测试输出二\n"));
  await expect.poll(() => page.evaluate(() => (window as any).auditQueue.length)).toBe(0);
  await panel.getByRole("button", { name: "停止录制", exact: true }).click();
  await panel.getByRole("button", { name: /审计测试服务器.*手动停止/ }).click();
  await panel.getByLabel("回放速度", { exact: true }).selectOption("4");
  await panel.getByRole("button", { name: "播放录像", exact: true }).click();
  await expect(panel.getByLabel("录像回放输出", { exact: true })).toContainText("测试输出二");
  expect(await page.evaluate(() => (window as any).auditWrites)).toBe(0);
  await expect(page.getByRole("button", { name: "清屏", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "监控", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "文件管理", exact: true })).toBeVisible();
  await panel.screenshot({ path: "test-results/terminal-audit-panel.png" });
  await panel.getByRole("button", { name: "开始录制", exact: true }).click();
  await page.getByRole("button", { name: "关闭 审计测试服务器", exact: true }).click();
  await expect(panel.getByRole("button", { name: "开始录制", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: /审计测试服务器.*会话切换或断开/ })).toBeVisible();
  await panel.getByRole("button", { name: /审计测试服务器.*手动停止/ }).click();
  await panel.getByLabel("回放进度", { exact: true }).fill(String(await panel.getByLabel("回放进度", { exact: true }).getAttribute("max")));
  await expect(panel.getByLabel("录像回放输出", { exact: true })).toContainText("测试输出二");
  await panel.getByRole("button", { name: "删除录像 1", exact: true }).click();
  await expect(panel.getByLabel("录像回放输出", { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "终端管理", exact: true }).click();
  await page.locator('[data-managed-host-group="测试"]').getByRole("button", { name: /选择服务器 审计测试服务器/ }).dblclick();
  await page.getByRole("tab", { name: "录像审计", exact: true }).click();
  await expect(panel.getByText("点击“开始录制”，记录之后的终端输出。", { exact: true })).toBeVisible();
  const tabs = page.getByRole("tablist", { name: "SSH 终端标签", exact: true });
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await page.evaluate(() => { (window as any).cachedTerminalNodes = [document.querySelector(".terminal-session-buffer .xterm")]; });
  await page.locator('[data-managed-host-group="测试"]').getByRole("button", { name: /选择服务器 审计测试服务器/ }).dblclick();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(tabs.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".terminal-session-buffer:visible .xterm")).toHaveCount(1);
  await page.evaluate(() => { (window as any).cachedTerminalNodes.push(document.querySelector(".terminal-session-buffer:has(.xterm) .xterm")); });
  for (const index of [0, 1, 0, 1]) {
    await tabs.getByRole("tab").nth(index).click();
    await expect(page.locator(".terminal-session-buffer:visible .xterm")).toHaveCount(1);
    expect(await page.evaluate((index) => {
      const original = (window as any).cachedTerminalNodes[index];
      return original.isConnected && getComputedStyle(original.parentElement).visibility === "visible";
    }, index)).toBe(true);
  }

  await tabs.getByRole("button", { name: "关闭 审计测试服务器", exact: true }).nth(1).click();
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(tabs.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".ssh-terminal-viewport .xterm")).toBeVisible();
});
