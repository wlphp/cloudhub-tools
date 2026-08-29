import type { PointerEvent, ReactNode } from "react";
import { Bookmark, BookmarkCheck, GripVertical, Server } from "lucide-react";
import { cloudProvider } from "../cloud/catalog";
import type { Account, LocalAsset } from "../../shared/types";
import { assetFavoriteKey } from "./preferences";

type AssetNoteDraft = { key: string; value: string; initial: string } | null;
type AssetNameDraft = { key: string; value: string; initial: string } | null;

type AssetsPageProps = {
  accounts: Account[];
  assets: LocalAsset[];
  visibleAssets: LocalAsset[];
  pagedAssets: LocalAsset[];
  assetTypes: ReadonlyArray<readonly [string, string]>;
  selectedAccount: Account | null;
  resourceAccountId: number | null;
  resourceTypeFilter: string | null;
  assetKeyword: string;
  assetRegionFilter: string;
  assetStatusFilter: string;
  assetPage: number;
  pageSize: number;
  favoriteAssetKeys: string[];
  assetNotes: Record<string, string>;
  editingAssetNote: AssetNoteDraft;
  editingAssetName: AssetNameDraft;
  savingAssetName: string | null;
  draggedAssetKey: string | null;
  displayValue: (value: unknown) => string;
  formatAssetDate: (value: unknown) => string;
  cloudStatusText: (value: unknown) => string;
  renderActions: (asset: LocalAsset, account: Account | undefined) => ReactNode;
  onResourceAccountChange: (accountId: number | null) => void;
  onResourceTypeFilterChange: (value: string | null) => void;
  onAssetKeywordChange: (value: string) => void;
  onAssetRegionFilterChange: (value: string) => void;
  onAssetStatusFilterChange: (value: string) => void;
  onAssetPageChange: (page: number) => void;
  onToggleFavorite: (asset: LocalAsset) => void;
  onStartAssetDrag: (event: PointerEvent<HTMLButtonElement>, key: string) => void;
  onStartEditingAssetNote: (key: string, value: string) => void;
  onAssetNoteValueChange: (value: string) => void;
  onSaveAssetNote: (key: string) => void;
  onCancelAssetNoteEdit: () => void;
  onStartEditingAssetName: (key: string, value: string) => void;
  onAssetNameValueChange: (value: string) => void;
  onSaveServerName: (asset: LocalAsset, account: Account, key: string) => void;
  onCancelAssetNameEdit: () => void;
};

