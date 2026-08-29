import { type FormEvent, type PointerEvent, useMemo, useRef, useState } from "react";
import { emptyManagedHostDraft } from "../cloud/catalog";
import { invoke, runningInTauri } from "../../platform/api";
import { stringListFromValue } from "../assets/preferences";
import type { ManagedHost, ManagedHostDraft } from "../../shared/types";

export const managedHostOrderStorageKey = "cloudhub-managed-host-order";
export const managedHostGroupOrderStorageKey = "cloudhub-managed-host-group-order";

type UseManagedHostsOptions = {
  confirm: (message: string) => Promise<boolean>;
  notify: (message: string) => void;
};

export function useManagedHosts({ confirm, notify }: UseManagedHostsOptions) {
  const [hosts, setHosts] = useState<ManagedHost[]>([]);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<ManagedHostDraft>(emptyManagedHostDraft);
  const [saving, setSaving] = useState(false);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [keyword, setKeyword] = useState("");
  const [group, setGroup] = useState("");
  const [order, setOrder] = useState<string[]>(() => stringListFromValue(localStorage.getItem(managedHostOrderStorageKey) || undefined));
  const [groupOrder, setGroupOrder] = useState<string[]>(() => stringListFromValue(localStorage.getItem(managedHostGroupOrderStorageKey) || undefined));
  const [sorting, setSorting] = useState(false);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [draggedGroup, setDraggedGroup] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [moreId, setMoreId] = useState<number | null>(null);
  const dragIdRef = useRef<number | null>(null);
  const groupDragRef = useRef<string | null>(null);

  const groups = useMemo(() => {
    const positions = new Map(groupOrder.map((name, index) => [name, index]));
    return Array.from(new Set(hosts.map((host) => host.group_name || "未分组")))
      .sort((left, right) => (positions.get(left) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right, "zh-CN"));
  }, [hosts, groupOrder]);

  const visibleHosts = useMemo(() => {
    const positions = new Map(order.map((id, index) => [id, index]));
    const search = keyword.trim().toLowerCase();
    return hosts.filter((host) => (!group || (host.group_name || "未分组") === group)
      && (!search || [host.name, host.host, host.username, host.group_name, host.tags, host.remark].some((value) => String(value || "").toLowerCase().includes(search))))
      .sort((left, right) => (positions.get(String(left.id)) ?? Number.MAX_SAFE_INTEGER) - (positions.get(String(right.id)) ?? Number.MAX_SAFE_INTEGER) || left.name.localeCompare(right.name, "zh-CN"));
  }, [hosts, order, group, keyword]);

  async function load() {
    if (!runningInTauri) return;
    try { setHosts(await invoke<ManagedHost[]>("list_managed_hosts")); }
    catch (error) { notify(`读取服务器管理列表失败：${String(error)}`); }
  }

  function openDialog(host?: ManagedHost) {
    setDraft(host ? {
      id: host.id, name: host.name, host: host.host, port: host.port, username: host.username, password: "",
      platform: host.platform === "windows" ? "windows" : "linux", auth_method: host.auth_method === "private_key" ? "private_key" : "password", private_key: "", key_passphrase: "",
      group_name: host.group_name || "", tags: host.tags || "", source_account_id: host.source_account_id,
      source_asset_key: host.source_asset_key, remark: host.remark || "",
    } : emptyManagedHostDraft);
    setDialogOpen(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runningInTauri) { notify("服务器管理仅支持桌面客户端"); return; }
    setSaving(true);
    try {
      const saved = await invoke<ManagedHost>("save_managed_host", { input: draft });
      setHosts((current) => current.some((host) => host.id === saved.id) ? current.map((host) => host.id === saved.id ? saved : host) : [...current, saved]);
      setDialogOpen(false);
      notify(draft.id ? "服务器已更新" : "服务器已加入管理，点击刷新状态完成首次探测");
    } catch (error) { notify(`保存服务器失败：${String(error)}`); }
    finally { setSaving(false); }
  }

  async function probe(id: number) {
    if (!runningInTauri || loadingId !== null) return;
    setLoadingId(id);
    try {
      const updated = await invoke<ManagedHost>("probe_managed_host", { id });
      setHosts((current) => current.map((host) => host.id === id ? updated : host));
      notify(updated.status === "online" ? `${updated.name} 状态已更新` : `${updated.name} 暂时无法连接`);
    } catch (error) { notify(`读取服务器状态失败：${String(error)}`); }
    finally { setLoadingId(null); }
  }

  async function remove(host: ManagedHost) {
    if (!(await confirm(`确认从服务器管理中移除“${host.name}”吗？本机保存的连接凭据也会删除。`))) return;
    try {
      await invoke("delete_managed_host", { id: host.id });
      setHosts((current) => current.filter((item) => item.id !== host.id));
      notify("服务器已移除");
    } catch (error) { notify(`移除服务器失败：${String(error)}`); }
  }

  async function exportHosts() {
    if (!hosts.length) { notify("没有可导出的服务器"); return; }
    if (!(await confirm(`导出文件会包含 ${hosts.length} 台服务器的连接凭据明文（SSH 密码/私钥或 RDP 密码），请妥善保管。确定继续吗？`))) return;
    try {
      const path = await invoke<string>("export_managed_hosts_file");
      notify(`已导出 ${hosts.length} 台服务器的连接凭据明文文件：${path}`);
    } catch (error) { notify(`导出服务器失败：${String(error)}`); }
  }

  async function importHosts(file: File) {
    setImporting(true);
    try {
      const parsed = JSON.parse(await file.text());
      const imported = Array.isArray(parsed) ? parsed : parsed.hosts;
      if (!Array.isArray(imported) || !imported.length) throw new Error("文件中没有服务器配置");
      const count = await invoke<number>("import_managed_hosts", { hosts: imported });
      await load();
      notify(`已导入 ${count} 台服务器`);
    } catch (error) { notify(`导入服务器失败：${String(error)}`); }
    finally { setImporting(false); }
  }

  function reorder(sourceId: number, targetId: number) {
    if (sourceId === targetId) return;
    const source = hosts.find((host) => host.id === sourceId);
    const target = hosts.find((host) => host.id === targetId);
    if (!source || !target || (source.group_name || "未分组") !== (target.group_name || "未分组")) return;
    const positions = new Map(order.map((id, index) => [id, index]));
    const groupHostIds = hosts.filter((host) => (host.group_name || "未分组") === (source.group_name || "未分组"))
      .sort((left, right) => (positions.get(String(left.id)) ?? Number.MAX_SAFE_INTEGER) - (positions.get(String(right.id)) ?? Number.MAX_SAFE_INTEGER))
      .map((host) => String(host.id));
    const movedId = String(sourceId);
    const nextGroupHostIds = groupHostIds.filter((id) => id !== movedId);
    nextGroupHostIds.splice(nextGroupHostIds.indexOf(String(targetId)), 0, movedId);
    const groupHostIdSet = new Set(groupHostIds);
    setOrder((current) => [...current.filter((id) => !groupHostIdSet.has(id)), ...nextGroupHostIds]);
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, sourceId: number) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragIdRef.current = sourceId;
    setDraggedId(sourceId);
    const cancel = () => { dragIdRef.current = null; setDraggedId(null); document.removeEventListener("pointerup", end); };
    const end = (endEvent: globalThis.PointerEvent) => {
      const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest<HTMLElement>("[data-managed-host-id]");
      const targetId = Number(target?.dataset.managedHostId);
      if (dragIdRef.current !== null && Number.isInteger(targetId)) reorder(dragIdRef.current, targetId);
      dragIdRef.current = null;
      setDraggedId(null);
      document.removeEventListener("pointercancel", cancel);
    };
    document.addEventListener("pointerup", end, { once: true });
    document.addEventListener("pointercancel", cancel, { once: true });
  }

  function reorderGroups(sourceGroup: string, targetGroup: string) {
    if (!sourceGroup || sourceGroup === targetGroup) return;
    const nextGroups = groups.filter((name) => name !== sourceGroup);
    nextGroups.splice(nextGroups.indexOf(targetGroup), 0, sourceGroup);
    setGroupOrder(nextGroups);
  }

  function startGroupDrag(event: PointerEvent<HTMLButtonElement>, sourceGroup: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    groupDragRef.current = sourceGroup;
    setDraggedGroup(sourceGroup);
    const cancel = () => { groupDragRef.current = null; setDraggedGroup(null); document.removeEventListener("pointerup", end); };
    const end = (endEvent: globalThis.PointerEvent) => {
      const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest<HTMLElement>("[data-managed-host-group]");
      const targetGroup = target?.dataset.managedHostGroup;
      if (groupDragRef.current && targetGroup) reorderGroups(groupDragRef.current, targetGroup);
      groupDragRef.current = null;
      setDraggedGroup(null);
      document.removeEventListener("pointercancel", cancel);
    };
    document.addEventListener("pointerup", end, { once: true });
    document.addEventListener("pointercancel", cancel, { once: true });
  }

  return {
    hosts, importing, importInputRef, dialogOpen, setDialogOpen, draft, setDraft, saving, loadingId,
    keyword, setKeyword, group, setGroup, order, setOrder, groupOrder, setGroupOrder, sorting, setSorting, draggedId, setDraggedId, draggedGroup, setDraggedGroup,
    collapsedGroups, setCollapsedGroups, moreId, setMoreId, groups, visibleHosts,
    load, openDialog, save, probe, remove, exportHosts, importHosts, startDrag, startGroupDrag,
  };
}
