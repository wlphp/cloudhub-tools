import type { MouseEvent } from "react";
import { Cloud, Download, MoreHorizontal, Plus, RefreshCw, Trash2 } from "lucide-react";
import { assetTypes, cloudProvider, cloudProviders, supportsResourceSync, syncAssetTypes } from "../cloud/catalog";
import type { Account, LocalAsset } from "../../shared/types";

type AccountResourceType = (typeof assetTypes)[number][0];

const accountResourceActionLabels: Record<AccountResourceType, string> = {
  ecs: "服务器", domain: "域名", oss: "对象存储", rds: "云数据库", redis: "Redis", swas: "轻量服务器", esa: "边缘安全加速", block: "块存储", network: "私有网络", firewall: "防火墙", ip: "保留 IP", loadbalancer: "负载均衡", snapshot: "快照", kubernetes: "Kubernetes",
};

type AccountsPageProps = {
  accounts: Account[];
  localAssets: LocalAsset[];
  filterField: "account_name" | "access_key_id";
  keyword: string;
  groupFilter: string;
  statusFilter: string;
  cloudFilter: string;
  groups: string[];
  accountSearchLoading: boolean;
  importing: boolean;
  selectedAccountIds: Set<number>;
  pagedAccounts: Account[];
  visibleAccountCount: number;
  page: number;
  pageSize: number;
  allPagedAccountsSelected: boolean;
  moreId: number | null;
  morePosition: { top: number; left: number } | null;
  onFilterFieldChange: (value: "account_name" | "access_key_id") => void;
  onKeywordChange: (value: string) => void;
  onGroupFilterChange: (value: string) => void;
  onStatusFilterChange: (value: string) => void;
  onCloudFilterChange: (value: string) => void;
  onSearch: () => void;
  onCreate: () => void;
  onGroupManage: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onTogglePagedSelection: () => void;
  onToggleSelection: (id: number) => void;
  onToggleEnabled: (account: Account) => void;
  onToggleMore: (id: number, count: number, event: MouseEvent<HTMLButtonElement>) => void;
  onOpenResource: (account: Account, resourceType: AccountResourceType) => void;
  onStartSync: (account: Account) => void;
  onOpenSummary: (account: Account) => void;
  onEdit: (account: Account) => void;
  onRemove: (id: number) => void;
  onPageChange: (page: number) => void;
};