export function AssetsPage({
  accounts, assets, visibleAssets, pagedAssets, assetTypes, selectedAccount,
  resourceAccountId, resourceTypeFilter, assetKeyword, assetRegionFilter, assetStatusFilter,
  assetPage, pageSize, favoriteAssetKeys, assetNotes, editingAssetNote, editingAssetName,
  savingAssetName, draggedAssetKey, displayValue, formatAssetDate, cloudStatusText,
  renderActions, onResourceAccountChange, onResourceTypeFilterChange, onAssetKeywordChange,
  onAssetRegionFilterChange, onAssetStatusFilterChange, onAssetPageChange, onToggleFavorite,
  onStartAssetDrag, onStartEditingAssetNote, onAssetNoteValueChange, onSaveAssetNote,
  onCancelAssetNoteEdit, onStartEditingAssetName, onAssetNameValueChange, onSaveServerName,
  onCancelAssetNameEdit,
}: AssetsPageProps) {
  const regions = Array.from(new Set(assets.map((asset) => asset.region_id || String(asset.payload?.RegionId || asset.payload?.Location || "")).filter(Boolean)));
  const statuses = Array.from(new Set(assets.map((asset) => String(asset.payload?.Status || asset.payload?.InstanceStatus || asset.payload?.DBInstanceStatus || asset.payload?.DomainStatus || "")).filter(Boolean)));

  return (
    <section className="local-resource-page">
      <header><div><span className="eyebrow">LOCAL ASSETS</span><h1>资源管理</h1><p>所有资产来自本地 SQLite，不会在此页面实时请求云端。</p></div></header>
      <div className="resource-account-switcher"><span>当前账号</span><select aria-label="当前资源账号" title="切换资源账号" value={resourceAccountId ?? "all"} onChange={(event) => onResourceAccountChange(event.target.value === "all" ? null : Number(event.target.value))}><option value="all">全部账号（汇总）</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.account_name} · {account.access_key_id}</option>)}</select>{selectedAccount && <strong>{selectedAccount.account_name}</strong>}</div>
      <div className="local-asset-summary">{assetTypes.map(([value, label]) => <button type="button" className={`asset-summary-card asset-summary-tile ${resourceTypeFilter === value ? "active" : ""}`} key={value} title={`筛选${label}资产`} aria-pressed={resourceTypeFilter === value} onClick={() => onResourceTypeFilterChange(resourceTypeFilter === value ? null : value)}><span>{label}</span><strong>{assets.filter((item) => (resourceAccountId === null || item.account_id === resourceAccountId) && item.resource_type === value).length}</strong><small>点击查看</small></button>)}</div>
      <section className="panel local-assets-panel">
        <div className="asset-list-toolbar"><input className="asset-list-search" aria-label="搜索资产" value={assetKeyword} onChange={(event) => onAssetKeywordChange(event.target.value)} placeholder="请输入资产名称 / ID / 账号" /><select className="asset-type-filter" aria-label="按资产类型筛选" value={resourceTypeFilter || ""} onChange={(event) => onResourceTypeFilterChange(event.target.value || null)}><option value="">全部类型</option>{assetTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select className="asset-region-filter" aria-label="按地域筛选" value={assetRegionFilter} onChange={(event) => onAssetRegionFilterChange(event.target.value)}><option value="">全部地域</option>{regions.map((region) => <option key={region} value={region}>{region}</option>)}</select><select className="asset-status-filter" aria-label="按状态筛选" value={assetStatusFilter} onChange={(event) => onAssetStatusFilterChange(event.target.value)}><option value="">全部状态</option>{statuses.map((status) => <option key={status} value={status}>{cloudStatusText(status)}</option>)}</select></div>
        {visibleAssets.length ? <div className="table-wrap"><table><thead><tr><th className="asset-order-column"><span className="sr-only">排序</span></th><th>资源类型</th><th>资产名称 / ID</th><th>到期时间</th><th>账号信息</th><th>地域</th><th>状态</th><th className="asset-actions-column">操作</th></tr></thead><tbody>{pagedAssets.map((asset, index) => {
          const account = accounts.find((item) => item.id === asset.account_id);
          const payload = asset.payload || {};
          const key = assetFavoriteKey(asset);
          const serverName = displayValue(payload.InstanceName || asset.asset_key);
          const canEditServerName = asset.resource_type === "ecs" && Boolean(account && (account.cloud_type === "aliyun" || account.cloud_type === "tencent"));
          const accessKey = account?.access_key_id || "";
          const maskedKey = accessKey.length > 8 ? `${accessKey.slice(0, 4)}****${accessKey.slice(-4)}` : accessKey || "-";
          const expiry = payload.ExpiredTime || payload.ExpirationTime || payload.ExpirationDate || payload.ExpireTime || payload.ExpireDate || payload.EndTime;
          const note = assetNotes[key] || "";
          const isFavorite = favoriteAssetKeys.includes(key);
          return <tr key={`${asset.account_id}-${asset.resource_type}-${asset.asset_key}-${index}`} className={draggedAssetKey === key ? "is-asset-dragging" : ""} data-asset-row-key={key}>
            <td className="asset-order-cell"><button type="button" className="asset-drag-handle" aria-label={`拖动排序 ${serverName}`} title="拖动排序" onPointerDown={(event) => onStartAssetDrag(event, key)}><GripVertical size={17} /></button></td>
            <td>{assetTypes.find(([value]) => value === asset.resource_type)?.[1] || asset.resource_type}</td>
            <td><div className="asset-name-cell"><div className="asset-note-line">{editingAssetNote?.key === key ? <input className="asset-note-editor" value={editingAssetNote.value} autoFocus onChange={(event) => onAssetNoteValueChange(event.target.value)} onBlur={() => onSaveAssetNote(key)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") onCancelAssetNoteEdit(); }} aria-label="资产备注" placeholder="添加备注" /> : <button type="button" className={`asset-note-button${note ? " has-note" : ""}`} onClick={() => onStartEditingAssetNote(key, note)}>{note || "添加备注"}</button>}</div><div className="asset-name-primary">{canEditServerName && account ? (editingAssetName?.key === key ? <input className="asset-name-editor" value={editingAssetName.value} autoFocus disabled={savingAssetName === key} onChange={(event) => onAssetNameValueChange(event.target.value)} onBlur={() => onSaveServerName(asset, account, key)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") onCancelAssetNameEdit(); }} aria-label="服务器名称" /> : <button type="button" className="asset-name-edit-button" title="点击修改服务器名称" onClick={() => onStartEditingAssetName(key, serverName === "-" ? "" : serverName)}><strong>{serverName}</strong></button>) : <strong>{displayValue(payload.InstanceName || payload.DBInstanceDescription || payload.SiteName || payload.DomainName || payload.Name || asset.asset_key)}</strong>}<button type="button" className={`asset-favorite-button asset-name-favorite ${isFavorite ? "is-favorite" : ""}`} title={isFavorite ? "取消收藏" : "收藏资源"} aria-label={isFavorite ? "取消收藏" : "收藏资源"} onClick={() => onToggleFavorite(asset)}>{isFavorite ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}</button></div><small className="asset-subline">{asset.asset_key}</small></div></td>
            <td>{formatAssetDate(expiry)}</td><td><div className="asset-account-name"><span className={`avatar cloud-avatar ${account?.cloud_type || "other"}`}>{cloudProvider(account?.cloud_type || "other").avatar}</span><strong>{account?.account_name || `账号 ${asset.account_id}`}</strong></div><small className="asset-subline">{cloudProvider(account?.cloud_type || "other").label} · {maskedKey}</small><small className="asset-subline">{account?.group_name || "未分组"}</small></td><td>{displayValue(asset.region_id || payload.RegionId || payload.Location)}</td><td>{cloudStatusText(payload.Status || payload.InstanceStatus || payload.DBInstanceStatus || payload.DomainStatus)}</td><td className="asset-actions-cell">{renderActions(asset, account)}</td>
          </tr>;
        })}</tbody></table></div> : <div className="empty"><Server size={40} /><h3>暂无本地资产</h3><p>请到账号管理，勾选资产类型并点击“获取资产”。</p></div>}
        {visibleAssets.length > 0 && <div className="pagination"><span>共 {visibleAssets.length} 条记录</span><button disabled={assetPage <= 1} onClick={() => onAssetPageChange(Math.max(1, assetPage - 1))}>‹</button><strong>{assetPage}</strong><button disabled={assetPage >= Math.max(1, Math.ceil(visibleAssets.length / pageSize))} onClick={() => onAssetPageChange(assetPage + 1)}>›</button></div>}
      </section>
    </section>
  );
}
