import { Fragment, useEffect, useState } from "react";
import { databaseClient, type DatabaseImportPreview } from "../../platform/clients/database";

export type TransferCategory = DatabaseImportPreview["categories"][number];
const moduleGroups = [
  ["云账号与连接", ["cloud_accounts", "ssh_connections", "managed_hosts", "rdp_connections"]],
  ["面板与证书", ["panel_connections", "certificates", "certificate_versions", "certificate_source_links", "esa_certificate_deployments"]],
  ["流水线与 FRP", ["flow_connections", "frp_local_settings", "frp_local_servers", "frp_local_proxies", "frp_clients", "frp_local_client"]],
  ["AI 与供应商", ["claude_providers", "codex_model_providers", "codex_provider_keys", "codex_provider_aggregates", "codex_provider_aggregate_members", "ai_profiles"]],
  ["备忘录与工具", ["memo_groups", "memo_notes", "browser_environments", "authenticator_entries"]],
  ["云盘、资产与外观", ["transfer_cloud_drive", "transfer_asset_metadata", "client_preferences"]],
] as const;
export function useTransferCatalog(enabled = true) {
  const [categories, setCategories] = useState<TransferCategory[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void databaseClient.transferCatalog().then(items => {
      if (active) { setCategories(items); setTables(items.map(item => item.table)); }
    }).catch(() => { if (active) setError("读取迁移范围失败，请重新打开窗口。"); });
    return () => { active = false; };
  }, [enabled]);
  return { categories, tables, setTables, error };
}
export function DataTransferScope({ categories, tables, onChange, disabled = false }: {
  categories: TransferCategory[]; tables: string[]; onChange: (tables: string[]) => void; disabled?: boolean;
}) {
  return <fieldset disabled={disabled} className="data-transfer-scope"><legend>数据范围</legend>
    <button type="button" className="secondary" onClick={() => onChange(tables.length === categories.length ? [] : categories.map(item => item.table))}>{tables.length === categories.length ? "清空选择" : "全部选择"}</button>
    {moduleGroups.map(([label, names]) => {
      const items=categories.filter(item => (names as readonly string[]).includes(item.table));
      return items.length ? <Fragment key={label}><strong className="data-transfer-group">{label}</strong>{items.map(item => <label className="data-transfer-check" key={item.table}><input type="checkbox" checked={tables.includes(item.table)} onChange={event => onChange(event.target.checked ? [...tables, item.table] : tables.filter(table => table !== item.table))} />{item.label}{item.count > 0 ? "（" + item.count + " 条）" : ""}</label>)}</Fragment> : null;
    })}
    <small>仅补齐所选记录需要的关联父记录，依赖只追加、不覆盖或删除。备份包含回收站；迁移与恢复默认排除，可单独勾选。桌面专属配置在手机仅保存。</small>
  </fieldset>;
}
