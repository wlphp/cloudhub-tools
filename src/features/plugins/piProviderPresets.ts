import type { PiApi } from "../../platform/clients/piConfig";

// 参考 cc-switch src/config/piProviderPresets.ts，只保留地址、协议和已核对的模型 ID；
// 未核对模型的版本留空由用户填写。不含远程脚本、推广链接或隐藏预设。
export type PiProviderPreset = {
  key: string; family: string; name: string;
  id: string; baseUrl: string; api: PiApi; models: string[]; keyless?: boolean;
};

export const PI_PROVIDER_PRESETS: PiProviderPreset[] = [
  { key: "kimi", family: "Kimi", name: "按量付费 · 国内", id: "kimi", baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions", models: [] },
  { key: "zhipu", family: "智谱 GLM", name: "Coding Plan · 国内", id: "zhipu-glm", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", api: "openai-completions", models: ["glm-5.3", "glm-5.3-flash"] },
  { key: "qianwen", family: "千问 AI 平台", name: "国内", id: "qianwen", baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1", api: "openai-completions", models: ["qwen3.8-max"] },
  { key: "qwencloud", family: "QwenCloud", name: "国际", id: "qwencloud", baseUrl: "https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1", api: "openai-completions", models: ["qwen3.8-max", "qwen3.8-flash"] },
  { key: "deepseek", family: "DeepSeek", name: "官方 API", id: "deepseek", baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", models: ["deepseek-flash"] },
  { key: "minimax", family: "MiniMax", name: "国内", id: "minimax", baseUrl: "https://api.minimax.cn/v1", api: "openai-completions", models: ["MiniMax-M3.1-Flash", "MiniMax-M3"] },
  { key: "doubao", family: "火山引擎", name: "豆包 · 按量付费", id: "doubao", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", api: "openai-completions", models: ["doubao-seed-2-1-pro-260915"] },
  { key: "openrouter", family: "OpenRouter", name: "官方 API", id: "openrouter", baseUrl: "https://openrouter.ai/api", api: "anthropic-messages", models: [] },
  { key: "ollama", family: "Ollama", name: "本机", id: "ollama", baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [], keyless: true },
];
