import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/features/plugins/claudeProviderPresets.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { PROVIDER_PRESETS, presetToInput } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
assert.equal(new Set(PROVIDER_PRESETS.map(item => item.id)).size, PROVIDER_PRESETS.length);
for (const item of PROVIDER_PRESETS) {
  const input = presetToInput(item);
  assert.equal(new URL(item.baseUrl).protocol, "https:");
  assert.equal(new URL(item.website).search, "");
  assert.equal(input.apiKey, "");
  assert.equal(input.id, "");
  assert.equal(input.apiFormat, "anthropic");
  for (const mapping of Object.values(input.models)) assert.ok(!mapping.model.includes("[1M]"));
  input.extraEnv.test = "local";
  assert.equal(item.extraEnv?.test, undefined);
  for (const value of Object.values(input.extraEnv)) assert.equal(typeof value, "string");
}
const minimax = presetToInput(PROVIDER_PRESETS.find(item => item.id === "minimax-cn"));
assert.equal(minimax.baseUrl, "https://api.minimaxi.com/anthropic");
assert.equal(minimax.models.sonnet.supports1m, true);
assert.equal(minimax.models.sonnet.model, "MiniMax-M3");
const qwen = presetToInput(PROVIDER_PRESETS.find(item => item.id === "qwen-payg"));
assert.notEqual(qwen.models.sonnet.model, qwen.models.opus.model);
const manual = presetToInput(PROVIDER_PRESETS.find(item => item.id === "qwen-coding"));
assert.deepEqual(manual.models, {});
console.log(`已验证 ${new Set(PROVIDER_PRESETS.map(item => item.family)).size} 家厂商、${PROVIDER_PRESETS.length} 个预设：地址、空密钥、模型映射、1M 声明与数据隔离正常。`);
