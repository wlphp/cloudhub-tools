import type { ReactNode } from "react";
import { Search } from "lucide-react";
import "./provider-preset.css";

// 供应商预设的公共分类栏与搜索框，Claude / Pi / Codex 预设选择器共用，避免各自拼装导致外观漂移。
export type PresetCategory = "all" | "login" | "vendor" | "platform" | "cloud" | "local";
export type PresetCategoryCounts = Partial<Record<Exclude<PresetCategory, "all">, number>>;

export const PRESET_CATEGORY_ORDER: Exclude<PresetCategory, "all">[] = ["login", "vendor", "platform", "cloud", "local"];
export const PRESET_CATEGORY_LABELS: Record<PresetCategory, string> = {
  all: "全部", login: "账号登录", vendor: "模型厂商", platform: "第三方平台", cloud: "云服务商", local: "本地",
};

const platformPattern = /openrouter|siliconflow|硅基|aihubmix|302\.ai|together|groq|fireworks|novita|ppio|modelscope|魔搭|聚合|中转/i;
const cloudPattern = /azure|bedrock|vertex|aws|google cloud/i;
const localHostPattern = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

/** 按名称与地址归类；只做展示分组，不参与任何请求或密钥处理。 */
export function presetCategoryOf(name: string, baseUrl = ""): Exclude<PresetCategory, "all" | "login"> {
  if (localHostPattern.test(baseUrl) || /ollama|lm studio|llama\.cpp|vllm/i.test(name)) return "local";
  if (platformPattern.test(name) || platformPattern.test(baseUrl)) return "platform";
  if (cloudPattern.test(name)) return "cloud";
  return "vendor";
}

export function countPresetCategories(items: { category: Exclude<PresetCategory, "all"> }[], extra: PresetCategoryCounts = {}): PresetCategoryCounts {
  const counts: PresetCategoryCounts = { ...extra };
  for (const item of items) counts[item.category] = (counts[item.category] ?? 0) + 1;
  return counts;
}

export function PresetSearch({ value, onChange, placeholder, label = "搜索供应商预设", disabled, autoFocus }: { value: string; onChange: (value: string) => void; placeholder: string; label?: string; disabled?: boolean; autoFocus?: boolean }) {
  return <label className="provider-preset-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label={label} placeholder={placeholder} value={value} disabled={disabled} autoFocus={autoFocus} onChange={event => onChange(event.target.value)} /></label>;
}

export function PresetCategoryLayout({ counts, value, onChange, children }: { counts: PresetCategoryCounts; value: PresetCategory; onChange: (value: PresetCategory) => void; children: ReactNode }) {
  const total = PRESET_CATEGORY_ORDER.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  const visible = PRESET_CATEGORY_ORDER.filter(key => (counts[key] ?? 0) > 0 || key === value);
  return <div className="provider-preset-layout">
    <nav className="provider-preset-nav" aria-label="供应商分类">
      {(["all", ...visible] as PresetCategory[]).map(key => <button type="button" key={key} className={key === value ? "is-active" : ""} aria-pressed={key === value} onClick={() => onChange(key)}>
        <span>{PRESET_CATEGORY_LABELS[key]}</span><small>{key === "all" ? total : counts[key] ?? 0}</small>
      </button>)}
    </nav>
    <div className="provider-preset-content">{children}</div>
  </div>;
}
