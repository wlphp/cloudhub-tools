import type { ChangeEvent, PointerEvent, RefObject } from "react";
import { Building2, ChevronDown, ChevronUp, Download, GripVertical, List, Monitor, MoreVertical, Plus, RefreshCw, Search, Server, Settings, Trash2, Upload, UserRound } from "lucide-react";
import type { ManagedHost } from "../../shared/types";

type TerminalHostSidebarProps = {
  hosts: ManagedHost[];
  visibleHosts: ManagedHost[];
  groups: string[];
  selectedHostId: number | null;
  keyword: string;
  group: string;
  sorting: boolean;
  draggedHostId: number | null;
  draggedGroup: string | null;
  collapsedGroups: Set<string>;
  moreId: number | null;
  loadingId: number | null;
  importing: boolean;
  importInputRef: RefObject<HTMLInputElement | null>;
  onExport: () => void;
  onImport: (file: File) => void;
  onRefresh: () => void;
  onGroupChange: (value: string) => void;
  onSortingChange: (value: boolean) => void;
  onKeywordChange: (value: string) => void;
  onAdd: () => void;
  onToggleGroup: (group: string) => void;
  onStartGroupDrag: (event: PointerEvent<HTMLButtonElement>, group: string) => void;
  onStartHostDrag: (event: PointerEvent<HTMLButtonElement>, id: number) => void;
  onOpenHost: (host: ManagedHost) => void;
  onToggleMore: (id: number) => void;
  onEdit: (host: ManagedHost) => void;
  onProbe: (host: ManagedHost) => void;
  onDelete: (host: ManagedHost) => void;
};

export function TerminalHostSidebar({ hosts, visibleHosts, groups, selectedHostId, keyword, group, sorting, draggedHostId, draggedGroup, collapsedGroups, moreId, loadingId, importing, importInputRef, onExport, onImport, onRefresh, onGroupChange, onSortingChange, onKeywordChange, onAdd, onToggleGroup, onStartGroupDrag, onStartHostDrag, onOpenHost, onToggleMore, onEdit, onProbe, onDelete }: TerminalHostSidebarProps) {
  const handleImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (file) onImport(file);
  };
  return <aside className="terminal-host-sidebar" aria-label="服务器列表">
    <div className="terminal-host-header"><div className="terminal-host-heading"><Server size={16} /><strong>服务器</strong><span>{visibleHosts.length}</span></div><div className="terminal-host-actions"><button type="button" className="terminal-toolbar-action" title="导出全部服务器（明文 JSON）" aria-label="导出服务器" disabled={!hosts.length} onClick={onExport}><Download size={15} />导出</button><label className="terminal-toolbar-action terminal-import-button" title="导入服务器 JSON"><Upload size={15} />{importing ? "导入中" : "导入"}<input ref={importInputRef} type="file" accept="application/json,.json" disabled={importing} onChange={handleImport} /></label><button type="button" className="terminal-toolbar-action" title="刷新服务器状态" aria-label="刷新服务器" onClick={onRefresh}><RefreshCw size={16} />刷新</button></div></div>
    <div className="terminal-group-title"><span><List size={15} />分组</span><div className="terminal-group-controls"><select aria-label="服务器分组" value={group} disabled={sorting} onChange={(event) => onGroupChange(event.target.value)}><option value="">全部分组</option>{groups.map((item) => <option key={item} value={item}>{item}</option>)}</select><button type="button" className={sorting ? "is-sorting" : ""} onClick={() => onSortingChange(!sorting)}><GripVertical size={14} />{sorting ? "退出排序" : "排序"}</button></div></div>
    <div className="terminal-host-filter"><label className="terminal-host-search"><Search size={15} /><input value={keyword} onChange={(event) => onKeywordChange(event.target.value)} placeholder="搜索服务器 IP / 名称" /></label><button type="button" className="terminal-add-host" onClick={onAdd}><Plus size={16} />添加服务器</button></div>
    <div className="terminal-host-tree">{groups.map((item) => {
      const groupHosts = visibleHosts.filter((host) => (host.group_name || "未分组") === item);
      if (!groupHosts.length) return null;
      const collapsed = !sorting && collapsedGroups.has(item);
      const personalGroup = /个人|默认/.test(item);
      return <section className={`terminal-host-group${draggedGroup === item ? " is-dragging" : ""}${collapsed ? " is-collapsed" : ""}`} key={item} data-managed-host-group={item}><div className="terminal-host-group-head">{sorting ? <button type="button" className="terminal-group-drag-handle" title="拖动分组排序" aria-label={`拖动分组排序 ${item}`} onPointerDown={(event) => onStartGroupDrag(event, item)}><GripVertical size={15} /></button> : personalGroup ? <UserRound size={18} /> : <Building2 size={18} />}<button type="button" className="terminal-host-group-toggle" disabled={sorting} onClick={() => onToggleGroup(item)}><strong>{item}</strong><span>{groupHosts.length}</span>{collapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}</button></div>{!collapsed && groupHosts.map((host) => <article className={`terminal-host-card${selectedHostId === host.id ? " active" : ""}${sorting ? " is-sorting" : ""}${draggedHostId === host.id ? " is-dragging" : ""}`} key={host.id} data-managed-host-id={host.id}>{sorting && <button type="button" className="terminal-host-drag-handle" title="拖动排序" aria-label={`拖动排序 ${host.name}`} onPointerDown={(event) => onStartHostDrag(event, host.id)}><GripVertical size={16} /></button>}<button type="button" className="terminal-host-card-main" title={host.platform === "windows" ? "打开 Windows 远程桌面" : "打开 SSH 终端"} disabled={sorting} onClick={(event) => { if (event.detail <= 1) onOpenHost(host); }}><span className="terminal-host-platform"><Monitor size={25} /><i className={host.status} /></span><span className="terminal-host-card-copy"><strong title={host.name}>{host.name}</strong><small className="terminal-host-card-meta"><span className="terminal-host-card-platform">{host.platform === "windows" ? "RDP" : "SSH"}</span><span className={`terminal-host-card-state ${host.status}`}>{host.status === "online" ? "在线" : host.status === "offline" ? "离线" : "未检测"}</span><span className="terminal-host-address">{host.host}</span></small></span></button>{!sorting && <div className="terminal-host-card-actions"><button type="button" title="更多操作" aria-label={`${host.name} 的更多操作`} aria-expanded={moreId === host.id} onClick={(event) => { event.stopPropagation(); onToggleMore(host.id); }}><MoreVertical size={20} /></button>{moreId === host.id && <div className="terminal-host-more-menu"><button type="button" onClick={() => onEdit(host)}><Settings size={14} />编辑</button>{host.platform !== "windows" && <button type="button" disabled={loadingId !== null} onClick={() => onProbe(host)}><RefreshCw size={14} />刷新</button>}<button type="button" className="danger" onClick={() => onDelete(host)}><Trash2 size={14} />移除</button></div>}</div>}</article>)}</section>;
    })}{!visibleHosts.length && <div className="terminal-host-empty"><Server size={30} /><p>{hosts.length ? "没有匹配的服务器" : "添加服务器后即可开始连接"}</p><button type="button" className="terminal-host-empty-action" onClick={onAdd}><Plus size={14} />添加服务器</button></div>}</div>
  </aside>;
}
