import { Clock3, RefreshCw, Wallet } from "lucide-react";
import { OverviewDialog } from "./OverviewDialogs";
import { type ProviderUsage } from "../../platform/clients/codex-providers";
import type { UsageProvider, UsageSelection } from "./ProviderUsageControl";

export function ProviderUsageDialog({ provider, selection, adapters, usage, busy, error, saveMessage, onChange, onSave, onQuery, onClose }: {
  adapters: readonly (readonly [string, string])[];
  provider: UsageProvider; selection: UsageSelection; usage: ProviderUsage | null; busy: boolean; error: string;
  saveMessage: string; onChange: (selection: UsageSelection) => void; onSave: () => void;
  onQuery: (selection: UsageSelection) => void; onClose: () => void;
}) {
  const { keyId, adapter } = selection;
  const query = () => onQuery(selection);
  return <OverviewDialog title={provider.name + " · 额度"} busy={busy} layout="form" className="codex-provider-usage-dialog" onClose={onClose} footer={<><button disabled={busy} onClick={onClose}>关闭</button><button disabled={busy || !keyId} onClick={onSave}>保存</button><button className="primary" disabled={busy || !keyId} onClick={() => void query()}><RefreshCw size={14} aria-hidden="true" className={busy ? "codex-refresh-spinning" : ""} />{busy ? "处理中..." : "查询额度"}</button></>}>
    <div className="codex-provider-form codex-usage-content">
      <div className="codex-usage-fields">
      <label>密钥<select disabled={busy} value={keyId} onChange={e => onChange({ ...selection, keyId: e.target.value })}>{provider.keys.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <label>额度适配<select disabled={busy} value={adapter} onChange={e => onChange({ ...selection, adapter: e.target.value })}>{adapters.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      </div>
      <p className="codex-usage-hint">点击查询获取额度；保存后，列表刷新默认使用此类型和密钥。</p>
      {saveMessage && <p role="status" className="codex-usage-hint">{saveMessage}</p>}
      {error && <p role="alert" className="codex-card-error">{error}</p>}
      <div className="codex-usage-result" aria-busy={busy}>
        {usage ? <>
          <dl className="codex-usage-balances">{usage.windows.map((window, index) => <div className="codex-usage-balance" key={index}>
            <dt><Wallet size={15} aria-hidden="true" />{window.name}</dt>
            <dd><strong>{window.remaining.toLocaleString()}</strong>{" "}<span>{window.unit}</span></dd>
            {(window.total != null || window.resetsAt) && <div className="codex-usage-details">{window.total != null && <span>总额度 {window.total.toLocaleString()} {window.unit}</span>}{window.resetsAt && <span>重置于 {new Date(window.resetsAt * 1000).toLocaleString()}</span>}</div>}
          </div>)}</dl>
          <div className="codex-usage-updated"><Clock3 size={12} aria-hidden="true" /><span>{busy ? "正在更新额度…" : error ? "刷新失败，显示上次结果" : "更新于 " + new Date(usage.fetchedAt).toLocaleString()}</span></div>
        </> : <div className="codex-usage-empty" role="status"><Wallet size={24} aria-hidden="true" /><strong>{busy ? "正在查询额度…" : "当前额度未知"}</strong><span>{busy ? "正在获取最新可用额度" : "选择平台和密钥后查询可用额度"}</span></div>}
      </div>
      {adapter === "new_api" && <p className="codex-usage-hint">额度按站点提供的单位展示；无限令牌额度不代表账户余额。</p>}
      {adapter === "one_api" && <p className="codex-usage-hint">额度单位以站点设置为准。</p>}
    </div>
  </OverviewDialog>;
}
