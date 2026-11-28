import { useId, useMemo, type ReactNode } from "react";
import "./provider-brand.css";

// 打包内置的 LobeHub 静态 SVG（MIT，见 assets/lobehub-LICENSE.md），运行时不请求外部资源。
const assets = import.meta.glob<string>("./assets/*.svg", { query: "?raw", import: "default", eager: true });
const svgOf = (file: string) => assets[`./assets/${file}.svg`];

/** 匹配规则按顺序生效：更具体的品牌放前面，避免被宽泛关键词提前命中。 */
const rules: [RegExp, string][] = [
  [/github\s*copilot|copilot/, "githubcopilot"],
  [/claude|anthropic/, "claude-color"],
  [/openai|chatgpt|\bgpt(?:[-_ ]?\d|\b)/, "openai"],
  [/deepseek/, "deepseek-color"],
  [/kimi|moonshot|月之暗面/, "kimi-color"],
  [/智谱|zhipu|bigmodel|chatglm|\bglm\b/, "zhipu-color"],
  [/百炼|bailian/, "bailian-color"],
  [/千问|通义|qwen|qianwen|dashscope/, "qwen-color"],
  [/minimax/, "minimax-color"],
  [/商汤|日日新|sensenova|sensetime/, "sensenova-color"],
  [/nvidia|\bnim\b/, "nvidia-color"],
  [/opencode/, "opencode"],
  [/kwaikat|快手|kat[-_ ]?coder/, "kwaikat"],
  [/阶跃|stepfun/, "stepfun-color"],
  [/火山|volcengine|volces/, "volcengine-color"],
  [/豆包|doubao/, "doubao-color"],
  [/byteplus|bytedance|字节/, "bytedance-color"],
  [/文心|wenxin|ernie/, "wenxin-color"],
  [/百度|baidu|千帆|qianfan/, "baidu-color"],
  [/混元|hunyuan/, "hunyuan-color"],
  [/腾讯|tencent/, "tencentcloud-color"],
  [/xiaomi|小米|mimo/, "xiaomimimo"],
  [/longcat/, "longcat-color"],
  [/百灵|bailing|ant-ling/, "ling-color"],
  [/万擎|streamlake/, "streamlake-color"],
  [/魔搭|modelscope/, "modelscope-color"],
  [/模力方舟|gitee\s*ai|giteeai|ai\.gitee/, "giteeai"],
  [/openrouter/, "openrouter-color"],
  [/silicon|硅基/, "siliconcloud-color"],
  [/ollama/, "ollama"],
  [/lm\s*studio/, "lmstudio"],
  [/\bvllm\b/, "vllm-color"],
  [/open\s*webui|openwebui/, "openwebui"],
  [/new\s*api|newapi/, "newapi-color"],
  [/grok|\bx\.ai\b|\bxai\b/, "xai"],
  [/mistral/, "mistral-color"],
  [/\bmeta\b|llama/, "meta-color"],
  [/讯飞|星火|xfyun|iflytek|astron|spark/, "spark-color"],
  [/vertex\s*ai|vertexai/, "vertexai-color"],
  [/gemini|google|generativelanguage/, "gemini-color"],
  [/bedrock|amazonaws/, "bedrock-color"],
  [/azure/, "azure-color"],
  [/cloudflare/, "cloudflare-color"],
  [/perplexity|pplx/, "perplexity-color"],
  [/cohere/, "cohere-color"],
  [/hugging\s*face|huggingface|\bhf\.co\b/, "huggingface-color"],
  [/cerebras/, "cerebras-color"],
  [/sambanova/, "sambanova-color"],
  [/\bpoe\b|poe\.com/, "poe"],
  [/aihubmix/, "aihubmix-color"],
  [/zenmux/, "zenmux"],
  [/novita/, "novita-color"],
  [/together/, "together-color"],
  [/groq/, "groq"],
  [/fireworks/, "fireworks-color"],
  [/阿里|alibaba|aliyun/, "alibabacloud-color"],
];

const match = (text?: string) => {
  const value = text?.toLocaleLowerCase();
  return value ? rules.find(([pattern]) => pattern.test(value))?.[1] : undefined;
};

/** 按名称优先、地址兜底识别品牌；只匹配名称避免 “火山引擎 · 豆包” 之类被套餐名误判。 */
export function providerBrandKey(name: string, ...hints: (string | undefined)[]) {
  for (const text of [name, ...hints]) {
    const key = match(text);
    if (key && svgOf(key)) return key;
  }
  return undefined;
}

export function ProviderBrandIcon({ name, hints = [], fallback, className = "" }: {
  name: string; hints?: (string | undefined)[]; fallback?: ReactNode; className?: string;
}) {
  const key = providerBrandKey(name, ...hints);
  // 同一图标可能在列表中多次出现，渐变/遮罩 ID 必须按实例唯一，否则后续实例引用到前一个节点。
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const html = useMemo(() => key ? svgOf(key).replace(/_R_0_/g, `-${uid}`) : "", [key, uid]);
  return <span className={`provider-brand-icon${key ? "" : " is-fallback"} ${className}`.trim()} aria-hidden="true"
    {...(key ? { dangerouslySetInnerHTML: { __html: html } } : { children: fallback ?? name.trim().slice(0, 1).toUpperCase() })} />;
}
