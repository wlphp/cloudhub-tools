import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Globe2, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import type { DomainTool } from "../../shared/types";

type DnsField = "Value" | "RR" | "TTL" | "Priority" | "Line";
type DomainToolDialogProps = {
  tool: DomainTool | null;
  maximized: boolean;
  loading: boolean;
  error: string;
  data: Record<string, unknown> | null;
  filter: string;
  typeFilter: string;
  page: number;
  pageSize: number;
  total: number;
  inlineEdit: { recordId: string; field: DnsField } | null;
  displayValue: (value: unknown) => string;
  onClose: () => void;
  onToggleMaximized: () => void;
  onRefresh: () => void;
  onFilterChange: (value: string) => void;
  onTypeFilterChange: (value: string) => void;
  onSearch: () => void;
  onAdd: () => void;
  onQuickAdd: (type: string, rr: string) => void;
  onInlineEditChange: (value: { recordId: string; field: DnsField } | null) => void;
  onUpdateField: (row: Record<string, unknown>, field: DnsField, value: string) => void;
  onRowAction: (row: Record<string, unknown>, action: "edit" | "toggle" | "delete") => void;
  onPageChange: (page: number) => void;
};

const readonlyDnsClouds = ["tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu"];

export function DomainToolDialog({ tool, maximized, loading, error, data, filter, typeFilter, page, pageSize, total, inlineEdit, displayValue, onClose, onToggleMaximized, onRefresh, onFilterChange, onTypeFilterChange, onSearch, onAdd, onQuickAdd, onInlineEditChange, onUpdateField, onRowAction, onPageChange }: DomainToolDialogProps) {
  if (!tool) return null;
  const isDns = tool.kind === "dns";
  const items = Array.isArray(data?.items) ? data.items as Record<string, unknown>[] : [];
  const canEditDns = isDns && !readonlyDnsClouds.includes(tool.account.cloud_type);
  const editing = (row: Record<string, unknown>, field: DnsField) => inlineEdit?.recordId === String(row.RecordId) && inlineEdit.field === field;
  const beginEdit = (row: Record<string, unknown>, field: DnsField) => onInlineEditChange({ recordId: String(row.RecordId), field });
  const onTextKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") onInlineEditChange(null);
  };

  return createPortal(<div className="resource-modal-backdrop domain-tool-backdrop" onClick={onClose}>
    <section className={`detail-panel resource-modal domain-tool-modal${maximized ? " is-maximized" : ""}`} onClick={(event) => event.stopPropagation()}>
      <div className="detail-toolbar"><div><span className="eyebrow">{tool.account.account_name}</span><h2>{isDns ? `【${tool.domain}】解析管理` : tool.kind === "logs" ? `【${tool.domain}】操作日志` : `【${tool.domain}】WHOIS`}</h2></div><div className="detail-toolbar-actions"><button className="secondary" title={maximized ? "还原窗口" : "放大到全屏"} onClick={onToggleMaximized}>{maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}{maximized ? "还原" : "放大"}</button><button className="secondary" disabled={loading} onClick={onRefresh}><RefreshCw className={loading ? "spin" : undefined} size={15} />{loading ? "刷新中…" : "刷新"}</button><button className="close-detail" onClick={onClose}><X size={18} /></button></div></div>
      <div className="domain-tool-body">
        {tool.kind !== "whois" && <div className="domain-tool-filter">{isDns && <select value={typeFilter} onChange={(event) => onTypeFilterChange(event.target.value)}><option value="">全部类型</option><option value="A">A</option><option value="AAAA">AAAA</option><option value="CNAME">CNAME</option><option value="MX">MX</option><option value="TXT">TXT</option><option value="NS">NS</option></select>}<input value={filter} onChange={(event) => onFilterChange(event.target.value)} placeholder={isDns ? "搜索主机记录" : "搜索关键词"} /><button className="layui-btn layui-btn-sm" disabled={loading} onClick={onSearch}><RefreshCw className={loading ? "spin" : undefined} size={14} />{loading ? "查询中…" : "查询"}</button></div>}
        {canEditDns && <div className="domain-tool-actions"><span className="quick-add-label">快速添加：</span>{[{ label: "@记录", type: "A", rr: "@" }, { label: "www记录", type: "A", rr: "www" }, { label: "www CNAME", type: "CNAME", rr: "www" }, { label: "MX记录", type: "MX", rr: "@" }, { label: "TXT记录", type: "TXT", rr: "@" }].map((item) => <button key={item.label} className="quick-add-btn" onClick={() => onQuickAdd(item.type, item.rr)}>{item.label}</button>)}<button className="layui-btn layui-btn-normal dns-add-btn" onClick={onAdd}>＋ 添加记录</button><span className="domain-tool-count">共 {items.length} 条</span></div>}
        {loading && !data && <div className="detail-empty"><RefreshCw className="spin" size={24} />正在读取…</div>}
        {error && <div className="error-list"><div>{error}</div></div>}
        {!error && tool.kind === "whois" && <pre className="whois-result">{String(data?.text || "暂无 WHOIS 信息")}</pre>}
        {!error && tool.kind !== "whois" && (items.length ? <div className="resource-table-wrap dns-table-wrap"><table><thead><tr>{(isDns ? ["类型", "主机记录", "记录值", "TTL", "优先级", "线路", "状态", "操作"] : ["ActionTime", "Action", "Message", "ClientIp"]).map((key) => <th key={key}>{key}</th>)}</tr></thead><tbody>{items.map((row, index) => <tr key={index}>{isDns ? <>
          <td><span className={`dns-type-tag dns-type-${String(row.Type || "").toLowerCase()}`}>{displayValue(row.Type)}</span></td>
          <td onClick={() => beginEdit(row, "RR")}>{editing(row, "RR") ? <input autoFocus className="cell-input" defaultValue={String(row.RR ?? "")} onBlur={(event) => onUpdateField(row, "RR", event.target.value)} onKeyDown={onTextKeyDown} /> : <span className="cell-view">{displayValue(row.RR)}</span>}</td>
          <td className="dns-value-cell" title={String(displayValue(row.Value))} onClick={() => beginEdit(row, "Value")}>{editing(row, "Value") ? <input autoFocus className="cell-input" defaultValue={String(row.Value ?? "")} onBlur={(event) => onUpdateField(row, "Value", event.target.value)} onKeyDown={onTextKeyDown} /> : <span className="cell-view">{displayValue(row.Value)}</span>}</td>
          <td onClick={() => beginEdit(row, "TTL")}>{editing(row, "TTL") ? <select autoFocus className="cell-input" defaultValue={String(row.TTL ?? 600)} onBlur={(event) => onUpdateField(row, "TTL", event.target.value)} onChange={(event) => onUpdateField(row, "TTL", event.target.value)}>{[60, 120, 300, 600, 1800, 3600, 43200, 86400].map((value) => <option key={value} value={String(value)}>{value}秒</option>)}</select> : <span className="cell-view">{displayValue(row.TTL)}{row.TTL ? "秒" : ""}</span>}</td>
          <td onClick={() => beginEdit(row, "Priority")}>{editing(row, "Priority") ? <input autoFocus type="number" className="cell-input" defaultValue={String(row.Priority ?? 10)} onBlur={(event) => onUpdateField(row, "Priority", event.target.value)} onKeyDown={onTextKeyDown} /> : <span className="cell-view">{row.Priority ? displayValue(row.Priority) : "-"}</span>}</td>
          <td onClick={() => beginEdit(row, "Line")}>{editing(row, "Line") ? <select autoFocus className="cell-input" defaultValue={String(row.Line ?? "default")} onBlur={(event) => onUpdateField(row, "Line", event.target.value)} onChange={(event) => onUpdateField(row, "Line", event.target.value)}><option value="default">默认</option><option value="telecom">电信</option><option value="unicom">联通</option><option value="mobile">移动</option><option value="oversea">境外</option><option value="edu">教育网</option><option value="search">搜索引擎</option></select> : <span className="cell-view">{displayValue(row.Line)}</span>}</td>
          <td onClick={() => onRowAction(row, "toggle")}>{(() => { const status = String(row.Status || "").toUpperCase(); const enabled = status === "ENABLE"; return <span className={`dns-status ${enabled ? "on" : "off"}`}><span className="dns-status-dot" />{enabled ? "正常" : "暂停"}</span>; })()}</td>
          <td><div className="dns-actions"><button className="dns-action-btn edit" disabled={!canEditDns} onClick={() => onRowAction(row, "edit")}>编辑</button><button className="dns-action-btn warn" disabled={!canEditDns} onClick={() => onRowAction(row, "toggle")}>{String(row.Status).toUpperCase() === "ENABLE" ? "暂停" : "启用"}</button><button className="dns-action-btn danger" disabled={!canEditDns} onClick={() => onRowAction(row, "delete")}>删除</button></div></td>
        </> : (["ActionTime", "Action", "Message", "ClientIp"] as const).map((key) => <td key={key}>{displayValue(row[key])}</td>)}</tr>)}</tbody></table>{total > pageSize && <div className="pagination dns-pagination"><span>共 {total} 条 / 第 {page} 页</span><button disabled={page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))}>‹</button><strong>{page}</strong><button disabled={page >= Math.max(1, Math.ceil(total / pageSize))} onClick={() => onPageChange(page + 1)}>›</button></div>}</div> : <div className="detail-empty"><Globe2 size={28} /><span>{isDns ? "暂无解析记录" : "暂无操作日志"}</span></div>)}
      </div>
    </section>
  </div>, document.body);
}
