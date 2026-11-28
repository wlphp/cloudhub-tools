import { useState } from "react";
import { ArrowLeft, ChevronRight, Server, Settings2 } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import type { AiProfileInput } from "../../platform/clients/ai";
import { ProviderBrandIcon } from "../../shared/provider-brand/ProviderBrandIcon";
import {
  PRESET_CATEGORY_LABELS,
  PRESET_CATEGORY_ORDER,
  PresetCategoryLayout,
  PresetSearch,
  countPresetCategories,
  presetCategoryOf,
  type PresetCategory,
} from "../../shared/provider-brand/ProviderPresetCategories";
import { AI_PROTOCOL_SHORT_LABELS, AI_PROVIDER_PRESETS, presetToAiProfileInput } from "./aiProviderPresets";
import "../plugins/claude-providers.css";

const allGroups = [...new Set(AI_PROVIDER_PRESETS.map(item => item.family))].map(name => {
  const variants = AI_PROVIDER_PRESETS.filter(item => item.family === name);
  return { name, variants, category: presetCategoryOf(name, variants[0].baseUrl) };
});

const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).hostname : url);

export function AiProviderPresetPicker({
  base,
  onClose,
  onSelect,
  onCustom,
}: {
  base: AiProfileInput;
  onClose: () => void;
  onSelect: (value: AiProfileInput) => void;
  onCustom: () => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [family, setFamily] = useState<string | null>(null);
  const [category, setCategory] = useState<PresetCategory>("all");

  const query = keyword.trim().toLocaleLowerCase();
  const groups = allGroups.filter(group =>
    group.variants.some(item =>
      `${item.family} ${item.name} ${item.website} ${item.baseUrl} ${AI_PROTOCOL_SHORT_LABELS[item.protocol]}`
        .toLocaleLowerCase()
        .includes(query),
    ),
  );
  const counts = countPresetCategories(groups);
  const shows = (key: PresetCategory) => category === "all" || category === key;
  const variants = AI_PROVIDER_PRESETS.filter(item => item.family === family);
  const hasResults = groups.some(group => shows(group.category));

  return (
    <SharedDialog
      sizeStorageKey="features/ai/ai-provider-preset-picker/ai-provider-preset-picker"
      title="添加模型供应商"
      subtitle="先选择厂商及版本，再填写 API Key；选择预设不会立即保存。"
      icon={<Server size={20} aria-hidden="true" />}
      className="claude-providers claude-preset-dialog"
      onClose={onClose}
      footer={
        <button type="button" className="secondary" onClick={onClose}>
          取消
        </button>
      }
    >
      <div className="claude-preset-browser">
        {family ? (
          <>
            <button type="button" className="secondary claude-preset-back" onClick={() => setFamily(null)}>
              <ArrowLeft size={14} aria-hidden="true" />
              返回厂商列表
            </button>
            <h3>{family} · 选择版本</h3>
            <div className="claude-preset-grid">
              {variants.map(item => (
                <button
                  type="button"
                  className="claude-preset-card"
                  key={item.id}
                  onClick={() => onSelect(presetToAiProfileInput(item, base))}
                >
                  <ProviderBrandIcon name={item.family} hints={[item.website, item.baseUrl]} />
                  <span className="claude-preset-details">
                    <strong>{item.name}</strong>
                    <small>{item.baseUrl}</small>
                    <small>
                      {AI_PROTOCOL_SHORT_LABELS[item.protocol]}
                      {item.model ? ` · 默认模型：${item.model}` : " · 下一步可获取或手动填写模型"}
                    </small>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <PresetSearch
              value={keyword}
              onChange={setKeyword}
              label="搜索厂商预设"
              placeholder="搜索厂商、地区、套餐或 API 地址，例如 OpenAI、DeepSeek、Kimi、智谱"
              autoFocus
            />
            <PresetCategoryLayout counts={counts} value={category} onChange={setCategory}>
              {category === "all" && (
                <button type="button" className="claude-preset-card" onClick={onCustom}>
                  <Settings2 size={22} aria-hidden="true" />
                  <span className="claude-preset-details">
                    <strong>自定义配置</strong>
                    <small>手动填写请求地址、协议和 API Key</small>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              )}
              {PRESET_CATEGORY_ORDER.filter(key => key !== "login" && shows(key)).map(key => {
                const items = groups.filter(group => group.category === key);
                return (
                  items.length > 0 && (
                    <section key={key} className="claude-preset-browser" aria-label={PRESET_CATEGORY_LABELS[key]}>
                      <h3>
                        {PRESET_CATEGORY_LABELS[key]} <span>{items.length} 家</span>
                      </h3>
                      <div className="claude-preset-grid">
                        {items.map(group => (
                          <button
                            type="button"
                            className="claude-preset-card"
                            key={group.name}
                            onClick={() =>
                              group.variants.length === 1
                                ? onSelect(presetToAiProfileInput(group.variants[0], base))
                                : setFamily(group.name)
                            }
                          >
                            <ProviderBrandIcon
                              name={group.name}
                              hints={[group.variants[0].website, group.variants[0].baseUrl]}
                            />
                            <span className="claude-preset-details">
                              <strong>{group.name}</strong>
                              <small>
                                {hostOf(group.variants[0].website)}
                                {group.variants.length > 1
                                  ? ` · ${group.variants.length} 个版本`
                                  : ` · ${AI_PROTOCOL_SHORT_LABELS[group.variants[0].protocol]}`}
                              </small>
                            </span>
                            <ChevronRight size={16} aria-hidden="true" />
                          </button>
                        ))}
                      </div>
                    </section>
                  )
                );
              })}
              {!hasResults && (
                <p role="status" className="claude-config-help">
                  没有匹配的厂商，请换个关键词，或在“全部”中选择“自定义配置”。
                </p>
              )}
            </PresetCategoryLayout>
          </>
        )}
        <p className="claude-config-help">
          云枢工具箱内置厂商预设。选择后可在下一步填写 API Key、获取模型列表或调整配置，保存前不会写入。
        </p>
      </div>
    </SharedDialog>
  );
}
