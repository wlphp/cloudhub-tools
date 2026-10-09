import { SecretField } from "../shared/SecretField";
import { useCallback, useEffect, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { Activity, CloudDownload, LayoutGrid, ArrowDownToLine, ArrowUpDown, Cloud, Database, File, FileText, Filter, Folder, Globe2, Plus, Power, RefreshCw, RotateCw, Search, Server, ShieldCheck, X, Trash2, Award, Terminal, Pencil, ExternalLink, Monitor, Upload, Info } from "lucide-react";
import type { Account, ApiLog, Certificate, LocalAsset, ManagedHost, PanelConnection, PanelConnectionDraft, TransferAccount } from "../shared/types";
import packageJson from "../../package.json";
import { accountsClient, certificatesClient, domainsClient, logsClient, remoteClient, resourcesClient, storageClient } from "../platform/clients";
import type { OssObjectListing } from "../platform/clients/storage";
import { cloudProvider, cloudProviders, resourceLabels, syncAssetTypes } from "../features/cloud/catalog";
import type { AccountSaveInput } from "../platform/clients/accounts";
import { serversClient, type InstanceAction } from "../platform/clients/servers";
import { SyncTransferPanel } from "../features/accounts/SyncTransferPanel";
import { runningInTauri } from "../platform/api";
import { MobileResourceOverview } from "./MobileResourceOverview";
import { MobilePanelMetrics } from "./MobilePanelMetrics";
import { MobileMorePage } from "./MobileMorePage";
import { useMobileUpdates } from "./useMobileUpdates";
import { MobileUpdatePanel } from "./MobileUpdatePanel";
import { FlowPanel } from "../features/flow/FlowPanel";
import { MobileAccountSwipeCard } from "./MobileAccountSwipeCard";
import { panelRefreshIntervals, useMobilePanelRefresh } from "./useMobilePanelRefresh";

type MobileTab = "accounts" | "servers" | "domains" | "storage" | "databases" | "redis" | "certificates" | "ssh" | "panels" | "sync" | "settings" | "operationLogs" | "apiLogs" | "about" | "flow" | "more";

function payloadText(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "—";
}

function serverStatusClass(payload: Record<string, unknown>): string {
  const status = payloadText(payload, ["InstanceStatus", "instanceStatus", "status", "Status"]).toLowerCase();
  if (["running", "active", "运行中", "正常"].includes(status)) return "mobile-server-status is-running";
  if (["stopped", "stop", "已停止", "停止"].includes(status)) return "mobile-server-status is-stopped";
  return "mobile-server-status is-pending";
}

function fetchedAtLabel(timestamp: number): string {
  const date = new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString();
}

function accountMetaValue(account: Account | null | undefined, key: string): string {
  if (!account?.credential_meta) return "";
  try {
    const meta = JSON.parse(account.credential_meta) as Record<string, unknown>;
    return typeof meta[key] === "string" ? meta[key] as string : "";
  } catch { return ""; }
}

export function MobileApp() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [accountSearch, setAccountSearch] = useState("");
  const [accountProviderFilter, setAccountProviderFilter] = useState("");
  const [accountSortAscending, setAccountSortAscending] = useState(true);
  const [assetAccountFilterId, setAssetAccountFilterId] = useState<number | null>(null);
  const [serverSearch, setServerSearch] = useState("");
  const [serverSortAscending, setServerSortAscending] = useState(true);
  const [servers, setServers] = useState<LocalAsset[]>([]);
  const [serverKind, setServerKind] = useState<"ecs" | "swas">("ecs");
  const [domains, setDomains] = useState<LocalAsset[]>([]);
  const [domainSearch, setDomainSearch] = useState("");
  const [domainSortAscending, setDomainSortAscending] = useState(true);
  const [resourceSearch, setResourceSearch] = useState<Partial<Record<MobileTab, string>>>({});
  const [resourceAscending, setResourceAscending] = useState<Partial<Record<MobileTab, boolean>>>({});
  const [resourceStatus, setResourceStatus] = useState<Partial<Record<MobileTab, string>>>({});
  const [selectedDomain, setSelectedDomain] = useState<LocalAsset | null>(null);
  const [dnsRecords, setDnsRecords] = useState<Record<string, unknown>[]>([]);
  const [buckets, setBuckets] = useState<LocalAsset[]>([]);
  const [selectedBucket, setSelectedBucket] = useState<LocalAsset | null>(null);
  const [objectPrefix, setObjectPrefix] = useState("");
  const [objectListing, setObjectListing] = useState<OssObjectListing | null>(null);
  const [databaseAssets, setDatabaseAssets] = useState<LocalAsset[]>([]);
  const [selectedDatabase, setSelectedDatabase] = useState<LocalAsset | null>(null);
  const [databaseDetails, setDatabaseDetails] = useState<Record<string, unknown>[]>([]);
  const [redisAssets, setRedisAssets] = useState<LocalAsset[]>([]);
  const [selectedRedis, setSelectedRedis] = useState<LocalAsset | null>(null);
  const [redisAccounts, setRedisAccounts] = useState<Record<string, unknown>[]>([]);
  const [certificates, setCertificates] = useState<Certificate[]>([]);
  const mobileUpdate = useMobileUpdates();
  const [operationLogAssets, setOperationLogAssets] = useState<LocalAsset[]>([]);
  const [apiLogs, setApiLogs] = useState<ApiLog[]>([]);
  const [operationLogsLoading, setOperationLogsLoading] = useState(false);
  const [apiLogsLoading, setApiLogsLoading] = useState(false);
  const [operationLogClearedAt, setOperationLogClearedAt] = useState(() => Number(localStorage.getItem("aliyun-operation-log-cleared-at") || "0"));
  const [managedHosts, setManagedHosts] = useState<ManagedHost[]>([]);
  const [panelConnections, setPanelConnections] = useState<PanelConnection[]>([]);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelActionId, setPanelActionId] = useState<number | null>(null);
  const [panelDraft, setPanelDraft] = useState<PanelConnectionDraft | null>(null);
  const [panelSaving, setPanelSaving] = useState(false);
  const [sshSessionId, setSshSessionId] = useState<string | null>(null);
  const [sshHost, setSshHost] = useState<ManagedHost | null>(null);
  const [sshOutput, setSshOutput] = useState("");
  const [sshCommand, setSshCommand] = useState("");
  const [sshConnecting, setSshConnecting] = useState(false);
  const [showAddSshHost, setShowAddSshHost] = useState(false);
  const [newSshAuthMethod, setNewSshAuthMethod] = useState<"password" | "private_key">("password");
  const [dnsEditor, setDnsEditor] = useState<Record<string, unknown> | null | undefined>(undefined);
  const [tab, setTab] = useState<MobileTab>("accounts");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncingAccountId, setSyncingAccountId] = useState<number | null>(null);
  const [cleaningUnknownResource, setCleaningUnknownResource] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [removingAccountId, setRemovingAccountId] = useState<number | null>(null);
  const [importingAccounts, setImportingAccounts] = useState(false);
  const accountImportInput = useRef<HTMLInputElement>(null);
  const mobileContentRef = useRef<HTMLElement>(null);
  const pullRefreshActionRef = useRef<(() => Promise<void>) | null>(null);
  const pullRefreshingRef = useRef(false);
  const pullGestureRef = useRef({ startX: 0, startY: 0, distance: 0, tracking: false });
  const [pullDistance, setPullDistance] = useState(0);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [newAccountCloud, setNewAccountCloud] = useState("aliyun");
  const [notice, setNotice] = useState("");
  const accountForAsset = useCallback((asset: LocalAsset | null) => asset ? accounts.find((account) => account.id === asset.account_id) ?? null : null, [accounts]);
  const selectedDomainAccount = accountForAsset(selectedDomain);
  const selectedBucketAccount = accountForAsset(selectedBucket);
  const selectedDatabaseAccount = accountForAsset(selectedDatabase);
  const selectedRedisAccount = accountForAsset(selectedRedis);
  const currentResourceScope = useRef({ accountId: selectedAccountId, tab });
  currentResourceScope.current = { accountId: selectedAccountId, tab };
  const previousAccountId = useRef(selectedAccountId);
  const resourceReadSequence = useRef(0);
  const beginResourceRead = useCallback((resourceTab: MobileTab, accountId: number | null) => {
    const sequence = ++resourceReadSequence.current;
    return () => sequence === resourceReadSequence.current
      && currentResourceScope.current.tab === resourceTab
      && currentResourceScope.current.accountId === accountId;
  }, []);

  useEffect(() => {
    const accountChanged = previousAccountId.current !== selectedAccountId;
    previousAccountId.current = selectedAccountId;
    resourceReadSequence.current += 1;
    setLoading(false);
    setNotice("");
    if (accountChanged) {
      setServers([]);
      setDomains([]);
      setSelectedDomain(null);
      setDnsRecords([]);
      setBuckets([]);
      setSelectedBucket(null);
      setObjectListing(null);
      setDatabaseAssets([]);
      setSelectedDatabase(null);
      setDatabaseDetails([]);
      setRedisAssets([]);
      setSelectedRedis(null);
      setRedisAccounts([]);
      setCertificates([]);
    }
  }, [selectedAccountId, tab]);

  const refreshAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const result = await accountsClient.list();
      setAccounts(result);
      setSelectedAccountId((current) => current !== null && result.some((account) => account.id === current) ? current : result[0]?.id ?? null);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取云账号失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshServers = useCallback(async (accountId: number | null = selectedAccountId) => {
    const isCurrentRead = beginResourceRead("servers", accountId);
    setLoading(true);
    try {
      const results = await Promise.all(["ecs", "swas"].map((resourceType) => resourcesClient.listLocal({ resourceType })));
      const result = results.flat();
      if (!isCurrentRead()) return;
      setServers(result);
      setNotice("");
    } catch (error) {
      if (!isCurrentRead()) return;
      setNotice(error instanceof Error ? error.message : "读取本机缓存失败");
    } finally {
      if (isCurrentRead()) setLoading(false);
    }
  }, [beginResourceRead, selectedAccountId]);

  useEffect(() => { void refreshAccounts(); }, [refreshAccounts]);

  const refreshDomains = useCallback(async (accountId: number | null = selectedAccountId) => {
    const isCurrentRead = beginResourceRead("domains", accountId);
    setLoading(true);
    try {
      const result = await resourcesClient.listLocal({ resourceType: "domain" });
      if (!isCurrentRead()) return;
      setDomains(result);
      setSelectedDomain(null);
      setDnsRecords([]);
      setNotice("");
    } catch (error) {
      if (!isCurrentRead()) return;
      setNotice(error instanceof Error ? error.message : "读取域名缓存失败");
    } finally { if (isCurrentRead()) setLoading(false); }
  }, [beginResourceRead, selectedAccountId]);

  const refreshBuckets = useCallback(async (accountId: number | null = selectedAccountId) => {
    const isCurrentRead = beginResourceRead("storage", accountId);
    setLoading(true);
    try {
      const result = await resourcesClient.listLocal({ resourceType: "oss" });
      if (!isCurrentRead()) return;
      setBuckets(result); setSelectedBucket(null); setObjectListing(null); setNotice("");
    }
    catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取存储桶失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }, [beginResourceRead, selectedAccountId]);

  const refreshDatabases = useCallback(async (accountId: number | null = selectedAccountId) => {
    const isCurrentRead = beginResourceRead("databases", accountId);
    setLoading(true);
    try {
      const result = await resourcesClient.listLocal({ resourceType: "rds" });
      if (!isCurrentRead()) return;
      setDatabaseAssets(result); setSelectedDatabase(null); setDatabaseDetails([]); setNotice("");
    }
    catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取数据库实例失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }, [beginResourceRead, selectedAccountId]);

  const refreshRedis = useCallback(async (accountId: number | null = selectedAccountId) => {
    const isCurrentRead = beginResourceRead("redis", accountId);
    setLoading(true);
    try {
      const result = await resourcesClient.listLocal({ resourceType: "redis" });
      if (!isCurrentRead()) return;
      setRedisAssets(result); setSelectedRedis(null); setRedisAccounts([]); setNotice("");
    }
    catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取 Redis 实例失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }, [beginResourceRead, selectedAccountId]);

  async function loadRedisAccounts(instance: LocalAsset) {
    const account = accountForAsset(instance);
    if (!account) { setNotice("找不到该 Redis 实例所属的云账号"); return; }
    if (!["aliyun", "tencent"].includes(account.cloud_type)) { setNotice(`${cloudProvider(account.cloud_type).label}暂未接入 Redis 账号查询`); return; }
    const instanceId = payloadText(instance.payload, ["InstanceId", "instanceId", "Id", "id"]);
    const regionId = instance.region_id || account.region_id || "";
    if (instanceId === "—") { setNotice("Redis 实例缓存缺少实例 ID"); return; }
    const isCurrentRead = beginResourceRead("redis", selectedAccountId);
    setSelectedRedis(instance); setLoading(true);
    try {
      const result = await resourcesClient.redisAccounts(account.id, regionId, instanceId);
      if (!isCurrentRead()) return;
      setRedisAccounts(result); setNotice("");
    }
    catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取 Redis 账号失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }

  async function refreshRedisFromCloud() {
    await syncAllAccounts("redis", "Redis 实例", () => refreshRedis());
  }

  const refreshCertificates = useCallback(async () => {
    const isCurrentRead = beginResourceRead("certificates", selectedAccountId);
    setLoading(true);
    try {
      const result = await certificatesClient.list();
      if (!isCurrentRead()) return;
      setCertificates(result); setNotice("");
    }
    catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取证书失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }, [beginResourceRead, selectedAccountId]);

  useEffect(() => {
    if (tab === "servers") void refreshServers();
    else if (tab === "domains") void refreshDomains();
    else if (tab === "storage") void refreshBuckets();
    else if (tab === "databases") void refreshDatabases();
    else if (tab === "redis") void refreshRedis();
    else if (tab === "certificates") void refreshCertificates();
  }, [tab, selectedAccountId, refreshServers, refreshDomains, refreshBuckets, refreshDatabases, refreshRedis, refreshCertificates]);

  const refreshManagedHosts = useCallback(async () => {
    setLoading(true);
    try { setManagedHosts(await serversClient.listManaged()); setNotice(""); }
    catch (error) { setNotice(error instanceof Error ? error.message : "读取 SSH 主机失败"); }
    finally { setLoading(false); }
  }, []);

  const panelAutoRefresh = useMobilePanelRefresh(tab === "panels", panelLoading || panelActionId !== null || panelDraft !== null || panelSaving, panelConnections, setPanelConnections);

  const refreshPanelConnections = useCallback(async () => {
    if (panelAutoRefresh.inFlight.current) return;
    setPanelLoading(true);
    try { setPanelConnections(await remoteClient.listPanels()); }
    catch (error) { setNotice(error instanceof Error ? error.message : "读取面板配置失败"); }
    finally { setPanelLoading(false); }
  }, [panelAutoRefresh.inFlight]);

  useEffect(() => {
    if (tab === "ssh") void refreshManagedHosts();
    else if (tab === "panels") void refreshPanelConnections();
  }, [tab, refreshManagedHosts, refreshPanelConnections]);

  const refreshOperationLogs = useCallback(async () => {
    setOperationLogsLoading(true);
    try { setOperationLogAssets(await resourcesClient.listLocal()); setNotice(""); }
    catch { setNotice("读取操作日志失败"); }
    finally { setOperationLogsLoading(false); }
  }, []);

  const refreshApiLogs = useCallback(async () => {
    setApiLogsLoading(true);
    try { setApiLogs(await logsClient.listApi({ limit: 100 })); setNotice(""); }
    catch { setNotice("读取 API 日志失败"); }
    finally { setApiLogsLoading(false); }
  }, []);

  async function clearMobileLogs(kind: "operation" | "api") {
    const label = kind === "operation" ? "操作日志" : "API 日志";
    if (!window.confirm(`确定清空${label}吗？此操作不可恢复。`)) return;
    try {
      await logsClient.clear(kind);
      if (kind === "api") setApiLogs([]);
      else {
        const clearedAt = Date.now();
        setOperationLogClearedAt(clearedAt);
        localStorage.setItem("aliyun-operation-log-cleared-at", String(clearedAt));
      }
      setNotice(`${label}已清空`);
    } catch { setNotice(`清空${label}失败`); }
  }

  async function refreshPanelStatus(panel: PanelConnection) {
    if (panelActionId !== null || panelAutoRefresh.inFlight.current) return;
    setPanelActionId(panel.id); setNotice("");
    try {
      const updated = await remoteClient.refreshPanel(panel.id);
      setPanelConnections((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice(updated.status === "online" ? `已刷新面板“${updated.name}”状态` : `面板“${updated.name}”当前无法连接`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "刷新面板状态失败"); }
    finally { setPanelActionId(null); }
  }

  async function openPanel(panel: PanelConnection) {
    if (panelActionId !== null || panelAutoRefresh.inFlight.current) return;
    setPanelActionId(panel.id); setNotice("");
    try {
      await remoteClient.openPanelTemporaryLogin(panel.id);
      setNotice(`正在打开面板“${panel.name}”`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "打开面板失败"); }
    finally { setPanelActionId(null); }
  }

  function addPanel() {
    setNotice("");
    setPanelDraft({ name: "", panel_url: "", sort_order: panelConnections.length, api_key: "", allow_insecure_tls: false, group_name: "", remark: "" });
  }

  function editPanel(panel: PanelConnection) {
    setNotice("");
    setPanelDraft({ id: panel.id, name: panel.name, panel_url: panel.panel_url, sort_order: panel.sort_order, api_key: "", allow_insecure_tls: panel.allow_insecure_tls, group_name: panel.group_name ?? "", source_account_id: panel.source_account_id, source_asset_key: panel.source_asset_key, remark: panel.remark ?? "" });
  }

  async function savePanel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!panelDraft || panelSaving) return;
    const name = panelDraft.name.trim();
    const panelUrl = panelDraft.panel_url.trim();
    let parsedUrl: URL;
    try { parsedUrl = new URL(panelUrl); }
    catch { setNotice("请输入有效的面板根地址"); return; }
    if (!name) { setNotice("请填写面板名称"); return; }
    if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || (parsedUrl.pathname !== "/" && parsedUrl.pathname !== "") || parsedUrl.search || parsedUrl.hash) {
      setNotice("面板地址仅支持 http(s) 根地址，不要包含路径、查询参数或登录信息"); return;
    }
    if (!panelDraft.id && !panelDraft.api_key.trim()) { setNotice("首次添加面板时必须填写 API 密钥"); return; }
    setPanelSaving(true); setNotice("");
    try {
      const saved = await remoteClient.savePanel({ ...panelDraft, name, panel_url: parsedUrl.origin, api_key: panelDraft.api_key.trim() });
      setPanelConnections((current) => current.some((panel) => panel.id === saved.id) ? current.map((panel) => panel.id === saved.id ? saved : panel) : [...current, saved]);
      setPanelDraft(null); setNotice(`已保存面板“${saved.name}”，配置和密钥保存在本机`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "保存面板配置失败"); }
    finally { setPanelSaving(false); }
  }

  async function removePanel(panel: PanelConnection) {
    if (!window.confirm(`删除本机保存的面板“${panel.name}”？不会删除云服务器或面板中的数据。`)) return;
    setPanelActionId(panel.id); setNotice("");
    try { await remoteClient.deletePanel(panel.id); setPanelConnections((current) => current.filter((item) => item.id !== panel.id)); setNotice(`已删除本机面板配置“${panel.name}”`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "删除面板配置失败"); }
    finally { setPanelActionId(null); }
  }

  useEffect(() => {
    if (!sshSessionId) return;
    let disposed = false;
    const read = async () => {
      try {
        const output = await remoteClient.readSsh(sshSessionId);
        if (!disposed && output) setSshOutput((current) => `${current}${output}`.slice(-80_000));
      } catch (error) {
        if (!disposed) { setNotice(error instanceof Error ? `SSH 会话已断开：${error.message}` : "SSH 会话已断开"); setSshSessionId(null); }
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 300);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [sshSessionId]);

  useEffect(() => {
    if (tab === "ssh" || !sshSessionId) return;
    const sessionId = sshSessionId;
    void remoteClient.disconnectSsh(sessionId).catch(() => undefined).finally(() => {
      setSshSessionId((current) => current === sessionId ? null : current);
      setSshHost((current) => current?.id === sshHost?.id ? null : current);
      setSshOutput("");
    });
  }, [tab, sshSessionId]);

  async function loadDatabaseDetails(instance: LocalAsset) {
    const account = accountForAsset(instance);
    if (!account) { setNotice("找不到该数据库实例所属的云账号"); return; }
    const payload = instance.payload;
    const instanceId = payloadText(payload, ["DBInstanceId", "InstanceId", "instanceId", "id"]);
    const regionId = instance.region_id || account.region_id || "";
    if (instanceId === "—") { setNotice("数据库实例缓存缺少实例 ID"); return; }
    const isCurrentRead = beginResourceRead("databases", selectedAccountId);
    setSelectedDatabase(instance); setLoading(true);
    try {
      const result = await resourcesClient.rdsDetails("databases", account.id, regionId, instanceId);
      if (!isCurrentRead()) return;
      setDatabaseDetails(result); setNotice("");
    }
    catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取数据库清单失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }

  async function refreshDatabasesFromCloud() {
    await syncAllAccounts("rds", "数据库实例", () => refreshDatabases());
  }

  async function browseBucket(bucket: LocalAsset, prefix = "", marker = "") {
    const account = accountForAsset(bucket);
    if (!account) { setNotice("找不到该存储桶所属的云账号"); return; }
    const bucketName = payloadText(bucket.payload, ["Name", "Bucket", "name"]);
    const location = payloadText(bucket.payload, ["Location", "location", "Region"]);
    if (bucketName === "—" || location === "—") { setNotice("存储桶缓存缺少名称或地域"); return; }
    const isCurrentRead = beginResourceRead("storage", selectedAccountId);
    setSelectedBucket(bucket); setObjectPrefix(prefix); setLoading(true);
    try {
      const result = await storageClient.objects(account.id, bucketName, location, prefix, marker);
      if (!isCurrentRead()) return;
      setObjectListing(marker && objectListing ? { ...result, objects: [...objectListing.objects, ...result.objects], prefixes: [...objectListing.prefixes, ...result.prefixes] } : result);
      setNotice("");
    } catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取对象列表失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }

  async function refreshBucketsFromCloud() {
    await syncAllAccounts("oss", "存储桶", () => refreshBuckets());
  }

  async function loadDns(domainAsset: LocalAsset) {
    const account = accountForAsset(domainAsset);
    if (!account) { setNotice("找不到该域名所属的云账号"); return; }
    const domain = payloadText(domainAsset.payload, ["DomainName", "domain", "domainName", "name"]);
    if (domain === "—") { setNotice("缓存中缺少域名名称，请先刷新云端数据"); return; }
    const isCurrentRead = beginResourceRead("domains", selectedAccountId);
    setSelectedDomain(domainAsset);
    setLoading(true);
    try {
      const response = await domainsClient.records(account.id, domain, { page: 1, pageSize: 100 });
      if (!isCurrentRead()) return;
      setDnsRecords(Array.isArray(response.items) ? response.items as Record<string, unknown>[] : []);
      setNotice("");
    } catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取 DNS 记录失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }

  async function refreshDomainsFromCloud() {
    await syncAllAccounts("domain", "域名", () => refreshDomains());
  }

  async function changeDnsRecord(row: Record<string, unknown>, action: "toggle" | "delete") {
    const account = accountForAsset(selectedDomain);
    if (!account || !selectedDomain || account.cloud_type !== "aliyun") return;
    const recordId = String(row.RecordId ?? "");
    if (!recordId) { setNotice("记录缺少云端 ID，无法操作"); return; }
    if (action === "delete" && !window.confirm(`确认删除 ${String(row.RR ?? "")} 记录吗？`)) return;
    try {
      if (action === "delete") await domainsClient.remove(account.id, recordId);
      else await domainsClient.toggle(account.id, recordId, String(row.Status).toUpperCase() === "ENABLE" ? "Disable" : "Enable");
      await loadDns(selectedDomain);
      setNotice(action === "delete" ? "DNS 记录已删除" : "DNS 记录状态已更新");
    } catch (error) { setNotice(error instanceof Error ? error.message : "DNS 操作失败"); }
  }

  async function saveDnsRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const account = accountForAsset(selectedDomain);
    if (!account || !selectedDomain || account.cloud_type !== "aliyun") return;
    const form = new FormData(event.currentTarget);
    const type = String(form.get("recordType") || "A");
    const rr = String(form.get("rr") || "").trim();
    const value = String(form.get("value") || "").trim();
    const ttl = Number(form.get("ttl") || 600);
    const priority = Number(form.get("priority") || 10);
    const line = String(form.get("line") || "default");
    if (!rr || !value || !Number.isInteger(ttl) || ttl < 1) { setNotice("请填写主机记录、记录值和有效 TTL"); return; }
    const octets = value.split(".");
    if (type === "A" && (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255))) { setNotice("A 记录需要有效的 IPv4 地址"); return; }
    if (type === "AAAA" && !value.includes(":")) { setNotice("AAAA 记录需要 IPv6 地址"); return; }
    if (type === "MX" && (!Number.isInteger(priority) || priority < 1 || priority > 50)) { setNotice("MX 优先级需为 1 到 50 的整数"); return; }
    const domain = payloadText(selectedDomain.payload, ["DomainName", "domain", "domainName", "name"]);
    const input = { recordType: type, rr, value, ttl, priority: type === "MX" ? priority : undefined, line };
    try {
      if (dnsEditor) await domainsClient.update(account.id, { recordId: String(dnsEditor.RecordId), ...input });
      else await domainsClient.add(account.id, domain, input);
      setDnsEditor(undefined);
      await loadDns(selectedDomain);
      setNotice(dnsEditor ? "DNS 记录已更新" : "DNS 记录已添加");
    } catch (error) { setNotice(error instanceof Error ? error.message : "保存 DNS 记录失败"); }
  }

  async function syncAllAccounts(resourceType: string, label: string, refresh: () => Promise<void>) {
    if (syncing) return;
    const targets = accounts.filter((account) => syncAssetTypes(account).some(([type]) => type === resourceType));
    if (targets.length === 0) {
      setNotice(`当前没有已接入${label}同步的云账号`);
      return;
    }
    setSyncing(true);
    setNotice("");
    try {
      let fetched = 0;
      const errors: string[] = [];
      for (const account of targets) {
        try {
          const result = await resourcesClient.sync(account.id, [resourceType]);
          fetched += result.fetched;
          errors.push(...result.errors.map((error) => `${account.account_name}：${error}`));
        } catch (error) {
          errors.push(`${account.account_name}：${error instanceof Error ? error.message : "同步失败"}`);
        }
      }
      if (currentResourceScope.current.tab !== tab || currentResourceScope.current.accountId !== selectedAccountId) return;
      await refresh();
      if (currentResourceScope.current.tab !== tab || currentResourceScope.current.accountId !== selectedAccountId) return;
      setNotice(errors.length
        ? `部分${label}刷新失败，共获取 ${fetched} 项。${[...new Set(errors)].join("；")}`
        : `已从 ${targets.length} 个云账号刷新 ${fetched} 项${label}`);
    } catch (error) {
      if (currentResourceScope.current.tab === tab) setNotice(error instanceof Error ? error.message : `${label}同步失败`);
    } finally {
      setSyncing(false);
    }
  }

  async function syncAccountAssets(account: Account) {
    if (syncing) return;
    const resourceTypes = syncAssetTypes(account).map(([type]) => type);
    if (!resourceTypes.length) {
      setNotice(`${cloudProvider(account.cloud_type).label}暂未接入资产同步`);
      return;
    }
    setSyncing(true);
    setSyncingAccountId(account.id);
    setNotice("");
    try {
      const result = await resourcesClient.sync(account.id, resourceTypes);
      setNotice(result.errors.length
        ? `已从 ${account.account_name} 获取 ${result.fetched} 项资产，部分类型失败：${[...new Set(result.errors)].join("；")}`
        : `已从 ${account.account_name} 获取并保存 ${result.fetched} 项资产`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `获取 ${account.account_name} 资产失败`);
    } finally {
      setSyncing(false);
      setSyncingAccountId(null);
    }
  }

  async function syncServers() {
    const targets = accounts.filter((account) => syncAssetTypes(account).some(([type]) => type === "ecs" || type === "swas"));
    if (!targets.length) { setNotice("当前没有已接入服务器同步的云账号"); return; }
    if (syncing) return;
    setSyncing(true);
    setNotice("");
    try {
      let fetched = 0;
      const errors: string[] = [];
      for (const account of targets) {
        const resourceTypes = syncAssetTypes(account).map(([type]) => type).filter((type) => type === "ecs" || type === "swas");
        try {
          const result = await resourcesClient.sync(account.id, resourceTypes);
          fetched += result.fetched;
          errors.push(...result.errors.map((error) => `${account.account_name}：${error}`));
        } catch (error) {
          errors.push(`${account.account_name}：${error instanceof Error ? error.message : "同步失败"}`);
        }
      }
      if (currentResourceScope.current.tab !== "servers" || currentResourceScope.current.accountId !== selectedAccountId) return;
      await refreshServers();
      if (currentResourceScope.current.tab !== "servers" || currentResourceScope.current.accountId !== selectedAccountId) return;
      setNotice(errors.length
        ? `部分服务器刷新失败，共获取 ${fetched} 项。${[...new Set(errors)].join("；")}`
        : `已从 ${targets.length} 个云账号刷新 ${fetched} 项服务器`);
    } catch (error) {
      if (currentResourceScope.current.tab === "servers") setNotice(error instanceof Error ? error.message : "服务器同步失败");
    } finally { setSyncing(false); }
  }

  async function runServerAction(server: LocalAsset, action: InstanceAction) {
    const account = accountForAsset(server);
    if (!account || !["aliyun", "tencent"].includes(account.cloud_type)) return;
    const instanceId = payloadText(server.payload, ["instanceId", "InstanceId", "id", "Id"]);
    const name = payloadText(server.payload, ["instanceName", "InstanceName", "name", "Name", "serverName"]);
    const actionLabel = action === "reboot" ? "重启" : action === "start" ? "启动" : "停止";
    if (instanceId === "—" || !window.confirm(`确认${actionLabel}服务器“${name}”吗？`)) return;
    const key = `${server.account_id}:${server.asset_key}`;
    setActiveAction(key);
    setNotice("");
    try {
      const payload = { id: server.account_id, regionId: server.region_id || account.region_id || "", instanceId, action, forceStop: false };
      if (server.resource_type === "swas") await serversClient.swasAction(payload);
      else if (account.cloud_type === "aliyun") await serversClient.aliyunAction(payload);
      else await serversClient.providerAction("tencent", payload);
      setNotice(`已提交${actionLabel}请求，云厂商状态可能需要片刻更新`);
      await refreshServers();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${actionLabel}请求失败`);
    } finally {
      setActiveAction(null);
    }
  }

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const accountName = String(form.get("accountName") || "").trim();
    const credentialMeta = newAccountCloud === "oracle"
      ? { tenancy_ocid: String(form.get("tenancyOcid") || "").trim(), key_fingerprint: String(form.get("keyFingerprint") || "").trim() }
      : newAccountCloud === "azure"
        ? { tenant_id: String(form.get("tenantId") || "").trim(), subscription_id: String(form.get("subscriptionId") || "").trim() }
        : newAccountCloud === "gcp" ? { project_id: String(form.get("projectId") || "").trim() } : editingAccount?.credential_meta ?? null;
    const input: AccountSaveInput = {
      ...(editingAccount ? { id: editingAccount.id } : {}),
      account_name: accountName,
      cloud_type: newAccountCloud,
      group_name: String(form.get("groupName") || "").trim(),
      access_key_id: String(form.get("accessKeyId") || "").trim() || (newAccountCloud === "vultr" ? accountName : ""),
      access_key_secret: String(form.get("accessKeySecret") || ""),
      credential_meta: credentialMeta ? JSON.stringify(credentialMeta) : null,
      region_id: String(form.get("regionId") || "").trim(),
      enabled: form.get("enabled") === "true",
      sort_order: editingAccount?.sort_order ?? 0,
      remark: String(form.get("remark") || "").trim(),
    };
    try {
      await accountsClient.save(input);
      formElement.reset();
      setShowAddAccount(false);
      setEditingAccount(null);
      setNewAccountCloud("aliyun");
      await refreshAccounts();
      setNotice(editingAccount ? "云账号配置已更新，本机凭据保持加密" : "云账号已加密保存在本机");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : editingAccount ? "更新云账号失败" : "添加云账号失败");
    }
  }

  function openAddAccount() { setEditingAccount(null); setNewAccountCloud("aliyun"); setShowAddAccount(true); }
  function openEditAccount(account: Account) {
    setEditingAccount(account);
    setNewAccountCloud(account.cloud_type);
    setShowAddAccount(true);
  }

  async function removeAccount(account: Account) {
    if (!window.confirm(`确认从这台设备删除“${account.account_name}”及其本地加密凭据和缓存吗？此操作不会注销云厂商账号。`)) return;
    setRemovingAccountId(account.id);
    try {
      await accountsClient.remove(account.id);
      await refreshAccounts();
      if (tab === "servers") await refreshServers();
      else if (tab === "domains") await refreshDomains();
      else if (tab === "storage") await refreshBuckets();
      else if (tab === "databases") await refreshDatabases();
      else if (tab === "redis") await refreshRedis();
      else if (tab === "certificates") await refreshCertificates();
      setNotice("账号及其本地数据已删除");
    } catch (error) { setNotice(error instanceof Error ? error.message : "删除云账号失败"); }
    finally { setRemovingAccountId(null); }
  }

  async function importAccountFile(file?: File) {
    if (!file) return;
    setImportingAccounts(true);
    setNotice("");
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error("账号文件超过 15 MB，已拒绝读取。");
      const parsed: unknown = JSON.parse(await file.text());
      const rows = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && "format" in parsed && parsed.format === "cloudhub-tools-account-export" && "accounts" in parsed && Array.isArray(parsed.accounts)
          ? parsed.accounts
          : null;
      if (!rows?.length) throw new Error("文件格式不受支持，或文件中没有云账号。");
      const invalidIndex = rows.findIndex((item) => {
        if (!item || typeof item !== "object") return true;
        const account = item as Record<string, unknown>;
        return typeof account.account_name !== "string" || !account.account_name.trim()
          || typeof account.access_key_id !== "string" || !account.access_key_id.trim()
          || typeof account.access_key_secret !== "string" || !account.access_key_secret.trim();
      });
      if (invalidIndex >= 0) throw new Error(`第 ${invalidIndex + 1} 条账号缺少完整密钥信息。`);
      if (!window.confirm(`准备导入 ${rows.length} 个云账号。此 JSON 含明文凭据；确认后凭据会写入本机加密数据库。请确保你信任该文件来源。继续导入？`)) return;
      const count = await accountsClient.import(rows as TransferAccount[]);
      await refreshAccounts();
      setNotice(`已导入 ${count} 个云账号，凭据已加密保存在本机。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导入账号文件失败。");
    } finally {
      setImportingAccounts(false);
      if (accountImportInput.current) accountImportInput.current.value = "";
    }
  }

  async function connectManagedHost(host: ManagedHost) {
    if (host.platform === "windows") { setNotice("手机端 SSH 暂不支持 Windows/RDP 主机"); return; }
    if (!host.password_saved && !host.private_key_saved) { setNotice("此主机没有已保存的 SSH 凭据；请先在桌面端配置，再同步到手机"); return; }
    setSshConnecting(true); setSshOutput(""); setNotice("");
    try {
      const result = await remoteClient.connectSsh({ managedHostId: host.id, host: host.host, port: host.port, username: host.username, authMethod: host.auth_method, password: null, privateKey: null, keyPassphrase: null, savePassword: false, cols: 80, rows: 24 });
      setSshHost(host); setSshSessionId(result.sessionId); setNotice(`已连接 ${host.name}，主机指纹已由原生层校验`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "SSH 连接失败"); }
    finally { setSshConnecting(false); }
  }

  async function addManagedHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const hostAddress = String(form.get("host") || "").trim();
    const hostName = String(form.get("name") || "").trim() || hostAddress;
    const port = Number(form.get("port") || 22);
    if (!hostAddress || !Number.isInteger(port) || port < 1 || port > 65535) { setNotice("请填写有效主机地址和 1–65535 端口"); return; }
    const password = String(form.get("password") || "");
    const privateKey = String(form.get("privateKey") || "");
    if (newSshAuthMethod === "password" && !password.trim()) { setNotice("请输入 SSH 密码"); return; }
    if (newSshAuthMethod === "private_key" && !privateKey.trim()) { setNotice("请粘贴 SSH 私钥"); return; }
    try {
      await serversClient.saveManaged({
        name: hostName, host: hostAddress, port, username: String(form.get("username") || "root").trim(),
        platform: "linux", auth_method: newSshAuthMethod, password, private_key: privateKey,
        key_passphrase: String(form.get("keyPassphrase") || ""), group_name: "mobile", tags: "",
        remark: "由手机端添加",
      });
      element.reset(); setShowAddSshHost(false); setNewSshAuthMethod("password");
      await refreshManagedHosts(); setNotice("托管主机已加密保存在本机");
    } catch (error) { setNotice(error instanceof Error ? error.message : "保存 SSH 主机失败"); }
  }

  async function disconnectManagedHost() {
    if (sshSessionId) {
      try { await remoteClient.disconnectSsh(sshSessionId); } catch { /* session may already have closed */ }
    }
    setSshSessionId(null); setSshHost(null); setSshOutput(""); setSshCommand("");
  }

  async function sendSshCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const command = sshCommand;
    if (!sshSessionId || !command.trim()) return;
    setSshCommand("");
    try { await remoteClient.writeSsh(sshSessionId, `${command}\r`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "发送命令失败"); }
  }

  async function removeUnknownRecords<T>(
    resourceKey: string,
    resourceLabel: string,
    records: T[],
    isUnknown: (record: T) => boolean,
    getKey: (record: T) => string,
    remove: (record: T) => Promise<void>,
    setRecords: Dispatch<SetStateAction<T[]>>,
  ) {
    const unknownRecords = records.filter(isUnknown);
    if (cleaningUnknownResource || syncing || !unknownRecords.length) return;
    setCleaningUnknownResource(resourceKey);
    const results = await Promise.allSettled(unknownRecords.map(remove));
    const removedKeys = new Set(unknownRecords.filter((_, index) => results[index].status === "fulfilled").map(getKey));
    const removedCount = removedKeys.size;
    setRecords((current) => current.filter((record) => !removedKeys.has(getKey(record))));
    const failedCount = results.length - removedCount;
    setNotice(failedCount ? `已移除 ${removedCount} 项未知账号${resourceLabel}，${failedCount} 项移除失败。` : `已移除 ${removedCount} 项未知账号${resourceLabel}。`);
    setCleaningUnknownResource(null);
  }

  pullRefreshActionRef.current = loading || syncing || panelLoading || panelActionId !== null || operationLogsLoading || apiLogsLoading
    ? null
    : tab === "accounts" ? refreshAccounts
      : tab === "servers" ? refreshServers
      : tab === "domains" ? selectedDomain ? () => loadDns(selectedDomain) : refreshDomains
          : tab === "storage" ? selectedBucket ? () => browseBucket(selectedBucket, objectPrefix) : refreshBuckets
            : tab === "databases" ? selectedDatabase ? () => loadDatabaseDetails(selectedDatabase) : refreshDatabases
              : tab === "redis" ? selectedRedis ? () => loadRedisAccounts(selectedRedis) : refreshRedis
                : tab === "certificates" ? refreshCertificates
                  : tab === "ssh" && !sshSessionId ? refreshManagedHosts
                    : tab === "panels" ? refreshPanelConnections
                      : tab === "operationLogs" ? refreshOperationLogs
                        : tab === "apiLogs" ? refreshApiLogs
                          : null;

  useEffect(() => {
    const content = mobileContentRef.current;
    if (!content) return;
    const resetGesture = () => {
      pullGestureRef.current = { startX: 0, startY: 0, distance: 0, tracking: false };
      setPullDistance(0);
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || content.scrollTop > 0 || !pullRefreshActionRef.current || pullRefreshingRef.current) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true'], .mobile-terminal-output")) return;
      pullGestureRef.current = { startX: event.touches[0].clientX, startY: event.touches[0].clientY, distance: 0, tracking: true };
    };
    const onTouchMove = (event: TouchEvent) => {
      const gesture = pullGestureRef.current;
      if (!gesture.tracking || event.touches.length !== 1 || content.scrollTop > 0) return;
      const deltaX = event.touches[0].clientX - gesture.startX;
      const delta = event.touches[0].clientY - gesture.startY;
      if (Math.abs(deltaX) > Math.abs(delta)) {
        pullGestureRef.current = { ...gesture, tracking: false };
        setPullDistance(0);
        return;
      }
      if (delta <= 0) { resetGesture(); return; }
      if (delta < 8) return;
      if (event.cancelable) event.preventDefault();
      gesture.distance = Math.min(88, Math.round(delta * 0.55));
      setPullDistance(gesture.distance);
    };
    const onTouchEnd = () => {
      const shouldRefresh = pullGestureRef.current.tracking && pullGestureRef.current.distance >= 64 && !!pullRefreshActionRef.current;
      resetGesture();
      if (!shouldRefresh || pullRefreshingRef.current) return;
      pullRefreshingRef.current = true;
      setPullRefreshing(true);
      void Promise.resolve(pullRefreshActionRef.current?.()).finally(() => {
        pullRefreshingRef.current = false;
        setPullRefreshing(false);
      });
    };
    content.addEventListener("touchstart", onTouchStart, { passive: true });
    content.addEventListener("touchmove", onTouchMove, { passive: false });
    content.addEventListener("touchend", onTouchEnd, { passive: true });
    content.addEventListener("touchcancel", resetGesture, { passive: true });
    return () => {
      content.removeEventListener("touchstart", onTouchStart);
      content.removeEventListener("touchmove", onTouchMove);
      content.removeEventListener("touchend", onTouchEnd);
      content.removeEventListener("touchcancel", resetGesture);
    };
  }, []);

  const accountFilteredServers = servers.filter((server) => assetAccountFilterId === null || server.account_id === assetAccountFilterId);
  const filteredServers = accountFilteredServers.filter((server) => {
    const owner = accountForAsset(server);
    const searchable = [
      payloadText(server.payload, ["instanceName", "InstanceName", "name", "Name", "serverName"]),
      payloadText(server.payload, ["instanceId", "InstanceId", "id", "Id"]),
      owner?.account_name ?? "",
      owner ? cloudProvider(owner.cloud_type).label : "",
      server.region_id,
      serverStatusClass(server.payload),
      payloadText(server.payload, ["InstanceStatus", "instanceStatus", "status", "Status"]),
    ].join(" ").toLocaleLowerCase();
    return searchable.includes(serverSearch.trim().toLocaleLowerCase());
  });
  const unknownServers = servers.filter((server) => accountForAsset(server) === null);
  const visibleServers = filteredServers.filter((server) => server.resource_type === serverKind).sort((left, right) => {
    const leftName = payloadText(left.payload, ["instanceName", "InstanceName", "name", "Name", "serverName"]);
    const rightName = payloadText(right.payload, ["instanceName", "InstanceName", "name", "Name", "serverName"]);
    const order = leftName.localeCompare(rightName, "zh-CN", { numeric: true, sensitivity: "base" });
    return serverSortAscending ? order : -order;
  });
  const standardServerCount = filteredServers.filter((server) => server.resource_type === "ecs").length;
  const lightServerCount = filteredServers.filter((server) => server.resource_type === "swas").length;
  const runningServerCount = filteredServers.filter((server) => serverStatusClass(server.payload).includes("is-running")).length;
  const filteredDomains = domains.filter((domain) => {
    if (assetAccountFilterId !== null && domain.account_id !== assetAccountFilterId) return false;
    const owner = accountForAsset(domain);
    const searchable = [
      payloadText(domain.payload, ["DomainName", "domain", "domainName", "name"]),
      owner?.account_name ?? "",
      owner ? cloudProvider(owner.cloud_type).label : "",
      payloadText(domain.payload, ["Remark", "remark", "Description", "description", "Note", "note"]),
    ].join(" ").toLocaleLowerCase();
    return searchable.includes(domainSearch.trim().toLocaleLowerCase());
  }).sort((left, right) => {
    const leftName = payloadText(left.payload, ["DomainName", "domain", "domainName", "name"]);
    const rightName = payloadText(right.payload, ["DomainName", "domain", "domainName", "name"]);
    const order = leftName.localeCompare(rightName, "zh-CN", { numeric: true, sensitivity: "base" });
    return domainSortAscending ? order : -order;
  });
  function filterNamed<T>(page: MobileTab, rows: T[], name: (row: T) => string, text: (row: T) => string): T[] {
    const query = (resourceSearch[page] ?? "").trim().toLocaleLowerCase();
    const ascending = resourceAscending[page] !== false;
    return rows.filter((row) => !query || text(row).toLocaleLowerCase().includes(query)).sort((left, right) => name(left).localeCompare(name(right), "zh-CN", { numeric: true, sensitivity: "base" }) * (ascending ? 1 : -1));
  }
  const assetName = (asset: LocalAsset) => {
    const name = payloadText(asset.payload, ["Name", "Bucket", "DBInstanceDescription", "InstanceName", "name", "DBInstanceId", "InstanceId", "instanceId", "Id"]);
    return name === "—" ? asset.asset_key : name;
  };
  const assetSearchText = (asset: LocalAsset) => [assetName(asset), asset.asset_key, asset.region_id, accountForAsset(asset)?.account_name, accountForAsset(asset) ? cloudProvider(accountForAsset(asset)!.cloud_type).label : "", payloadText(asset.payload, ["Location", "location", "Region"]), payloadText(asset.payload, ["DBInstanceStatus", "InstanceStatus", "Status", "status"])].join(" ");
  const accountAssets = (rows: LocalAsset[]) => rows.filter((asset) => assetAccountFilterId === null || asset.account_id === assetAccountFilterId);
  const filteredBuckets = filterNamed("storage", accountAssets(buckets), assetName, assetSearchText);
  const filteredDatabaseAssets = filterNamed("databases", accountAssets(databaseAssets), assetName, assetSearchText);
  const filteredRedisAssets = filterNamed("redis", accountAssets(redisAssets), assetName, assetSearchText);
  const filteredCertificates = filterNamed("certificates", certificates.filter((certificate) => assetAccountFilterId === null || certificate.accountId === assetAccountFilterId), (certificate) => certificate.primaryDomain, (certificate) => [certificate.primaryDomain, ...certificate.domains, certificate.status, certificate.provider, certificate.issuer, accounts.find((account) => account.id === certificate.accountId)?.account_name].join(" "));
  const filteredHosts = filterNamed("ssh", managedHosts.filter((host) => !resourceStatus.ssh || host.status === resourceStatus.ssh), (host) => host.name, (host) => [host.name, host.host, host.username, host.platform, host.status].join(" "));
  const filteredPanels = filterNamed("panels", panelConnections.filter((panel) => !resourceStatus.panels || panel.status === resourceStatus.panels), (panel) => panel.name, (panel) => [panel.name, panel.panel_url, panel.group_name, panel.status].join(" "));
  const operationLogRows = operationLogAssets.flatMap((asset) => {
    const account = accountForAsset(asset);
    return account && asset.fetched_at > operationLogClearedAt ? [{ asset, account }] : [];
  }).sort((left, right) => right.asset.fetched_at - left.asset.fetched_at);
  const filteredOperationLogs = filterNamed("operationLogs", operationLogRows.filter((row) => assetAccountFilterId === null || row.account.id === assetAccountFilterId), (row) => row.asset.asset_key, (row) => [row.asset.asset_key, row.account.account_name, resourceLabels[row.asset.resource_type as keyof typeof resourceLabels]].join(" "));
  const filteredApiLogs = filterNamed("apiLogs", apiLogs.filter((log) => !resourceStatus.apiLogs || log.status === resourceStatus.apiLogs), (log) => log.action, (log) => [log.action, log.endpoint, log.account_name, log.status].join(" "));
  const resourceConfigs = {
    storage: { title: "对象存储", description: "管理多云存储桶，浏览文件与目录", icon: Folder, count: filteredBuckets.length, unit: "存储桶", second: linkedResourceAccountCount(filteredBuckets), secondLabel: "关联账号", accounts: true },
    databases: { title: "云数据库", description: "查看数据库实例，管理多云数据资源", icon: Database, count: filteredDatabaseAssets.length, unit: "数据库实例", second: linkedResourceAccountCount(filteredDatabaseAssets), secondLabel: "关联账号", accounts: true },
    redis: { title: "Redis", description: "查看缓存实例与账号，掌握资源状态", icon: Database, count: filteredRedisAssets.length, unit: "Redis 实例", second: linkedResourceAccountCount(filteredRedisAssets), secondLabel: "关联账号", accounts: true },
    certificates: { title: "证书管理", description: "查看域名证书、签发状态与有效期", icon: Award, count: filteredCertificates.length, unit: "证书", second: new Set(filteredCertificates.map((certificate) => certificate.accountId).filter((id) => accounts.some((account) => account.id === id))).size, secondLabel: "关联账号", accounts: true },
    ssh: { title: "SSH 终端", description: "管理本机托管主机，安全连接远程终端", icon: Terminal, count: filteredHosts.length, unit: "托管主机", second: filteredHosts.filter((host) => host.password_saved || host.private_key_saved).length, secondLabel: "已存凭据", accounts: false },
    panels: { title: "运维面板", description: "统一管理已保存的面板与连接状态", icon: Monitor, count: filteredPanels.length, unit: "运维面板", second: filteredPanels.filter((panel) => panel.status === "online").length, secondLabel: "在线面板", accounts: false },
    operationLogs: { title: "操作日志", description: "查看本机资源管理记录，追踪操作历史", icon: FileText, count: filteredOperationLogs.length, unit: "操作记录", second: new Set(filteredOperationLogs.map((row) => row.account.id)).size, secondLabel: "关联账号", accounts: true },
    apiLogs: { title: "API 日志", description: "查看接口调用记录与执行状态", icon: Terminal, count: filteredApiLogs.length, unit: "调用记录", second: filteredApiLogs.filter((log) => log.status === "成功").length, secondLabel: "成功调用", accounts: false },
  };
  const resourceConfig = tab in resourceConfigs ? resourceConfigs[tab as keyof typeof resourceConfigs] : null;
  const statusOptions = [...new Set((tab === "ssh" ? managedHosts : tab === "panels" ? panelConnections : tab === "apiLogs" ? apiLogs : []).map((row) => row.status).filter(Boolean))];
  const statusFilter = statusOptions.length ? <select aria-label="按状态筛选" value={resourceStatus[tab] ?? ""} onChange={(event) => { const value = event.currentTarget.value; setResourceStatus((current) => ({ ...current, [tab]: value })); }}><option value="">全部状态</option>{statusOptions.map((status) => <option value={status} key={status}>{status === "online" ? "在线" : status === "offline" ? "离线" : status === "unknown" ? "未检查" : status}</option>)}</select> : undefined;
  const resourcePageOverview = resourceConfig && <MobileResourceOverview inlineActions={tab === "ssh" || tab === "panels"} title={resourceConfig.title} description={resourceConfig.description} icon={resourceConfig.icon} count={resourceConfig.count} countLabel={resourceConfig.unit} secondaryCount={resourceConfig.second} secondaryLabel={resourceConfig.secondLabel} search={resourceSearch[tab] ?? ""} onSearch={(value) => setResourceSearch((current) => ({ ...current, [tab]: value }))} ascending={resourceAscending[tab] !== false} onSort={() => setResourceAscending((current) => ({ ...current, [tab]: current[tab] === false }))} filter={resourceConfig.accounts ? <select aria-label={`按账号筛选${resourceConfig.title}`} value={assetAccountFilterId ?? ""} onChange={(event) => setAssetAccountFilterId(event.currentTarget.value ? Number(event.currentTarget.value) : null)}><option value="">全部账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.account_name}</option>)}</select> : statusFilter} actions={tab === "ssh" ? <button type="button" className="mobile-primary" onClick={() => setShowAddSshHost(true)}><Plus size={17} />添加主机</button> : tab === "panels" ? <button type="button" className="mobile-primary" onClick={addPanel}><Plus size={17} />添加面板</button> : tab === "operationLogs" || tab === "apiLogs" ? <button type="button" className="mobile-icon-button" aria-label="清空日志" title="清空日志" disabled={operationLogsLoading || apiLogsLoading} onClick={() => void clearMobileLogs(tab === "operationLogs" ? "operation" : "api")}><Trash2 size={18} /></button> : undefined} />;
  const cloudPullAction = tab === "servers" ? syncServers : tab === "domains" && !selectedDomain ? refreshDomainsFromCloud : tab === "storage" && !selectedBucket ? refreshBucketsFromCloud : tab === "databases" && !selectedDatabase ? refreshDatabasesFromCloud : tab === "redis" && !selectedRedis ? refreshRedisFromCloud : null;
  const refreshLabel = cloudPullAction ? "刷新本机缓存" : tab === "domains" ? "刷新 DNS 记录" : "刷新当前页面";
  function linkedResourceAccountCount(assets: LocalAsset[]) { return new Set(assets.filter((asset) => accountForAsset(asset)).map((asset) => asset.account_id)).size; }
  const unknownDomains = domains.filter((domain) => accountForAsset(domain) === null);
  const unknownBuckets = buckets.filter((bucket) => accountForAsset(bucket) === null);
  const unknownDatabases = databaseAssets.filter((instance) => accountForAsset(instance) === null);
  const unknownRedisInstances = redisAssets.filter((instance) => accountForAsset(instance) === null);
  const unknownCertificates = certificates.filter((certificate) => !accounts.some((account) => account.id === certificate.accountId));
  const accountProviderCount = new Set(accounts.map((account) => account.cloud_type)).size;
  const availableAccountProviders = [...new Set(accounts.map((account) => account.cloud_type))]
    .map((cloudType) => ({ value: cloudType, label: cloudProvider(cloudType).label }))
    .sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
  const normalizedAccountSearch = accountSearch.trim().toLocaleLowerCase();
  const filteredAccounts = accounts
    .filter((account) => !accountProviderFilter || account.cloud_type === accountProviderFilter)
    .filter((account) => {
      if (!normalizedAccountSearch) return true;
      const searchable = [account.account_name, account.group_name, account.region_id, account.remark, cloudProvider(account.cloud_type).label]
        .filter(Boolean).join(" ").toLocaleLowerCase();
      return searchable.includes(normalizedAccountSearch);
    })
    .sort((left, right) => (left.account_name.localeCompare(right.account_name, "zh-CN", { numeric: true, sensitivity: "base" })) * (accountSortAscending ? 1 : -1));

  return (
    <main className="mobile-shell">
      <header className="mobile-header">
        <div className="mobile-brand"><span className="mobile-brand-icon"><img src="/cloudhub-logo.png" alt="" /></span><div><div className="mobile-brand-title"><strong>云枢 Tools</strong><span className="mobile-brand-version">v{packageJson.version}</span></div><small>本地多云资源管理</small></div></div>
        <div className="mobile-header-actions">
          {(tab === "accounts" || tab === "servers" || tab === "domains" || tab === "more" || resourceConfig) && (tab !== "domains" || !selectedDomain) && (tab !== "storage" || !selectedBucket) && (tab !== "databases" || !selectedDatabase) && (tab !== "redis" || !selectedRedis) && (tab !== "ssh" || !sshSessionId) && <button className="mobile-icon-button mobile-header-search" type="button" aria-label="搜索当前页面" title="搜索当前页面" onClick={() => {
            const field = mobileContentRef.current?.querySelector<HTMLInputElement>('input[aria-label^="搜索"]');
            field?.scrollIntoView({ block: "center", behavior: "smooth" });
            field?.focus({ preventScroll: true });
          }}><Search size={20} /></button>}
          <button className="mobile-icon-button" type="button" aria-label={refreshLabel} title={cloudPullAction ? "重新读取本机缓存" : refreshLabel} disabled={!pullRefreshActionRef.current} onClick={() => void pullRefreshActionRef.current?.()}><RefreshCw size={19} className={loading || syncing || panelLoading || operationLogsLoading || apiLogsLoading ? "mobile-spin" : ""} /></button>
          {cloudPullAction && <button className="mobile-primary mobile-header-fetch" type="button" aria-label={syncing ? "正在拉取云端" : "拉取云端"} title="从云端拉取资源并更新本机缓存" disabled={accounts.length === 0 || loading || syncing} onClick={() => void cloudPullAction()}><CloudDownload size={20} /><span>{syncing ? "拉取中" : "拉取云端"}</span></button>}
        </div>
      </header>

      <section ref={mobileContentRef} className={resourceConfig ? "mobile-content mobile-resource-page" : "mobile-content"}>
        {(pullDistance > 0 || pullRefreshing) && <div className="mobile-pull-refresh" style={{ height: `${pullRefreshing ? 48 : Math.min(pullDistance, 72)}px` }} role="status" aria-live="polite"><RefreshCw size={16} className={pullRefreshing ? "mobile-spin" : ""} /><span>{pullRefreshing ? "正在刷新…" : pullDistance >= 64 ? "松开刷新" : "下拉刷新"}</span></div>}
        {notice && <p className="mobile-notice" role="status">{notice}</p>}
        {mobileUpdate.info?.available && tab !== "about" && <button type="button" className="mobile-update-banner" onClick={() => setTab("about")}><ArrowDownToLine size={15} aria-hidden="true" />发现新版 v{mobileUpdate.info.version} · 查看更新</button>}
        {tab === "accounts" ? <>
          <div className="mobile-page-title"><h1>云账号</h1></div>
          <div className="mobile-account-overview">
            <div className="mobile-account-stats" aria-label="账号统计">
              <div className="account-stat-total"><span className="mobile-account-stat-icon"><Database size={21} /></span><span className="mobile-account-stat-copy"><strong>{accounts.length}</strong><small>云账号</small></span></div>
              <div className="account-stat-providers"><span className="mobile-account-stat-icon"><Cloud size={21} /></span><span className="mobile-account-stat-copy"><strong>{accountProviderCount}</strong><small>云厂商</small></span></div>
            </div>
            <div className="mobile-title-actions mobile-account-actions">
              <button type="button" className="mobile-icon-button" aria-label="导入账号 JSON" title="导入账号 JSON" disabled={importingAccounts} onClick={() => accountImportInput.current?.click()}><Upload size={19} /></button>
              <input ref={accountImportInput} className="mobile-file-input" type="file" accept=".json,application/json" aria-label="选择 CloudHub 账号 JSON 文件" onChange={(event) => void importAccountFile(event.currentTarget.files?.[0])} />
              <button type="button" className="mobile-primary" onClick={openAddAccount}><Plus size={18} />添加账号</button>
            </div>
          </div>
          <div className="mobile-security-note"><ShieldCheck size={18} /><span>凭据只保存在这台设备的本地加密数据库中。</span></div>
          {accounts.length > 0 && <>
            <div className="mobile-account-tools">
              <label className="mobile-account-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索云账号" value={accountSearch} onChange={(event) => setAccountSearch(event.currentTarget.value)} placeholder="搜索云厂商 / 账号名称 / 地域…" /></label>
              <label className="mobile-account-provider-filter"><Filter size={16} aria-hidden="true" /><select aria-label="按云厂商筛选" value={accountProviderFilter} onChange={(event) => setAccountProviderFilter(event.currentTarget.value)}><option value="">全部</option>{availableAccountProviders.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}</select></label>
            </div>
            <div className="mobile-account-list-heading"><h2>云账号列表 <span>{filteredAccounts.length}</span></h2><button type="button" className="mobile-account-sort" aria-label={`按名称${accountSortAscending ? "降序" : "升序"}排列`} onClick={() => setAccountSortAscending((ascending) => !ascending)}><ArrowUpDown size={16} />{accountSortAscending ? "按名称" : "名称倒序"}</button></div>
            {filteredAccounts.length > 0 && <p className="mobile-account-swipe-hint">左滑或点击卡片右侧“更多”可获取资产、编辑或删除</p>}
          </>}
          {loading && accounts.length === 0 ? <div className="mobile-empty"><Activity className="mobile-spin" />正在读取本机账号…</div> : accounts.length === 0 ? <div className="mobile-empty"><Cloud size={30} /><strong>还没有云账号</strong><span>添加账号后，手机可以独立查询云资源。</span><button className="mobile-primary" type="button" onClick={openAddAccount}><Plus size={17} />添加云账号</button></div> : filteredAccounts.length === 0 ? <div className="mobile-empty"><Search size={30} /><strong>没有匹配的云账号</strong><span>试试其他关键词或选择全部云厂商。</span><button className="mobile-primary" type="button" onClick={() => { setAccountSearch(""); setAccountProviderFilter(""); }}>清除筛选</button></div> : <div className="mobile-account-list">{filteredAccounts.map((account) => {
            const canSync = syncAssetTypes(account).length > 0;
            return <MobileAccountSwipeCard key={account.id} label={account.account_name}>
              <div className="mobile-account-select">
                <span className="mobile-provider-avatar" data-provider={account.cloud_type}>{cloudProvider(account.cloud_type).avatar}</span>
                <span className="mobile-account-copy"><strong>{account.account_name}</strong><small>{cloudProvider(account.cloud_type).label} · {account.region_id || "默认地域"}</small></span>
              </div>
              <div className="mobile-account-swipe-actions" role="group" aria-label={`${account.account_name} 操作`}>
                <button type="button" className="mobile-account-fetch" aria-label={`获取 ${account.account_name} 资产`} title={canSync ? "获取并保存此账号已接入的全部资产" : "此云厂商暂未接入资产同步"} disabled={!canSync || syncing} onClick={() => void syncAccountAssets(account)}>{syncingAccountId === account.id ? <RefreshCw size={17} className="mobile-spin" /> : <ArrowDownToLine size={17} />}</button>
                <button type="button" className="mobile-account-edit" aria-label={`编辑本机账号 ${account.account_name}`} title="编辑账号配置" onClick={() => openEditAccount(account)}><Pencil size={17} /></button>
                <button type="button" className="mobile-account-delete" aria-label={`删除本机账号 ${account.account_name}`} title="删除此设备上的账号和数据" disabled={removingAccountId !== null} onClick={() => void removeAccount(account)}>{removingAccountId === account.id ? <RefreshCw size={17} className="mobile-spin" /> : <Trash2 size={17} />}</button>
              </div>
            </MobileAccountSwipeCard>;
          })}</div>}
        </> : tab === "servers" ? <>
          <div className="mobile-page-title"><h1>云服务器</h1></div>
          <div className="mobile-server-overview"><div className="mobile-server-stats" aria-label="服务器统计"><div className="server-stat-total"><span className="mobile-account-stat-icon"><Server size={21} /></span><span className="mobile-account-stat-copy"><strong>{filteredServers.length}</strong><small>服务器</small></span></div><div className="server-stat-running"><span className="mobile-account-stat-icon"><Activity size={21} /></span><span className="mobile-account-stat-copy"><strong>{runningServerCount}</strong><small>运行中</small></span></div></div></div>
          <div className="mobile-security-note"><ShieldCheck size={18} /><span>云服务器数据保存在本机，账号凭据由加密数据库保护。</span></div>
          {accounts.length > 0 && <div className="mobile-server-tools"><label className="mobile-account-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索云服务器" value={serverSearch} onChange={(event) => setServerSearch(event.currentTarget.value)} placeholder="搜索云厂商 / 服务器名称 / 地域…" /></label><label className="mobile-account-provider-filter"><Filter size={16} aria-hidden="true" /><select aria-label="按云账号筛选服务器" value={assetAccountFilterId ?? ""} onChange={(event) => setAssetAccountFilterId(event.currentTarget.value ? Number(event.currentTarget.value) : null)}><option value="">全部账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.account_name}</option>)}</select></label></div>}
          {accounts.length > 0 && unknownServers.length > 0 && <button type="button" className="mobile-clean-unknown" disabled={loading || syncing || cleaningUnknownResource !== null} onClick={() => void removeUnknownRecords("servers", "服务器", servers, (server) => accountForAsset(server) === null, (server) => `${server.account_id}:${server.resource_type}:${server.asset_key}`, resourcesClient.removeLocal, setServers)}>{cleaningUnknownResource === "servers" ? "正在移除…" : `移除未知账号服务器（${unknownServers.length}）`}</button>}
          <div className="mobile-server-tabs" role="group" aria-label="筛选服务器类型">
            <button type="button" aria-pressed={serverKind === "ecs"} className={serverKind === "ecs" ? "active" : ""} onClick={() => setServerKind("ecs")}>普通服务器 <span>{standardServerCount}</span></button>
            <button type="button" aria-pressed={serverKind === "swas"} className={serverKind === "swas" ? "active" : ""} onClick={() => setServerKind("swas")}>轻量服务器 <span>{lightServerCount}</span></button>
          </div>
          <div className="mobile-server-list-heading"><h2>云服务器列表 <span>{visibleServers.length}</span></h2><button type="button" className="mobile-account-sort" aria-label={`按名称${serverSortAscending ? "升序" : "降序"}排列`} onClick={() => setServerSortAscending((ascending) => !ascending)}><ArrowUpDown size={16} />{serverSortAscending ? "按名称" : "名称倒序"}</button></div>
          {accounts.length === 0 ? <div className="mobile-empty"><Cloud size={30} /><strong>先添加云账号</strong><button type="button" className="mobile-primary" onClick={() => setTab("accounts")}>查看账号</button></div> : servers.length === 0 && (loading || syncing) ? <div className="mobile-empty" role="status"><RefreshCw size={30} className="mobile-spin" /><strong>{syncing ? "正在查询云端服务器" : "正在读取本机缓存"}</strong><span>正在查询云端资源，请稍候。</span></div> : visibleServers.length === 0 ? <div className="mobile-empty"><Server size={30} /><strong>{serverSearch ? "没有匹配的服务器" : `暂无${serverKind === "ecs" ? "普通" : "轻量"}服务器`}</strong><span>{serverSearch ? "试试其他关键词或清除搜索条件。" : filteredServers.length ? "切换上方标签查看另一类服务器。" : servers.length && assetAccountFilterId !== null ? "该账号下暂无缓存服务器。" : "点击“拉取云端”同步已接入账号的服务器。"}</span>{(serverSearch || assetAccountFilterId !== null) && <button className="mobile-primary" type="button" onClick={() => { setServerSearch(""); setAssetAccountFilterId(null); }}>清除筛选</button>}</div> : <div className="mobile-server-list">{visibleServers.map((server) => { const key = `${server.account_id}:${server.asset_key}`; const busy = activeAction === key; const owner = accountForAsset(server); const status = payloadText(server.payload, ["InstanceStatus", "instanceStatus", "status", "Status"]); return <article className="mobile-server-card mobile-server-card-featured" key={key}><div className="mobile-server-featured-main"><span className="mobile-provider-avatar" data-provider={owner?.cloud_type ?? "other"}>{owner ? cloudProvider(owner.cloud_type).avatar : <Server size={21} />}</span><div className="mobile-server-featured-copy"><div className="mobile-server-featured-title"><strong title={payloadText(server.payload, ["instanceName", "InstanceName", "name", "Name", "serverName"])}>{payloadText(server.payload, ["instanceName", "InstanceName", "name", "Name", "serverName"])}</strong>{owner && <span className="mobile-server-provider">{cloudProvider(owner.cloud_type).label}</span>}</div><p>{owner?.account_name ?? "未知账号"} · {server.region_id || "地域未知"}</p></div><span className={`${serverStatusClass(server.payload)} mobile-server-status-pill`}><i aria-hidden="true" />{status}</span></div><details className="mobile-server-options"><summary>详情与操作</summary><div className="mobile-server-metadata"><span>{payloadText(server.payload, ["instanceId", "InstanceId", "id", "Id"])} · {server.resource_type === "swas" ? "轻量服务器" : "云服务器"} · 缓存于 {fetchedAtLabel(server.fetched_at)}</span></div>{owner && ["aliyun", "tencent"].includes(owner.cloud_type) && <div className="mobile-server-actions"><button type="button" disabled={busy || syncing} onClick={() => void runServerAction(server, "start")}><Power size={14} />启动</button><button type="button" disabled={busy || syncing} onClick={() => void runServerAction(server, "stop")}><Power size={14} />停止</button><button type="button" disabled={busy || syncing} onClick={() => void runServerAction(server, "reboot")}><RotateCw size={14} />重启</button>{busy && <span role="status">提交中…</span>}</div>}</details></article>; })}</div>}
        </> : tab === "domains" ? <>
          {!selectedDomain && <>
            <div className="mobile-page-title"><h1>域名与 DNS</h1></div>
            <div className="mobile-domain-overview"><div className="mobile-domain-stats" aria-label="域名统计"><div className="domain-stat-total"><span className="mobile-account-stat-icon"><Globe2 size={21} /></span><span className="mobile-account-stat-copy"><strong>{filteredDomains.length}</strong><small>域名</small></span></div><div className="domain-stat-accounts"><span className="mobile-account-stat-icon"><Cloud size={21} /></span><span className="mobile-account-stat-copy"><strong>{new Set(filteredDomains.map((domain) => domain.account_id)).size}</strong><small>关联账号</small></span></div></div></div>
            {accounts.length > 0 && <div className="mobile-domain-tools"><label className="mobile-account-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索域名、账号或备注" value={domainSearch} onChange={(event) => setDomainSearch(event.currentTarget.value)} placeholder="搜索域名 / 账号名 / 备注…" /></label><label className="mobile-account-provider-filter"><Filter size={16} aria-hidden="true" /><select aria-label="按云账号筛选域名" value={assetAccountFilterId ?? ""} onChange={(event) => setAssetAccountFilterId(event.currentTarget.value ? Number(event.currentTarget.value) : null)}><option value="">全部</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.account_name}</option>)}</select></label></div>}
            {accounts.length > 0 && unknownDomains.length > 0 && <button type="button" className="mobile-clean-unknown" disabled={loading || syncing || cleaningUnknownResource !== null} onClick={() => void removeUnknownRecords("domains", "域名", domains, (domain) => accountForAsset(domain) === null, (domain) => `${domain.account_id}:${domain.resource_type}:${domain.asset_key}`, resourcesClient.removeLocal, setDomains)}>{cleaningUnknownResource === "domains" ? "正在移除…" : `移除未知账号域名（${unknownDomains.length}）`}</button>}
            <div className="mobile-domain-list-heading"><h2>域名与 DNS 列表 <span>{filteredDomains.length}</span></h2><button type="button" className="mobile-account-sort" aria-label={`按名称${domainSortAscending ? "升序" : "降序"}排列`} onClick={() => setDomainSortAscending((ascending) => !ascending)}><ArrowUpDown size={16} />{domainSortAscending ? "按名称" : "名称倒序"}</button></div>
          </>}
          {accounts.length === 0 ? <div className="mobile-empty"><Globe2 size={30} /><strong>先添加云账号</strong><button type="button" className="mobile-primary" onClick={() => setTab("accounts")}>查看账号</button></div> : selectedDomain ? <>
            <button type="button" className="mobile-domain-back" onClick={() => { setSelectedDomain(null); setDnsRecords([]); }}>‹ 返回域名列表</button>
            <div className="mobile-domain-heading"><div><h2 className="mobile-domain-name">{payloadText(selectedDomain.payload, ["DomainName", "domain", "domainName", "name"])}</h2><small>{selectedDomainAccount?.account_name ?? "未知账号"}</small></div>{selectedDomainAccount?.cloud_type === "aliyun" && <button className="mobile-primary" type="button" onClick={() => setDnsEditor(null)}><Plus size={16} />新增记录</button>}</div>
            {loading && dnsRecords.length === 0 ? <div className="mobile-empty">正在读取 DNS 记录…</div> : dnsRecords.length === 0 ? <div className="mobile-empty"><strong>暂无 DNS 记录</strong></div> : <div className="mobile-domain-list">{dnsRecords.map((row, index) => <article className="mobile-domain-card" key={String(row.RecordId ?? index)}><div className="mobile-server-heading"><span className="mobile-domain-type">{String(row.Type ?? "DNS")}</span><strong>{String(row.RR ?? "@")}</strong></div><p>{String(row.Value ?? "—")}</p><div className="mobile-server-meta"><span>TTL {String(row.TTL ?? "—")}</span><span>{String(row.Status ?? "未知")}</span></div>{selectedDomainAccount?.cloud_type === "aliyun" && <div className="mobile-server-actions"><button type="button" onClick={() => setDnsEditor(row)}>编辑</button><button type="button" onClick={() => void changeDnsRecord(row, "toggle")}>{String(row.Status).toUpperCase() === "ENABLE" ? "暂停" : "启用"}</button><button type="button" aria-label={`删除 ${String(row.RR ?? "")} 记录`} onClick={() => void changeDnsRecord(row, "delete")}><Trash2 size={15} />删除</button></div>}</article>)}</div>}
          </> : loading && domains.length === 0 ? <div className="mobile-empty" role="status"><Activity className="mobile-spin" /><strong>正在读取本机域名缓存</strong></div> : filteredDomains.length === 0 ? <div className="mobile-empty"><Globe2 size={30} /><strong>{domainSearch || assetAccountFilterId !== null ? "没有匹配的域名" : domains.length ? "该账号下暂无缓存的域名" : "暂无缓存的域名"}</strong><span>{domainSearch || assetAccountFilterId !== null ? "试试其他关键词或清除筛选条件。" : "点击“拉取云端”汇总已接入账号的域名。"}</span>{(domainSearch || assetAccountFilterId !== null) && <button className="mobile-primary" type="button" onClick={() => { setDomainSearch(""); setAssetAccountFilterId(null); }}>清除筛选</button>}</div> : <div className="mobile-domain-list mobile-domain-resource-list">{filteredDomains.map((domain) => { const key = `${domain.account_id}:${domain.asset_key}`; const owner = accountForAsset(domain); const domainName = payloadText(domain.payload, ["DomainName", "domain", "domainName", "name"]); return <button className="mobile-server-card mobile-server-card-featured mobile-domain-resource-card" key={key} type="button" onClick={() => void loadDns(domain)}><span className="mobile-provider-avatar" data-provider={owner?.cloud_type ?? "other"}><Globe2 size={21} /></span><span className="mobile-domain-resource-copy"><span className="mobile-domain-resource-title"><strong title={domainName}>{domainName}</strong>{owner && <span className="mobile-server-provider">{cloudProvider(owner.cloud_type).label}</span>}</span><small>{owner?.account_name ?? "未知账号"} · 点击查看解析记录 · {fetchedAtLabel(domain.fetched_at)}</small></span><span className="mobile-server-status-pill is-running mobile-domain-cached"><i aria-hidden="true" />已缓存</span><span className="mobile-account-arrow">›</span></button>; })}</div>}
        </> : tab === "storage" ? <>
          {!selectedBucket && resourcePageOverview}
          {accounts.length > 0 && unknownBuckets.length > 0 && <button type="button" className="mobile-clean-unknown" disabled={loading || syncing || cleaningUnknownResource !== null} onClick={() => void removeUnknownRecords("storage", "存储桶", buckets, (bucket) => accountForAsset(bucket) === null, (bucket) => `${bucket.account_id}:${bucket.resource_type}:${bucket.asset_key}`, resourcesClient.removeLocal, setBuckets)}>{cleaningUnknownResource === "storage" ? "正在移除…" : `移除未知账号存储桶（${unknownBuckets.length}）`}</button>}
          {accounts.length === 0 ? <div className="mobile-empty"><Folder size={30} /><strong>先添加云账号</strong></div> : selectedBucket ? <>
            <button type="button" className="mobile-domain-back" onClick={() => { if (objectPrefix) { const parts = objectPrefix.replace(/\/$/, "").split("/"); parts.pop(); void browseBucket(selectedBucket, parts.length ? `${parts.join("/")}/` : ""); } else { setSelectedBucket(null); setObjectListing(null); } }}>‹ {objectPrefix ? "上一级目录" : "存储桶列表"}</button>
            <h2 className="mobile-domain-name">{payloadText(selectedBucket.payload, ["Name", "Bucket", "name"])}</h2><small>{selectedBucketAccount?.account_name ?? "未知账号"}</small>
            {objectPrefix && <p className="mobile-object-prefix">/{objectPrefix}</p>}
            {objectListing && <div className="mobile-domain-list">{objectListing.prefixes.map((prefix) => <button type="button" className="mobile-object-row" key={prefix} onClick={() => void browseBucket(selectedBucket, prefix)}><Folder size={19} /><span>{prefix.slice(objectPrefix.length)}</span><b>›</b></button>)}{objectListing.objects.map((object) => <article className="mobile-object-row" key={object.Key}><File size={18} /><span><strong>{object.Key.slice(objectPrefix.length)}</strong><small>{Number(object.Size).toLocaleString()} bytes · {object.LastModified ? new Date(object.LastModified).toLocaleDateString() : ""}</small></span></article>)}</div>}
            {objectListing?.isTruncated && <button className="mobile-primary mobile-load-more" type="button" disabled={loading} onClick={() => void browseBucket(selectedBucket, objectPrefix, objectListing.nextMarker)}>{loading ? "加载中…" : "加载更多"}</button>}
          </> : filteredBuckets.length === 0 && !loading ? <div className="mobile-empty"><Folder size={30} /><strong>{buckets.length ? "该账号下暂无缓存的存储桶" : "暂无缓存的存储桶"}</strong><span>点击“拉取云端”汇总已接入账号的存储桶。</span></div> : <div className="mobile-domain-list">{filteredBuckets.map((bucket) => { const owner = accountForAsset(bucket); return <button className="mobile-account-card mobile-resource-list-card" key={`${bucket.account_id}:${bucket.asset_key}`} type="button" onClick={() => void browseBucket(bucket)}><span className="mobile-provider-avatar" data-provider={owner?.cloud_type ?? "other"}><Folder size={20} /></span><span className="mobile-account-copy"><span className="mobile-resource-card-title"><strong>{payloadText(bucket.payload, ["Name", "Bucket", "name"])}</strong>{owner && <span className="mobile-server-provider">{cloudProvider(owner.cloud_type).label}</span>}</span><small>{owner?.account_name ?? "未知账号"} · {payloadText(bucket.payload, ["Location", "location", "Region"])} · 缓存于 {fetchedAtLabel(bucket.fetched_at)}</small></span><span className="mobile-resource-state">已缓存</span><span className="mobile-account-arrow">›</span></button>; })}</div>}

        </> : tab === "databases" ? <>
          {!selectedDatabase && resourcePageOverview}
          {accounts.length > 0 && unknownDatabases.length > 0 && <button type="button" className="mobile-clean-unknown" disabled={loading || syncing || cleaningUnknownResource !== null} onClick={() => void removeUnknownRecords("databases", "数据库实例", databaseAssets, (instance) => accountForAsset(instance) === null, (instance) => `${instance.account_id}:${instance.resource_type}:${instance.asset_key}`, resourcesClient.removeLocal, setDatabaseAssets)}>{cleaningUnknownResource === "databases" ? "正在移除…" : `移除未知账号数据库实例（${unknownDatabases.length}）`}</button>}
          {accounts.length === 0 ? <div className="mobile-empty"><Database size={30} /><strong>先添加云账号</strong></div> : selectedDatabase ? <>
            <button type="button" className="mobile-domain-back" onClick={() => { setSelectedDatabase(null); setDatabaseDetails([]); }}>‹ 返回实例列表</button>
            <h2 className="mobile-domain-name">{payloadText(selectedDatabase.payload, ["DBInstanceDescription", "DBInstanceId", "InstanceName", "name"])}</h2><small>{selectedDatabaseAccount?.account_name ?? "未知账号"}</small>
            {loading && databaseDetails.length === 0 ? <div className="mobile-empty">正在读取数据库…</div> : databaseDetails.length === 0 ? <div className="mobile-empty"><strong>没有返回数据库清单</strong><span>当前云账号或实例可能不支持此查询。</span></div> : <div className="mobile-domain-list">{databaseDetails.map((item, index) => <article className="mobile-domain-card" key={String(item.DBName ?? item.AccountName ?? index)}><div className="mobile-server-heading"><Database size={17} /><strong>{String(item.DBName ?? item.AccountName ?? item.Name ?? "数据库")}</strong></div><p>{String(item.CharacterSetName ?? item.AccountDescription ?? item.Description ?? "")}</p><div className="mobile-server-meta"><span>{String(item.DBStatus ?? item.AccountStatus ?? "")}</span><span>{String(item.DBInstanceId ?? "")}</span></div></article>)}</div>}
          </> : filteredDatabaseAssets.length === 0 && !loading ? <div className="mobile-empty"><Database size={30} /><strong>{databaseAssets.length ? "该账号下暂无缓存的数据库实例" : "暂无缓存的数据库实例"}</strong><span>点击“拉取云端”汇总已接入账号的实例。</span></div> : <div className="mobile-domain-list">{filteredDatabaseAssets.map((instance) => { const owner = accountForAsset(instance); return <button className="mobile-account-card mobile-resource-list-card" key={`${instance.account_id}:${instance.asset_key}`} type="button" onClick={() => void loadDatabaseDetails(instance)}><span className="mobile-provider-avatar" data-provider={owner?.cloud_type ?? "other"}><Database size={20} /></span><span className="mobile-account-copy"><span className="mobile-resource-card-title"><strong>{payloadText(instance.payload, ["DBInstanceDescription", "DBInstanceId", "InstanceName", "name"])}</strong>{owner && <span className="mobile-server-provider">{cloudProvider(owner.cloud_type).label}</span>}</span><small>{owner?.account_name ?? "未知账号"} · {instance.region_id} · {payloadText(instance.payload, ["DBInstanceStatus", "InstanceStatus", "status"])} · 缓存于 {fetchedAtLabel(instance.fetched_at)}</small></span><span className="mobile-resource-state">已缓存</span><span className="mobile-account-arrow">›</span></button>; })}</div>}

        </> : tab === "redis" ? <>
          {!selectedRedis && resourcePageOverview}
          {accounts.length > 0 && unknownRedisInstances.length > 0 && <button type="button" className="mobile-clean-unknown" disabled={loading || syncing || cleaningUnknownResource !== null} onClick={() => void removeUnknownRecords("redis", "Redis 实例", redisAssets, (instance) => accountForAsset(instance) === null, (instance) => `${instance.account_id}:${instance.resource_type}:${instance.asset_key}`, resourcesClient.removeLocal, setRedisAssets)}>{cleaningUnknownResource === "redis" ? "正在移除…" : `移除未知账号 Redis 实例（${unknownRedisInstances.length}）`}</button>}
          {accounts.length === 0 ? <div className="mobile-empty"><Database size={30} /><strong>先添加云账号</strong></div> : selectedRedis ? <>
            <button type="button" className="mobile-domain-back" onClick={() => { setSelectedRedis(null); setRedisAccounts([]); }}>‹ 返回实例列表</button>
            <h2 className="mobile-domain-name">{payloadText(selectedRedis.payload, ["InstanceName", "InstanceId", "instanceId", "Id"])}</h2><small>{selectedRedisAccount?.account_name ?? "未知账号"}</small>
            {loading && redisAccounts.length === 0 ? <div className="mobile-empty">正在读取 Redis 账号…</div> : redisAccounts.length === 0 ? <div className="mobile-empty"><strong>没有返回账号信息</strong><span>实例可能没有自定义账号，或当前凭据缺少读取权限。</span></div> : <div className="mobile-domain-list">{redisAccounts.map((item, index) => <article className="mobile-domain-card" key={String(item.AccountName ?? index)}><div className="mobile-server-heading"><Database size={17} /><strong>{String(item.AccountName ?? "默认账号")}</strong></div><div className="mobile-server-meta"><span>{String(item.AccountType ?? "")}</span><span>{String(item.AccountStatus ?? "")}</span></div>{typeof item.AccountDescription === "string" && item.AccountDescription && <p>{item.AccountDescription}</p>}</article>)}</div>}
          </> : filteredRedisAssets.length === 0 && !loading ? <div className="mobile-empty"><Database size={30} /><strong>{redisAssets.length ? "该账号下暂无缓存的 Redis 实例" : "暂无缓存的 Redis 实例"}</strong><span>点击“拉取云端”汇总已接入账号的实例。</span></div> : <div className="mobile-domain-list">{filteredRedisAssets.map((instance) => { const owner = accountForAsset(instance); return <button className="mobile-account-card mobile-resource-list-card" key={`${instance.account_id}:${instance.asset_key}`} type="button" onClick={() => void loadRedisAccounts(instance)}><span className="mobile-provider-avatar" data-provider={owner?.cloud_type ?? "other"}><Database size={20} /></span><span className="mobile-account-copy"><span className="mobile-resource-card-title"><strong>{payloadText(instance.payload, ["InstanceName", "InstanceId", "instanceId", "Id"])}</strong>{owner && <span className="mobile-server-provider">{cloudProvider(owner.cloud_type).label}</span>}</span><small>{owner?.account_name ?? "未知账号"} · {instance.region_id} · {payloadText(instance.payload, ["InstanceStatus", "Status", "status"])} · 缓存于 {fetchedAtLabel(instance.fetched_at)}</small></span><span className="mobile-resource-state">已缓存</span><span className="mobile-account-arrow">›</span></button>; })}</div>}

        </> : tab === "certificates" ? <>
          {resourcePageOverview}
          {accounts.length > 0 && unknownCertificates.length > 0 && <button type="button" className="mobile-clean-unknown" disabled={loading || cleaningUnknownResource !== null} onClick={() => void removeUnknownRecords("certificates", "证书", certificates, (certificate) => !accounts.some((account) => account.id === certificate.accountId), (certificate) => String(certificate.id), (certificate) => certificatesClient.remove(certificate.id), setCertificates)}>{cleaningUnknownResource === "certificates" ? "正在移除…" : `移除未知账号证书（${unknownCertificates.length}）`}</button>}
          {loading && filteredCertificates.length === 0 ? <div className="mobile-empty">正在读取证书…</div> : filteredCertificates.length === 0 ? <div className="mobile-empty"><Award size={30} /><strong>{certificates.length ? "该账号下暂无证书" : "暂无证书"}</strong><span>手机端暂提供证书状态查看；签发、下载与私钥查看仍保留在桌面端。</span></div> : <div className="mobile-domain-list">{filteredCertificates.map((certificate) => <article className="mobile-domain-card" key={certificate.id}><div className="mobile-server-heading"><Award size={17} /><strong>{certificate.primaryDomain}</strong></div><p>{certificate.domains.join(" · ")}</p><div className="mobile-server-meta"><span>{accounts.find((account) => account.id === certificate.accountId)?.account_name ?? "未知账号"}</span><span>{certificate.status} · {certificate.provider}</span></div><small className="mobile-cert-expiry">到期时间：{certificate.notAfter ? new Date(certificate.notAfter * 1000).toLocaleDateString() : "未知"}</small>{certificate.issuer && <small className="mobile-cert-expiry">签发者：{certificate.issuer}</small>}</article>)}</div>}

        </> : tab === "ssh" ? <>
          {!sshSessionId && resourcePageOverview}
          {sshSessionId ? <section className="mobile-terminal"><div className="mobile-terminal-heading"><span><Terminal size={16} />{sshHost?.name ?? sshHost?.host ?? "SSH"}</span><button type="button" onClick={() => void disconnectManagedHost()}>断开</button></div><pre className="mobile-terminal-output" aria-live="polite">{sshOutput || "已连接，等待远端输出…"}</pre><form className="mobile-terminal-input" onSubmit={(event) => void sendSshCommand(event)}><label className="mobile-sr-only" htmlFor="mobile-ssh-command">输入 SSH 命令</label><input id="mobile-ssh-command" value={sshCommand} onChange={(event) => setSshCommand(event.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="输入命令并发送" /><button className="mobile-primary" type="submit" disabled={!sshCommand.trim()}>发送</button></form><p>命令会直接在远程 Shell 执行。敏感凭据仅由原生层读取。</p></section> : loading && filteredHosts.length === 0 ? <div className="mobile-empty">正在读取托管主机…</div> : filteredHosts.length === 0 ? <div className="mobile-empty"><Terminal size={30} /><strong>{resourceSearch.ssh ? "没有匹配的主机" : "暂无托管主机"}</strong><span>可以直接在手机上添加 SSH 主机并将凭据加密保存在本机。</span><button type="button" className="mobile-primary" onClick={() => setShowAddSshHost(true)}><Plus size={17} />添加 SSH 主机</button></div> : <div className="mobile-ssh-host-list">{filteredHosts.map((host) => <article className="mobile-ssh-host-row" key={host.id}>
            <span className="mobile-ssh-host-icon" aria-hidden="true"><Terminal size={18} /></span>
            <div className="mobile-ssh-host-copy"><strong>{host.name}</strong><p>{host.username}@{host.host}:{host.port}</p><div className="mobile-ssh-host-meta"><span className={`mobile-ssh-host-status is-${host.status === "online" ? "online" : host.status === "offline" ? "offline" : "unknown"}`}><i aria-hidden="true" />{host.status === "online" ? "在线" : host.status === "offline" ? "离线" : "未检查"}</span><span>{host.platform === "windows" ? "RDP · 手机端暂不支持" : !host.password_saved && !host.private_key_saved ? "未配置凭据" : "SSH"}</span></div></div>
            <button type="button" className="mobile-ssh-connect" aria-label={`连接终端 ${host.name}`} disabled={sshConnecting || host.platform === "windows" || (!host.password_saved && !host.private_key_saved)} onClick={() => void connectManagedHost(host)}>{sshConnecting ? "连接中" : "连接"}</button>
          </article>)}</div>}

        </> : tab === "panels" ? <>
          {resourcePageOverview}
          <div className="mobile-panel-refresh-control">
            <div><strong>自动刷新监控</strong><small>{panelAutoRefresh.seconds === 0 ? "已关闭 · 打开页面先读缓存" : panelAutoRefresh.busy ? "正在更新…" : panelAutoRefresh.failed ? "部分更新失败，将自动重试" : runningInTauri ? "前台定时更新，后台暂停" : "网页预览仅定时读取本机缓存"}</small></div>
            <select aria-label="自动刷新监控间隔" value={panelAutoRefresh.seconds} onChange={(event) => panelAutoRefresh.setSeconds(Number(event.target.value))}>{panelRefreshIntervals.map((seconds) => <option key={seconds} value={seconds}>{seconds === 0 ? "关闭" : `${seconds} 秒`}</option>)}</select>
          </div>
          {panelLoading && filteredPanels.length === 0 ? <div className="mobile-empty">正在读取面板配置…</div> : filteredPanels.length === 0 ? <div className="mobile-empty"><Monitor size={28} /><strong>{resourceSearch.panels ? "没有匹配的面板" : "暂无已配置的面板"}</strong><span>可直接在手机添加面板，也可以导入电脑中的加密配置。</span><button type="button" className="mobile-primary" onClick={addPanel}>添加运维面板</button><button type="button" className="mobile-domain-back" onClick={() => setTab("sync")}>导入电脑配置</button></div> : <div className="mobile-domain-list">{filteredPanels.map((panel) => <article className="mobile-domain-card mobile-panel-card" key={panel.id}><div className="mobile-panel-card-heading"><div className="mobile-server-heading"><Monitor size={17} /><strong>{panel.name}</strong></div><span className={`mobile-panel-status ${panel.status === "online" ? "online" : panel.status === "offline" ? "offline" : "unknown"}`}>{panel.status === "online" ? "在线" : panel.status === "offline" ? "离线" : "未检查"}</span></div><div className="mobile-panel-identity"><p className="mobile-panel-url">{panel.panel_url}</p><div className="mobile-panel-card-meta"><span>{panel.group_name || "未分组"}</span><small><ShieldCheck size={13} />{panel.api_key_saved ? "密钥已加密" : "缺少 API 密钥"}</small></div></div><details className="mobile-server-options"><summary>监控详情</summary><MobilePanelMetrics panel={panel} /></details><div className="mobile-panel-actions"><button type="button" aria-label={`刷新面板 ${panel.name} 状态`} title="刷新状态" disabled={panelAutoRefresh.busy || panelActionId !== null} onClick={() => void refreshPanelStatus(panel)}><RefreshCw size={17} className={panelActionId === panel.id ? "mobile-spin" : ""} /><span>刷新</span></button><button type="button" className="primary" aria-label={`打开面板 ${panel.name}`} title="打开面板" disabled={panelAutoRefresh.busy || panelActionId !== null || !panel.api_key_saved || panel.status === "offline"} onClick={() => void openPanel(panel)}><ExternalLink size={17} /><span>打开</span></button><button type="button" aria-label={`编辑面板 ${panel.name}`} title="编辑面板" disabled={panelAutoRefresh.busy || panelActionId !== null} onClick={() => editPanel(panel)}><Pencil size={17} aria-hidden="true" /><span>编辑</span></button><button type="button" className="danger" aria-label={`删除面板 ${panel.name}`} title="删除面板" disabled={panelAutoRefresh.busy || panelActionId !== null} onClick={() => void removePanel(panel)}><Trash2 size={17} aria-hidden="true" /><span>删除</span></button></div></article>)}</div>}

        </> : tab === "sync" ? <SyncTransferPanel mode="mobile" accounts={accounts} managedHosts={managedHosts} panels={panelConnections} onClose={() => setTab("settings")} onImported={() => { void refreshAccounts(); void refreshManagedHosts(); void refreshPanelConnections(); }} /> : tab === "settings" ? <>
          <div className="mobile-page-title"><div><p>本机客户端</p><h1>系统设置</h1></div></div>
          <div className="mobile-domain-list mobile-more-list">
            <button type="button" className="mobile-account-card" onClick={() => setTab("sync")}><span className="mobile-provider-avatar"><ShieldCheck size={20} /></span><span className="mobile-account-copy"><strong>导入数据</strong><small>导入电脑端加密配置</small></span><span className="mobile-account-arrow">›</span></button>
            <button type="button" className="mobile-account-card" onClick={() => setTab("operationLogs")}><span className="mobile-provider-avatar"><FileText size={20} /></span><span className="mobile-account-copy"><strong>操作日志</strong><small>查看本机资源管理记录</small></span><span className="mobile-account-arrow">›</span></button>
            <button type="button" className="mobile-account-card" onClick={() => setTab("apiLogs")}><span className="mobile-provider-avatar"><Terminal size={20} /></span><span className="mobile-account-copy"><strong>API 日志</strong><small>查看接口调用状态</small></span><span className="mobile-account-arrow">›</span></button>
            <a className="mobile-account-card mobile-settings-link" href="https://github.com/wlphp/cloudhub-tools" target="_blank" rel="noreferrer"><span className="mobile-provider-avatar"><ExternalLink size={20} /></span><span className="mobile-account-copy"><strong>GitHub 开源仓库</strong><small>github.com/wlphp/cloudhub-tools</small></span><span className="mobile-account-arrow" aria-hidden="true">›</span></a>
            <button type="button" className="mobile-account-card" onClick={() => setTab("about")}><span className="mobile-provider-avatar"><Info size={20} /></span><span className="mobile-account-copy"><strong>关于</strong><small>云枢 Tools · v{packageJson.version}</small></span><span className="mobile-account-arrow">›</span></button>
          </div>
        </> : tab === "operationLogs" ? <>
          {resourcePageOverview}
          {operationLogsLoading && filteredOperationLogs.length === 0 ? <div className="mobile-empty">正在读取操作日志…</div> : filteredOperationLogs.length === 0 ? <div className="mobile-empty"><FileText size={30} /><strong>暂无操作日志</strong><span>获取并保存云资源后会在这里显示记录。</span></div> : <div className="mobile-domain-list">{filteredOperationLogs.map(({ asset, account }) => <article className="mobile-domain-card mobile-log-card" key={`${asset.account_id}:${asset.resource_type}:${asset.asset_key}`}><div className="mobile-server-heading"><FileText size={17} /><strong>获取并保存资产</strong></div><p>{asset.asset_key}</p><div className="mobile-server-meta"><span>{account.account_name} · {resourceLabels[asset.resource_type as keyof typeof resourceLabels] ?? asset.resource_type}</span><time>{new Date(asset.fetched_at).toLocaleString()}</time></div></article>)}</div>}

        </> : tab === "apiLogs" ? <>
          {resourcePageOverview}
          {apiLogsLoading && filteredApiLogs.length === 0 ? <div className="mobile-empty">正在读取 API 日志…</div> : filteredApiLogs.length === 0 ? <div className="mobile-empty"><Terminal size={30} /><strong>暂无 API 日志</strong><span>调用云资源接口后会在这里显示记录。</span></div> : <div className="mobile-domain-list">{filteredApiLogs.map((log) => <article className="mobile-domain-card mobile-log-card" key={log.id}><div className="mobile-server-heading"><Terminal size={17} /><strong>{log.action}</strong></div><p>{log.endpoint}</p><div className="mobile-server-meta"><span>{log.account_name || "未知账号"}</span><span className={log.status === "成功" ? "mobile-log-success" : "mobile-log-failure"}>{log.status}</span><time>{new Date(log.created_at).toLocaleString()}</time></div></article>)}</div>}

        </> : tab === "flow" ? <FlowPanel mobile /> : tab === "about" ? <>
          <div className="mobile-page-title"><div><p>系统设置</p><h1>关于</h1></div></div>
          <section className="mobile-about-card"><span className="mobile-about-logo"><img src="/cloudhub-logo.png" alt="" /></span><strong>云枢 Tools</strong><span>本地多云资源管理</span><small>版本 {packageJson.version}</small></section>
          <MobileUpdatePanel update={mobileUpdate} />
        </> : <MobileMorePage onNavigate={setTab} />}
      </section>

      <nav className="mobile-tab-bar" aria-label="主导航"><button type="button" aria-current={tab === "accounts" ? "page" : undefined} className={tab === "accounts" ? "active" : ""} onClick={() => setTab("accounts")}><Cloud size={19} /><span>账号</span></button><button type="button" aria-current={tab === "servers" ? "page" : undefined} className={tab === "servers" ? "active" : ""} onClick={() => setTab("servers")}><Server size={19} /><span>服务器</span></button><button type="button" aria-current={tab === "domains" ? "page" : undefined} className={tab === "domains" ? "active" : ""} onClick={() => setTab("domains")}><Globe2 size={19} /><span>域名</span></button><button type="button" aria-current={tab === "more" || tab === "flow" || tab === "storage" || tab === "databases" || tab === "redis" || tab === "certificates" || tab === "ssh" || tab === "panels" || tab === "sync" || tab === "settings" || tab === "operationLogs" || tab === "apiLogs" || tab === "about" ? "page" : undefined} className={tab === "more" || tab === "flow" || tab === "storage" || tab === "databases" || tab === "redis" || tab === "certificates" || tab === "ssh" || tab === "panels" || tab === "sync" || tab === "settings" || tab === "operationLogs" || tab === "apiLogs" || tab === "about" ? "active" : ""} onClick={() => setTab("more")}><LayoutGrid size={19} /><span>更多</span></button></nav>

      {showAddAccount && <div className="mobile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setShowAddAccount(false); setEditingAccount(null); } }}><form className="mobile-account-form" onSubmit={(event) => void saveAccount(event)}><div className="mobile-modal-heading"><div><small>凭据由 Rust 原生层加密保存</small><h2>{editingAccount ? "编辑云账号" : "添加云账号"}</h2></div><button className="mobile-icon-button" type="button" aria-label="关闭" onClick={() => { setShowAddAccount(false); setEditingAccount(null); }}><X size={20} /></button></div>
        <label>云厂商<select value={newAccountCloud} disabled={!!editingAccount} onChange={(event) => setNewAccountCloud(event.target.value)}>{cloudProviders.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}</select></label>
        <label>账号名称<input name="accountName" required maxLength={80} autoComplete="organization" defaultValue={editingAccount?.account_name} placeholder="生产环境" /></label>
        {newAccountCloud === "oracle" && <><label>Tenancy OCID<input name="tenancyOcid" required maxLength={256} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "tenancy_ocid")} placeholder="ocid1.tenancy..." /></label><label>Key Fingerprint<input name="keyFingerprint" required maxLength={100} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "key_fingerprint")} placeholder="aa:bb:cc:..." /></label></>}
        {newAccountCloud === "azure" && <><label>Tenant ID<input name="tenantId" required maxLength={100} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "tenant_id")} /></label><label>Subscription ID<input name="subscriptionId" required maxLength={100} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "subscription_id")} /></label></>}
        {newAccountCloud === "gcp" && <label>Project ID<input name="projectId" required maxLength={100} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "project_id")} /></label>}
        <label>{cloudProvider(newAccountCloud).idLabel}<input name="accessKeyId" required={newAccountCloud !== "vultr"} maxLength={2048} autoComplete="off" defaultValue={editingAccount?.access_key_id} placeholder={newAccountCloud === "vultr" ? "可留空，账号名称用于本地识别" : undefined} /></label>
        <label>{cloudProvider(newAccountCloud).secretLabel}{newAccountCloud === "oracle" || newAccountCloud === "gcp" ? <SecretField key={`${editingAccount?.id ?? "new"}:${newAccountCloud}`} multiline secretLabel={cloudProvider(newAccountCloud).secretLabel} reveal={editingAccount ? () => accountsClient.revealSecret(editingAccount.id) : undefined} name="accessKeySecret" required={!editingAccount} maxLength={32768} rows={6} autoComplete="off" spellCheck={false} /> : <SecretField key={`${editingAccount?.id ?? "new"}:${newAccountCloud}`} secretLabel={cloudProvider(newAccountCloud).secretLabel} reveal={editingAccount ? () => accountsClient.revealSecret(editingAccount.id) : undefined} name="accessKeySecret" required={!editingAccount} maxLength={8192} autoComplete="new-password" />}</label>
        {editingAccount && <p className="mobile-form-hint">留空会保留本机加密凭据。更改密钥 ID 时必须同时输入新 Secret。</p>}
        <label>默认地域<input name="regionId" maxLength={100} defaultValue={editingAccount?.region_id} placeholder={cloudProvider(newAccountCloud).regionPlaceholder} autoComplete="off" /></label>
        <label>分组<input name="groupName" maxLength={80} defaultValue={editingAccount?.group_name} placeholder="例如：生产环境" /></label>
        <label>账号状态<select name="enabled" defaultValue={editingAccount?.enabled === false ? "false" : "true"}><option value="true">启用</option><option value="false">停用</option></select></label>
        <label>备注<input name="remark" maxLength={500} defaultValue={editingAccount?.remark} /></label>
        <p className="mobile-form-hint">账号密钥由 Rust 原生层加密保存；云厂商可能需要额外授予只读权限。</p><button className="mobile-primary mobile-submit" type="submit"><ShieldCheck size={17} />{editingAccount ? "保存配置" : "保存到本机"}</button></form></div>}

      {showAddSshHost && <div className="mobile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAddSshHost(false); }}><form className="mobile-account-form" onSubmit={(event) => void addManagedHost(event)}><div className="mobile-modal-heading"><div><small>主机信息和凭据仅保存在本机</small><h2>添加 SSH 主机</h2></div><button className="mobile-icon-button" type="button" aria-label="关闭" onClick={() => setShowAddSshHost(false)}><X size={20} /></button></div><label>显示名称<input name="name" maxLength={100} autoComplete="off" placeholder="例如：生产 Web 服务器" /></label><label>主机地址<input name="host" required maxLength={253} autoCapitalize="off" autoComplete="url" placeholder="主机名或 IP 地址" /></label><div className="mobile-form-grid"><label>SSH 端口<input name="port" type="number" min="1" max="65535" defaultValue="22" inputMode="numeric" /></label><label>用户名<input name="username" required maxLength={128} defaultValue="root" autoComplete="username" /></label></div><label>认证方式<select value={newSshAuthMethod} onChange={(event) => setNewSshAuthMethod(event.target.value as "password" | "private_key")}><option value="password">密码</option><option value="private_key">SSH 私钥</option></select></label>{newSshAuthMethod === "password" ? <label>SSH 密码<SecretField name="password" required secretLabel="SSH 密码" maxLength={8192} autoComplete="new-password" /></label> : <><label>SSH 私钥<SecretField multiline secretLabel="SSH 私钥" name="privateKey" required maxLength={32768} rows={7} autoComplete="off" spellCheck={false} placeholder="粘贴 OpenSSH 或 PEM 私钥" /></label><label>私钥口令（可选）<SecretField name="keyPassphrase" secretLabel="私钥口令" maxLength={8192} autoComplete="new-password" /></label></>}<p className="mobile-form-hint">保存时凭据会在 Rust 原生层加密；连接时会校验并记住主机指纹。</p><button className="mobile-primary mobile-submit" type="submit"><ShieldCheck size={17} />加密保存主机</button></form></div>}

      {panelDraft && <div className="mobile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !panelSaving) setPanelDraft(null); }}><form className="mobile-account-form" onSubmit={(event) => void savePanel(event)}><div className="mobile-modal-heading"><div><small>密钥由 Rust 原生层加密后保存在本机</small><h2 id="mobile-panel-form-title">{panelDraft.id ? "编辑运维面板" : "添加运维面板"}</h2></div><button className="mobile-icon-button" type="button" aria-label="关闭面板表单" disabled={panelSaving} onClick={() => setPanelDraft(null)}><X size={20} /></button></div><label>面板名称<input required maxLength={100} autoComplete="off" value={panelDraft.name} onChange={(event) => setPanelDraft({ ...panelDraft, name: event.target.value })} placeholder="例如：生产环境" /></label><label>面板根地址<input required type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" maxLength={2048} autoComplete="url" value={panelDraft.panel_url} onChange={(event) => setPanelDraft({ ...panelDraft, panel_url: event.target.value })} placeholder="https://panel.example.com" /></label><label>API 密钥<SecretField key={panelDraft.id ?? "new"} secretLabel="API 密钥" reveal={panelDraft.id ? () => remoteClient.revealPanelApiKey(panelDraft.id!) : undefined} maxLength={8192} autoComplete="new-password" value={panelDraft.api_key} onChange={(event) => setPanelDraft({ ...panelDraft, api_key: event.target.value })} placeholder={panelDraft.id ? "留空以保留已保存的密钥" : "首次添加必须填写"} required={!panelDraft.id} /></label><div className="mobile-form-grid"><label>分组<input maxLength={80} autoComplete="off" value={panelDraft.group_name} onChange={(event) => setPanelDraft({ ...panelDraft, group_name: event.target.value })} placeholder="例如：生产" /></label><label>排序<input type="number" min="0" max="100000" inputMode="numeric" value={panelDraft.sort_order} onChange={(event) => setPanelDraft({ ...panelDraft, sort_order: Number(event.target.value) })} /></label></div><label>备注<input maxLength={500} autoComplete="off" value={panelDraft.remark} onChange={(event) => setPanelDraft({ ...panelDraft, remark: event.target.value })} /></label><label className="mobile-panel-check"><input type="checkbox" checked={panelDraft.allow_insecure_tls} onChange={(event) => setPanelDraft({ ...panelDraft, allow_insecure_tls: event.target.checked })} />允许不安全 TLS 证书（仅在面板使用自签名证书时开启）</label><p className="mobile-form-hint">手机会直接连接面板验证配置。点击小眼睛可查看密钥，留空会保留本机已加密密钥。</p><button className="mobile-primary mobile-submit" type="submit" disabled={panelSaving}><ShieldCheck size={17} />{panelSaving ? "正在验证并保存…" : "验证并加密保存"}</button></form></div>}

      {dnsEditor !== undefined && <div className="mobile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDnsEditor(undefined); }}><form className="mobile-account-form" onSubmit={(event) => void saveDnsRecord(event)}><div className="mobile-modal-heading"><div><small>{payloadText(selectedDomain?.payload ?? {}, ["DomainName", "domain", "domainName", "name"])}</small><h2>{dnsEditor ? "编辑 DNS 记录" : "新增 DNS 记录"}</h2></div><button className="mobile-icon-button" type="button" aria-label="关闭" onClick={() => setDnsEditor(undefined)}><X size={20} /></button></div><label>记录类型<select name="recordType" defaultValue={String(dnsEditor?.Type ?? "A")}><option>A</option><option>AAAA</option><option>CNAME</option><option>MX</option><option>TXT</option><option>NS</option><option>SRV</option><option>CAA</option></select></label><label>主机记录<input name="rr" required maxLength={253} defaultValue={String(dnsEditor?.RR ?? "")} placeholder="@ 或 www" /></label><label>记录值<input name="value" required maxLength={2048} defaultValue={String(dnsEditor?.Value ?? "")} /></label><label>TTL（秒）<input name="ttl" type="number" min="1" max="86400" defaultValue={Number(dnsEditor?.TTL ?? 600)} /></label><label>MX 优先级<input name="priority" type="number" min="1" max="50" defaultValue={Number(dnsEditor?.Priority ?? 10)} /></label><label>线路<input name="line" required maxLength={80} defaultValue={String(dnsEditor?.Line ?? "default")} /></label><p className="mobile-form-hint">保存后会直接修改云厂商 DNS 配置，请核对主机记录和值。</p><button className="mobile-primary mobile-submit" type="submit"><ShieldCheck size={17} />保存记录</button></form></div>}
    </main>
  );
}
