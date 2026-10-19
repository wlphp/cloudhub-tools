import type { ClaudeModelMapping, ClaudeProviderInput } from "../../platform/clients/claudeProviders";

// Reviewed against cc-switch/src/config/claudeProviderPresets.ts on 2026-10-19.
// Reference data only: no remote scripts, affiliate links, OAuth adapters or hidden presets.
// Source: https://github.com/farion1231/cc-switch/blob/main/src/config/claudeProviderPresets.ts
export interface ProviderPreset {
  id: string; family: string; name: string; website: string; baseUrl: string;
  model?: string; haiku?: string; opus?: string; extraEnv?: Record<string, string>;
}
const preset = (id: string, family: string, name: string, website: string, baseUrl: string, model?: string, options: Partial<Pick<ProviderPreset, "haiku" | "opus" | "extraEnv">> = {}): ProviderPreset =>
  ({ id, family, name, website, baseUrl, model, ...options });
const qwenModels = { haiku: "qwen3.8-flash[1M]", opus: "qwen3.8-max[1M]", extraEnv: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "983616" } };
export const PROVIDER_PRESETS: ProviderPreset[] = [
  preset("baidu-coding", "Baidu Qianfan · 百度千帆", "Coding Plan", "https://cloud.baidu.com/product/qianfan_modelbuilder", "https://qianfan.baidubce.com/anthropic/coding", "qianfan-code-latest"),
  preset("baidu-token", "Baidu Qianfan · 百度千帆", "Token Plan · 个人版", "https://cloud.baidu.com/product/codingplan.html", "https://qianfan.baidubce.com/anthropic/tokenplan/personal", "deepseek-v4-pro[1M]"),
  preset("bailing", "BaiLing · 百灵", "按量付费", "https://developer.ant-ling.com", "https://api.ant-ling.com/anthropic", "Ling-2.6-1T"),
  preset("byteplus", "BytePlus", "Coding Plan", "https://www.byteplus.com/en/product/modelark", "https://ark.ap-southeast.bytepluses.com/api/coding", "ark-code-latest"),
  preset("deepseek", "DeepSeek", "官方 API", "https://platform.deepseek.com", "https://api.deepseek.com/anthropic", "deepseek-v4-pro[1M]", { haiku: "deepseek-flash[1M]" }),
  preset("volc-payg", "火山引擎", "豆包 · 按量付费", "https://www.volcengine.com", "https://ark.cn-beijing.volces.com/api/compatible", "doubao-seed-2-1-pro-260628"),
  preset("volc-coding", "火山引擎", "Coding Plan", "https://www.volcengine.com/activity/codingplan", "https://ark.cn-beijing.volces.com/api/coding", "ark-code-latest"),
  preset("volc-agent", "火山引擎", "Agent Plan", "https://www.volcengine.com/activity/agentplan", "https://ark.cn-beijing.volces.com/api/plan", "ark-code-latest"),
  preset("kimi-cn", "Kimi", "按量付费 · 国内", "https://platform.kimi.com", "https://api.moonshot.cn/anthropic", "kimi-k2.7-code"),
  preset("kimi-intl", "Kimi", "按量付费 · 国际", "https://platform.kimi.ai", "https://api.moonshot.ai/anthropic", "kimi-k2.7-code"),
  preset("kimi-code-cn", "Kimi", "For Coding · 国内", "https://www.kimi.com/code", "https://api.kimi.com/coding/", "kimi-for-coding", { extraEnv: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144" } }),
  preset("kimi-code-intl", "Kimi", "For Coding · 国际", "https://www.kimi.ai/code", "https://api.kimi.ai/coding/", "kimi-for-coding", { extraEnv: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144" } }),
  preset("longcat", "Longcat", "官方 API", "https://longcat.chat/platform", "https://api.longcat.chat/anthropic", "LongCat-2.0[1M]", { extraEnv: { ANTHROPIC_SMALL_FAST_MODEL: "LongCat-2.0", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "131072" } }),
  // Keep the user-confirmed mainland endpoint rather than replacing existing hosts.
  preset("minimax-cn", "MiniMax", "国内", "https://platform.minimaxi.com", "https://api.minimaxi.com/anthropic", "MiniMax-M3[1M]", { extraEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" } }),
  preset("minimax-intl", "MiniMax", "国际", "https://platform.minimax.io", "https://api.minimax.io/anthropic", "MiniMax-M3[1M]", { extraEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" } }),
  preset("qwen-payg", "千问 AI 平台", "按量付费 · 国内", "https://platform.qianwenai.com", "https://dashscope.aliyuncs.com/apps/anthropic", "qwen3.7-plus[1M]", qwenModels),
  preset("qwen-coding", "千问 AI 平台", "Coding Plan", "https://bailian.console.aliyun.com", "https://coding.dashscope.aliyuncs.com/apps/anthropic"),
  preset("qwen-token", "千问 AI 平台", "Token Plan · 国内", "https://platform.qianwenai.com/pricing/token-plan", "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic", "qwen3.7-plus[1M]", qwenModels),
  preset("qwen-intl", "QwenCloud", "按量付费 · 国际", "https://home.qwencloud.com", "https://dashscope-intl.aliyuncs.com/apps/anthropic", "qwen3.7-plus[1M]", { haiku: qwenModels.haiku, opus: qwenModels.opus }),
  preset("qwen-intl-code", "QwenCloud", "For Coding · 国际", "https://www.qwencloud.com", "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic", "qwen3.7-plus[1M]"),
  preset("qwen-intl-token", "QwenCloud", "Token Plan · 国际", "https://www.qwencloud.com/pricing/token-plan", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic", "qwen3.7-plus[1M]", qwenModels),
  preset("step-cn", "StepFun · 阶跃星辰", "Step Plan · 国内", "https://platform.stepfun.com/step-plan", "https://api.stepfun.com/step_plan", "step-3.5-flash-2603"),
  preset("step-intl", "StepFun · 阶跃星辰", "Step Plan · 国际", "https://platform.stepfun.ai/step-plan", "https://api.stepfun.ai/step_plan", "step-3.5-flash-2603"),
  preset("stream-cn", "StreamLake · 万擎", "国内", "https://www.streamlake.com", "https://wanqing.streamlakeapi.com/api/gateway/v1/endpoints/kat-coder-pro-v2.5/claude-code-proxy", "kat-coder-pro-v2.5"),
  preset("stream-intl", "StreamLake · 万擎", "国际", "https://console.streamlake.ai", "https://vanchin.streamlake.ai/api/gateway/v1/endpoints/kat-coder-pro-v2.5/claude-code-proxy", "kat-coder-pro-v2.5"),
  preset("tencent", "腾讯云", "Token Plan · 国内个人", "https://cloud.tencent.com/product/tokenhub", "https://api.lkeap.cloud.tencent.com/plan/anthropic", "tc-code-latest"),
  preset("tencent-intl", "腾讯云", "Token Plan · 国际个人", "https://www.tencentcloud.com/products/tokenhub", "https://tokenhub-intl.tencentcloudmaas.com/plan/anthropic", "auto"),
  preset("tencent-pro", "腾讯云", "Enterprise Pro · 国内", "https://cloud.tencent.com/product/tokenhub", "https://tokenhub.tencentmaas.com/plan/anthropic", "auto"),
  preset("tencent-pro-intl", "腾讯云", "Enterprise Pro · 国际", "https://www.tencentcloud.com/products/tokenhub", "https://tokenhub-intl.tencentcloudmaas.com/plan/anthropic", "auto"),
  preset("tencent-lite", "腾讯云", "Enterprise Lite · 国内", "https://cloud.tencent.com/product/tokenhub", "https://tokenhub.tencentmaas.com/plan/anthropic", "auto"),
  preset("tencent-lite-intl", "腾讯云", "Enterprise Lite · 国际", "https://www.tencentcloud.com/products/tokenhub", "https://tokenhub-intl.tencentcloudmaas.com/plan/anthropic", "auto"),
  preset("mimo", "Xiaomi MiMo · 小米", "按量付费", "https://platform.xiaomimimo.com", "https://api.xiaomimimo.com/anthropic", "mimo-v2.6-pro[1M]"),
  preset("mimo-token", "Xiaomi MiMo · 小米", "Token Plan · 国内", "https://platform.xiaomimimo.com/#/token-plan", "https://token-plan-cn.xiaomimimo.com/anthropic", "mimo-v2.6-pro[1M]"),
  preset("glm-cn", "Zhipu GLM · 智谱", "国内", "https://open.bigmodel.cn", "https://open.bigmodel.cn/api/anthropic", "glm-5.3[1M]"),
  preset("glm-intl", "Zhipu GLM · 智谱", "国际 · Z.ai", "https://z.ai", "https://api.z.ai/api/anthropic", "glm-5.3[1M]"),
];
export function presetToInput(item: ProviderPreset): ClaudeProviderInput {
  const mapping = (model: string) => ({ model: model.replace(/\s*\[1m\]$/i, ""), supports1m: /\[1m\]$/i.test(model) });
  const models: Record<string, ClaudeModelMapping> = item.model ? { sonnet: mapping(item.model), opus: mapping(item.opus ?? item.model), haiku: mapping(item.haiku ?? item.model) } : {};
  return { id: "", name: item.family.split(" · ")[0] + " · " + item.name, description: "", websiteUrl: item.website, baseUrl: item.baseUrl, apiKey: "", apiKeyField: "auth_token", apiFormat: "anthropic", isFullUrl: true, officialLogin: false, models, modelCatalog: [...new Set([item.model, item.opus, item.haiku].filter((model): model is string => Boolean(model)))].map(mapping), extraEnv: { ...item.extraEnv } };
}
