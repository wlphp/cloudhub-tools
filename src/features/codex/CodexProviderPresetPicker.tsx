import { useState } from "react";
import { ChevronRight, Server, Settings2 } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import type { ProviderInput } from "../../platform/clients/codex-providers";
import { AiSupplierImport } from "../ai/AiSupplierImport";
import { ProviderBrandIcon } from "../../shared/provider-brand/ProviderBrandIcon";
import { PRESET_CATEGORY_LABELS, PRESET_CATEGORY_ORDER, PresetCategoryLayout, PresetSearch, countPresetCategories, presetCategoryOf, type PresetCategory } from "../../shared/provider-brand/ProviderPresetCategories";
import "../plugins/claude-providers.css";

// 仅包含公开接口地址；模型目录由用户使用自己的密钥获取或手动填写。
const CODEX_PROVIDER_PRESETS: { name: string; baseUrl: string; wireApi: ProviderInput["wireApi"] }[] = [
  { name: "OpenAI API", baseUrl: "https://api.openai.com/v1", wireApi: "responses" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com", wireApi: "responses" },
  { name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", wireApi: "chat_completions" },
  { name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", wireApi: "chat_completions" },
  { name: "阿里云百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", wireApi: "chat_completions" },
  { name: "MiniMax 国内", baseUrl: "https://api.minimaxi.com/v1", wireApi: "chat_completions" },
  { name: "MiniMax 国际", baseUrl: "https://api.minimax.io/v1", wireApi: "chat_completions" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", wireApi: "chat_completions" },
  { name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", wireApi: "chat_completions" },
];

const hostOf = (url: string) => URL.canParse(url) ? new URL(url).hostname : url;
const wireLabel = (wireApi: ProviderInput["wireApi"]) => wireApi === "responses" ? "Responses API" : "Chat Completions";

/** Codex 添加供应商入口：选择预设或导入模型供应商后生成编辑草稿，此时尚未保存。 */
export function CodexProviderPresetPicker({ base, onClose, onSelect, onCustom }: {
  base: ProviderInput; onClose: () => void; onSelect: (value: ProviderInput) => void; onCustom: () => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState<PresetCategory>("all");
  const query = keyword.trim().toLocaleLowerCase();
  const items = CODEX_PROVIDER_PRESETS
    .map(item => ({ ...item, category: presetCategoryOf(item.name, item.baseUrl) }))
    .filter(item => `${item.name} ${item.baseUrl}`.toLocaleLowerCase().includes(query));

  return <SharedDialog sizeStorageKey="features/codex/provider-preset-picker" title="添加 Codex 供应商"
    subtitle="先选择厂商或导入模型供应商，再确认 API Key 与模型；选择预设不会立即保存。"
    icon={<Server size={20} aria-hidden="true" />} className="claude-providers claude-preset-dialog" onClose={onClose}
    footer={<button type="button" className="secondary" onClick={onClose}>取消</button>}>
    <div className="claude-preset-browser">
      <PresetSearch value={keyword} onChange={setKeyword} label="搜索厂商预设" placeholder="搜索厂商或 API 地址，例如 Kimi、智谱、DeepSeek" autoFocus />
      <PresetCategoryLayout counts={countPresetCategories(items)} value={category} onChange={setCategory}>
        {category === "all" && <>
          <button type="button" className="claude-preset-card" onClick={onCustom}><Settings2 size={22} aria-hidden="true" /><span className="claude-preset-details"><strong>自定义配置</strong><small>手动填写请求地址、接入模式、API Key 与模型</small></span><ChevronRight size={16} aria-hidden="true" /></button>
          <AiSupplierImport target="codex" onImport={({ profile, apiKey }) => {
            const models = [...new Set([profile.model, ...(profile.models ?? [])].map(model => model.trim()).filter(Boolean))];
            const first = base.keys[0];
            onSelect({ ...base, name: profile.name, baseUrl: profile.baseUrl, wireApi: profile.protocol === "openai_responses" ? "responses" : "chat_completions", models,
              settings: { ...base.settings, defaultModel: profile.model || models[0] || null },
              keys: [{ ...first, name: "导入密钥", secret: apiKey, settings: { ...first?.settings, models, modelsScoped: true } }] });
          }} />
        </>}
        {PRESET_CATEGORY_ORDER.filter(key => category === "all" || category === key).map(key => {
          const matches = items.filter(item => item.category === key);
          return matches.length > 0 && <section key={key} className="claude-preset-browser" aria-label={PRESET_CATEGORY_LABELS[key]}>
            <h3>{PRESET_CATEGORY_LABELS[key]} <span>{matches.length} 家</span></h3>
            <div className="claude-preset-grid">{matches.map(item => <button type="button" className="claude-preset-card" key={item.name}
              onClick={() => onSelect({ ...base, name: item.name, baseUrl: item.baseUrl, wireApi: item.wireApi })}>
              <ProviderBrandIcon name={item.name} hints={[item.baseUrl]} />
              <span className="claude-preset-details"><strong>{item.name}</strong><small>{hostOf(item.baseUrl)} · {wireLabel(item.wireApi)}</small></span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>)}</div>
          </section>;
        })}
        {!items.some(item => category === "all" || item.category === category) && <p role="status" className="claude-config-help">没有匹配的厂商，请换个关键词，或在“全部”中选择“自定义配置”。</p>}
      </PresetCategoryLayout>
    </div>
    <p className="claude-config-help">模板只填入名称、地址和接入模式；模型请用自己的密钥获取或手动填写。从模型供应商导入时会复制地址、协议、模型和密钥，保存前均可修改。</p>
  </SharedDialog>;
}
