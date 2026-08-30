import { PointerEvent, startTransition, Suspense, type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "@xterm/xterm/css/xterm.css";
import {
  ChevronDown,
  Download,
  Monitor,
  Terminal,
  FileText,
  Power,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import "./App.css";
import "./summary.css";
import "./server.css";
import "./domain.css";
import "./domain-tools.css";
import "./local-assets.css";
import "./settings-compact.css";
import "./terminal-workbench.css";
import "./ide-theme.css";
import { invoke, runningInTauri, webApi } from "./platform/api";
import { ConfirmDialog, PromptDialog, useConfirm } from "./app/useConfirm";
import { useClientPreferences } from "./app/useClientPreferences";
import { useToast } from "./app/useToast";
import {
  assetFavoriteKey,
  stringListFromValue,
  stringRecordFromValue,
} from "./features/assets/preferences";
import { useDomainTools } from "./features/domains/useDomainTools";
import { AccountsPage } from "./features/accounts/AccountsPage";
import { useAccounts } from "./features/accounts/useAccounts";
import { useAssetCollection } from "./features/assets/useAssetCollection";
import { useAssetSync } from "./features/assets/useAssetSync";
import { usePanels } from "./features/panels/usePanels";
import { useLogWorkspace } from "./features/logs/useLogWorkspace";
import { AppShell, type AppSection } from "./app/AppShell";
import { useDesktopApp } from "./app/useDesktopApp";
import {
  AccountDialog,
  ApiLogsPage,
  AssetDetailDialog,
  AssetsPage,
  AssetSyncDialog,
  DnsEditorDialog,
  DomainToolDialog,
  FavoritesPage,
  ManagedHostDialog,
  OperationLogsPage,
  PageLoadingState,
  PanelResourceMetrics,
  PanelsPage,
  ResourceDetailDialog,
  SettingsPage,
  SshClientDialog,
  TerminalConnectDialog,
  TerminalHostSidebar,
  TerminalWorkspace,
  assetTypes,
  bundledVersion,
  cloudHubAssetDisplayNamesStorageKey,
  cloudHubAssetNotesStorageKey,
  cloudHubAssetOrderStorageKey,
  cloudHubFavoriteAssetOrderStorageKey,
  cloudHubFavoriteAssetsStorageKey,
  cloudHubTerminalThemeStorageKey,
  emptyManagedHost,
  isDevelopmentBuild,
} from "./app/appBootstrap";
import { managedHostGroupOrderStorageKey, managedHostOrderStorageKey, useManagedHosts } from "./features/servers/useManagedHosts";
import { terminalThemes, type TerminalThemeName } from "./features/servers/useSshTerminal";
import { useTerminalWorkspaceController } from "./features/servers/useTerminalWorkspaceController";
import { useInstanceActions } from "./features/resources/useInstanceActions";
import { useResourceWorkspace } from "./features/resources/useResourceWorkspace";
import { displayValue, firstAddress, formatAssetDate, formatChineseDateTime, formatJson } from "./shared/utils/display";
import { cloudStatusText, columnLabel, remotePlatformFromPayload } from "./features/resources/presentation";
import { hiddenPanelAddress, panelAddress } from "./features/panels/panelMetrics";
import type {
  Account,
  DomainTool,
  LocalAsset,
  ManagedHost,
  PanelConnection,
} from "./shared/types";

function App({ onReady }: { onReady?: () => void } = {}) {
  const { confirm: requestConfirm, prompt: requestPrompt, confirmRequest, promptRequest, promptValue, setPromptValue, resolveConfirm, resolvePrompt } = useConfirm();
  const { message: status, notify: setStatus } = useToast();
  const [ossQuickTool, setOssQuickTool] = useState<{
    accountId: number;
    bucket: string;
    kind: "files" | "stat";
  } | null>(null);
  const [section, setSection] = useState<AppSection>("accounts");
  const [localAssets, setLocalAssets] = useState<LocalAsset[]>([]);
  const [assetDetail, setAssetDetail] = useState<{ asset: LocalAsset; account: Account } | null>(null);
  const {
    autoRefresh, setAutoRefresh,
    compactMode, setCompactMode,
    pageSize, setPageSize,
    appSidebarWidth, setAppSidebarWidth,
    terminalHostSidebarWidth, setTerminalHostSidebarWidth,
    clientPreferencesReady, setClientPreferencesReady,
    saveClientPreference,
  } = useClientPreferences();
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => { onReadyRef.current?.(); }, []);
  const terminalWorkbenchRef = useRef<HTMLDivElement | null>(null);

  const {
    appVersion,
    windowMaximized,
    updateState,
    performWindowAction,
    handleTitlebarMouseDown,
    handleTitlebarDoubleClick,
    checkForUpdates,
    installUpdate,
  } = useDesktopApp({ bundledVersion, notify: setStatus });

  const {
    connections: panelConnections,
    dialogOpen: panelDialog,
    setDialogOpen: setPanelDialog,
    draft: panelDraft,
    setDraft: setPanelDraft,
    saving: panelSaving,
    loadingId: panelLoadingId,
    openingId: panelOpeningId,
    sorting: panelSorting,
    setSorting: setPanelSorting,
    draggedId: draggedPanelId,
    setDraggedId: setDraggedPanelId,
    keyword: panelKeyword,
    setKeyword: setPanelKeyword,
    group: panelGroup,
    setGroup: setPanelGroup,
    editingRemark: editingPanelRemark,
    setEditingRemark: setEditingPanelRemark,
    selectedIds: selectedPanelIds,
    expandedDiskIds: expandedPanelDisks,
    setExpandedDiskIds: setExpandedPanelDisks,
    importing: panelImporting,
    hideIps: hidePanelIps,
    setHideIps: setHidePanelIps,
    openMode: panelOpenMode,
    setOpenMode: setPanelOpenMode,
    refreshSeconds: panelRefreshSeconds,
    setRefreshSeconds: setPanelRefreshSeconds,
    importInputRef: panelImportInputRef,
    groups: panelGroups,
    visibleConnections: visiblePanels,
    load: loadPanelConnections,
    openDialog: openPanelDialog,
    openFromAsset: openPanelFromAsset,
    save: savePanelConnection,
    refreshAll: refreshAllPanelConnections,
    openTemporaryLogin: openPanelTemporaryLogin,
    openDataDirectory,
    copyAddress: copyPanelAddress,
    saveRemark: savePanelRemark,
    remove: deletePanelConnection,
    toggleSelection: togglePanelSelection,
    toggleAllVisible: toggleAllVisiblePanels,
    exportConnections: exportPanels,
    importConnections: importPanels,
    startDrag: startPanelDrag,
  } = usePanels({
    clientPreferencesReady,
    isVisible: section === "panels",
    notify: setStatus,
    requestConfirm,
    savePreference: saveClientPreference,
  });
  const {
    keyword: domainKeyword,
    keywordDraft: domainKeywordDraft,
    setKeywordDraft: setDomainKeywordDraft,
    searchLoading: domainSearchLoading,
    searchDomains,
    tool: domainTool,
    loading: domainToolLoading,
    error: domainToolError,
    data: domainToolData,
    maximized: domainToolMaximized,
    setMaximized: setDomainToolMaximized,
    filter: domainToolDraftFilter,
    setFilter: setDomainToolDraftFilter,
    typeFilter: domainToolDraftType,
    setTypeFilter: setDomainToolDraftType,
    page: domainToolPage,
    setPage: setDomainToolPage,
    pageSize: domainToolPageSize,
    total: domainToolTotal,
    editor: dnsEditor,
    setEditor: setDnsEditor,
    inlineEdit: dnsInlineEdit,
    setInlineEdit: setDnsInlineEdit,
    open: openDomainTool,
    close: closeDomainTool,
    load: loadDomainTool,
    search: searchDomainTool,
    add: dnsAdd,
    quickAdd: dnsQuickAdd,
    submitEditor: submitDnsEditor,
    updateField: updateDnsField,
    rowAction: dnsRowAction,
  } = useDomainTools({ notify: setStatus, confirm: (message) => requestConfirm(message) });
  const {
    hosts: managedHosts,
    importing: managedHostImporting,
    importInputRef: managedHostImportInputRef,
    dialogOpen: managedHostDialog,
    setDialogOpen: setManagedHostDialog,
    draft: managedHostDraft,
    setDraft: setManagedHostDraft,
    saving: managedHostSaving,
    loadingId: managedHostLoadingId,
    keyword: managedHostKeyword,
    setKeyword: setManagedHostKeyword,
    group: managedHostGroup,
    setGroup: setManagedHostGroup,
    order: managedHostOrder,
    setOrder: setManagedHostOrder,
    groupOrder: managedHostGroupOrder,
    setGroupOrder: setManagedHostGroupOrder,
    sorting: managedHostSorting,
    setSorting: setManagedHostSorting,
    draggedId: draggedManagedHostId,
    setDraggedId: setDraggedManagedHostId,
    draggedGroup: draggedManagedHostGroup,
    setDraggedGroup: setDraggedManagedHostGroup,
    collapsedGroups: collapsedManagedHostGroups,
    setCollapsedGroups: setCollapsedManagedHostGroups,
    moreId: managedHostMoreId,
    setMoreId: setManagedHostMoreId,
    groups: managedHostGroups,
    visibleHosts: visibleManagedHosts,
    load: loadManagedHosts,
    openDialog: openManagedHostDialog,
    save: saveManagedHost,
    probe: probeManagedHost,
    remove: deleteManagedHost,
    exportHosts: exportManagedHosts,
    importHosts: importManagedHosts,
    startDrag: startManagedHostDrag,
    startGroupDrag: startManagedHostGroupDrag,
  } = useManagedHosts({
    confirm: requestConfirm,
    notify: setStatus,
  });
  const {
    accounts,
    selectedAccountIds,
    keyword,
    setKeyword,
    dialog,
    setDialog,
    showSecret,
    verifying: verifyingAccount,
    draft,
    setDraft,
    moreId,
    morePosition,
    importing,
    filterField,
    setFilterField,
    groupFilter,
    setGroupFilter,
    statusFilter,
    setStatusFilter,
    cloudFilter,
    setCloudFilter,
    searchLoading: accountSearchLoading,
    page: accountPage,
    setPage: setAccountPage,
    groups,
    visibleAccounts,
    pagedAccounts,
    allPagedAccountsSelected,
    load,
    openCreateDialog: openAccountDialog,
    edit,
    toggleEnabled: toggleAccountEnabled,
    toggleSelection: toggleAccountSelection,
    togglePagedSelection: togglePagedAccountSelection,
    toggleMore: toggleAccountMore,
    closeMore: closeAccountMore,
    toggleSecretVisibility: toggleAccountSecretVisibility,
    save,
    verify: verifyCloudAccount,
    remove,
    exportSelected: exportAccounts,
    importFile: importAccounts,
  } = useAccounts({ notify: setStatus, pageSize, requestConfirm });
  const {
    apiLogDetail,
    setApiLogDetail,
    filter: logFilter,
    setFilter: setLogFilter,
    typeFilter: logTypeFilter,
    setTypeFilter: setLogTypeFilter,
    operationPage: logPage,
    setOperationPage: setLogPage,
    apiPage: apiLogPage,
    setApiPage: setApiLogPage,
    setOperationLogClearedAt,
    loadApiLogs,
    clearLogs: clearLogWorkspace,
    operationRows: logRows,
    pagedOperationRows: pagedLogRows,
    filteredApiLogs,
    pagedApiLogs,
  } = useLogWorkspace({
    accounts,
    clientPreferencesReady,
    localAssets,
    pageSize,
    requestConfirm,
    savePreference: saveClientPreference,
  });
  const {
    editingName: editingAssetName,
    setEditingName: setEditingAssetName,
    savingName: savingAssetName,
    reboot: rebootLocalAsset,
    stop: stopLocalAsset,
    saveName: saveServerName,
  } = useInstanceActions({
    accounts,
    loadApiLogs,
    notify: setStatus,
    requestConfirm,
    setLocalAssets,
  });
  const {
    account: syncAccount,
    selectedTypes: syncTypes,
    setSelectedTypes: setSyncTypes,
    syncing,
    result: syncResult,
    showOracleDatabasePermissionHint,
    open: openAssetSync,
    close: closeAssetSync,
    sync: syncAssets,
  } = useAssetSync({
    loadApiLogs,
    loadLocalAssets,
    notify: setStatus,
  });
  const {
    resourceAccountId, setResourceAccountId, resourceTypeFilter, setResourceTypeFilter,
    assetKeyword, setAssetKeyword, assetRegionFilter, setAssetRegionFilter, assetStatusFilter, setAssetStatusFilter,
    favoriteTypeFilter, setFavoriteTypeFilter, favoriteKeyword, setFavoriteKeyword, favoriteRegionFilter, setFavoriteRegionFilter,
    assetPage, setAssetPage, favoritePage, setFavoritePage, favoriteAssetKeys, setFavoriteAssetKeys,
    assetNotes, setAssetNotes, setAssetOrder, setFavoriteAssetOrder, assetDisplayNames, setAssetDisplayNames, editingAssetNote, setEditingAssetNote,
    favoriteRefreshingKey, setFavoriteRefreshingKey, draggedAssetKey, draggedFavoriteKey, assetMoreKey, setAssetMoreKey,
    visibleLocalAssets, pagedLocalAssets, favoriteAssets, visibleFavoriteAssets, pagedFavoriteAssets,
    toggleFavorite: toggleAssetFavorite, saveAssetNote, startAssetDrag, startFavoriteCardDrag,
  } = useAssetCollection({
    accounts,
    localAssets,
    pageSize,
    clientPreferencesReady,
    savePreference: saveClientPreference,
  });
  const {
    active, setActive, summary, resources, loading,
    esaTab, setEsaTab, esaRange, setEsaRange, esaTrend, setEsaTrend,
    esaSelectedSiteId, setEsaSelectedSiteId, esaOverview, setEsaOverview, esaSiteKeyword, setEsaSiteKeyword,
    openCachedSummary, openCachedView, openAccountResource, pullLatestResources, pullLatestEsaOverview,
  } = useResourceWorkspace({
    closeAccountMenu: closeAccountMore,
    loadLocalAssets,
    loadApiLogs,
    notify: setStatus,
    openLocalResourceList: (accountId, resourceType) => {
      setResourceAccountId(accountId);
      setResourceTypeFilter(resourceType);
      setSection("resources");
    },
  });
  const {
    selectedHostId: terminalSelectedHostId,
    setSelectedHostId: setTerminalSelectedHostId,
    sshError,
    sessionId: sshSessionId,
    tabs: terminalTabs,
    activeTabId: activeTerminalTabId,
    themeName: terminalThemeName,
    setThemeName: setTerminalThemeName,
    themeMenuOpen: terminalThemeMenuOpen,
    setThemeMenuOpen: setTerminalThemeMenuOpen,
    terminalHostRef: sshTerminalHostRef,
    clearTerminal: clearSshTerminal,
    completeCommand: completeSshCommand,
    files: sshFiles,
    path: sshFilePath,
    setPath: setSshFilePath,
    loadingFiles: sshFilesLoading,
    fileError: sshFileError,
    editor: sshFileEditor,
    setEditor: setSshFileEditor,
    savingFile: sshFileSaving,
    paneWidth: sshFilePaneWidth,
    paneCollapsed: sshFilePaneCollapsed,
    setPaneCollapsed: setSshFilePaneCollapsed,
    dragActive: sshFileDragActive,
    setDragActive: setSshFileDragActive,
    uploadInputRef: sshUploadInputRef,
    workspaceRef: sshWorkspaceRef,
    parentPath: parentSshPath,
    fileSize: sshFileSize,
    loadFiles: loadSshFiles,
    startFileResize: startSshFileResize,
    openFile: openSshFile,
    saveFile: saveSshFile,
    uploadFiles: uploadSshFiles,
    downloadFile: downloadSshFile,
    makeDirectory: makeSshDirectory,
    deleteEntry: deleteSshEntry,
    target: sshTarget,
    host: sshHost,
    setHost: setSshHost,
    port: sshPort,
    setPort: setSshPort,
    username: sshUsername,
    setUsername: setSshUsername,
    password: sshPassword,
    setPassword: setSshPassword,
    showPassword: showSshPassword,
    setShowPassword: setShowSshPassword,
    platform: sshPlatform,
    setAuthMethod: setSshAuthMethod,
    authMethod: sshAuthMethod,
    setPrivateKey: setSshPrivateKey,
    privateKey: sshPrivateKey,
    setKeyPassphrase: setSshKeyPassphrase,
    keyPassphrase: sshKeyPassphrase,
    testing: sshTesting,
    savePassword: sshSavePassword,
    setSavePassword: setSshSavePassword,
    passwordSaved: sshPasswordSaved,
    passwordRevealing: sshPasswordRevealing,
    connecting: sshConnecting,
    maximized: sshModalMaximized,
    setMaximized: setSshModalMaximized,
    changePlatform: changeSshPlatform,
    testConnection: testSshConnection,
    togglePasswordVisibility: toggleSshPasswordVisibility,
    clearSavedConnection: clearSavedSshConnection,
    activateTab: activateTerminalTab,
    closeTab: closeTerminalTab,
    openManagedHost: openManagedHostSsh,
    openAssetSshClient: openSshClient,
    closeClient: closeSshClient,
    connectClient: connectSshClient,
  } = useTerminalWorkspaceController({
    isTerminalSection: section === "servers",
    loadManagedHosts,
    notify: setStatus,
    requestConfirm,
    requestPrompt,
  });


  async function loadLocalAssets() {
    try {
      setLocalAssets(runningInTauri
        ? await invoke<LocalAsset[]>("list_local_assets", {})
        : await webApi<LocalAsset[]>("/api/local-assets"));
    } catch (error) { setStatus(`读取本地资产失败：${String(error)}`); }
  }
  async function copyAssetIp(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setStatus("IP 地址已复制");
    } catch {
      setStatus("复制 IP 地址失败，请手动复制");
    }
  }
  async function refreshFavoriteAsset(asset: LocalAsset, account: Account) {
    const key = assetFavoriteKey(asset);
    if (favoriteRefreshingKey) return;
    setFavoriteRefreshingKey(key);
    try {
      const result = runningInTauri
        ? await invoke<{ counts: Record<string, number>; errors: string[] }>("sync_cloud_assets", { id: account.id, resourceTypes: [asset.resource_type] })
        : await webApi<{ counts: Record<string, number>; errors: string[] }>("/api/sync-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: account.id, resource_types: [asset.resource_type] }) });
      await loadLocalAssets();
      setStatus(`${account.account_name} · ${assetTypes.find(([type]) => type === asset.resource_type)?.[1] || "资源"}已刷新${result.errors.length ? `，${result.errors.length} 项失败` : ""}`);
    } catch (error) { setStatus(`刷新服务器失败：${String(error)}`); }
    finally { setFavoriteRefreshingKey(null); }
  }
  function openTerminalConfiguration(asset: LocalAsset, account: Account, host?: ManagedHost) {
    const payload = asset.payload || {};
    if (host) {
      openManagedHostDialog(host);
      return;
    }
    const platform = remotePlatformFromPayload(payload);
    setManagedHostDraft({
      ...emptyManagedHost,
      name: String(payload.InstanceName || asset.asset_key),
      host: firstAddress(payload.PublicIpAddress || payload.PublicAddresses || payload.PublicIp || payload.InternetIp || payload.EipAddress),
      platform,
      port: platform === "windows" ? 3389 : 22,
      username: platform === "windows" ? "administrator" : "root",
      group_name: account.group_name || "",
      source_account_id: account.id,
      source_asset_key: asset.asset_key,
      remark: `来源：${account.account_name} / ${asset.resource_type}`,
    });
    setManagedHostDialog(true);
  }
  function startAppSidebarResize(event: PointerEvent<HTMLDivElement>) {
    const shell = appShellRef.current;
    if (!shell || window.innerWidth <= 900) return;
    event.preventDefault();
    const initialX = event.clientX;
    const initialWidth = appSidebarWidth;
    const maxWidth = Math.max(190, Math.min(340, shell.clientWidth - 560));
    const resize = (moveEvent: globalThis.PointerEvent) => setAppSidebarWidth(Math.min(maxWidth, Math.max(190, initialWidth + moveEvent.clientX - initialX)));
    const finish = () => {
      window.removeEventListener("pointermove", resize);
      document.body.classList.remove("pane-resizing");
      setAppSidebarWidth((width) => { localStorage.setItem("cloudhub-app-sidebar-width", String(width)); return width; });
    };
    document.body.classList.add("pane-resizing");
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish, { once: true });
  }
  function navigate(nextSection: AppSection) {
    startTransition(() => setSection(nextSection));
    if (nextSection === "resources" || nextSection === "favorites") {
      void loadLocalAssets();
      return;
    }
    if (nextSection === "panels") {
      void loadPanelConnections();
      return;
    }
    if (nextSection === "servers") {
      void loadManagedHosts();
      return;
    }
    if (nextSection === "api_logs") void loadApiLogs();
  }
  function startTerminalHostSidebarResize(event: PointerEvent<HTMLDivElement>) {
    const workbench = terminalWorkbenchRef.current;
    if (!workbench || window.innerWidth <= 900) return;
    event.preventDefault();
    const initialX = event.clientX;
    const initialWidth = terminalHostSidebarWidth;
    const maxWidth = Math.max(190, Math.min(420, workbench.clientWidth - 360));
    const resize = (moveEvent: globalThis.PointerEvent) => setTerminalHostSidebarWidth(Math.min(maxWidth, Math.max(190, initialWidth + moveEvent.clientX - initialX)));
    const finish = () => {
      window.removeEventListener("pointermove", resize);
      document.body.classList.remove("pane-resizing");
      setTerminalHostSidebarWidth((width) => { localStorage.setItem("cloudhub-terminal-host-sidebar-width", String(width)); return width; });
    };
    document.body.classList.add("pane-resizing");
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish, { once: true });
  }
  async function clearLogs(kind: "api" | "operation") {
    const title = kind === "api" ? "API 日志" : "操作日志";
    try {
      await clearLogWorkspace(kind);
      setStatus(`${title}已清空`);
    } catch (error) { setStatus(`清空${title}失败：${String(error)}`); }
  }
  useEffect(() => {
    void loadLocalAssets();
    void loadManagedHosts();
    void loadPanelConnections();
    void loadApiLogs();
  }, []);
  useEffect(() => {
    if (!runningInTauri) return;
    let cancelled = false;
    void invoke<Record<string, string>>("list_client_preferences").then((preferences) => {
      if (cancelled) return;
      if (preferences[cloudHubFavoriteAssetsStorageKey] !== undefined) setFavoriteAssetKeys(stringListFromValue(preferences[cloudHubFavoriteAssetsStorageKey]));
      if (preferences[cloudHubFavoriteAssetOrderStorageKey] !== undefined) setFavoriteAssetOrder(stringListFromValue(preferences[cloudHubFavoriteAssetOrderStorageKey]));
      if (preferences[cloudHubAssetNotesStorageKey] !== undefined) setAssetNotes(stringRecordFromValue(preferences[cloudHubAssetNotesStorageKey]));
      if (preferences[cloudHubAssetOrderStorageKey] !== undefined) setAssetOrder(stringListFromValue(preferences[cloudHubAssetOrderStorageKey]));
      if (preferences[cloudHubAssetDisplayNamesStorageKey] !== undefined) setAssetDisplayNames(stringRecordFromValue(preferences[cloudHubAssetDisplayNamesStorageKey]));
      if (preferences[managedHostOrderStorageKey] !== undefined) setManagedHostOrder(stringListFromValue(preferences[managedHostOrderStorageKey]));
      if (preferences[managedHostGroupOrderStorageKey] !== undefined) setManagedHostGroupOrder(stringListFromValue(preferences[managedHostGroupOrderStorageKey]));
      if (preferences[cloudHubTerminalThemeStorageKey] !== undefined && preferences[cloudHubTerminalThemeStorageKey] in terminalThemes) setTerminalThemeName(preferences[cloudHubTerminalThemeStorageKey] as TerminalThemeName);
      if (preferences["aliyun-auto-refresh"] !== undefined) setAutoRefresh(preferences["aliyun-auto-refresh"] !== "0");
      if (preferences["aliyun-compact-mode"] !== undefined) setCompactMode(preferences["aliyun-compact-mode"] === "1");
      if (preferences["aliyun-panel-hide-ip"] !== undefined) setHidePanelIps(preferences["aliyun-panel-hide-ip"] === "1");
      if (preferences["aliyun-panel-open-mode"] === "copy") setPanelOpenMode("copy");
      const refreshSeconds = Number(preferences["aliyun-panel-refresh-seconds"]);
      if ([0, 5, 10, 30, 60].includes(refreshSeconds)) setPanelRefreshSeconds(refreshSeconds);
      const savedPageSize = Number(preferences["aliyun-page-size"]);
      if ([10, 20, 50, 100].includes(savedPageSize)) setPageSize(savedPageSize);
      const clearedAt = Number(preferences["aliyun-operation-log-cleared-at"]);
      if (Number.isFinite(clearedAt) && clearedAt > 0) setOperationLogClearedAt(clearedAt);
    }).catch(() => {}).finally(() => { if (!cancelled) setClientPreferencesReady(true); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { const value = String(pageSize); localStorage.setItem("aliyun-page-size", value); saveClientPreference("aliyun-page-size", value); setAccountPage(1); setAssetPage(1); setFavoritePage(1); setLogPage(1); setApiLogPage(1); }, [pageSize, clientPreferencesReady]);
  useEffect(() => { const value = JSON.stringify(managedHostOrder); localStorage.setItem(managedHostOrderStorageKey, value); saveClientPreference(managedHostOrderStorageKey, value); }, [managedHostOrder, clientPreferencesReady]);
  useEffect(() => { const value = JSON.stringify(managedHostGroupOrder); localStorage.setItem(managedHostGroupOrderStorageKey, value); saveClientPreference(managedHostGroupOrderStorageKey, value); }, [managedHostGroupOrder, clientPreferencesReady]);
  useEffect(() => { localStorage.setItem(cloudHubTerminalThemeStorageKey, terminalThemeName); saveClientPreference(cloudHubTerminalThemeStorageKey, terminalThemeName); }, [terminalThemeName, clientPreferencesReady]);
  async function openOssQuickTool(account: Account, asset: LocalAsset, kind: "files" | "stat") {
    const bucket = String(asset.payload?.Name || asset.asset_key || "").trim();
    if (!bucket) { setStatus("对象存储资产缺少存储桶名称"); return; }
    setSection("resources");
    setOssQuickTool({ accountId: account.id, bucket, kind });
    await openCachedView(account, "oss");
  }
  const selectedResourceAccount = accounts.find((account) => account.id === resourceAccountId) ?? null;
  const openLocalDomainTool = (asset: LocalAsset, account: Account, kind: DomainTool["kind"]) => {
    const payload = asset.payload || {};
    openDomainTool({
      kind,
      account,
      domain: String(payload.DomainName || payload.Name || asset.asset_key),
    });
  };
  async function deleteLocalAsset(asset: LocalAsset) {
    const assetName = String(asset.payload?.InstanceName || asset.payload?.Name || asset.payload?.DomainName || asset.asset_key);
    if (!(await requestConfirm(`确认删除本地缓存记录“${assetName}”吗？\n这不会删除云端真实资源。`))) return;
    try {
      if (runningInTauri) await invoke("delete_local_asset", { accountId: asset.account_id, resourceType: asset.resource_type, assetKey: asset.asset_key });
      else await webApi(`/api/local-assets?account_id=${asset.account_id}&resource_type=${encodeURIComponent(asset.resource_type)}&asset_key=${encodeURIComponent(asset.asset_key)}`, { method: "DELETE" });
      setLocalAssets((items) => items.filter((item) => item.account_id !== asset.account_id || item.resource_type !== asset.resource_type || item.asset_key !== asset.asset_key));
      setStatus(`已删除“${assetName}”的本地缓存记录`);
    } catch (error) { setStatus(`删除本地缓存记录失败：${String(error)}`); }
  }
  const renderAssetActions = (asset: LocalAsset, account: Account | undefined) => {
    if (!account) return <span className="asset-action-muted">—</span>;
    if (account.cloud_type === "other") return <div className="asset-action-buttons">
      <button type="button" className="asset-cache-delete-button" onClick={() => void deleteLocalAsset(asset)}><Trash2 size={15} />删除记录</button>
    </div>;
    if (asset.resource_type === "domain" && !["oracle", "huawei", "baidu", "ucloud", "aws", "azure", "gcp", "jdcloud", "qingcloud", "ksyun"].includes(account.cloud_type)) return <div className="asset-action-buttons domain-asset-actions">
      <button className="asset-domain-dns-button" onClick={() => openLocalDomainTool(asset, account, "dns")}>解析管理</button>
      <button className="asset-domain-log-button" onClick={() => openLocalDomainTool(asset, account, "logs")}>操作日志</button>
      <button className="asset-domain-whois-button" onClick={() => openLocalDomainTool(asset, account, "whois")}>WHOIS</button>
    </div>;
    if (asset.resource_type === "oss" && !["volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud", "qiniu", "aws", "azure", "gcp", "jdcloud", "qingcloud", "ksyun"].includes(account.cloud_type)) return <div className="asset-action-buttons oss-asset-actions">
      <button className="asset-oss-files-button" onClick={() => void openOssQuickTool(account, asset, "files")}>文件列表</button>
      <button className="asset-oss-stat-button" onClick={() => void openOssQuickTool(account, asset, "stat")}>容量统计</button>
    </div>;
    if (asset.resource_type === "ecs" || asset.resource_type === "swas") {
      const key = assetFavoriteKey(asset);
      const linkedPanel = panelConnections.find((panel) => panel.source_account_id === account.id && panel.source_asset_key === asset.asset_key);
      const linkedHost = managedHosts.find((host) => host.source_account_id === account.id && host.source_asset_key === asset.asset_key);
      const canControl = ["aliyun", "tencent", "baidu", "oracle", "jdcloud", "vultr"].includes(account.cloud_type);
      return <div className="asset-action-buttons server-asset-actions">
        {canControl && <button className="asset-force-reboot-button" onClick={() => void rebootLocalAsset(asset, true)}><RefreshCw size={15} />强制重启</button>}
        <span className={`asset-more-wrap ${assetMoreKey === key ? "is-open" : ""}`}>
          <button type="button" className="asset-more-button" title="更多功能" aria-label="更多功能" aria-expanded={assetMoreKey === key} onClick={() => setAssetMoreKey((current) => current === key ? null : key)}>更多功能<ChevronDown size={15} /></button>
          {assetMoreKey === key && <div className="asset-more-menu">
            <button type="button" onClick={() => { setAssetMoreKey(null); setAssetDetail({ asset, account }); }}><FileText size={14} />查看详情</button>
            <button type="button" onClick={() => { setAssetMoreKey(null); linkedPanel ? openPanelDialog(linkedPanel) : openPanelFromAsset(asset, account); }}><Monitor size={14} />{linkedPanel ? "修改面板配置" : "添加面板配置"}</button>
            <button type="button" onClick={() => { setAssetMoreKey(null); openTerminalConfiguration(asset, account, linkedHost); }}><Terminal size={14} />{linkedHost ? "修改终端配置" : "添加终端配置"}</button>
            <button type="button" onClick={() => { setAssetMoreKey(null); void openSshClient(asset, account); }}><Terminal size={14} />SSH 登录</button>
            {canControl && <button type="button" onClick={() => { setAssetMoreKey(null); void rebootLocalAsset(asset, false); }}><RefreshCw size={14} />普通重启</button>}
            {canControl && <button type="button" className="danger" onClick={() => { setAssetMoreKey(null); void stopLocalAsset(asset); }}><Power size={14} />关机</button>}
          </div>}
        </span>
      </div>;
    }
    return <span className="asset-action-muted">—</span>;
  };
  const renderPanelMetrics = (panel: PanelConnection) => <PanelResourceMetrics
    panel={panel}
    expanded={expandedPanelDisks.has(panel.id)}
    onExpandedChange={(expanded) => setExpandedPanelDisks((current) => {
      const next = new Set(current);
      if (expanded) next.add(panel.id);
      else next.delete(panel.id);
      return next;
    })}
  />;
  return (
    <AppShell
      shellRef={appShellRef}
      sidebarWidth={appSidebarWidth}
      section={section}
      appVersion={appVersion}
      isDevelopmentBuild={isDevelopmentBuild}
      runningInTauri={runningInTauri}
      windowMaximized={windowMaximized}
      onNavigate={navigate}
      onSidebarResize={startAppSidebarResize}
      onTitlebarMouseDown={handleTitlebarMouseDown}
      onTitlebarDoubleClick={handleTitlebarDoubleClick}
      onWindowAction={(action) => void performWindowAction(action)}
    >
        {status && <div className="toast-notice" role="status" aria-live="polite" aria-atomic="true">{status}</div>}
        <div className={`account-section ${section === "accounts" ? "" : "section-hidden"}`}>
        <AccountsPage
          accounts={accounts}
          localAssets={localAssets}
          filterField={filterField}
          keyword={keyword}
          groupFilter={groupFilter}
          statusFilter={statusFilter}
          cloudFilter={cloudFilter}
          groups={groups}
          accountSearchLoading={accountSearchLoading}
          importing={importing}
          selectedAccountIds={selectedAccountIds}
          pagedAccounts={pagedAccounts}
          visibleAccountCount={visibleAccounts.length}
          page={accountPage}
          pageSize={pageSize}
          allPagedAccountsSelected={allPagedAccountsSelected}
          moreId={moreId}
          morePosition={morePosition}
          onFilterFieldChange={setFilterField}
          onKeywordChange={setKeyword}
          onGroupFilterChange={setGroupFilter}
          onStatusFilterChange={setStatusFilter}
          onCloudFilterChange={setCloudFilter}
          onSearch={() => void load()}
          onCreate={openAccountDialog}
          onGroupManage={() => setStatus("分组管理：本地分组跟随账号编辑")}
          onExport={() => void exportAccounts()}
          onImport={(file) => void importAccounts(file)}
          onTogglePagedSelection={togglePagedAccountSelection}
          onToggleSelection={toggleAccountSelection}
          onToggleEnabled={(account) => void toggleAccountEnabled(account)}
          onToggleMore={toggleAccountMore}
          onOpenResource={openAccountResource}
          onStartSync={openAssetSync}
          onOpenSummary={(account) => void openCachedSummary(account)}
          onEdit={edit}
          onRemove={(id) => void remove(id)}
          onPageChange={setAccountPage}
        />
        {domainTool && <Suspense fallback={null}><DomainToolDialog
          tool={domainTool}
          maximized={domainToolMaximized}
          loading={domainToolLoading}
          error={domainToolError}
          data={domainToolData}
          filter={domainToolDraftFilter}
          typeFilter={domainToolDraftType}
          page={domainToolPage}
          pageSize={domainToolPageSize}
          total={domainToolTotal}
          inlineEdit={dnsInlineEdit}
          displayValue={displayValue}
          onClose={closeDomainTool}
          onToggleMaximized={() => setDomainToolMaximized((value) => !value)}
          onRefresh={() => { if (domainTool) void loadDomainTool(domainTool); }}
          onFilterChange={setDomainToolDraftFilter}
          onTypeFilterChange={setDomainToolDraftType}
          onSearch={searchDomainTool}
          onAdd={() => void dnsAdd()}
          onQuickAdd={(type, rr) => void dnsQuickAdd(type, rr)}
          onInlineEditChange={setDnsInlineEdit}
          onUpdateField={(row, field, value) => void updateDnsField(row, field, value)}
          onRowAction={(row, action) => void dnsRowAction(row, action)}
          onPageChange={setDomainToolPage}
        /></Suspense>}
        {dnsEditor && createPortal(
          <Suspense fallback={null}><DnsEditorDialog
            preset={dnsEditor.preset}
            row={dnsEditor.row}
            mode={dnsEditor.mode}
            onCancel={() => setDnsEditor(null)}
            onSubmit={submitDnsEditor}
          /></Suspense>,
          document.body,
        )}
        {active && <Suspense fallback={null}><ResourceDetailDialog
          active={active}
          summary={summary}
          resources={resources}
          loading={loading}
          quickTool={ossQuickTool}
          assetDisplayNames={assetDisplayNames}
          domainKeyword={domainKeyword}
          domainKeywordDraft={domainKeywordDraft}
          domainSearchLoading={domainSearchLoading}
          esaTab={esaTab}
          esaRange={esaRange}
          esaTrend={esaTrend}
          esaSelectedSiteId={esaSelectedSiteId}
          esaOverview={esaOverview}
          esaSiteKeyword={esaSiteKeyword}
          onClose={() => setActive(null)}
          onQuickActionOpened={() => setOssQuickTool(null)}
          onDisplayNamesChange={setAssetDisplayNames}
          onDomainKeywordChange={setDomainKeywordDraft}
          onSearchDomains={searchDomains}
          onOpenDomainTool={openDomainTool}
          onRefreshResources={(account, type) => void pullLatestResources(account, type)}
          onRefreshEsa={(account) => void pullLatestEsaOverview(account)}
          onOpenSshClient={openSshClient}
          onNotice={setStatus}
          onConfirm={requestConfirm}
          onPrompt={requestPrompt}
          onEsaTabChange={setEsaTab}
          onEsaRangeChange={setEsaRange}
          onEsaTrendChange={setEsaTrend}
          onEsaSelectedSiteChange={setEsaSelectedSiteId}
          onEsaOverviewChange={setEsaOverview}
          onEsaSiteKeywordChange={setEsaSiteKeyword}
        /></Suspense>}        </div>
        {section === "favorites" && <Suspense fallback={<PageLoadingState />}><FavoritesPage
          accounts={accounts}
          favoriteAssets={favoriteAssets}
          visibleFavoriteAssets={visibleFavoriteAssets}
          pagedFavoriteAssets={pagedFavoriteAssets}
          assetTypes={assetTypes}
          favoriteTypeFilter={favoriteTypeFilter}
          favoriteKeyword={favoriteKeyword}
          favoriteRegionFilter={favoriteRegionFilter}
          favoritePage={favoritePage}
          pageSize={pageSize}
          assetNotes={assetNotes}
          editingAssetNote={editingAssetNote}
          favoriteRefreshingKey={favoriteRefreshingKey}
          draggedFavoriteKey={draggedFavoriteKey}
          displayValue={displayValue}
          formatAssetDate={formatAssetDate}
          cloudStatusText={cloudStatusText}
          renderActions={renderAssetActions}
          onFavoriteTypeFilterChange={setFavoriteTypeFilter}
          onFavoriteKeywordChange={setFavoriteKeyword}
          onFavoriteRegionFilterChange={setFavoriteRegionFilter}
          onFavoritePageChange={setFavoritePage}
          onStartFavoriteCardDrag={startFavoriteCardDrag}
          onStartEditingAssetNote={(key, value) => setEditingAssetNote({ key, value, initial: value })}
          onAssetNoteValueChange={(value) => setEditingAssetNote((current) => current ? { ...current, value } : current)}
          onSaveAssetNote={saveAssetNote}
          onCancelAssetNoteEdit={() => setEditingAssetNote(null)}
          onToggleFavorite={toggleAssetFavorite}
          onCopyIp={(address) => void copyAssetIp(address)}
          onRefreshAsset={(asset, account) => void refreshFavoriteAsset(asset, account)}
          onOpenResources={() => { setSection("resources"); void loadLocalAssets(); }}
        /></Suspense>}
        {section === "panels" && <Suspense fallback={<PageLoadingState />}><PanelsPage
          accounts={accounts}
          assets={localAssets}
          panels={panelConnections}
          visiblePanels={visiblePanels}
          groups={panelGroups}
          keyword={panelKeyword}
          group={panelGroup}
          sorting={panelSorting}
          draggedPanelId={draggedPanelId}
          selectedPanelIds={selectedPanelIds}
          remarkDraft={editingPanelRemark}
          loadingId={panelLoadingId}
          openingId={panelOpeningId}
          importing={panelImporting}
          importInputRef={panelImportInputRef}
          hideIps={hidePanelIps}
          refreshSeconds={panelRefreshSeconds}
          openMode={panelOpenMode}
          renderMetrics={renderPanelMetrics}
          formatDateTime={formatChineseDateTime}
          formatAddress={panelAddress}
          hiddenAddress={hiddenPanelAddress}
          onKeywordChange={setPanelKeyword}
          onGroupChange={setPanelGroup}
          onRefreshAll={() => void refreshAllPanelConnections()}
          onAdd={() => openPanelDialog()}
          onExport={() => void exportPanels()}
          onImport={(file) => void importPanels(file)}
          onHideIpsChange={setHidePanelIps}
          onRefreshSecondsChange={setPanelRefreshSeconds}
          onOpenModeChange={setPanelOpenMode}
          onSortingChange={(value) => { setPanelSorting(value); setDraggedPanelId(null); }}
          onStartDrag={startPanelDrag}
          onToggleAll={toggleAllVisiblePanels}
          onToggleSelected={togglePanelSelection}
          onStartEditingRemark={(panel) => setEditingPanelRemark({ id: panel.id, value: panel.remark || "", initial: panel.remark || "" })}
          onRemarkChange={(value) => setEditingPanelRemark((current) => current ? { ...current, value } : current)}
          onSaveRemark={(panel) => void savePanelRemark(panel)}
          onCancelRemark={() => setEditingPanelRemark(null)}
          onCopyAddress={(panel) => void copyPanelAddress(panel)}
          onEdit={openPanelDialog}
          onOpen={(panel) => void openPanelTemporaryLogin(panel)}
          onOpenSsh={(asset, account) => void openSshClient(asset, account)}
          onReboot={(asset) => void rebootLocalAsset(asset, false)}
          onDelete={(panel) => void deletePanelConnection(panel)}
        /></Suspense>}
        {section === "servers" && <Suspense fallback={<PageLoadingState />}>
          <section className="managed-servers-page">
            <div ref={terminalWorkbenchRef} className={`terminal-workbench${sshFilePaneCollapsed ? " is-file-pane-collapsed" : ""}`} style={{ gridTemplateColumns: `${terminalHostSidebarWidth}px minmax(0, 1fr)`, "--terminal-host-sidebar-width": `${terminalHostSidebarWidth}px` } as CSSProperties}>
              <TerminalHostSidebar
                hosts={managedHosts}
                visibleHosts={visibleManagedHosts}
                groups={managedHostGroups}
                selectedHostId={terminalSelectedHostId}
                keyword={managedHostKeyword}
                group={managedHostGroup}
                sorting={managedHostSorting}
                draggedHostId={draggedManagedHostId}
                draggedGroup={draggedManagedHostGroup}
                collapsedGroups={collapsedManagedHostGroups}
                moreId={managedHostMoreId}
                loadingId={managedHostLoadingId}
                importing={managedHostImporting}
                importInputRef={managedHostImportInputRef}
                onExport={() => void exportManagedHosts()}
                onImport={(file) => void importManagedHosts(file)}
                onRefresh={() => void loadManagedHosts()}
                onGroupChange={setManagedHostGroup}
                onSortingChange={(value) => { setManagedHostSorting(value); setDraggedManagedHostId(null); setDraggedManagedHostGroup(null); setManagedHostMoreId(null); }}
                onKeywordChange={setManagedHostKeyword}
                onAdd={() => openManagedHostDialog()}
                onToggleGroup={(group) => setCollapsedManagedHostGroups((current) => { const next = new Set(current); if (next.has(group)) next.delete(group); else next.add(group); return next; })}
                onStartGroupDrag={startManagedHostGroupDrag}
                onStartHostDrag={startManagedHostDrag}
                onOpenHost={(host) => { setTerminalSelectedHostId(host.id); openManagedHostSsh(host); }}
                onToggleMore={(id) => setManagedHostMoreId((current) => current === id ? null : id)}
                onEdit={(host) => { setManagedHostMoreId(null); openManagedHostDialog(host); }}
                onProbe={(host) => { setManagedHostMoreId(null); void probeManagedHost(host.id); }}
                onDelete={(host) => { setManagedHostMoreId(null); void deleteManagedHost(host); }}
              />
              <div className="terminal-host-resizer" role="separator" aria-label="调整服务器列表宽度" aria-orientation="vertical" onPointerDown={startTerminalHostSidebarResize} />
              <TerminalWorkspace
                tabs={terminalTabs}
                activeTabId={activeTerminalTabId}
                managedHosts={managedHosts}
                sessionId={sshSessionId}
                host={sshHost}
                port={sshPort}
                username={sshUsername}
                themes={terminalThemes}
                themeName={terminalThemeName}
                themeMenuOpen={terminalThemeMenuOpen}
                filePaneCollapsed={sshFilePaneCollapsed}
                filePaneWidth={sshFilePaneWidth}
                fileDragActive={sshFileDragActive}
                files={sshFiles}
                filePath={sshFilePath}
                filesLoading={sshFilesLoading}
                fileError={sshFileError}
                fileEditor={sshFileEditor}
                fileSaving={sshFileSaving}
                workspaceRef={sshWorkspaceRef}
                terminalHostRef={sshTerminalHostRef}
                uploadInputRef={sshUploadInputRef}
                onActivateTab={activateTerminalTab}
                onCloseTab={(id) => void closeTerminalTab(id)}
                onFilePaneCollapsedChange={setSshFilePaneCollapsed}
                onCompleteCommand={completeSshCommand}
                onThemeMenuOpenChange={setTerminalThemeMenuOpen}
                onThemeNameChange={(name) => setTerminalThemeName(name as TerminalThemeName)}
                onClearTerminal={clearSshTerminal}
                onDisconnect={() => void closeSshClient()}
                onFileResize={startSshFileResize}
                onFileDragActiveChange={setSshFileDragActive}
                onLoadFiles={(path) => void loadSshFiles(path)}
                onFilePathChange={setSshFilePath}
                onUploadFiles={(files) => void uploadSshFiles(files)}
                onMakeDirectory={() => void makeSshDirectory()}
                onOpenFile={(entry) => void openSshFile(entry)}
                onDownloadFile={(entry) => void downloadSshFile(entry)}
                onDeleteEntry={(entry) => void deleteSshEntry(entry)}
                onCloseFileEditor={() => setSshFileEditor(null)}
                onFileContentChange={(content) => setSshFileEditor((current) => current ? { ...current, content } : current)}
                onSaveFile={() => void saveSshFile()}
                fileSize={sshFileSize}
                parentPath={parentSshPath}
                onAddHost={() => openManagedHostDialog()}
              />
            </div>
          </section>
        </Suspense>}
        {section === "servers" && sshTarget && !sshSessionId && <Suspense fallback={null}><TerminalConnectDialog
          target={sshTarget}
          platform={sshPlatform}
          host={sshHost}
          port={sshPort}
          username={sshUsername}
          password={sshPassword}
          showPassword={showSshPassword}
          passwordSaved={sshPasswordSaved}
          passwordRevealing={sshPasswordRevealing}
          testing={sshTesting}
          connecting={sshConnecting}
          error={sshError}
          displayValue={displayValue}
          onClose={() => void closeSshClient()}
          onPlatformChange={(platform) => void changeSshPlatform(platform)}
          onHostChange={setSshHost}
          onPortChange={setSshPort}
          onUsernameChange={setSshUsername}
          onPasswordChange={setSshPassword}
          onTogglePassword={() => void toggleSshPasswordVisibility()}
          onTest={() => void testSshConnection()}
          onConnect={() => void connectSshClient()}
        /></Suspense>}
        {section === "resources" && <Suspense fallback={<PageLoadingState />}><AssetsPage
          accounts={accounts}
          assets={localAssets}
          visibleAssets={visibleLocalAssets}
          pagedAssets={pagedLocalAssets}
          assetTypes={assetTypes}
          selectedAccount={selectedResourceAccount}
          resourceAccountId={resourceAccountId}
          resourceTypeFilter={resourceTypeFilter}
          assetKeyword={assetKeyword}
          assetRegionFilter={assetRegionFilter}
          assetStatusFilter={assetStatusFilter}
          assetPage={assetPage}
          pageSize={pageSize}
          favoriteAssetKeys={favoriteAssetKeys}
          assetNotes={assetNotes}
          editingAssetNote={editingAssetNote}
          editingAssetName={editingAssetName}
          savingAssetName={savingAssetName}
          draggedAssetKey={draggedAssetKey}
          displayValue={displayValue}
          formatAssetDate={formatAssetDate}
          cloudStatusText={cloudStatusText}
          renderActions={renderAssetActions}
          onResourceAccountChange={(accountId) => { setResourceAccountId(accountId); setResourceTypeFilter(null); }}
          onResourceTypeFilterChange={setResourceTypeFilter}
          onAssetKeywordChange={setAssetKeyword}
          onAssetRegionFilterChange={setAssetRegionFilter}
          onAssetStatusFilterChange={setAssetStatusFilter}
          onAssetPageChange={setAssetPage}
          onToggleFavorite={toggleAssetFavorite}
          onStartAssetDrag={startAssetDrag}
          onStartEditingAssetNote={(key, value) => setEditingAssetNote({ key, value, initial: value })}
          onAssetNoteValueChange={(value) => setEditingAssetNote((current) => current ? { ...current, value } : current)}
          onSaveAssetNote={saveAssetNote}
          onCancelAssetNoteEdit={() => setEditingAssetNote(null)}
          onStartEditingAssetName={(key, value) => setEditingAssetName({ key, value, initial: value })}
          onAssetNameValueChange={(value) => setEditingAssetName((current) => current ? { ...current, value } : current)}
          onSaveServerName={(asset, account, key) => void saveServerName(asset, account, key)}
          onCancelAssetNameEdit={() => setEditingAssetName(null)}
        /></Suspense>}
        {sshTarget && section !== "servers" && !sshTarget.managedHostId && <Suspense fallback={null}><SshClientDialog
          target={sshTarget}
          maximized={sshModalMaximized}
          sessionId={sshSessionId}
          platform={sshPlatform}
          authMethod={sshAuthMethod}
          host={sshHost}
          port={sshPort}
          username={sshUsername}
          password={sshPassword}
          privateKey={sshPrivateKey}
          keyPassphrase={sshKeyPassphrase}
          showPassword={showSshPassword}
          savePassword={sshSavePassword}
          passwordSaved={sshPasswordSaved}
          passwordRevealing={sshPasswordRevealing}
          testing={sshTesting}
          connecting={sshConnecting}
          error={sshError}
          filePaneCollapsed={sshFilePaneCollapsed}
          filePaneWidth={sshFilePaneWidth}
          fileDragActive={sshFileDragActive}
          files={sshFiles}
          filePath={sshFilePath}
          filesLoading={sshFilesLoading}
          fileError={sshFileError}
          fileEditor={sshFileEditor}
          fileSaving={sshFileSaving}
          workspaceRef={sshWorkspaceRef}
          terminalHostRef={sshTerminalHostRef}
          uploadInputRef={sshUploadInputRef}
          displayValue={displayValue}
          onClose={() => void closeSshClient()}
          onMaximizedChange={setSshModalMaximized}
          onPlatformChange={(platform) => void changeSshPlatform(platform)}
          onAuthMethodChange={setSshAuthMethod}
          onHostChange={setSshHost}
          onPortChange={setSshPort}
          onUsernameChange={setSshUsername}
          onPasswordChange={setSshPassword}
          onPrivateKeyChange={setSshPrivateKey}
          onKeyPassphraseChange={setSshKeyPassphrase}
          onShowPasswordChange={setShowSshPassword}
          onSavePasswordChange={setSshSavePassword}
          onTogglePassword={() => void toggleSshPasswordVisibility()}
          onClearSavedConnection={() => void clearSavedSshConnection()}
          onTest={() => void testSshConnection()}
          onConnect={() => void connectSshClient()}
          onCompleteCommand={completeSshCommand}
          onClearTerminal={clearSshTerminal}
          onDisconnect={() => void closeSshClient()}
          onFilePaneCollapsedChange={setSshFilePaneCollapsed}
          onFileResize={startSshFileResize}
          onFileDragActiveChange={setSshFileDragActive}
          onLoadFiles={(path) => void loadSshFiles(path)}
          onFilePathChange={setSshFilePath}
          onUploadFiles={(files) => void uploadSshFiles(files)}
          onMakeDirectory={() => void makeSshDirectory()}
          onOpenFile={(entry) => void openSshFile(entry)}
          onDownloadFile={(entry) => void downloadSshFile(entry)}
          onDeleteEntry={(entry) => void deleteSshEntry(entry)}
          onCloseFileEditor={() => setSshFileEditor(null)}
          onFileContentChange={(content) => setSshFileEditor((current) => current ? { ...current, content } : current)}
          onSaveFile={() => void saveSshFile()}
          fileSize={sshFileSize}
          parentPath={parentSshPath}
        /></Suspense>}
        {section === "logs" && <Suspense fallback={<PageLoadingState />}><OperationLogsPage rows={logRows} pagedRows={pagedLogRows} assetTypes={assetTypes} filter={logFilter} typeFilter={logTypeFilter} page={logPage} pageSize={pageSize} onFilterChange={setLogFilter} onTypeFilterChange={setLogTypeFilter} onReset={() => { setLogFilter(""); setLogTypeFilter(""); }} onClear={() => void clearLogs("operation")} onPageChange={setLogPage} /></Suspense>}
        {section === "api_logs" && <Suspense fallback={<PageLoadingState />}><ApiLogsPage rows={filteredApiLogs} pagedRows={pagedApiLogs} filter={logFilter} page={apiLogPage} pageSize={pageSize} onFilterChange={setLogFilter} onReset={() => { setLogFilter(""); setApiLogPage(1); }} onClear={() => void clearLogs("api")} onDetail={setApiLogDetail} onPageChange={setApiLogPage} /></Suspense>}
        {section === "settings" && <Suspense fallback={<PageLoadingState />}><SettingsPage
          autoRefresh={autoRefresh}
          compactMode={compactMode}
          pageSize={pageSize}
          updateSummary={!runningInTauri ? `当前版本 v${appVersion}；自动更新仅在桌面客户端可用` : updateState.phase === "available" ? `当前 v${appVersion}，最新 v${updateState.version}${updateState.notes ? "，可下载并安装" : ""}` : updateState.phase === "downloading" ? `当前 v${appVersion}，正在下载 v${updateState.version}` : updateState.phase === "ready" ? `v${updateState.version} 已安装，正在重新启动` : updateState.phase === "current" ? `当前 v${appVersion} 已是最新版本` : updateState.phase === "error" ? `当前 v${appVersion}；${updateState.message}` : `当前版本 v${appVersion}，启动时会自动检查新版本`}
          updateAction={runningInTauri && updateState.phase === "downloading" ? <span className="setting-state on">{updateState.total ? `${Math.min(100, Math.round((updateState.downloaded / updateState.total) * 100))}%` : "下载中"}</span> : runningInTauri && updateState.phase === "checking" ? <span className="setting-state on">检查中</span> : runningInTauri && updateState.phase === "available" ? <button className="secondary settings-link" onClick={() => void installUpdate()}><Download size={16} />下载并安装</button> : runningInTauri ? <button className="secondary settings-link" onClick={() => void checkForUpdates()}><RefreshCw size={16} />检查更新</button> : <span className="setting-state">桌面端</span>}
          onAutoRefreshChange={setAutoRefresh}
          onCompactModeChange={setCompactMode}
          onPageSizeChange={setPageSize}
          onOpenDataDirectory={() => void openDataDirectory()}
        /></Suspense>}
        {panelDialog && (
          <div className="modal-backdrop">
            <form className="modal panel-bind-modal" onSubmit={savePanelConnection} onClick={(event) => event.stopPropagation()}>
              <div className="modal-head"><div><span className="eyebrow">BT / AAPANEL API</span><h2>{panelDraft.id ? "编辑面板" : "添加面板"}</h2></div><button type="button" className="close" disabled={panelSaving} onClick={() => setPanelDialog(false)}><X size={20} /></button></div>
              <p className="security-tip">通过面板 API 验证并绑定。API 密钥将使用本机密钥加密保存，不会显示在面板列表中。</p>
              <label>名称<input required value={panelDraft.name} onChange={(event) => setPanelDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如：生产网站面板" autoFocus /></label>
              <label>验证类型<div className="panel-auth-static"><span>API</span><small>使用面板设置中的 API 接口密钥</small></div></label>
              <label>面板 URL<input required type="url" value={panelDraft.panel_url} onChange={(event) => setPanelDraft((current) => ({ ...current, panel_url: event.target.value }))} placeholder="例如：https://192.168.1.2:8888" /></label>
              <label>API 密钥<textarea required={!panelDraft.id} rows={2} value={panelDraft.api_key} onChange={(event) => setPanelDraft((current) => ({ ...current, api_key: event.target.value }))} placeholder={panelDraft.id ? "留空则保留已保存 API 密钥" : "粘贴面板 API 接口密钥"} autoComplete="off" /></label>
              <label className="panel-insecure-tls"><input type="checkbox" checked={panelDraft.allow_insecure_tls} onChange={(event) => setPanelDraft((current) => ({ ...current, allow_insecure_tls: event.target.checked }))} /><span><strong>允许不受信任 HTTPS 证书</strong><small>仅在面板使用确认可信的自签名证书时开启。</small></span></label>
              <div className="form-grid"><label>分组<input value={panelDraft.group_name} onChange={(event) => setPanelDraft((current) => ({ ...current, group_name: event.target.value }))} placeholder="生产 / 测试 / 个人" /></label><label>排序号<input type="number" min={0} value={panelDraft.sort_order} onChange={(event) => setPanelDraft((current) => ({ ...current, sort_order: Math.max(0, Number(event.target.value) || 0) }))} placeholder="数字越小越靠前" /></label></div>
              <label>备注<input value={panelDraft.remark} onChange={(event) => setPanelDraft((current) => ({ ...current, remark: event.target.value }))} placeholder="可选" /></label>
              <ul className="panel-bind-steps"><li>填写面板 URL，例如 <code>https://192.168.1.2:8888</code>。</li><li>在宝塔或 aaPanel 的“面板设置 / API 接口”中启用 API。</li><li>把当前电脑的公网 IP 加到 API 白名单；没有固定 IP 时可按面板规则配置。</li><li>复制接口密钥到上方，保存时会即时验证连接。</li></ul>
              <div className="modal-actions"><button type="button" className="secondary" disabled={panelSaving} onClick={() => setPanelDialog(false)}>取消</button><button type="submit" className="layui-btn layui-btn-normal" disabled={panelSaving}>{panelSaving ? "验证并保存中…" : panelDraft.id ? "验证并保存" : "绑定面板"}</button></div>
            </form>
          </div>
        )}
        {managedHostDialog && <Suspense fallback={null}><ManagedHostDialog
          open={managedHostDialog}
          draft={managedHostDraft}
          saving={managedHostSaving}
          onClose={() => setManagedHostDialog(false)}
          onDraftChange={setManagedHostDraft}
          onSubmit={saveManagedHost}
        /></Suspense>}        {apiLogDetail && (
          <div className="modal-backdrop" onClick={() => setApiLogDetail(null)}>
            <section className="modal api-log-detail-modal" onClick={(event) => event.stopPropagation()}>
              <div className="modal-head"><div><span className="eyebrow">API DETAIL</span><h2>API 调用详情</h2></div><button className="close" onClick={() => setApiLogDetail(null)}><X size={20} /></button></div>
              <div className="api-log-meta"><span>账号：{apiLogDetail.account_name || "未知账号"}</span><span>接口：{apiLogDetail.endpoint}</span><span>操作：{apiLogDetail.action}</span><span>时间：{new Date(apiLogDetail.created_at).toLocaleString()}</span><span className={apiLogDetail.status === "成功" ? "log-success" : "log-failure"}>状态：{apiLogDetail.status}</span></div>
              <div className="api-log-section"><h3>上送参数</h3><pre>{formatJson(apiLogDetail.request_params)}</pre></div>
              <div className="api-log-section"><h3>返回参数</h3><pre>{formatJson(apiLogDetail.response_params)}</pre></div>
              {apiLogDetail.message && <div className="api-log-message">错误信息：{apiLogDetail.message}</div>}
            </section>
          </div>
        )}
        {assetDetail && <Suspense fallback={null}><AssetDetailDialog
          detail={assetDetail}
          displayValue={displayValue}
          columnLabel={columnLabel}
          onClose={() => setAssetDetail(null)}
        /></Suspense>}
        {syncAccount && <Suspense fallback={null}><AssetSyncDialog
          account={syncAccount}
          selectedTypes={syncTypes}
          syncing={syncing}
          result={syncResult}
          showOracleDatabasePermissionHint={showOracleDatabasePermissionHint}
          onSelectedTypesChange={setSyncTypes}
          onClose={closeAssetSync}
          onSync={() => void syncAssets()}
        /></Suspense>}
        <footer>
          <span />
        </footer>
      {dialog && <Suspense fallback={null}><AccountDialog
        open={dialog}
        draft={draft}
        showSecret={showSecret}
        verifying={verifyingAccount}
        onClose={() => setDialog(false)}
        onDraftChange={setDraft}
        onSubmit={save}
        onToggleSecret={() => void toggleAccountSecretVisibility()}
        onVerify={() => void verifyCloudAccount()}
      /></Suspense>}
      <ConfirmDialog request={confirmRequest} onResolve={resolveConfirm} />
      <PromptDialog request={promptRequest} value={promptValue} onValueChange={setPromptValue} onResolve={resolvePrompt} />
    </AppShell>
  );
}

export default App;




