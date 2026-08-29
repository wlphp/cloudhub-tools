import { AlertTriangle, X } from "lucide-react";
import { assetTypes, cloudProvider, providerSyncDescription, supportsResourceSync, syncAssetTypes } from "../cloud/catalog";
import type { Account, LocalAsset } from "../../shared/types";

type AssetDetailDialogProps = {
  detail: { asset: LocalAsset; account: Account } | null;
  displayValue: (value: unknown) => string;
  columnLabel: (key: string) => string;
  onClose: () => void;
};

export function AssetDetailDialog({ detail, displayValue, columnLabel, onClose }: AssetDetailDialogProps) {
  if (!detail) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal asset-detail-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><span className="eyebrow">SERVER DETAIL</span><h2>{displayValue(detail.asset.payload.InstanceName || detail.asset.asset_key)}</h2></div><button className="close" title="关闭详情" onClick={onClose}><X size={20} /></button></div>
        <div className="asset-detail-meta"><span className={`avatar cloud-avatar ${detail.account.cloud_type}`}>{cloudProvider(detail.account.cloud_type).avatar}</span><span>{detail.account.account_name}</span><span>{assetTypes.find(([value]) => value === detail.asset.resource_type)?.[1] || detail.asset.resource_type}</span><span>{detail.asset.region_id || String(detail.asset.payload.RegionId || detail.asset.payload.Location || "未标注地域")}</span></div>
        <div className="asset-detail-list">{Object.entries(detail.asset.payload).filter(([key]) => !key.startsWith("_")).map(([key, value]) => <div key={key}><span>{columnLabel(key)}</span><strong title={displayValue(value)}>{displayValue(value)}</strong></div>)}</div>
        <div className="modal-actions"><button className="secondary" onClick={onClose}>关闭</button></div>
      </section>
    </div>
  );
}

type AssetSyncDialogProps = {
  account: Account | null;
  selectedTypes: string[];
  syncing: boolean;
  result: { fetched: number; counts: Record<string, number>; errors: string[] } | null;
  showOracleDatabasePermissionHint: boolean;
  onSelectedTypesChange: (types: string[]) => void;
  onClose: () => void;
  onSync: () => void;
};

export function AssetSyncDialog({
  account,
  selectedTypes,
  syncing,
  result,
  showOracleDatabasePermissionHint,
  onSelectedTypesChange,
  onClose,
  onSync,
}: AssetSyncDialogProps) {
  if (!account) return null;
  const supportedTypes = syncAssetTypes(account);
  const resultLevel = result?.errors.length ? (result.fetched > 0 ? "warning" : "has-errors") : "success";

  return (
    <div className="modal-backdrop">
      <section className="modal asset-sync-modal">
        <div className="modal-head"><div><span className="eyebrow">LOCAL SYNC</span><h2>获取账号资产</h2></div><button type="button" className="close" title="关闭" aria-label="关闭" onClick={onClose}><X size={20} /></button></div>
        <p className="security-tip">选择要从{cloudProvider(account.cloud_type).label}获取并保存到本地 SQLite 的资产类型。当前支持{providerSyncDescription(account.cloud_type)}。</p>
        <div className="asset-sync-selection" role="group" aria-label="选择要获取的资产类型">
          <div className="asset-sync-selection-head"><div><strong>资源类型</strong><span>已选择 {selectedTypes.length} / {supportedTypes.length}</span></div><label className="asset-check-all"><input type="checkbox" checked={supportedTypes.every(([value]) => selectedTypes.includes(value))} onChange={(event) => onSelectedTypesChange(event.target.checked ? supportedTypes.map(([value]) => value) : [])} /><span>全选</span></label></div>
          <div className="asset-check-grid">{supportedTypes.map(([value, label]) => { const selected = selectedTypes.includes(value); const displayLabel = account.cloud_type === "tencent" && value === "ecs" ? "CVM服务器" : label; return <label key={value} className={`asset-check${selected ? " selected" : ""}`}><input type="checkbox" checked={selected} onChange={(event) => onSelectedTypesChange(event.target.checked ? [...new Set([...selectedTypes, value])] : selectedTypes.filter((item) => item !== value))} /><span>{displayLabel}</span></label>; })}</div>
        </div>
        <div className="asset-sync-account"><span>同步账号</span><strong title={account.account_name}>{account.account_name}</strong></div>
        {result && <div className={`asset-sync-result ${resultLevel}`} role="status" aria-atomic="true"><strong>{resultLevel === "has-errors" ? "获取失败" : resultLevel === "warning" ? "获取完成（含提示）" : "获取成功并已保存到本地"}</strong><span>共保存 {result.fetched} 项资产</span><div className="asset-result-counts">{selectedTypes.map((type) => <span key={type}>{assetTypes.find(([value]) => value === type)?.[1] || type}：{result.counts[type] ?? 0} 个</span>)}</div>{showOracleDatabasePermissionHint && <div className="asset-sync-guidance"><AlertTriangle size={16} /><div><strong>云数据库未获取</strong><span>当前 OCI 密钥缺少数据库读取权限。请在 OCI IAM 为用户或所属组授予目标资源组的 <code>read database-family</code>，或配置更精细的 DB System 只读策略后重新获取。</span></div></div>}{result.errors.length > 0 && <div className="asset-sync-errors">{result.errors.map((error, index) => <div key={`${error}-${index}`}>{error}</div>)}</div>}</div>}
        <div className="modal-actions"><button className="secondary" onClick={onClose}>{result ? "关闭" : "取消"}</button><button className="primary" disabled={syncing || selectedTypes.length === 0} onClick={onSync}>{syncing ? "获取中…" : supportsResourceSync(account) ? (result ? "重新获取" : "开始获取并保存") : "查看接入状态"}</button></div>
      </section>
    </div>
  );
}
