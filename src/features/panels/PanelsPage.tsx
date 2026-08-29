import type { ChangeEvent, PointerEvent, ReactNode, RefObject } from "react";
import { Copy, Download, Globe2, GripVertical, Monitor, Plus, RefreshCw, Search, Settings, Terminal, Trash2, Upload } from "lucide-react";
import type { Account, LocalAsset, PanelConnection } from "../../shared/types";

type PanelRemarkDraft = { id: number; value: string; initial: string } | null;

type PanelsPageProps = {
  accounts: Account[];
  assets: LocalAsset[];
  panels: PanelConnection[];
  visiblePanels: PanelConnection[];
  groups: string[];
  keyword: string;
  group: string;
  sorting: boolean;
  draggedPanelId: number | null;
  selectedPanelIds: Set<number>;
  remarkDraft: PanelRemarkDraft;
  loadingId: number | null;
  openingId: number | null;
  importing: boolean;
  importInputRef: RefObject<HTMLInputElement | null>;
  hideIps: boolean;
  refreshSeconds: number;
  openMode: "browser" | "copy";
  renderMetrics: (panel: PanelConnection) => ReactNode;
  formatDateTime: (value: unknown) => string;
  formatAddress: (value: string) => string;
  hiddenAddress: (value: string) => string;
  onKeywordChange: (value: string) => void;
  onGroupChange: (value: string) => void;
  onRefreshAll: () => void;
  onAdd: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onHideIpsChange: (value: boolean) => void;
  onRefreshSecondsChange: (value: number) => void;
  onOpenModeChange: (value: "browser" | "copy") => void;
  onSortingChange: (value: boolean) => void;
  onStartDrag: (event: PointerEvent<HTMLButtonElement>, id: number) => void;
  onToggleAll: () => void;
  onToggleSelected: (id: number) => void;
  onStartEditingRemark: (panel: PanelConnection) => void;
  onRemarkChange: (value: string) => void;
  onSaveRemark: (panel: PanelConnection) => void;
  onCancelRemark: () => void;
  onCopyAddress: (panel: PanelConnection) => void;
  onEdit: (panel: PanelConnection) => void;
  onOpen: (panel: PanelConnection) => void;
  onOpenSsh: (asset: LocalAsset, account: Account) => void;
  onReboot: (asset: LocalAsset) => void;
  onDelete: (panel: PanelConnection) => void;
};

