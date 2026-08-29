import { useEffect, useMemo, useState, type FormEvent, type MouseEvent } from "react";
import { cloudProvider, emptyAccountDraft } from "../cloud/catalog";
import {
  deleteAccount,
  exportAccounts as exportAccountRecords,
  importAccounts as importAccountRecords,
  listAccounts,
  revealAccountSecret,
  saveAccount,
  verifyAccount,
} from "../../platform/accounts";
import type { Account, ConfirmRequest, Draft, TransferAccount } from "../../shared/types";

type UseAccountsOptions = {
  notify: (message: string) => void;
  pageSize: number;
  requestConfirm: (
    message: string,
    options?: Pick<ConfirmRequest, "tone" | "title" | "confirmLabel">,
  ) => Promise<boolean>;
};

function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useAccounts({ notify, pageSize, requestConfirm }: UseAccountsOptions) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<number>>(() => new Set());
  const [keyword, setKeyword] = useState("");
  const [dialog, setDialog] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyAccountDraft);
  const [moreId, setMoreId] = useState<number | null>(null);
  const [morePosition, setMorePosition] = useState<{ top: number; left: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const [filterField, setFilterField] = useState<"account_name" | "access_key_id">("account_name");
  const [groupFilter, setGroupFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("1");
  const [cloudFilter, setCloudFilter] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [page, setPage] = useState(1);

  const load = async () => {
    const startedAt = Date.now();
    setSearchLoading(true);
    try {
      setAccounts(await listAccounts(keyword));
    } catch (error) {
      notify(String(error));
    } finally {
      const remaining = 320 - (Date.now() - startedAt);
      if (remaining > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
      setSearchLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    setSelectedAccountIds((current) => {
      const ids = new Set(accounts.map((account) => account.id));
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [accounts]);
  useEffect(() => { setPage(1); }, [keyword, filterField, groupFilter, statusFilter, cloudFilter]);
  useEffect(() => {
    if (moreId === null) return;
    const close = (event: globalThis.MouseEvent) => {
      if (!(event.target as HTMLElement).closest(".more-wrap")) {
        setMoreId(null);
        setMorePosition(null);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [moreId]);

  const visibleAccounts = useMemo(() => accounts.filter((account) => {
    const source = filterField === "account_name" ? account.account_name : account.access_key_id;
    const matchesKeyword = !keyword.trim() || source.toLowerCase().includes(keyword.trim().toLowerCase());
    const matchesGroup = !groupFilter || (account.group_name || "") === groupFilter;
    const matchesStatus = statusFilter === "all" || (statusFilter === "1" ? account.enabled : !account.enabled);
    const matchesCloud = !cloudFilter || account.cloud_type === cloudFilter;
    return matchesKeyword && matchesGroup && matchesStatus && matchesCloud;
  }), [accounts, keyword, filterField, groupFilter, statusFilter, cloudFilter]);
  const pagedAccounts = visibleAccounts.slice((page - 1) * pageSize, page * pageSize);
  const pagedAccountIds = pagedAccounts.map((account) => account.id);
  const allPagedAccountsSelected = pagedAccountIds.length > 0 && pagedAccountIds.every((id) => selectedAccountIds.has(id));
  const groups = useMemo(() => [...new Set(accounts.map((account) => account.group_name || "").filter(Boolean))].sort(), [accounts]);

  function openCreateDialog() {
    setDraft(emptyAccountDraft);
    setShowSecret(false);
    setDialog(true);
  }
  function edit(account: Account) {
    let credentialMeta: { tenancy_ocid?: string; key_fingerprint?: string; tenant_id?: string; subscription_id?: string; project_id?: string } = {};
    try { credentialMeta = JSON.parse(account.credential_meta || "{}"); } catch { /* legacy account */ }
    setShowSecret(false);
    setDraft({
      id: account.id,
      account_name: account.account_name,
      cloud_type: account.cloud_type,
      group_name: account.group_name ?? "",
      access_key_id: account.access_key_id,
      access_key_secret: "",
      tenancy_ocid: credentialMeta.tenancy_ocid || "",
      key_fingerprint: credentialMeta.key_fingerprint || "",
      tenant_id: credentialMeta.tenant_id || "",
      subscription_id: credentialMeta.subscription_id || "",
      project_id: credentialMeta.project_id || "",
      region_id: account.region_id ?? "",
      sort_order: account.sort_order ?? 0,
      enabled: account.enabled,
      remark: account.remark ?? "",
    });
    setDialog(true);
    setMoreId(null);
  }
  async function toggleEnabled(account: Account) {
    try {
      await saveAccount({
        id: account.id,
        account_name: account.account_name,
        cloud_type: account.cloud_type,
        group_name: account.group_name || null,
        access_key_id: account.access_key_id,
        access_key_secret: null,
        credential_meta: account.credential_meta || null,
        region_id: account.region_id || null,
        sort_order: account.sort_order ?? 0,
        enabled: !account.enabled,
        remark: account.remark || null,
      });
      await load();
    } catch (error) { notify(String(error)); }
  }
  function toggleSelection(id: number) {
    setSelectedAccountIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function togglePagedSelection() {
    setSelectedAccountIds((current) => {
      const next = new Set(current);
      if (allPagedAccountsSelected) pagedAccountIds.forEach((id) => next.delete(id));
      else pagedAccountIds.forEach((id) => next.add(id));
      return next;
    });
  }
  function toggleMore(id: number, count: number, event: MouseEvent<HTMLButtonElement>) {
    if (moreId === id) { setMoreId(null); setMorePosition(null); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    const menuHeight = Math.min(280, 14 + count * 38);
    const top = rect.bottom + menuHeight > window.innerHeight ? Math.max(8, rect.top - menuHeight - 6) : rect.bottom + 6;
    setMoreId(id);
    setMorePosition({ top, left: Math.max(8, Math.min(window.innerWidth - 182, rect.right - 174)) });
  }
  function closeMore() {
    setMoreId(null);
    setMorePosition(null);
  }
  async function toggleSecretVisibility() {
    if (!showSecret && draft.id && !draft.access_key_secret) {
      try {
        const secret = await revealAccountSecret(draft.id);
        setDraft((current) => ({ ...current, access_key_secret: secret }));
      } catch (error) { notify(`读取 Secret 失败：${String(error)}`); return; }
    }
    setShowSecret((value) => !value);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    notify("保存中…");
    try {
      const normalizedDraft = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, typeof value === "string" ? value.trim() : value])) as Draft;
      const input = {
        ...normalizedDraft,
        access_key_id: normalizedDraft.access_key_id || (normalizedDraft.cloud_type === "vultr" ? normalizedDraft.account_name : ""),
        group_name: normalizedDraft.group_name || null,
        region_id: normalizedDraft.region_id || null,
        remark: normalizedDraft.remark || null,
        access_key_secret: normalizedDraft.access_key_secret || null,
        credential_meta: normalizedDraft.cloud_type === "oracle" ? JSON.stringify({ tenancy_ocid: normalizedDraft.tenancy_ocid, key_fingerprint: normalizedDraft.key_fingerprint }) : normalizedDraft.cloud_type === "azure" ? JSON.stringify({ tenant_id: normalizedDraft.tenant_id, subscription_id: normalizedDraft.subscription_id }) : normalizedDraft.cloud_type === "gcp" ? JSON.stringify({ project_id: normalizedDraft.project_id }) : null,
      };
      const saved = await saveAccount(input);
      if (saved.cloud_type !== draft.cloud_type) throw new Error(`账号保存类型异常：期望 ${cloudProvider(draft.cloud_type).label}，实际为 ${cloudProvider(saved.cloud_type).label}。请重启本地服务后重试。`);
      setDialog(false);
      setDraft(emptyAccountDraft);
      notify("账号已保存");
      await load();
    } catch (error) { notify(String(error)); }
  }
  async function verify() {
    if (!draft.id || !["vultr", "ctyun", "huawei", "baidu", "jdcloud", "ucloud", "qingcloud", "ksyun", "qiniu", "aws", "azure", "gcp"].includes(draft.cloud_type)) return;
    setVerifying(true);
    try {
      const result = await verifyAccount(draft.id, draft.cloud_type);
      notify(`${cloudProvider(draft.cloud_type).label}账号验证成功，已读取 ${result.region_count} 个地域`);
      if (!draft.region_id && result.default_region) setDraft((current) => ({ ...current, region_id: result.default_region }));
    } catch (error) { notify(`${cloudProvider(draft.cloud_type).label}账号验证失败：${String(error)}`); } finally { setVerifying(false); }
  }
  async function remove(id: number) {
    const confirmed = await requestConfirm("删除后将移除本机保存的账号信息和访问密钥，不会影响云端资源。", { tone: "danger", title: "删除云账号", confirmLabel: "删除账号" });
    if (!confirmed) return;
    try { await deleteAccount(id); notify("账号已删除"); await load(); } catch (error) { notify(String(error)); }
  }
  async function exportSelected() {
    const accountIds = [...selectedAccountIds];
    const exportCount = accountIds.length || accounts.length;
    const exportScope = accountIds.length ? `已勾选的 ${accountIds.length} 个` : `全部 ${exportCount} 个`;
    if (!(await requestConfirm(`导出文件会包含 AccessKey Secret，将导出${exportScope}云账号，请妥善保管。确定继续吗？`))) return;
    try {
      const result = await exportAccountRecords(accountIds);
      if (result.kind === "file") { notify(`已导出云账号，文件已保存到：${result.path}`); return; }
      downloadJson({ format: "cloudhub-tools-account-export", version: 2, encryption: "plaintext", secret_exported: true, exported_at: new Date().toISOString(), accounts: result.accounts }, `cloudhub-tools-accounts-${new Date().toISOString().slice(0, 10)}.json`);
      notify(`已导出 ${result.accounts.length} 个云账号`);
    } catch (error) { notify(`导出失败：${String(error)}`); }
  }
  async function importFile(file: File) {
    setImporting(true);
    try {
      const parsed = JSON.parse(await file.text());
      const data = (Array.isArray(parsed) ? parsed : parsed.accounts) as TransferAccount[];
      if (!Array.isArray(data)) throw new Error("文件格式无效，需要 accounts 数组");
      if (!data.length) throw new Error("导入文件中没有云账号");
      const missingSecret = data.findIndex((item) => !String(item?.access_key_secret || "").trim());
      if (missingSecret >= 0) throw new Error(`第 ${missingSecret + 1} 条账号没有 AccessKey Secret，请使用完整导出文件`);
      const count = await importAccountRecords(data);
      notify(`已导入 ${count} 个云账号`);
      await load();
    } catch (error) { notify(`导入失败：${String(error)}`); } finally { setImporting(false); }
  }

  return {
    accounts, keyword, setKeyword, dialog, setDialog, showSecret, verifying, draft, setDraft,
    moreId, morePosition, importing, filterField, setFilterField, groupFilter, setGroupFilter,
    statusFilter, setStatusFilter, cloudFilter, setCloudFilter, searchLoading, page, setPage,
    groups, visibleAccounts, pagedAccounts, selectedAccountIds, allPagedAccountsSelected,
    load, openCreateDialog, edit, toggleEnabled, toggleSelection, togglePagedSelection, toggleMore, closeMore,
    toggleSecretVisibility, save, verify, remove, exportSelected, importFile,
  };
}
