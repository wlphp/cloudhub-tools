import { useEffect, useState } from "react";
import { databaseClient, type DatabaseImportPreview } from "../../platform/clients/database";

export type TransferCategory = DatabaseImportPreview["categories"][number];
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
    {categories.map(item => <label className="data-transfer-check" key={item.table}><input type="checkbox" checked={tables.includes(item.table)} onChange={event => onChange(event.target.checked ? [...tables, item.table] : tables.filter(table => table !== item.table))} />{item.label}{item.count > 0 ? "（" + item.count + " 条）" : ""}</label>)}
    <small>关联父记录会一并处理。只恢复数据；桌面专属配置在手机保存，执行能力仍由对应平台提供。</small>
  </fieldset>;
}