export function PanelsPage({
  accounts, assets, panels, visiblePanels, groups, keyword, group, sorting, draggedPanelId,
  selectedPanelIds, remarkDraft, loadingId, openingId, importing, importInputRef, hideIps,
  refreshSeconds, openMode, renderMetrics, formatDateTime, formatAddress, hiddenAddress,
  onKeywordChange, onGroupChange, onRefreshAll, onAdd, onExport, onImport, onHideIpsChange,
  onRefreshSecondsChange, onOpenModeChange, onSortingChange, onStartDrag, onToggleAll,
  onToggleSelected, onStartEditingRemark, onRemarkChange, onSaveRemark, onCancelRemark,
  onCopyAddress, onEdit, onOpen, onOpenSsh, onReboot, onDelete,
}: PanelsPageProps) {
  const handleImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (file) onImport(file);
  };

  return <section className="panel-management-page">
    <header><div><h1>面板管理</h1><p>统一绑定和管理多台宝塔或 aaPanel 面板；API 密钥仅加密保存在当前设备。</p></div></header>
    <section className="managed-server-toolbar panel-management-toolbar">
      <div className="panel-toolbar-primary"><label className="managed-host-search" title="搜索面板"><Search size={16} /><input aria-label="搜索面板" value={keyword} onChange={(event) => onKeywordChange(event.target.value)} placeholder="搜索面板名称、IP 地址或备注" /></label><select aria-label="面板分组" title="按分组筛选面板" value={group} disabled={sorting} onChange={(event) => onGroupChange(event.target.value)}><option value="">全部分组</option>{groups.map((item) => <option key={item} value={item}>{item}</option>)}</select><button type="button" className="secondary" title="刷新所有面板状态" disabled={loadingId !== null} onClick={onRefreshAll}><RefreshCw size={15} className={loadingId !== null ? "spin" : ""} />{loadingId !== null ? "刷新中" : "刷新"}</button><button type="button" className="layui-btn panel-toolbar-add" title="添加新的面板连接" onClick={onAdd}><Plus size={15} />添加面板</button><button type="button" className="secondary" title={selectedPanelIds.size ? `导出已选 ${selectedPanelIds.size} 个面板` : "导出全部面板"} disabled={!panels.length} onClick={onExport}><Download size={15} />导出{selectedPanelIds.size ? ` (${selectedPanelIds.size})` : "全部"}</button><label className="layui-btn panel-toolbar-import" title="导入面板 JSON"><Upload size={15} />{importing ? "导入中" : "导入"}<input ref={importInputRef} type="file" accept="application/json,.json" disabled={importing} onChange={handleImport} /></label></div>
      <div className="panel-toolbar-secondary"><label className="panel-toolbar-option" title="在地址和列表中隐藏 IP"><input type="checkbox" checked={hideIps} onChange={(event) => onHideIpsChange(event.target.checked)} />隐藏 IP</label><label className="panel-toolbar-option panel-refresh-mode"><span>监控刷新</span><select value={refreshSeconds} onChange={(event) => onRefreshSecondsChange(Number(event.target.value))} aria-label="监控资源刷新间隔" title="监控资源刷新间隔"><option value={0}>关闭</option><option value={5}>5 秒</option><option value={10}>10 秒</option><option value={30}>30 秒</option><option value={60}>60 秒</option></select></label><label className="panel-toolbar-option panel-open-mode"><span>打开面板</span><select value={openMode} onChange={(event) => onOpenModeChange(event.target.value as "browser" | "copy")} aria-label="打开面板方式" title="打开面板方式"><option value="browser">默认浏览器打开</option><option value="copy">复制临时 URL</option></select></label><button type="button" className={`panel-sort-button${sorting ? " is-sorting" : ""}`} title={sorting ? "退出面板排序" : "调整面板顺序"} onClick={() => onSortingChange(!sorting)}><GripVertical size={15} />{sorting ? "退出排序" : "排序"}</button><span className="panel-toolbar-count">共 {panels.length} 台服务器</span></div>
    </section>
    {visiblePanels.length ? <div className={`panel-monitor-scroll${sorting ? " is-sorting" : ""}`}><div className="panel-monitor-table"><div className="panel-monitor-table-head"><span>{sorting ? "排序" : <input type="checkbox" aria-label="选择全部当前面板" checked={visiblePanels.every((panel) => selectedPanelIds.has(panel.id))} onChange={onToggleAll} />}</span><span>服务器信息</span><span>状态</span><span>资源监控</span><span>操作</span></div>{visiblePanels.map((panel) => {
      const summary = panel.summary || {};
      const value = (key: string) => { const entry = summary[key]; return entry == null || entry === "" ? "-" : typeof entry === "string" || typeof entry === "number" ? String(entry) : "-"; };
      const sourceAccount = panel.source_account_id ? accounts.find((account) => account.id === panel.source_account_id) : undefined;
      const sourceAsset = sourceAccount && panel.source_asset_key ? assets.find((asset) => asset.account_id === sourceAccount.id && asset.asset_key === panel.source_asset_key) : undefined;
      const canSsh = Boolean(sourceAccount && sourceAsset);
      const canReboot = Boolean(sourceAsset && (sourceAsset.resource_type === "ecs" || sourceAsset.resource_type === "swas"));
      return <article className={`panel-monitor-row ${panel.status}${sorting ? " is-sorting" : ""}${draggedPanelId === panel.id ? " is-dragging" : ""}`} key={panel.id} data-panel-id={panel.id}>
        <div className="panel-row-order">{sorting ? <button type="button" className="panel-drag-handle" title="拖动排序" aria-label={`拖动排序 ${panel.name}`} onPointerDown={(event) => onStartDrag(event, panel.id)}><GripVertical size={18} /></button> : <input aria-label={`选择面板 ${panel.name}`} type="checkbox" checked={selectedPanelIds.has(panel.id)} onChange={() => onToggleSelected(panel.id)} />}</div>
        <div className="panel-row-server"><div className="panel-row-note"><span>备注</span>{remarkDraft?.id === panel.id ? <input value={remarkDraft.value} autoFocus onChange={(event) => onRemarkChange(event.target.value)} onBlur={() => onSaveRemark(panel)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") onCancelRemark(); }} aria-label={`${panel.name} 的备注`} placeholder="添加备注" /> : <button type="button" aria-label={`编辑 ${panel.name} 的备注`} className={panel.remark ? "has-note" : ""} onClick={() => onStartEditingRemark(panel)}>{panel.remark || "添加备注"}</button>}</div><div className="panel-row-address"><i className={panel.status} /><strong title={hideIps ? undefined : panel.panel_url}>{hideIps ? hiddenAddress(panel.panel_url) : formatAddress(panel.panel_url)}</strong><button type="button" title="复制面板地址" aria-label={`复制 ${panel.name} 的面板地址`} onClick={() => onCopyAddress(panel)}><Copy size={15} /></button><button type="button" title="编辑面板" aria-label={`编辑 ${panel.name}`} onClick={() => onEdit(panel)}><Settings size={15} /></button></div><div className="panel-row-details"><span>名称：{panel.name}</span><span>来源：{panel.group_name || "-"}</span></div></div>
        <div className="panel-row-status"><span className={`managed-server-status ${panel.status}`}>{panel.status === "online" ? "在线" : panel.status === "offline" ? "离线" : "未检测"}</span><small>{value("version") === "-" ? "版本未获取" : value("version")}</small><small>{panel.last_checked_at ? `同步于 ${formatDateTime(panel.last_checked_at)}` : "尚未同步"}</small>{panel.status === "offline" && panel.last_error && <em title={panel.last_error}>连接失败</em>}</div>
        <div className="panel-row-metrics">{renderMetrics(panel)}</div>
        <div className="panel-row-actions"><button type="button" className="panel-action-button panel-open-button" title="在浏览器中打开面板" aria-label={`打开 ${panel.name}`} disabled={openingId !== null} onClick={() => onOpen(panel)}><Globe2 size={15} />{openingId === panel.id ? "打开中" : "面板"}</button><button type="button" className="panel-action-button" disabled={!canSsh} title={canSsh ? "通过关联云服务器 SSH 登录" : "关联云服务器后可使用 SSH"} aria-label={`通过 SSH 连接 ${panel.name}`} onClick={() => sourceAccount && sourceAsset && onOpenSsh(sourceAsset, sourceAccount)}><Terminal size={15} />SSH</button><button type="button" className="panel-action-button panel-reboot-button" disabled={!canReboot} title={canReboot ? "重启关联云服务器" : "关联云服务器后可重启"} aria-label={`重启 ${panel.name} 关联服务器`} onClick={() => sourceAsset && onReboot(sourceAsset)}><RefreshCw size={15} />重启</button><button type="button" className="panel-action-button panel-delete-button" disabled={openingId !== null} title="移除面板" aria-label={`移除 ${panel.name}`} onClick={() => onDelete(panel)}><Trash2 size={16} /></button></div>
      </article>;
    })}</div></div> : <div className="managed-server-empty"><Monitor size={42} /><h3>{panels.length ? "没有符合条件的面板" : "还没有绑定面板"}</h3><p>{panels.length ? "调整搜索或分组条件后再试。" : "添加面板 URL 与 API 密钥，验证成功后即可统一查看并快速进入面板。"}</p></div>}
  </section>;
}
