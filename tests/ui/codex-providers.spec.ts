import { test, expect } from "@playwright/test";

test("model provider management, masked editing and configuration recovery", async ({ page }) => {
  await page.addInitScript(() => {
    let providers: Record<string, unknown>[] = [];
    let backup = false;
    let activeProbeRequests = 0;
    let maxProbeRequests = 0;
    let probeCalls = 0;
    let catalogCalls = 0;
    const aggregates = [{
      id: "aggregate-a", version: 1, name: "Shared pool", strategy: "failover", models: ["model-a"],
      members: [{ providerId: "provider-a", keyId: "key-0", providerName: "Example Provider", keyName: "primary", wireApi: "chat_completions", models: ["model-a"], weight: 1 }],
    }];
    Object.assign(window, { __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "list_client_preferences") return { "codex.providers.switch-enabled": "true" };
        if (command === "codex_get_state") return { accounts: [], cliAvailable: true, desktopAvailable: true, profileHome: "C:/fixture", currentAccountId: null, canRestore: false };
        if (command === "codex_config_source") return { path: "C:/fixture/config.toml", workspace: null, exists: true, authExists: false, preview: null };
        if (command === "codex_gateway_state") return { running: false, accountIds: [], completed: 0, failed: 0, active: 0 };
        if (command === "codex_provider_list") return providers;
        if (command === "codex_provider_aggregate_list") {
          const renamed = localStorage.getItem("refreshed-aggregate-name");
          return aggregates.map(value => ({ ...value, name: renamed ?? value.name }));
        }
        if (command === "codex_provider_models") {
          const input = args.input as { baseUrl: string; providerId: string | null; keyId: string | null; version: number | null; secret: string | null };
          const calls = JSON.parse(localStorage.getItem("provider-model-catalog-inputs") ?? "[]");
          calls.push({ baseUrl: input.baseUrl, providerId: input.providerId, keyId: input.keyId, version: input.version, hasSecret: !!input.secret });
          localStorage.setItem("provider-model-catalog-inputs", JSON.stringify(calls));
          await new Promise(resolve => setTimeout(resolve, 250));
          const mode = localStorage.getItem("provider-catalog-mode");
          const models = catalogCalls++ % 2 === 0 ? ["model-a"] : ["model-b"];
          return { models: mode === "error" ? [] : mode === "empty" ? [] : models, generated: false, elapsedMs: 250, status: mode === "error" ? 401 : 200, error: mode === "error" ? "http" : null };
        }
        if (command === "codex_provider_probe") {
          probeCalls += 1;
          activeProbeRequests += 1;
          maxProbeRequests = Math.max(maxProbeRequests, activeProbeRequests);
          localStorage.setItem("provider-probe-stats", JSON.stringify({ calls: probeCalls, max: maxProbeRequests, active: activeProbeRequests }));
          await new Promise(resolve => setTimeout(resolve, 250));
          activeProbeRequests -= 1;
          localStorage.setItem("provider-probe-stats", JSON.stringify({ calls: probeCalls, max: maxProbeRequests, active: activeProbeRequests }));
          if (localStorage.getItem("probe-output-limit")) return { models: [], generated: false, elapsedMs: 250, status: 200, error: "output_limit" };
          return { models: args.model ? [] : ["model-c"], generated: !!args.model, elapsedMs: 250, status: 200, error: null };
        }
        if (command === "codex_provider_usage") return { adapter: "deepseek", fetchedAt: Date.now(), windows: [{ name: "余额", remaining: 12.3, total: null, unit: "CNY", resetsAt: null }] };
        if (command === "codex_provider_reveal_key") return `revealed-${args.keyId}`;
        if (command === "codex_provider_import") {
          if (args.action === "prepare") return { token: "import-fixture", providers: [{ name: "imported", baseUrl: "https://example.org/v1", wireApi: "responses", models: ["model-a"], keyCount: 1, duplicate: false }], warnings: ["实例和 OAuth 绑定不迁移"] };
          if (args.action === "confirm" && localStorage.getItem("reject-provider-import")) throw { message: "供应商目录已变更，请重新预览导入" };
          return null;
        }
        if (command === "codex_provider_save") {
          const input = args.input as { id?: string; name: string; keys: { name: string; secret: string | null; settings?: Record<string, unknown> }[] };
          if (input.name === "conflict") throw { message: "供应商已被修改，请刷新后重试" };
          providers = [{ ...input, id: "provider-a", version: 1, keys: input.keys.map((k, i) => ({ id: "key-" + i, name: k.name, settings: k.settings })) }];
          return providers;
        }
        if (command === "codex_provider_remove") { providers = []; return providers; }
        if (command === "codex_provider_preview") return { version: "v1", path: "C:/fixture", hasBackup: backup };
        if (command === "codex_provider_apply") { backup = true; localStorage.setItem("last-provider-apply", JSON.stringify(args.input)); return { version: "v2", path: "C:/fixture", hasBackup: backup }; }
        if (command === "codex_provider_restore") { backup = false; return { version: "v1", path: "C:/fixture", hasBackup: backup }; }
        if (command === "app_is_development") return true;
        if (command === "plugin:app|version") return "0.1.45";
        if (command === "plugin:updater|check") return null;
        if (command === "plugin:event|listen") return 1;
        return [];
      },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Codex 管理", exact: true }).first().click();
  await page.getByRole("tab", { name: "模型供应商", exact: true }).click();
  await expect(page.getByRole("button", { name: "添加聚合供应商", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "添加供应商", exact: true }).first().click();
  const editor = page.locator('dialog.codex-provider-editor-dialog');
  const fetchAllModels = editor.getByRole("button", { name: "获取所有密钥模型", exact: true });
  await expect(fetchAllModels).toBeDisabled();
  await editor.getByLabel("名称", { exact: true }).fill("Example Provider");
  await editor.getByLabel("API 地址", { exact: true }).fill("https://example.com/v1");
  const secretInput = editor.getByLabel("密钥", { exact: true }).first();
  const secretToggle = editor.getByRole("button", { name: "显示密钥", exact: true }).first();
  await expect(secretToggle).toBeEnabled();
  await secretToggle.click();
  await expect(editor.getByText("输入密钥后即可显示或隐藏。", { exact: true })).toBeVisible();
  await secretInput.fill("provider-test-secret");
  await expect(secretInput).toHaveAttribute("type", "password");
  await secretToggle.click();
  await expect(secretInput).toHaveAttribute("type", "text");
  await expect(secretInput).toHaveValue("provider-test-secret");
  await editor.getByRole("button", { name: "隐藏密钥", exact: true }).first().click();
  await expect(secretInput).toHaveAttribute("type", "password");
  await secretInput.fill(crypto.randomUUID());
  const addressBox = await editor.getByLabel("API 地址", { exact: true }).boundingBox();
  const keyBox = await editor.locator(".codex-provider-secret-group").first().boundingBox();
  const protocolBox = await editor.getByRole("combobox", { name: "接入模式", exact: true }).boundingBox();
  expect(keyBox!.y).toBeGreaterThan(addressBox!.y);
  expect(protocolBox!.y).toBeLessThan(addressBox!.y);
  await editor.getByRole("button", { name: "添加密钥", exact: true }).click();
  await editor.getByLabel("密钥名称", { exact: true }).nth(1).fill("secondary");
  await editor.getByLabel("密钥", { exact: true }).nth(1).fill(crypto.randomUUID());
  await editor.getByText("默认密钥 · 模型目录与设置", { exact: true }).click();
  await editor.getByLabel("模型目录 · 默认密钥", { exact: true }).fill("manual-model");
  const modelSummary = editor.getByLabel("模型 ID（按密钥汇总）", { exact: true });
  await expect(modelSummary).toHaveValue("manual-model");
  await fetchAllModels.click();
  await expect(fetchAllModels).toBeDisabled();
  await expect(editor.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await expect(editor.getByRole("status")).toHaveText("已查询 2/2 个密钥，发现 2 个模型");
  await expect(modelSummary).toHaveValue("manual-model\nmodel-a\nmodel-b");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("provider-model-catalog-inputs") ?? "[]"))).toEqual([
    { baseUrl: "https://example.com/v1", providerId: null, keyId: null, version: null, hasSecret: true },
    { baseUrl: "https://example.com/v1", providerId: null, keyId: null, version: null, hasSecret: true },
  ]);
  await expect(page.getByRole("article", { name: "模型供应商 Example Provider" })).toHaveCount(0);
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  const card = page.getByRole("article", { name: "模型供应商 Example Provider" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "查询额度 Example Provider", exact: true }).click();
  const usage = page.getByRole("dialog", { name: "Example Provider · 额度", exact: true });
  await usage.getByRole("button", { name: "查询额度", exact: true }).click();
  await expect(usage.getByText("12.3 CNY", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "导入供应商", exact: true }).click();
  const importing = page.getByRole("dialog", { name: "导入模型供应商", exact: true });
  await importing.getByRole("button", { name: "选择 JSON 文件", exact: true }).click();
  await expect(importing.getByText("待导入", { exact: true })).toBeVisible();
  await expect(importing.getByRole("button", { name: "确认导入", exact: true })).toBeEnabled();
  await page.evaluate(() => localStorage.setItem("reject-provider-import", "1"));
  await importing.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(importing.getByRole("alert")).toHaveText("供应商目录已变更，请重新预览导入");
  // 确认失败后后端已消费预览令牌，必须重新预览，不能再次确认同一批供应商。
  await expect(importing.getByRole("button", { name: "确认导入", exact: true })).toHaveCount(0);
  await expect(importing.getByText("待导入", { exact: true })).toHaveCount(0);
  await page.evaluate(() => localStorage.removeItem("reject-provider-import"));
  await importing.getByRole("button", { name: "选择 JSON 文件", exact: true }).click();
  await expect(importing.getByRole("button", { name: "确认导入", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await card.getByRole("button", { name: "模型测试 Example Provider", exact: true }).click();
  const probe = page.getByRole("dialog", { name: "Example Provider · 模型测试", exact: true });
  await expect(probe.getByRole("button", { name: "生成测试", exact: true })).toBeDisabled();
  await probe.getByRole("checkbox", { name: "secondary", exact: true }).check();
  await probe.getByRole("button", { name: "获取模型目录", exact: true }).click();
  await expect(probe.getByText("已获取 1 个模型", { exact: true })).toHaveCount(2);
  await probe.getByRole("checkbox", { name: "model-c · 默认密钥", exact: true }).check();
  await probe.getByRole("checkbox", { name: "model-c · secondary", exact: true }).check();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await probe.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const checkbox of await probe.getByRole("checkbox").all()) {
      const box = await checkbox.boundingBox();
      expect(box?.width).toBe(16);
      expect(box?.height).toBe(16);
    }
    await expect(probe.locator(".codex-provider-consent")).toHaveCSS("display", "flex");
    await expect(probe.locator(".codex-provider-options label").first()).toHaveCSS("display", "flex");
  }
  await probe.getByRole("button", { name: "添加所选模型到对应密钥", exact: true }).click();
  await expect(probe).toBeHidden();
  await expect(card).toContainText("4 个模型");
  await card.getByRole("button", { name: "模型测试 Example Provider", exact: true }).click();
  await probe.getByRole("checkbox", { name: "secondary", exact: true }).check();
  await probe.getByRole("checkbox", { name: "model-b", exact: true }).check();
  await probe.getByRole("checkbox", { name: "model-c", exact: true }).check();
  await probe.getByRole("checkbox", { name: /我同意发送实际生成请求/ }).check();
  await probe.getByRole("button", { name: "生成测试", exact: true }).click();
  await expect(probe.getByText("生成成功", { exact: true })).toHaveCount(4);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("provider-probe-stats") ?? "{}"))).toEqual({ calls: 6, max: 3, active: 0 });
  await page.keyboard.press("Escape");
  await card.getByRole("button", { name: "模型测试 Example Provider", exact: true }).click();
  await probe.getByRole("checkbox", { name: "secondary", exact: true }).check();
  await probe.getByRole("checkbox", { name: "model-b", exact: true }).check();
  await probe.getByRole("checkbox", { name: "model-c", exact: true }).check();
  await probe.getByRole("checkbox", { name: /我同意发送实际生成请求/ }).check();
  await probe.getByRole("button", { name: "生成测试", exact: true }).click();
  await expect(probe.getByText("请求中", { exact: true }).first()).toBeVisible();
  await probe.getByRole("button", { name: "停止排队", exact: true }).click();
  await expect(probe.getByText("已停止", { exact: true }).first()).toBeVisible();
  await expect(probe.getByText("生成成功", { exact: true })).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("provider-probe-stats") ?? "{}"))).toEqual({ calls: 9, max: 3, active: 0 });
  await page.keyboard.press("Escape");
  await card.getByRole("button", { name: "编辑 Example Provider", exact: true }).click();
  const editing = page.locator('dialog.codex-provider-editor-dialog');
  const secretInputs = editing.getByLabel("密钥", { exact: true });
  const savedSecretToggles = editing.getByRole("button", { name: "显示密钥", exact: true });
  await expect(secretInputs).toHaveCount(2);
  await expect(savedSecretToggles).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    await expect(secretInputs.nth(index)).toHaveValue("");
    await expect(secretInputs.nth(index)).toHaveAttribute("type", "password");
    await expect(savedSecretToggles.nth(index)).toBeEnabled();
  }
  await savedSecretToggles.first().click();
  await expect(secretInputs.first()).toHaveValue("revealed-key-0");
  await expect(secretInputs.first()).toHaveAttribute("type", "text");
  await expect(editing.getByRole("button", { name: "隐藏密钥", exact: true })).toHaveCount(1);
  await expect(editing.getByRole("button", { name: "复制密钥", exact: true })).toHaveCount(2);
  await editing.getByRole("button", { name: "隐藏密钥", exact: true }).click();
  await expect(secretInputs.first()).toHaveAttribute("type", "password");
  const fetchAllSavedKeys = editing.getByRole("button", { name: "获取所有密钥模型", exact: true });
  await fetchAllSavedKeys.click();
  await expect(editing.getByRole("status")).toHaveText("已查询 2/2 个密钥，发现 2 个模型");
  const catalogInputs = await page.evaluate(() => JSON.parse(localStorage.getItem("provider-model-catalog-inputs") ?? "[]"));
  expect(catalogInputs.slice(-2)).toEqual([
    { baseUrl: "https://example.com/v1", providerId: "provider-a", keyId: "key-0", version: 1, hasSecret: false },
    { baseUrl: "https://example.com/v1", providerId: "provider-a", keyId: "key-1", version: 1, hasSecret: false },
  ]);
  const savedModelSummary = editing.getByLabel("模型 ID（按密钥汇总）", { exact: true });
  await expect(savedModelSummary).toHaveValue("manual-model\nmodel-a\nmodel-c\nmodel-b");
  await page.evaluate(() => localStorage.setItem("provider-catalog-mode", "error"));
  await fetchAllSavedKeys.click();
  await expect(editing.getByRole("status")).toHaveText("已查询 0/2 个密钥，发现 0 个模型；失败：默认密钥、secondary");
  await expect(savedModelSummary).toHaveValue("manual-model\nmodel-a\nmodel-c\nmodel-b");
  await page.evaluate(() => localStorage.setItem("provider-catalog-mode", "empty"));
  await fetchAllSavedKeys.click();
  await expect(editing.getByRole("status")).toHaveText("已查询 2/2 个密钥，发现 0 个模型");
  await expect(savedModelSummary).toHaveValue("manual-model\nmodel-a\nmodel-c\nmodel-b");
  await page.evaluate(() => localStorage.removeItem("provider-catalog-mode"));
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await editing.locator(".codex-provider-editor-models").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await editing.locator(".codex-provider-key-row").first().evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await editing.locator(".modal-body").evaluate(el => { el.scrollTop = 0; });
  await editing.screenshot({ path: test.info().outputPath("provider-editor-desktop.png") });
  await editing.getByText("secondary · 模型目录与设置", { exact: true }).click();
  await editing.locator(".codex-provider-key-group").nth(1).locator("textarea").first().fill("secondary-model");
  await editing.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editing).toBeHidden();
  await card.getByRole("button", { name: "模型测试 Example Provider", exact: true }).click();
  await probe.getByRole("checkbox", { name: "secondary", exact: true }).check();
  await probe.getByRole("checkbox", { name: "默认密钥", exact: true }).uncheck();
  await probe.getByRole("checkbox", { name: /我同意发送实际生成请求/ }).check();
  await expect(probe.getByRole("checkbox", { name: "model-a", exact: true })).toHaveCount(0);
  await expect(probe.getByRole("button", { name: "生成测试", exact: true })).toBeDisabled();
  await probe.getByRole("checkbox", { name: "secondary-model", exact: true }).check();
  await probe.getByRole("button", { name: "生成测试", exact: true }).click();
  await expect(probe.getByText("生成成功", { exact: true })).toHaveCount(1);
  await page.evaluate(() => localStorage.setItem("probe-output-limit", "1"));
  await probe.getByRole("button", { name: "生成测试", exact: true }).click();
  await expect(probe.getByText("已达到短测试生成上限，未验证完整回答 (HTTP 200)", { exact: true })).toBeVisible();
  await expect(probe.getByText("生成成功", { exact: true })).toHaveCount(0);
  await page.evaluate(() => localStorage.removeItem("probe-output-limit"));
  await page.keyboard.press("Escape");
  await card.getByRole("button", { name: "编辑 Example Provider", exact: true }).click();
  await editing.getByLabel("名称", { exact: true }).fill("conflict");
  await editing.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editing.getByRole("alert")).toHaveText("供应商已被修改，请刷新后重试");
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").getByRole("button", { name: "放弃修改", exact: true }).click();
  await card.getByRole("button", { name: "启动预览 Example Provider" }).click();
  const launch = page.getByRole("dialog", { name: "Example Provider · 启动预览", exact: true });
  await launch.getByRole("combobox", { name: "模型", exact: true }).selectOption({ label: "model-c · 默认密钥" });
  await expect(launch.getByRole("combobox", { name: "匹配密钥", exact: true })).toHaveValue("key-0");
  await expect(launch.getByText("匹配：默认密钥 · 使用：默认密钥", { exact: true })).toBeVisible();
  await launch.getByRole("combobox", { name: "模型", exact: true }).selectOption({ label: "secondary-model · secondary" });
  await expect(launch.getByRole("combobox", { name: "匹配密钥", exact: true })).toHaveValue("key-1");
  await expect(launch.getByText("匹配：secondary · 使用：secondary", { exact: true })).toBeVisible();
  await launch.getByRole("button", { name: "应用配置", exact: true }).click();
  await expect(launch.getByRole("button", { name: "配置已应用", exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("last-provider-apply") ?? "{}"))).toMatchObject({ keyId: "key-1", model: "secondary-model" });
  await launch.getByRole("button", { name: "恢复配置与登录", exact: true }).click();
  await expect(launch.getByText("已恢复应用前的配置与登录", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await card.getByRole("button", { name: "编辑 Example Provider", exact: true }).click();
  await editing.getByRole("combobox", { name: "接入模式", exact: true }).selectOption("chat_completions");
  await editing.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editing).toBeHidden();
  await page.getByRole("button", { name: "添加聚合供应商", exact: true }).click();
  const aggregateEditor = page.getByRole("dialog", { name: "新建聚合供应商", exact: true });
  await aggregateEditor.getByLabel("名称", { exact: true }).fill("Two keys from one provider");
  await expect(aggregateEditor.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await aggregateEditor.getByRole("checkbox").nth(0).check();
  await aggregateEditor.getByRole("checkbox").nth(1).check();
  await expect(aggregateEditor.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.evaluate(() => localStorage.setItem("refreshed-aggregate-name", "Updated pool"));
  await page.getByRole("button", { name: "刷新供应商", exact: true }).click();
  await expect(page.getByRole("button", { name: "启动预览聚合 Updated pool", exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.removeItem("refreshed-aggregate-name"));
  await page.getByRole("button", { name: "刷新供应商", exact: true }).click();
  await expect(page.getByRole("button", { name: "启动预览聚合 Shared pool", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "启动预览聚合 Shared pool", exact: true }).click();
  const aggregateLaunch = page.getByRole("dialog", { name: "Shared pool · 启动预览", exact: true });
  await expect(aggregateLaunch.getByRole("combobox", { name: "模型", exact: true })).toHaveValue("model-a");
  await expect(aggregateLaunch.getByText("Example Provider · primary", { exact: true })).toBeVisible();
  await expect(aggregateLaunch.getByLabel("OAuth 登录身份", { exact: true })).toHaveCount(0);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await aggregateLaunch.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await aggregateLaunch.getByRole("button", { name: "应用配置", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("last-provider-apply") ?? "{}"))).toEqual({
    providerId: "aggregate:aggregate-a", providerVersion: 1, keyId: "aggregate", model: "model-a", version: "v1", oauthAccountId: null,
  });
  await aggregateLaunch.getByRole("button", { name: "恢复配置与登录", exact: true }).click();
  await page.keyboard.press("Escape");
  const aggregateSection = page.getByRole("region", { name: "聚合供应商", exact: true });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await aggregateSection.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth, row: el.querySelector<HTMLElement>(".codex-aggregate-row")?.scrollWidth }));
    expect(dimensions.scroll <= dimensions.client, `aggregate section overflow at ${width}px: ${JSON.stringify(dimensions)}`).toBe(true);
  }
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(card).toBeVisible();
    const overflow = await card.evaluate(el => el.scrollWidth > el.clientWidth + 1);
    expect(overflow).toBe(false);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "test-results/codex-providers-desktop.png", fullPage: true });
  await card.getByRole("button", { name: "删除 Example Provider", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("heading", { name: "暂无模型供应商", exact: true })).toBeVisible();
});
