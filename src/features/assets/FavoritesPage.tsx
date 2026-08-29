import type { PointerEvent, ReactNode } from "react";
import { BookmarkCheck, Copy, GripVertical, RefreshCw, Search, Star } from "lucide-react";
import { cloudProvider } from "../cloud/catalog";
import { FavoriteServerDetails } from "../servers/ServerCards";
import type { Account, LocalAsset } from "../../shared/types";
import { assetFavoriteKey } from "./preferences";

type AssetNoteDraft = { key: string; value: string; initial: string } | null;

type FavoritesPageProps = {
  accounts: Account[];
  favoriteAssets: LocalAsset[];
  visibleFavoriteAssets: LocalAsset[];
  pagedFavoriteAssets: LocalAsset[];
  assetTypes: ReadonlyArray<readonly [string, string]>;
  favoriteTypeFilter: string | null;
  favoriteKeyword: string;
  favoriteRegionFilter: string;
  favoritePage: number;
  pageSize: number;
  assetNotes: Record<string, string>;
  editingAssetNote: AssetNoteDraft;
  favoriteRefreshingKey: string | null;
  draggedFavoriteKey: string | null;
  displayValue: (value: unknown) => string;
  formatAssetDate: (value: unknown) => string;
  cloudStatusText: (value: unknown) => string;
  renderActions: (asset: LocalAsset, account: Account | undefined) => ReactNode;
  onFavoriteTypeFilterChange: (value: string | null) => void;
  onFavoriteKeywordChange: (value: string) => void;
  onFavoriteRegionFilterChange: (value: string) => void;
  onFavoritePageChange: (page: number) => void;
  onStartFavoriteCardDrag: (event: PointerEvent<HTMLButtonElement>, key: string) => void;
  onStartEditingAssetNote: (key: string, value: string) => void;
  onAssetNoteValueChange: (value: string) => void;
  onSaveAssetNote: (key: string) => void;
  onCancelAssetNoteEdit: () => void;
  onToggleFavorite: (asset: LocalAsset) => void;
  onCopyIp: (address: string) => void;
  onRefreshAsset: (asset: LocalAsset, account: Account) => void;
  onOpenResources: () => void;
};

