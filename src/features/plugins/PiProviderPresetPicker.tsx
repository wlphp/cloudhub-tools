import { useState } from "react";
import { ArrowLeft, ChevronRight, Server, Settings2 } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import type { PiApi } from "../../platform/clients/piConfig";
import { AiSupplierImport } from "../ai/AiSupplierImport";
import { ProviderBrandIcon } from "../../shared/provider-brand/ProviderBrandIcon";
import { PRESET_CATEGORY_LABELS, PRESET_CATEGORY_ORDER, PresetCategoryLayout, PresetSearch, countPresetCategories, presetCategoryOf, type PresetCategory } from "../../shared/provider-brand/ProviderPresetCategories";
import { PI_PROVIDER_PRESETS, type PiProviderPreset } from "./piProviderPresets";

/** 选中预设或导入的模型供应商后生成的编辑草稿；此时尚未写入 models.json。 */
export type PiPresetSelection = { name: string; id: string; baseUrl: string; api: PiApi; apiKey: string; models: string[] };

const protocolApi: Record<string, PiApi> = {
  openai_chat: "openai-completions",
  openai_responses: "openai-responses",
  claude: "anthropic-messages",
  gemini: "google-generative-ai",
};
const hostOf = (url: string) => URL.canParse(url) ? new URL(url).hostname : url;

/** 生成符合 Pi 供应商标识规则的 ID；中文名称无法转写时回退到请求地址的主机名。 */
export function slugProviderId(name: string, baseUrl = "") {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 64);
  return slug(name) || slug(hostOf(baseUrl).replace(/^(api|www)\./, "")) || "provider";
}

const fromPreset = (item: PiProviderPreset): PiPresetSelection => ({
  name: `${item.family} · ${item.name}`, id: item.id, baseUrl: item.baseUrl, api: item.api, apiKey: "", models: item.models,
});
const presetSummary = (item: PiProviderPreset) => item.models.length ? "默认模型：" + item.models.join("、") : "模型需按账户权限手动填写";

export function PiProviderPresetPicker({ onClose, onSelect, onCustom }: {
  onClose: () => void; onSelect: (value: PiPresetSelection) => void; onCustom: () => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [family, setFamily] = useState<string | null>(null);
  const [category, setCategory] = useState<PresetCategory>("all");
  const query = keyword.trim().toLocaleLowerCase();
  const groups = [...new Set(PI_PROVIDER_PRESETS.map(item => item.family))]
    .map(name => { const variants = PI_PROVIDER_PRESETS.filter(item => item.family === name); return { name, variants, category: presetCategoryOf(name, variants[0].baseUrl) }; })
    .filter(group => group.variants.some(item => `${item.family} ${item.name} ${item.id} ${item.baseUrl}`.toLocaleLowerCase().includes(query)));
  const variants = PI_PROVIDER_PRESETS.filter(item => item.family === family);

  return <SharedDialog sizeStorageKey="features/plugins/pi-provider-preset-picker" title="添加 Pi 供应商"
    subtitle="先选择厂商或导入模型供应商，再确认 API Key 与模型；选择预设不会立即写入配置。"
    icon={<Server size={20} aria-hidden="true" />} className="claude-providers claude-preset-dialog" onClose={onClose}
    footer={<button type="button" className="secondary" onClick={onClose}>取消</button>}>
    <div className="claude-preset-browser">
      {family ? <>
        <button type="button" className="secondary claude-preset-back" onClick={() => setFamily(null)}><ArrowLeft size={14} aria-hidden="true" />返回厂商列表</button>
        <h3>{family} · 选择版本</h3>
        <div className="claude-preset-grid">{variants.map(item => <button type="button" className="claude-preset-card" key={item.key} onClick={() => onSelect(fromPreset(item))}>
          <ProviderBrandIcon name={item.family} hints={[item.id, item.baseUrl]} />
          <span className="claude-preset-details"><strong>{item.name}</strong><small>{item.baseUrl}</small><small>{presetSummary(item)}</small></span><ChevronRight size={16} aria-hidden="true" />
        </button>)}</div>
      </> : <>
        <PresetSearch value={keyword} onChange={setKeyword} label="搜索厂商预设" placeholder="搜索厂商、地区或 API 地址，例如 Kimi、智谱、DeepSeek" autoFocus />
        <PresetCategoryLayout counts={countPresetCategories(groups)} value={category} onChange={setCategory}>
        {category === "all" && <>
        <button type="button" className="claude-preset-card" onClick={onCustom}><Settings2 size={22} aria-hidden="true" /><span className="claude-preset-details"><strong>自定义配置</strong><small>手动填写请求地址、协议、API Key 与模型</small></span><ChevronRight size={16} aria-hidden="true" /></button>
        <AiSupplierImport target="pi" onImport={({ profile, apiKey }) => {
          const models = [...new Set([profile.model, ...(profile.models ?? [])].map(model => model.trim()).filter(Boolean))];
          onSelect({ name: profile.name, id: slugProviderId(profile.name, profile.baseUrl), baseUrl: profile.baseUrl,
            api: protocolApi[profile.protocol] ?? "openai-completions", apiKey, models });
        }} />
        </>}
        {PRESET_CATEGORY_ORDER.filter(key => category === "all" || category === key).map(key => {
          const items = groups.filter(group => group.category === key);
          return items.length > 0 && <section key={key} className="claude-preset-browser" aria-label={PRESET_CATEGORY_LABELS[key]}>
        <h3>{PRESET_CATEGORY_LABELS[key]} <span>{items.length} 家</span></h3>
        <div className="claude-preset-grid">{items.map(group => <button type="button" className="claude-preset-card" key={group.name}
          onClick={() => group.variants.length === 1 ? onSelect(fromPreset(group.variants[0])) : setFamily(group.name)}>
          <ProviderBrandIcon name={group.name} hints={[group.variants[0].id, group.variants[0].baseUrl]} />
          <span className="claude-preset-details"><strong>{group.name}</strong>
            <small>{hostOf(group.variants[0].baseUrl)}{group.variants.length > 1 ? ` · ${group.variants.length} 个版本` : ` · ${group.variants[0].name}`}{group.variants[0].keyless ? " · 无需 API Key" : ""}</small></span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>)}</div>
          </section>;
        })}
        {!groups.some(group => category === "all" || group.category === category) && <p role="status" className="claude-config-help">没有匹配的厂商，请换个关键词，或在“全部”中选择“自定义配置”。</p>}
        </PresetCategoryLayout>
      </>}
      <p className="claude-config-help">从模型供应商导入时会复制其地址、协议、模型和密钥，保存后在 Pi 的 models.json 中单独保存一份。默认模型以账户实际权限为准，保存前均可修改。</p>
    </div>
  </SharedDialog>;
}
