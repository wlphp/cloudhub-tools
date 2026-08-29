import type { ReactNode } from "react";
import { Cloud, Database, Download, FolderOpen, Globe2, List, Monitor, Terminal } from "lucide-react";

type SettingsPageProps = {
  autoRefresh: boolean;
  compactMode: boolean;
  pageSize: number;
  updateSummary: ReactNode;
  updateAction: ReactNode;
  onAutoRefreshChange: (value: boolean) => void;
  onCompactModeChange: (value: boolean) => void;
  onPageSizeChange: (value: number) => void;
  onOpenDataDirectory: () => void;
};

export function SettingsPage({ autoRefresh, compactMode, pageSize, updateSummary, updateAction, onAutoRefreshChange, onCompactModeChange, onPageSizeChange, onOpenDataDirectory }: SettingsPageProps) {
  return <section className="utility-page"><header><div><span className="eyebrow">LOCAL PREFERENCES</span><h1>系统设置</h1><p>管理本地客户端的显示和数据行为。</p></div></header><section className="settings-grid"><div className="settings-card"><div className="settings-icon blue"><Database size={22} /></div><div className="settings-copy"><strong>本地模式</strong><small>所有账号密钥和资产保存在本机 SQLite</small></div><span className="setting-state on">✓ 已启用</span></div><div className="settings-card"><div className="settings-icon cyan"><Cloud size={22} /></div><div className="settings-copy"><strong>自动刷新资产</strong><small>进入资源管理时读取本地缓存，不主动上传数据</small></div><label className="setting-switch"><input type="checkbox" checked={autoRefresh} onChange={(event) => onAutoRefreshChange(event.target.checked)} /><span /></label></div><div className="settings-card"><div className="settings-icon purple"><Monitor size={22} /></div><div className="settings-copy"><strong>紧凑显示</strong><small>减少表格行高，适合小窗口查看</small></div><label className="setting-switch"><input type="checkbox" checked={compactMode} onChange={(event) => onCompactModeChange(event.target.checked)} /><span /></label></div><div className="settings-card"><div className="settings-icon blue"><List size={22} /></div><div className="settings-copy"><strong>每页显示条数</strong><small>账号、资源和操作日志列表统一使用此分页大小</small></div><select className="settings-select" value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}><option value={10}>10 条</option><option value={20}>20 条</option><option value={50}>50 条</option><option value={100}>100 条</option></select></div><div className="settings-card"><div className="settings-icon purple"><Database size={22} /></div><div className="settings-copy"><strong>数据库位置</strong><small>系统应用数据目录 / CloudHubTools / cloudhub_tools.sqlite3</small></div><button className="secondary settings-link" onClick={onOpenDataDirectory}><FolderOpen size={16} />打开目录</button></div><div className="settings-card"><div className="settings-icon green"><Globe2 size={22} /></div><div className="settings-copy"><strong>作者网站</strong><small>https://www.wlphp.com</small></div><a className="secondary settings-link" href="https://www.wlphp.com" target="_blank" rel="noreferrer">访问网站 ↗</a></div><div className="settings-card"><div className="settings-icon blue"><Download size={22} /></div><div className="settings-copy"><strong>客户端更新</strong><small>{updateSummary}</small></div><div className="settings-update-actions">{updateAction}</div></div><div className="settings-card"><div className="settings-icon amber"><Terminal size={22} /></div><div className="settings-copy"><strong>GitHub 开源仓库</strong><small>https://github.com/wlphp/cloudhub-tools</small></div><a className="secondary settings-link" href="https://github.com/wlphp/cloudhub-tools" target="_blank" rel="noreferrer">访问仓库 ↗</a></div></section></section>;
}
