import type { AiProfileInput, AiProtocol } from "../../platform/clients/ai";

export interface AiProviderPreset {
  id: string;
  family: string;
  name: string;
  website: string;
  baseUrl: string;
  protocol: AiProtocol;
  model?: string;
  models?: string[];
  allowLoopbackHttp?: boolean;
}

const preset = (
  id: string,
  family: string,
  name: string,
  website: string,
  baseUrl: string,
  protocol: AiProtocol,
  options: Partial<Pick<AiProviderPreset, "model" | "models" | "allowLoopbackHttp">> = {},
): AiProviderPreset => ({ id, family, name, website, baseUrl, protocol, ...options });

export const AI_PROTOCOL_SHORT_LABELS: Record<AiProtocol, string> = {
  openai_chat: "Chat Completions",
  openai_responses: "Responses",
  claude: "Claude Messages",
  gemini: "Gemini",
};

// 仅包含公开接口地址与协议映射；不包含推广链接、远程脚本或凭据。
export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  preset("openai-chat", "OpenAI", "Chat Completions", "https://platform.openai.com", "https://api.openai.com/v1", "openai_chat"),
  preset("openai-responses", "OpenAI", "Responses API", "https://platform.openai.com", "https://api.openai.com/v1", "openai_responses"),
  preset("claude", "Claude", "官方 API · Messages", "https://console.anthropic.com", "https://api.anthropic.com/v1", "claude"),
  preset("gemini", "Gemini", "Google AI Studio", "https://aistudio.google.com", "https://generativelanguage.googleapis.com/v1beta", "gemini"),
  preset("deepseek-openai", "DeepSeek", "OpenAI 兼容", "https://platform.deepseek.com", "https://api.deepseek.com/v1", "openai_chat", { model: "deepseek-chat", models: ["deepseek-chat", "deepseek-reasoner"] }),
  preset("deepseek-claude", "DeepSeek", "Claude 兼容", "https://platform.deepseek.com", "https://api.deepseek.com/anthropic", "claude"),
  preset("kimi-cn", "Kimi", "按量付费 · 国内", "https://platform.kimi.com", "https://api.moonshot.cn/v1", "openai_chat"),
  preset("kimi-intl", "Kimi", "按量付费 · 国际", "https://platform.kimi.ai", "https://api.moonshot.ai/v1", "openai_chat"),
  preset("glm-cn", "Zhipu GLM · 智谱", "通用 API · 国内", "https://open.bigmodel.cn", "https://open.bigmodel.cn/api/paas/v4", "openai_chat"),
  preset("glm-coding", "Zhipu GLM · 智谱", "Coding Plan · 国内", "https://open.bigmodel.cn", "https://open.bigmodel.cn/api/coding/paas/v4", "openai_chat"),
  preset("glm-intl", "Zhipu GLM · 智谱", "国际 · Z.ai", "https://z.ai", "https://api.z.ai/api/paas/v4", "openai_chat"),
  preset("qwen-cn", "千问 AI 平台", "按量付费 · 国内", "https://bailian.console.aliyun.com", "https://dashscope.aliyuncs.com/compatible-mode/v1", "openai_chat"),
  preset("qwen-intl", "QwenCloud", "按量付费 · 国际", "https://home.qwencloud.com", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "openai_chat"),
  preset("volc-payg", "火山引擎", "豆包 · 按量付费", "https://www.volcengine.com", "https://ark.cn-beijing.volces.com/api/v3", "openai_chat"),
  preset("volc-coding", "火山引擎", "Coding Plan", "https://www.volcengine.com/activity/codingplan", "https://ark.cn-beijing.volces.com/api/coding/v3", "openai_chat"),
  preset("minimax-cn", "MiniMax", "国内", "https://platform.minimaxi.com", "https://api.minimaxi.com/v1", "openai_chat"),
  preset("minimax-intl", "MiniMax", "国际", "https://platform.minimax.io", "https://api.minimax.io/v1", "openai_chat"),
  preset("baidu-v2", "Baidu Qianfan · 百度千帆", "千帆 V2 · OpenAI 兼容", "https://cloud.baidu.com/product/qianfan_modelbuilder", "https://qianfan.baidubce.com/v2", "openai_chat"),
  preset("tencent-hunyuan", "腾讯云 · 混元", "OpenAI 兼容", "https://cloud.tencent.com/product/hunyuan", "https://api.hunyuan.cloud.tencent.com/v1", "openai_chat"),
  preset("step-cn", "StepFun · 阶跃星辰", "国内", "https://platform.stepfun.com", "https://api.stepfun.com/v1", "openai_chat"),
  preset("step-intl", "StepFun · 阶跃星辰", "国际", "https://platform.stepfun.ai", "https://api.stepfun.ai/v1", "openai_chat"),
  preset("mimo", "Xiaomi MiMo · 小米", "按量付费", "https://platform.xiaomimimo.com", "https://api.xiaomimimo.com/v1", "openai_chat"),
  preset("longcat", "Longcat", "官方 API", "https://longcat.chat/platform", "https://api.longcat.chat/openai/v1", "openai_chat"),
  preset("xai", "xAI · Grok", "官方 API", "https://console.x.ai", "https://api.x.ai/v1", "openai_chat"),
  preset("mistral", "Mistral", "官方 API", "https://console.mistral.ai", "https://api.mistral.ai/v1", "openai_chat"),
  preset("openrouter-openai", "OpenRouter", "OpenAI 兼容", "https://openrouter.ai", "https://openrouter.ai/api/v1", "openai_chat"),
  preset("openrouter-claude", "OpenRouter", "Claude 兼容", "https://openrouter.ai", "https://openrouter.ai/api/v1", "claude"),
  preset("siliconflow", "SiliconFlow · 硅基流动", "国内 · OpenAI 兼容", "https://siliconflow.cn", "https://api.siliconflow.cn/v1", "openai_chat"),
  preset("groq", "Groq", "官方 API", "https://console.groq.com", "https://api.groq.com/openai/v1", "openai_chat"),
  preset("together", "Together AI", "官方 API", "https://api.together.xyz", "https://api.together.xyz/v1", "openai_chat"),
  preset("aihubmix", "AiHubMix", "官方 API", "https://aihubmix.com", "https://aihubmix.com/v1", "openai_chat"),
  preset("ollama", "Ollama", "本机 OpenAI 兼容", "https://ollama.com", "http://localhost:11434/v1", "openai_chat", { allowLoopbackHttp: true }),
  preset("lmstudio", "LM Studio", "本机 OpenAI 兼容", "https://lmstudio.ai", "http://localhost:1234/v1", "openai_chat", { allowLoopbackHttp: true }),
];

export function presetToAiProfileInput(item: AiProviderPreset, base: AiProfileInput): AiProfileInput {
  const models = item.models?.length ? item.models : item.model ? [item.model] : [""];
  const defaultModel = item.model ?? (models[0] || "");
  return {
    ...base,
    name: `${item.family.split(" · ")[0]} · ${item.name}`,
    protocol: item.protocol,
    baseUrl: item.baseUrl,
    model: defaultModel,
    models,
    allowLoopbackHttp: Boolean(item.allowLoopbackHttp),
  };
}
