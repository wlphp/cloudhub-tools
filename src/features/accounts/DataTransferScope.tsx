import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { databaseClient, type DatabaseImportPreview } from "../../platform/clients/database";
import { platformErrorMessage } from "../../platform/api";
import "./data-transfer-scope.css";

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
  const [loading, setLoading] = useState(enabled);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true); setError("");
    void databaseClient.transferCatalog().then(items => {
      if (!Array.isArray(items) || !items.length) throw new Error("暂无可用的数据范围，请更新本机程序后重试。");
      if (active) { setCategories(items); setTables(items.map(item => item.table)); }
    }).catch(reason => { if (active) setError(platformErrorMessage(reason, "读取数据范围失败，请重试。")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [enabled, revision]);
  return { categories, tables, setTables, error, loading, retry };
}
export function DataTransferScope({ categories, tables, onChange, disabled = false }: {
  categories: TransferCategory[]; tables: string[]; onChange: (tables: string[]) => void; disabled?: boolean;
}) {
  function toggle(groupItems: TransferCategory[]) {
    const names = new Set(groupItems.map(item => item.table));
    const selected = groupItems.every(item => tables.includes(item.table));
    onChange(selected ? tables.filter(table => !names.has(table)) : [...new Set([...tables, ...names])]);
  }
  return <fieldset disabled={disabled} className="data-transfer-scope"><legend>数据范围</legend>
    <GroupSelect items={categories} tables={tables} onToggle={() => toggle(categories)} label="全选" ariaLabel="选择全部数据" className="data-transfer-all" />
    {moduleGroups.map(([label, names]) => {
      const items=categories.filter(item => (names as readonly string[]).includes(item.table));
      if (!items.length) return null;
      return <Fragment key={label}><div className="data-transfer-group-heading"><GroupSelect items={items} tables={tables} onToggle={() => toggle(items)} label={label} ariaLabel={`全选${label}`} /></div>{items.map(item => <label className="data-transfer-check" key={item.table}><input type="checkbox" checked={tables.includes(item.table)} onChange={event => onChange(event.target.checked ? [...new Set([...tables, item.table])] : tables.filter(table => table !== item.table))} />{item.label}{item.count > 0 ? "（" + item.count + " 条）" : ""}</label>)}</Fragment>;
    })}
    <small>仅补齐所选记录需要的关联父记录，依赖只追加、不覆盖或删除。备份包含回收站；迁移与恢复默认排除，可单独勾选。桌面专属配置在手机仅保存。</small>
  </fieldset>;
}

function GroupSelect({ items, tables, onToggle, label, ariaLabel, className = "data-transfer-group-select" }: { items: TransferCategory[]; tables: string[]; onToggle: () => void; label: string; ariaLabel: string; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const selected = items.filter(item => tables.includes(item.table)).length;
  useEffect(() => { if (input.current) input.current.indeterminate = selected > 0 && selected < items.length; }, [selected, items.length]);
  return <label className={className}><input ref={input} type="checkbox" checked={items.length > 0 && selected === items.length} disabled={!items.length} onChange={onToggle} aria-label={ariaLabel} />{label}</label>;
}
