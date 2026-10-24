import { useState } from "react";
import { ArrowLeft, ChevronRight, Search, Server, Settings2 } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import type { ClaudeProviderInput } from "../../platform/clients/claudeProviders";
import { PROVIDER_PRESETS, presetToInput } from "./claudeProviderPresets";

export function ClaudeProviderPresetPicker({ onClose, onSelect, onCustom }: { onClose: () => void; onSelect: (value: ClaudeProviderInput) => void; onCustom: () => void }) {
  const [keyword, setKeyword] = useState("");
  const [family, setFamily] = useState<string | null>(null);
  const query = keyword.trim().toLocaleLowerCase();
  const groups = [...new Set(PROVIDER_PRESETS.map(item => item.family))].map(name => ({ name, variants: PROVIDER_PRESETS.filter(item => item.family === name) }))
    .filter(group => group.variants.some(item => `${item.family} ${item.name} ${item.website} ${item.baseUrl}`.toLocaleLowerCase().includes(query)));
  const variants = PROVIDER_PRESETS.filter(item => item.family === family);
  return <SharedDialog title="添加供应商" subtitle="先选择厂商及版本，再填写 API Key；选择预设不会立即写入配置。" icon={<Server size={20} aria-hidden="true" />} className="claude-providers claude-preset-dialog" onClose={onClose} footer={<button type="button" className="secondary" onClick={onClose}>取消</button>}>
    <div className="claude-preset-browser">
      {family ? <>
        <button type="button" className="secondary claude-preset-back" onClick={() => setFamily(null)}><ArrowLeft size={14} aria-hidden="true" />返回厂商列表</button>
        <h3>{family} · 选择版本</h3>
        <div className="claude-preset-grid">{variants.map(item => <button type="button" className="claude-preset-card" key={item.id} onClick={() => onSelect(presetToInput(item))}>
          <span className="claude-preset-details"><strong>{item.name}</strong><small>{item.baseUrl}</small><small>{item.model ? "默认模型：" + item.model : "模型需按套餐手动填写或获取"}</small></span><ChevronRight size={16} aria-hidden="true" />
        </button>)}</div>
      </> : <>
        <label className="claude-preset-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="搜索厂商预设" placeholder="搜索厂商、地区、套餐或 API 地址，例如 Kimi、智谱、MiniMax" value={keyword} onChange={event => setKeyword(event.target.value)} autoFocus /></label>
        <button type="button" className="claude-preset-card" onClick={onCustom}><Settings2 size={22} aria-hidden="true" /><span className="claude-preset-details"><strong>自定义配置</strong><small>手动填写请求地址、协议和 API Key</small></span><ChevronRight size={16} aria-hidden="true" /></button>
        <h3>账号登录</h3>
        <div className="claude-preset-grid"><button type="button" className="claude-preset-card" onClick={() => onSelect({ id: "", name: "Claude 官方", baseUrl: "https://api.anthropic.com", websiteUrl: "https://www.anthropic.com/claude-code", officialLogin: true, apiKey: "", apiKeyField: "auth_token", apiFormat: "anthropic", isFullUrl: true, models: {}, extraEnv: {}, modelCatalog: [] })}><Server size={22} aria-hidden="true" /><span className="claude-preset-details"><strong>Claude Official</strong><small>使用已有 Claude 登录状态，不在此进行登录</small></span><ChevronRight size={16} aria-hidden="true" /></button></div>
        <h3>模型厂商 <span>{groups.length} 家</span></h3>
        <div className="claude-preset-grid">{groups.map(group => <button type="button" className="claude-preset-card" key={group.name} onClick={() => group.variants.length === 1 ? onSelect(presetToInput(group.variants[0])) : setFamily(group.name)}>
          <Server size={22} aria-hidden="true" /><span className="claude-preset-details"><strong>{group.name}</strong><small>{new URL(group.variants[0].website).hostname}{group.variants.length > 1 ? ` · ${group.variants.length} 个版本` : ""}</small></span><ChevronRight size={16} aria-hidden="true" />
        </button>)}</div>
        {!groups.length && <p role="status" className="claude-config-help">没有匹配的厂商，请换个关键词，或选择上方“自定义配置”。</p>}
      </>}
      <p className="claude-config-help">云枢工具箱内置厂商预设。默认模型需以账户实际权限为准，保存前均可修改。不包含尚未接入的第三方账号登录。</p>
    </div>
  </SharedDialog>;
}
