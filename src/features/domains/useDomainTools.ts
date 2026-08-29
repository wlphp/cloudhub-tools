import { useEffect, useState } from "react";
import { invoke, runningInTauri, webApi } from "../../platform/api";
import { cloudProvider } from "../cloud/catalog";
import type { DomainTool } from "../../shared/types";

const readOnlyDnsCloudTypes = new Set([
  "tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud",
  "aws", "jdcloud", "qingcloud", "ksyun", "azure", "gcp",
]);

type DnsEditorState = {
  mode: "add" | "edit" | "quick";
  row?: Record<string, unknown>;
  preset?: { type?: string; rr?: string };
};

type DnsInput = {
  type: string;
  rr: string;
  value: string;
  ttl: number;
  priority: number;
  line: string;
};

type DomainToolsOptions = {
  notify: (message: string) => void;
  confirm: (message: string) => Promise<boolean>;
};

export function useDomainTools({ notify, confirm }: DomainToolsOptions) {
  const [keyword, setKeyword] = useState("");
  const [keywordDraft, setKeywordDraft] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [tool, setTool] = useState<DomainTool | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [draftFilter, setDraftFilter] = useState("");
  const [draftTypeFilter, setDraftTypeFilter] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [editor, setEditor] = useState<DnsEditorState | null>(null);
  const [inlineEdit, setInlineEdit] = useState<{ recordId: string; field: "Value" | "RR" | "TTL" | "Priority" | "Line" } | null>(null);
  const pageSize = 20;

  const ensureWritableDns = (current: DomainTool) => {
    if (!readOnlyDnsCloudTypes.has(current.account.cloud_type)) return true;
    notify(`${cloudProvider(current.account.cloud_type).label} DNS 解析当前仅支持只读查看`);
    return false;
  };

  const load = async (current: DomainTool) => {
    const startedAt = Date.now();
    setLoading(true);
    setError("");
    try {
      if (current.kind === "whois") {
        const text = runningInTauri
          ? await invoke<string>("query_whois", { id: current.account.id, domain: current.domain })
          : await webApi<string>(`/api/whois?id=${current.account.id}&domain=${encodeURIComponent(current.domain)}`);
        setData({ text });
        return;
      }
      const next = runningInTauri
        ? await invoke<Record<string, unknown>>(
            current.kind === "dns" ? "list_dns_records" : "list_domain_logs",
            current.kind === "dns"
              ? { id: current.account.id, domain: current.domain, recordType: typeFilter || null, keyword: filter || null, pageNumber: page, pageSize }
              : { id: current.account.id, domain: current.domain, startDate: null, endDate: null, keyword: filter || null, pageNumber: page, pageSize },
          )
        : await webApi<Record<string, unknown>>(
            `/api/${current.kind === "dns" ? "dns-records" : "domain-logs"}?id=${current.account.id}&domain=${encodeURIComponent(current.domain)}&page=${page}&pageSize=${pageSize}${filter ? `&keyword=${encodeURIComponent(filter)}` : ""}${current.kind === "dns" && typeFilter ? `&type=${typeFilter}` : ""}`,
          );
      setData(next);
      const nextTotal = Number(next.total ?? 0);
      if (!Number.isNaN(nextTotal)) setTotal(nextTotal);
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      const delay = 320 - (Date.now() - startedAt);
      if (delay > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tool && tool.kind !== "whois") void load(tool);
    // The explicit search controls own the filter values consumed by load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, typeFilter, page]);

  const open = (next: DomainTool) => {
    setTool(next);
    void load(next);
  };

  const close = () => {
    setTool(null);
    setMaximized(false);
    setEditor(null);
    setInlineEdit(null);
  };

  const search = () => {
    if (!tool) return;
    if (draftTypeFilter !== typeFilter || draftFilter !== filter) {
      setPage(1);
      setTypeFilter(draftTypeFilter);
      setFilter(draftFilter);
      return;
    }
    void load(tool);
  };

  const searchDomains = () => {
    setSearchLoading(true);
    setKeyword(keywordDraft);
    window.setTimeout(() => setSearchLoading(false), 320);
  };

  const add = () => {
    if (tool?.kind === "dns" && ensureWritableDns(tool)) setEditor({ mode: "add" });
  };

  const quickAdd = (recordType: string, rr: string) => {
    if (tool?.kind === "dns" && ensureWritableDns(tool)) setEditor({ mode: "quick", preset: { type: recordType, rr } });
  };

  const submitEditor = async (input: DnsInput) => {
    if (!tool || tool.kind !== "dns" || !ensureWritableDns(tool)) return;
    const isEdit = editor?.mode === "edit" && editor.row;
    const payload = isEdit
      ? { id: tool.account.id, recordId: String(editor.row!.RecordId), recordType: input.type, rr: input.rr, value: input.value, ttl: input.ttl, priority: input.priority, line: input.line }
      : { id: tool.account.id, domain: tool.domain, recordType: input.type, rr: input.rr, value: input.value, ttl: input.ttl, priority: input.priority || undefined, line: input.line };
    if (runningInTauri) {
      await invoke(isEdit ? "update_dns_record" : "add_dns_record", payload);
    } else {
      await webApi("/api/dns-records", { method: isEdit ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    }
    await load(tool);
    notify(isEdit ? "解析记录已更新" : "解析记录已添加");
    setEditor(null);
  };

  const updateField = async (row: Record<string, unknown>, field: "Value" | "RR" | "TTL" | "Priority" | "Line", value: string) => {
    if (!tool || tool.kind !== "dns" || !ensureWritableDns(tool)) return;
    setInlineEdit(null);
    const normalized = value.trim();
    if (normalized === String(row[field] ?? "")) return;
    try {
      const payload = {
        id: tool.account.id, recordId: String(row.RecordId), recordType: String(row.Type || "A"), rr: String(row.RR || ""), value: String(row.Value || ""), ttl: Number(row.TTL || 600), priority: Number(row.Priority || 10), line: String(row.Line || "default"),
        ...(field === "Value" ? { value: normalized } : {}), ...(field === "RR" ? { rr: normalized } : {}), ...(field === "TTL" ? { ttl: Number(normalized) || 600 } : {}), ...(field === "Priority" ? { priority: Number(normalized) || 10 } : {}), ...(field === "Line" ? { line: normalized } : {}),
      };
      if (runningInTauri) await invoke("update_dns_record", payload);
      else await webApi("/api/dns-records", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      await load(tool);
      notify(`${field} 已更新`);
    } catch (updateError) {
      setError(String(updateError));
    }
  };

  const rowAction = async (row: Record<string, unknown>, action: "toggle" | "delete" | "edit") => {
    if (!tool || tool.kind !== "dns" || !ensureWritableDns(tool)) return;
    try {
      if (action === "delete" && !(await confirm(`确定删除 ${String(row.RR || "")} 记录吗？`))) return;
      if (action === "edit") {
        setEditor({ mode: "edit", row });
        return;
      }
      const payload = { id: tool.account.id, recordId: String(row.RecordId), status: String(row.Status).toUpperCase() === "ENABLE" ? "Disable" : "Enable" };
      if (runningInTauri) await invoke(action === "delete" ? "delete_dns_record" : "toggle_dns_record", action === "delete" ? { id: tool.account.id, recordId: String(row.RecordId) } : payload);
      else await webApi("/api/dns-records", { method: action === "delete" ? "DELETE" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      await load(tool);
      notify(action === "delete" ? "解析记录已删除" : "解析记录状态已更新");
    } catch (actionError) {
      setError(String(actionError));
    }
  };

  return {
    keyword, keywordDraft, setKeywordDraft, searchLoading, searchDomains,
    tool, loading, error, data, maximized, setMaximized, filter: draftFilter, setFilter: setDraftFilter,
    typeFilter: draftTypeFilter, setTypeFilter: setDraftTypeFilter, page, setPage, pageSize, total,
    editor, setEditor, inlineEdit, setInlineEdit, open, close, load, search, add, quickAdd, submitEditor, updateField, rowAction,
  };
}
