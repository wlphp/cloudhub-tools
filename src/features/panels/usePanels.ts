import { type FormEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { emptyPanelConnectionDraft } from "../cloud/catalog";
import { invoke, runningInTauri } from "../../platform/api";
import { firstAddress } from "../../shared/utils/display";
import type { Account, LocalAsset, PanelConnection, PanelConnectionDraft } from "../../shared/types";

type PanelRemarkDraft = { id: number; value: string; initial: string } | null;

type UsePanelsOptions = {
  clientPreferencesReady: boolean;
  isVisible: boolean;
  notify: (message: string) => void;
  requestConfirm: (message: string) => Promise<boolean>;
  savePreference: (key: string, value: string) => void;
};

function nextSortOrder(panels: PanelConnection[]) {
  return Math.max(-1, ...panels.map((panel) => panel.sort_order ?? 0)) + 1;
}

export function usePanels({ clientPreferencesReady, isVisible, notify, requestConfirm, savePreference }: UsePanelsOptions) {
  const [connections, setConnections] = useState<PanelConnection[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<PanelConnectionDraft>(emptyPanelConnectionDraft);
  const [saving, setSaving] = useState(false);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [sorting, setSorting] = useState(false);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [keyword, setKeyword] = useState("");
  const [group, setGroup] = useState("");
  const [editingRemark, setEditingRemark] = useState<PanelRemarkDraft>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [expandedDiskIds, setExpandedDiskIds] = useState<Set<number>>(() => new Set());
  const [importing, setImporting] = useState(false);
  const [hideIps, setHideIps] = useState(() => localStorage.getItem("aliyun-panel-hide-ip") === "1");
  const [openMode, setOpenMode] = useState<"browser" | "copy">(() => localStorage.getItem("aliyun-panel-open-mode") === "copy" ? "copy" : "browser");
  const [refreshSeconds, setRefreshSeconds] = useState(() => {
    const value = Number(localStorage.getItem("aliyun-panel-refresh-seconds") || "0");
    return [0, 5, 10, 30, 60].includes(value) ? value : 0;
  });
  const refreshInFlightRef = useRef(false);
  const dragIdRef = useRef<number | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(
    () => Array.from(new Set(connections.map((panel) => panel.group_name || "未分组"))).sort(),
    [connections],
  );
  const visibleConnections = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return connections.filter((panel) => (!group || (panel.group_name || "未分组") === group)
      && (!normalizedKeyword || `${panel.name} ${panel.panel_url} ${panel.remark || ""}`.toLowerCase().includes(normalizedKeyword)));
  }, [connections, group, keyword]);

  async function load() {
    if (!runningInTauri) return;
    try {
      setConnections(await invoke<PanelConnection[]>("list_panel_connections"));
    } catch (error) {
      notify(`读取面板管理列表失败：${String(error)}`);
    }
  }

  function openDialog(panel?: PanelConnection) {
    setDraft(panel ? {
      id: panel.id,
      name: panel.name,
      panel_url: panel.panel_url,
      sort_order: panel.sort_order ?? 0,
      api_key: "",
      allow_insecure_tls: panel.allow_insecure_tls,
      group_name: panel.group_name || "",
      source_account_id: panel.source_account_id,
      source_asset_key: panel.source_asset_key,
      remark: panel.remark || "",
    } : { ...emptyPanelConnectionDraft, sort_order: nextSortOrder(connections) });
    setDialogOpen(true);
  }

  function openFromAsset(asset: LocalAsset, account: Account) {
    const payload = asset.payload || {};
    const ip = firstAddress(payload.PublicIpAddress || payload.PublicAddresses || payload.PublicIp || payload.InternetIp || payload.EipAddress);
    setDraft({
      ...emptyPanelConnectionDraft,
      name: String(payload.InstanceName || asset.asset_key),
      panel_url: ip ? `https://${ip}:8888` : "",
      sort_order: nextSortOrder(connections),
      group_name: account.group_name || "",
      source_account_id: account.id,
      source_asset_key: asset.asset_key,
      remark: `来源：${account.account_name} / ${asset.resource_type}`,
    });
    setDialogOpen(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runningInTauri) {
      notify("面板管理仅支持桌面客户端");
      return;
    }
    setSaving(true);
    try {
      await invoke<PanelConnection>("save_panel_connection", { input: draft });
      await load();
      setDialogOpen(false);
      notify("面板验证成功，已加入面板管理");
    } catch (error) {
      notify(`绑定面板失败：${String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function reorder(sourceId: number, targetId: number) {
    if (sourceId === targetId) return;
    const visibleIds = visibleConnections.map((panel) => panel.id);
    const sourceIndex = visibleIds.indexOf(sourceId);
    const targetIndex = visibleIds.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextVisibleIds = [...visibleIds];
    nextVisibleIds.splice(sourceIndex, 1);
    nextVisibleIds.splice(targetIndex, 0, sourceId);
    const visibleIdSet = new Set(nextVisibleIds);
    const remainingIds = connections.filter((panel) => !visibleIdSet.has(panel.id)).map((panel) => panel.id);
    const orderedIds = [...nextVisibleIds, ...remainingIds];
    const order = new Map(orderedIds.map((id, index) => [id, index]));
    setConnections((current) => [...current]
      .sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER))
      .map((panel, index) => ({ ...panel, sort_order: index })));
    try {
      await invoke("update_panel_connection_order", { ids: orderedIds });
    } catch (error) {
      notify(`保存面板排序失败：${String(error)}`);
      await load();
    }
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, sourceId: number) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragIdRef.current = sourceId;
    setDraggedId(sourceId);
    const endDrag = (endEvent: globalThis.PointerEvent) => {
      const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest<HTMLElement>("[data-panel-id]");
      const targetId = Number(target?.dataset.panelId);
      if (dragIdRef.current !== null && Number.isInteger(targetId)) void reorder(dragIdRef.current, targetId);
      dragIdRef.current = null;
      setDraggedId(null);
      document.removeEventListener("pointercancel", cancelDrag);
    };
    const cancelDrag = () => {
      dragIdRef.current = null;
      setDraggedId(null);
      document.removeEventListener("pointerup", endDrag);
    };
    document.addEventListener("pointerup", endDrag, { once: true });
    document.addEventListener("pointercancel", cancelDrag, { once: true });
  }

  async function refreshAll(quiet = false) {
    if (!runningInTauri || refreshInFlightRef.current || !connections.length) return;
    refreshInFlightRef.current = true;
    setLoadingId(-1);
    let online = 0;
    let offline = 0;
    let failed = 0;
    try {
      for (const panel of connections) {
        try {
          const updated = await invoke<PanelConnection>("refresh_panel_connection", { id: panel.id });
          setConnections((current) => current.map((item) => item.id === panel.id ? updated : item));
          if (updated.status === "online") online += 1;
          else offline += 1;
        } catch {
          failed += 1;
        }
      }
      if (!quiet) notify(`监控已刷新：${online} 台在线${offline ? `，${offline} 台离线` : ""}${failed ? `，${failed} 台失败` : ""}`);
    } finally {
      refreshInFlightRef.current = false;
      setLoadingId(null);
    }
  }

  async function openTemporaryLogin(panel: PanelConnection) {
    if (!runningInTauri || openingId !== null) return;
    setOpeningId(panel.id);
    try {
      const temporaryUrl = await invoke<string>("panel_temporary_login", { id: panel.id });
      if (openMode === "copy") {
        await navigator.clipboard.writeText(temporaryUrl);
        notify(`${panel.name} 的临时面板 URL 已复制`);
      } else {
        await openUrl(temporaryUrl);
        notify(`${panel.name} 已在默认浏览器中打开`);
      }
    } catch (error) {
      notify(`${openMode === "copy" ? "复制" : "打开"}面板失败：${String(error)}`);
    } finally {
      setOpeningId(null);
    }
  }

  async function openDataDirectory() {
    if (!runningInTauri) {
      notify("打开数据目录仅支持桌面客户端");
      return;
    }
    try {
      await invoke("open_app_data_directory");
      notify("已在文件资源管理器中打开数据目录");
    } catch (error) {
      notify(`打开数据目录失败：${String(error)}`);
    }
  }

  async function copyAddress(panel: PanelConnection) {
    try {
      await navigator.clipboard.writeText(panel.panel_url);
      notify(`${panel.name} 面板地址已复制`);
    } catch {
      notify("复制面板地址失败，请手动复制");
    }
  }

  async function saveRemark(panel: PanelConnection) {
    const currentDraft = editingRemark;
    if (!currentDraft || currentDraft.id !== panel.id) return;
    const remark = currentDraft.value.trim();
    setEditingRemark(null);
    if (remark === currentDraft.initial) return;
    try {
      const updated = await invoke<PanelConnection>("update_panel_connection_remark", { id: panel.id, remark: remark || null });
      setConnections((current) => current.map((item) => item.id === updated.id ? updated : item));
      notify("面板备注已保存");
    } catch (error) {
      notify(`保存面板备注失败：${String(error)}`);
    }
  }

  async function remove(panel: PanelConnection) {
    if (!(await requestConfirm(`确认移除面板“${panel.name}”吗？本机保存的 API 密钥也会删除。`))) return;
    try {
      await invoke("delete_panel_connection", { id: panel.id });
      setConnections((current) => current.filter((item) => item.id !== panel.id));
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(panel.id);
        return next;
      });
      notify("面板已移除");
    } catch (error) {
      notify(`移除面板失败：${String(error)}`);
    }
  }

  function toggleSelection(id: number) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedIds((current) => {
      const ids = visibleConnections.map((panel) => panel.id);
      const allSelected = ids.length > 0 && ids.every((id) => current.has(id));
      const next = new Set(current);
      ids.forEach((id) => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  }

  async function exportConnections() {
    if (!connections.length) {
      notify("没有可导出的面板");
      return;
    }
    const panelIds = selectedIds.size ? [...selectedIds] : undefined;
    const count = panelIds?.length || connections.length;
    if (!(await requestConfirm(`导出文件会包含 ${count} 个面板的 API 密钥明文，请妥善保管。确定继续吗？`))) return;
    try {
      const path = await invoke<string>("export_panel_connections_file", { panelIds });
      notify(`已导出 ${count} 个面板，明文文件已保存到：${path}`);
    } catch (error) {
      notify(`导出面板失败：${String(error)}`);
    }
  }

  async function importConnections(file: File) {
    setImporting(true);
    try {
      const parsed = JSON.parse(await file.text());
      const panels = Array.isArray(parsed) ? parsed : parsed.panels;
      if (!Array.isArray(panels) || !panels.length) throw new Error("文件中没有面板配置");
      const count = await invoke<number>("import_panel_connections", { panels });
      await load();
      setSelectedIds(new Set());
      notify(`已导入 ${count} 个面板`);
    } catch (error) {
      notify(`导入面板失败：${String(error)}`);
    } finally {
      setImporting(false);
    }
  }

  useEffect(() => {
    const value = hideIps ? "1" : "0";
    localStorage.setItem("aliyun-panel-hide-ip", value);
    savePreference("aliyun-panel-hide-ip", value);
  }, [hideIps, clientPreferencesReady]);
  useEffect(() => {
    localStorage.setItem("aliyun-panel-open-mode", openMode);
    savePreference("aliyun-panel-open-mode", openMode);
  }, [openMode, clientPreferencesReady]);
  useEffect(() => {
    const value = String(refreshSeconds);
    localStorage.setItem("aliyun-panel-refresh-seconds", value);
    savePreference("aliyun-panel-refresh-seconds", value);
  }, [refreshSeconds, clientPreferencesReady]);
  useEffect(() => {
    if (!runningInTauri || !isVisible || refreshSeconds <= 0 || !connections.length) return;
    const timer = window.setInterval(() => { void refreshAll(true); }, refreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [isVisible, refreshSeconds, connections]);

  return {
    connections,
    dialogOpen,
    setDialogOpen,
    draft,
    setDraft,
    saving,
    loadingId,
    openingId,
    sorting,
    setSorting,
    draggedId,
    setDraggedId,
    keyword,
    setKeyword,
    group,
    setGroup,
    editingRemark,
    setEditingRemark,
    selectedIds,
    expandedDiskIds,
    setExpandedDiskIds,
    importing,
    hideIps,
    setHideIps,
    openMode,
    setOpenMode,
    refreshSeconds,
    setRefreshSeconds,
    importInputRef,
    groups,
    visibleConnections,
    load,
    openDialog,
    openFromAsset,
    save,
    refreshAll,
    openTemporaryLogin,
    openDataDirectory,
    copyAddress,
    saveRemark,
    remove,
    toggleSelection,
    toggleAllVisible,
    exportConnections,
    importConnections,
    startDrag,
  };
}