export function AccountsPage(props: AccountsPageProps) {
  const accountResourceActions = (account: Account) => syncAssetTypes(account)
    .map(([resourceType], order) => ({
      resourceType,
      count: props.localAssets.filter((asset) => asset.account_id === account.id && asset.resource_type === resourceType).length,
      order,
    }))
    .sort((left, right) => right.count - left.count || left.order - right.order);

  return (
    <>
      <header><div><span className="eyebrow">LOCAL CONSOLE</span><h1>云账号管理</h1><p>多云账号、密钥和已获取资源都加密保存在当前设备。</p></div></header>
      <section className="stats"><div><span>云账号</span><strong>{props.accounts.length}</strong><small>本地管理</small></div><div><span>已启用</span><strong>{props.accounts.filter((account) => account.enabled).length}</strong><small>可调用</small></div><div><span>资源总数</span><strong>{props.localAssets.length}</strong><small>已获取资产</small></div></section>
      <section className="panel">
        <div className="layui-toolbar">
          <select value={props.filterField} aria-label="关键词字段" onChange={(event) => props.onFilterFieldChange(event.target.value as "account_name" | "access_key_id")}><option value="account_name">账号名称</option><option value="access_key_id">AccessKeyId</option></select>
          <input className="account-keyword-input" value={props.keyword} onChange={(event) => props.onKeywordChange(event.target.value)} onKeyDown={(event) => event.key === "Enter" && props.onSearch()} placeholder="请输入关键词" aria-label="关键词" />
          <label>分组：</label><select className="account-group-filter" aria-label="按分组筛选" value={props.groupFilter} onChange={(event) => props.onGroupFilterChange(event.target.value)}><option value="">全部分组</option>{props.groups.map((group) => <option key={group} value={group}>{group}</option>)}</select>
          <label>状态：</label><select className="account-status-filter" aria-label="按状态筛选" value={props.statusFilter} onChange={(event) => props.onStatusFilterChange(event.target.value)}><option value="1">启用</option><option value="0">禁用</option><option value="all">全部</option></select>
          <label>云类型：</label><select className="account-cloud-filter" aria-label="按云类型筛选" value={props.cloudFilter} onChange={(event) => props.onCloudFilterChange(event.target.value)}><option value="">全部</option>{cloudProviders.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}{props.accounts.some((account) => account.cloud_type === "other") && <option value="other">未接入云（历史账号）</option>}</select>
          <button type="button" className="layui-btn layui-btn-search account-search-button" title="按当前条件搜索账号" aria-label="搜索账号" disabled={props.accountSearchLoading} onClick={props.onSearch}><RefreshCw className={props.accountSearchLoading ? "spin" : undefined} size={14} />{props.accountSearchLoading ? "查询中…" : "搜索"}</button>
          <button type="button" className="layui-btn account-add-button" title="添加云账号" aria-label="添加云账号" onClick={props.onCreate}><Plus size={14} />添加</button>
          <button type="button" className="layui-btn account-group-button" title="账号分组跟随账号编辑" aria-label="分组管理" onClick={props.onGroupManage}>分组管理</button>
          <button type="button" className="layui-btn account-export-button" title={props.selectedAccountIds.size ? `导出已勾选 ${props.selectedAccountIds.size} 个账号` : "导出全部账号"} aria-label="导出账号" onClick={props.onExport}><Download size={14} />{props.selectedAccountIds.size ? `导出已勾选 (${props.selectedAccountIds.size})` : "导出全部"}</button>
          <label className="layui-btn layui-btn-import account-import-button" title="导入账号 JSON">导入<input type="file" accept=".json,application/json" onChange={(event) => event.target.files?.[0] && props.onImport(event.target.files[0])} disabled={props.importing} /></label>
        </div>
        {props.accounts.length === 0 ? <div className="empty"><Cloud size={40} /><h3>还没有云账号</h3><p>添加一个阿里云 RAM 账号开始管理。</p><button className="primary" onClick={props.onCreate}><Plus size={17} />添加第一个账号</button></div> : <div className="table-wrap"><table><thead><tr><th className="account-select"><input aria-label="全选当前页账号" type="checkbox" checked={props.allPagedAccountsSelected} onChange={props.onTogglePagedSelection} /></th><th>云类型 / AccessKeyId</th><th>账号名称 / 添加时间</th><th>分组</th><th>备注</th><th>状态</th><th className="account-resources-column">资源</th><th className="account-actions-column">操作</th></tr></thead><tbody>
          {props.pagedAccounts.map((account) => {
            const resourceActions = accountResourceActions(account);
            const primaryResourceActions = resourceActions.slice(0, 3);
            const moreResourceActions = resourceActions.slice(3);
            return <tr key={account.id}>
              <td className="account-select"><input aria-label={`选择账号 ${account.account_name}`} type="checkbox" checked={props.selectedAccountIds.has(account.id)} onChange={() => props.onToggleSelection(account.id)} /></td>
              <td><div className="account-cloud-credential"><span className={`cloud-type cloud-type-text ${account.cloud_type}`}>{cloudProvider(account.cloud_type).label}</span><code>{account.access_key_id.length > 10 ? `${account.access_key_id.slice(0, 6)}****${account.access_key_id.slice(-4)}` : account.access_key_id}</code></div></td>
              <td><div className="account-name"><span className={`avatar cloud-avatar ${account.cloud_type}`}>{cloudProvider(account.cloud_type).avatar}</span><div><strong>{account.account_name}</strong><small>{new Date(account.created_at).toLocaleString("zh-CN")}</small></div></div></td>
              <td>{account.group_name || ""}</td><td>{account.remark || ""}</td>
              <td><button className={`status-switch ${account.enabled ? "checked" : ""}`} onClick={() => props.onToggleEnabled(account)}>{account.enabled ? "启用" : "禁用"}</button></td>
              <td className="account-resources-cell">{supportsResourceSync(account) ? <div className="resource-actions account-resource-actions">{primaryResourceActions.map(({ resourceType, count }) => <button key={resourceType} type="button" className={resourceType === "domain" ? "purple" : "blue"} title={`查看${accountResourceActionLabels[resourceType]}资产（已获取 ${count} 项）`} aria-label={`查看 ${account.account_name} ${accountResourceActionLabels[resourceType]}资产，已获取 ${count} 项`} onClick={() => props.onOpenResource(account, resourceType)}>{accountResourceActionLabels[resourceType]}</button>)}{moreResourceActions.length > 0 && <span className={`more-wrap ${props.moreId === account.id ? "more-open" : ""}`}><button type="button" className="action-text more-trigger" title="更多资产类型" aria-label={`更多 ${account.account_name} 资产操作`} onClick={(event) => props.onToggleMore(account.id, moreResourceActions.length, event)}><MoreHorizontal size={17} /></button>{props.moreId === account.id && <div className="more-menu" style={props.morePosition ? { position: "fixed", top: props.morePosition.top, left: props.morePosition.left, right: "auto" } : undefined}>{moreResourceActions.map(({ resourceType, count }) => <button key={resourceType} title={`查看${accountResourceActionLabels[resourceType]}资产（已获取 ${count} 项）`} aria-label={`查看 ${account.account_name} ${accountResourceActionLabels[resourceType]}资产，已获取 ${count} 项`} onClick={() => props.onOpenResource(account, resourceType)}>{accountResourceActionLabels[resourceType]}</button>)}</div>}</span>}</div> : <span className="account-resource-muted">—</span>}</td>
              <td className="account-actions-cell"><div className="resource-actions account-actions">{supportsResourceSync(account) ? <><button type="button" className="teal" title="选择资产类型并同步到本地" aria-label={`获取 ${account.account_name} 资产`} onClick={() => props.onStartSync(account)}>获取资产</button><button type="button" className="orange" title="打开账号资产汇总" aria-label={`打开 ${account.account_name} 资产汇总`} onClick={() => props.onOpenSummary(account)}>汇总</button></> : <span className="action-text">仅保留历史账号</span>}<button type="button" className="action-text" title={`修改 ${account.account_name}`} aria-label={`修改 ${account.account_name}`} onClick={() => props.onEdit(account)}>修改</button><button type="button" className="action-text danger account-delete-action" title={`删除 ${account.account_name}`} aria-label={`删除 ${account.account_name}`} onClick={() => props.onRemove(account.id)}><Trash2 size={13} aria-hidden="true" />删除</button></div></td>
            </tr>;
          })}
        </tbody></table></div>}
        <div className="pagination"><span>共 {props.visibleAccountCount} 条记录</span><button disabled={props.page <= 1} onClick={() => props.onPageChange(Math.max(1, props.page - 1))}>‹</button><strong>{props.page}</strong><button disabled={props.page >= Math.max(1, Math.ceil(props.visibleAccountCount / props.pageSize))} onClick={() => props.onPageChange(props.page + 1)}>›</button></div>
      </section>
    </>
  );
}