export function FavoritesPage({
  accounts, favoriteAssets, visibleFavoriteAssets, pagedFavoriteAssets, assetTypes,
  favoriteTypeFilter, favoriteKeyword, favoriteRegionFilter, favoritePage, pageSize,
  assetNotes, editingAssetNote, favoriteRefreshingKey, draggedFavoriteKey, displayValue,
  formatAssetDate, cloudStatusText, renderActions, onFavoriteTypeFilterChange,
  onFavoriteKeywordChange, onFavoriteRegionFilterChange, onFavoritePageChange,
  onStartFavoriteCardDrag, onStartEditingAssetNote, onAssetNoteValueChange, onSaveAssetNote,
  onCancelAssetNoteEdit, onToggleFavorite, onCopyIp, onRefreshAsset, onOpenResources,
}: FavoritesPageProps) {
  const regions = Array.from(new Set(favoriteAssets.map((asset) => asset.region_id || String(asset.payload?.RegionId || asset.payload?.Location || "")).filter(Boolean)));
  return <section className="favorites-page">
    <header><div><span className="eyebrow">MY COLLECTIONS</span><h1>我的收藏</h1><p>收藏重要云资源，方便快速访问和管理。</p></div></header>
    <div className="local-asset-summary favorite-asset-summary">{assetTypes.filter(([value]) => favoriteAssets.some((item) => item.resource_type === value)).map(([value, label]) => <button type="button" className={`asset-summary-card ${favoriteTypeFilter === value ? "active" : ""}`} key={value} onClick={() => onFavoriteTypeFilterChange(favoriteTypeFilter === value ? null : value)}><span>{label}</span><strong>{favoriteAssets.filter((item) => item.resource_type === value).length}</strong><small>点击查看</small></button>)}</div>
    <section className="favorite-toolbar"><div className="favorite-type-tabs"><button type="button" className={!favoriteTypeFilter ? "active" : ""} onClick={() => onFavoriteTypeFilterChange(null)}>全部 ({favoriteAssets.length})</button>{assetTypes.map(([value, label]) => <button type="button" className={favoriteTypeFilter === value ? "active" : ""} key={value} onClick={() => onFavoriteTypeFilterChange(value)}>{label} ({favoriteAssets.filter((item) => item.resource_type === value).length})</button>)}</div><label className="favorite-search"><Search size={16} /><input value={favoriteKeyword} onChange={(event) => onFavoriteKeywordChange(event.target.value)} placeholder="搜索资源名称 / ID / 账号" /></label><select value={favoriteRegionFilter} onChange={(event) => onFavoriteRegionFilterChange(event.target.value)}><option value="">全部地域</option>{regions.map((region) => <option key={region} value={region}>{region}</option>)}</select></section>
    {visibleFavoriteAssets.length ? <div className="favorite-card-grid">{pagedFavoriteAssets.map((asset) => {
      const account = accounts.find((item) => item.id === asset.account_id);
      const payload = asset.payload || {};
      const title = displayValue(payload.InstanceName || payload.DBInstanceDescription || payload.SiteName || payload.DomainName || payload.Name || asset.asset_key);
      const region = displayValue(asset.region_id || payload.RegionId || payload.Location);
      const status = cloudStatusText(payload.Status || payload.InstanceStatus || payload.DBInstanceStatus || payload.DomainStatus);
      const expiry = payload.ExpiredTime || payload.ExpirationTime || payload.ExpirationDate || payload.ExpireTime || payload.ExpireDate || payload.EndTime;
      const key = assetFavoriteKey(asset);
      const note = assetNotes[key] || "";
      const isServer = asset.resource_type === "ecs" || asset.resource_type === "swas";
      const detailRows = asset.resource_type === "domain" ? [["注册商", displayValue(payload.RegistrantOrganization || payload.Registrant || payload.RegistrantName)], ["到期时间", formatAssetDate(expiry)], ["地域", region]] : asset.resource_type === "oss" ? [["地域", region], ["存储类型", displayValue(payload.StorageClass)], ["创建时间", formatAssetDate(payload.CreationDate || payload.CreationTime)]] : [["地域", region], ["版本 / 引擎", displayValue(payload.EngineVersion || payload.Engine || payload.Version)], ["到期时间", formatAssetDate(expiry)]];
      return <article className={`favorite-resource-card${draggedFavoriteKey === key ? " is-favorite-dragging" : ""}`} key={key} data-favorite-asset-key={key}>
        <div className="favorite-card-account"><button type="button" className="favorite-card-drag-handle" aria-label={`拖动排序 ${title}`} title="拖动排序" onPointerDown={(event) => onStartFavoriteCardDrag(event, key)}><GripVertical size={16} /></button><span className={`avatar cloud-avatar ${account?.cloud_type || "other"}`}>{cloudProvider(account?.cloud_type || "other").avatar}</span><span>{account?.account_name || `账号 ${asset.account_id}`}</span></div>
        <div className="favorite-card-note"><span>备注</span>{editingAssetNote?.key === key ? <input value={editingAssetNote.value} autoFocus onChange={(event) => onAssetNoteValueChange(event.target.value)} onBlur={() => onSaveAssetNote(key)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") onCancelAssetNoteEdit(); }} aria-label="资产备注" placeholder="添加备注" /> : <button type="button" className={note ? "has-note" : ""} onClick={() => onStartEditingAssetNote(key, note)}>{note || "添加备注"}</button>}</div>
        <div className="favorite-card-head"><div><h2 title={title}>{title}</h2><small>{asset.asset_key}</small></div><button type="button" className="asset-favorite-button is-favorite" title="取消收藏" aria-label="取消收藏" onClick={() => onToggleFavorite(asset)}><BookmarkCheck size={18} /></button></div>
        {isServer && account ? <FavoriteServerDetails asset={asset} account={account} onCopyIp={onCopyIp} /> : <div className="favorite-card-details">{detailRows.map(([label, value]) => <div key={label}><span>{label}：</span><div className="favorite-detail-value"><strong title={String(value)}>{value}</strong>{label === "IP 地址" && value !== "-" && <button type="button" className="favorite-ip-copy" title="复制 IP 地址" aria-label="复制 IP 地址" onClick={() => onCopyIp(String(value))}><Copy size={14} /></button>}</div></div>)}</div>}
        <div className="favorite-card-meta"><span className={`favorite-resource-type ${asset.resource_type}`}>{assetTypes.find(([value]) => value === asset.resource_type)?.[1] || asset.resource_type}</span><span className="favorite-status">{status}</span>{isServer && account && <button type="button" className="favorite-status-refresh" title="刷新服务器状态" disabled={favoriteRefreshingKey !== null} onClick={() => onRefreshAsset(asset, account)}><RefreshCw size={13} className={favoriteRefreshingKey === key ? "spin" : ""} />{favoriteRefreshingKey === key ? "刷新中" : "刷新"}</button>}</div>
        <div className="favorite-card-actions">{renderActions(asset, account)}</div>
      </article>;
    })}</div> : <div className="favorite-empty"><Star size={42} /><h3>{favoriteAssets.length ? "没有符合条件的收藏" : "还没有收藏资源"}</h3><p>{favoriteAssets.length ? "调整筛选条件后再试。" : "前往资源管理，点击操作列的星标即可收藏资源。"}</p><button className="secondary" onClick={onOpenResources}>前往资源管理</button></div>}
    {visibleFavoriteAssets.length > 0 && <div className="pagination favorite-pagination"><span>共 {visibleFavoriteAssets.length} 条收藏</span><button disabled={favoritePage <= 1} onClick={() => onFavoritePageChange(Math.max(1, favoritePage - 1))}>‹</button><strong>{favoritePage}</strong><button disabled={favoritePage >= Math.max(1, Math.ceil(visibleFavoriteAssets.length / pageSize))} onClick={() => onFavoritePageChange(favoritePage + 1)}>›</button></div>}
  </section>;
}
