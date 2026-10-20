import { FileText, FolderOpen, Play, Server, SlidersHorizontal } from "lucide-react";
import { OverviewDialog } from "./OverviewDialogs";
import type { OverviewPreferences } from "./overviewPreferences";

export function CodexSettingsDialog({ preferences, busy, canOpenDefault, onClose, onSave, onOpenGroups, onOpenLogs, onOpenApi, onStartCodex }: {
  preferences: OverviewPreferences;
  busy: boolean;
  canOpenDefault: boolean;
  onClose: () => void;
  onSave: (preferences: OverviewPreferences) => void;
  onOpenGroups: () => void;
  onOpenLogs: () => void;
  onOpenApi: () => void;
  onStartCodex: () => void;
}) {
  const update = (patch: Partial<OverviewPreferences>) => onSave({ ...preferences, ...patch });
  return <OverviewDialog title="Codex 设置" busy={busy} onClose={onClose} className="codex-settings-dialog">
    <section className="codex-settings-section">
      <div className="codex-settings-heading"><SlidersHorizontal size={16} /><h3>账号总览</h3></div>
      <label className="codex-settings-switch"><span><strong>显示 API 服务入口</strong><small>控制账号总览中的 API 服务卡片显示，不会停止本地 API 服务。</small></span><input type="checkbox" role="switch" aria-label="显示 API 服务入口" checked={preferences.showServiceEntry} disabled={busy} onChange={event => update({ showServiceEntry: event.target.checked })} /></label>
      <label className="codex-settings-switch"><span><strong>紧凑账号卡片</strong><small>减少卡片内边距与额度区间距，在账号较多时显示更多内容。</small></span><input type="checkbox" role="switch" aria-label="紧凑卡片" checked={preferences.compact} disabled={busy} onChange={event => update({ compact: event.target.checked })} /></label>
      <label className="codex-settings-select"><span><strong>默认账号视图</strong><small>选择卡片、列表或表格布局；也可以直接使用工具栏上的视图按钮切换。</small></span><select aria-label="默认账号视图" value={preferences.view} disabled={busy} onChange={event => update({ view: event.target.value as OverviewPreferences["view"] })}><option value="grid">卡片视图</option><option value="list">列表视图</option><option value="table">表格视图</option></select></label>
      <button className="codex-settings-link" disabled={busy} onClick={onOpenGroups}><FolderOpen size={16} />管理账号分组</button>
    </section>
    <section className="codex-settings-section">
      <div className="codex-settings-heading"><Server size={16} /><h3>API 服务</h3></div>
      <p>服务运行状态、账号池、模型目录与远端请求记录可在对应页面配置。</p>
      <div className="codex-settings-actions"><button disabled={busy} onClick={onOpenApi}><Server size={15} />打开 API 服务设置</button><button disabled={busy} onClick={onOpenLogs}><FileText size={15} />远端请求与正文日志</button></div>
    </section>
    <section className="codex-settings-section">
      <div className="codex-settings-heading"><Play size={16} /><h3>客户端</h3></div>
      <p>打开本机默认 Codex 桌面客户端。登录、实例和客户端模型配置在各自的管理流程中完成。</p>
      <button disabled={busy || !canOpenDefault} title={canOpenDefault ? "打开默认 Codex 桌面客户端" : "当前环境无法定位默认 Codex 客户端"} onClick={onStartCodex}><Play size={15} />启动 Codex</button>
    </section>
  </OverviewDialog>;
}
