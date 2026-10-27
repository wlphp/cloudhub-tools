import { expect, test } from "@playwright/test";

const INSTALL_SCRIPT = () => {
  localStorage.setItem("cloudhub-tools-ui-theme", "dark");
  (window as any).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 1, unregisterCallback: () => {},
    invoke: async (command: string) => {
      if (command === "authenticator_status") return { configured: false, unlocked: false };
      if (command === "list_client_preferences") return {};
      if (command === "ai_list_profiles") return [{ id: "f", name: "T", protocol: "openai_chat", model: "m", enabled: true, isDefault: true, visionStatus: "supported" }];
      if (command === "notes_snapshot") return { notes: [], groups: ["公司"], reminders: [] };
      if (command === "codex_gateway_state") return { running: false, address: null, accountIds: [], completed: 0, failed: 0, active: 0, settings: { loggingEnabled: false, strategy: "quota_first", cooldownSeconds: 60 }, configuredPort: 0 };
      if (command === "list_codex_accounts") return [];
      if (command === "codex_state") return { accounts: [], cliAvailable: false, desktopAvailable: false, profileHome: "", currentAccountId: null, canRestore: false };
      if (command === "codex_tunnel_state") return {};
      if (command === "codex_remote_logs") return { enabled: false, logs: [] };
      if (command === "codex_gateway_logs") return [];
      if (command === "codex_detect_proxies") return [];
      if (command === "list_codex_instances") return [];
      return [];
    },
  };
};

/** Every section paints on the same neutral IDE surfaces; no page may tint the background. */
test("codex gateway keeps the neutral IDE surface instead of a private blue palette", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(INSTALL_SCRIPT);
  await page.goto("/");
  await page.locator("main").waitFor();

  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector(".ide-theme")!);
    return { surface: style.getPropertyValue("--jb-surface").trim(), background: style.getPropertyValue("--jb-bg").trim() };
  });
  const rgb = (token: string) => `rgb(${parseInt(token.slice(1, 3), 16)}, ${parseInt(token.slice(3, 5), 16)}, ${parseInt(token.slice(5, 7), 16)})`;

  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  // The gateway cards live in the API 反代服务 tab, not the default 账号总览 tab.
  await page.getByRole("tab", { name: "API 反代服务", exact: true }).click();
  const card = page.locator(".codex-api-card:visible").first();
  await expect(card).toBeVisible();

  const surfaces = await page.evaluate(() => {
    const read = (selector: string) => {
      const element = [...document.querySelectorAll(selector)].find(item => item.getClientRects().length > 0);
      return element ? getComputedStyle(element).backgroundColor : null;
    };
    return {
      main: read("main"),
      card: read(".codex-api-card"),
      header: read(".codex-api-header"),
      metric: read(".codex-api-metrics > div"),
      input: read(".codex-api-field input, .codex-api-field select"),
    };
  });

  expect(surfaces.main).toBe(rgb(tokens.background));
  for (const [name, value] of Object.entries(surfaces)) {
    if (!value || name === "main") continue;
    // Blue-tinted mixes land near rgb(31, 38, 49); neutral surfaces keep r === g === b.
    const [r, g, b] = (value.match(/\d+/g) ?? []).map(Number);
    expect(Math.abs(r - g), `${name} ${value} 的红绿通道应一致`).toBeLessThanOrEqual(2);
    expect(Math.abs(g - b), `${name} ${value} 的绿蓝通道应一致`).toBeLessThanOrEqual(2);
  }
  expect(surfaces.card).toBe(rgb(tokens.surface));
});
