import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Activity, ArrowDownToLine, Cloud, Database, File, Folder, Globe2, Plus, Power, RefreshCw, RotateCw, Server, ShieldCheck, X, Trash2, MoreHorizontal, Award, Terminal, Pencil, ExternalLink, Monitor } from "lucide-react";
import type { Account, Certificate, LocalAsset, ManagedHost, PanelConnection, PanelConnectionDraft } from "../shared/types";
import { accountsClient, certificatesClient, domainsClient, remoteClient, resourcesClient, storageClient } from "../platform/clients";
import type { OssObjectListing } from "../platform/clients/storage";
import { cloudProvider, cloudProviders } from "../features/cloud/catalog";
import type { AccountSaveInput } from "../platform/clients/accounts";
import { serversClient, type InstanceAction } from "../platform/clients/servers";
import { SyncTransferPanel } from "../features/accounts/SyncTransferPanel";

type MobileTab = "accounts" | "servers" | "domains" | "storage" | "databases" | "redis" | "certificates" | "ssh" | "sync" | "more";

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
  const [servers, setServers] = useState<LocalAsset[]>([]);
  const [domains, setDomains] = useState<LocalAsset[]>([]);
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
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [removingAccountId, setRemovingAccountId] = useState<number | null>(null);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [newAccountCloud, setNewAccountCloud] = useState("aliyun");
  const [notice, setNotice] = useState("");
  const selectedAccount = useMemo(() => accounts.find((account) => account.id === selectedAccountId) ?? null, [accounts, selectedAccountId]);
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

  const refreshServers = useCallback(async (accountId: number) => {
    const isCurrentRead = beginResourceRead("servers", accountId);
    setLoading(true);
    try {
      const result = await resourcesClient.listLocal({ accountId, resourceType: "ecs" });
      if (!isCurrentRead()) return;
      setServers(result);
      setNotice("");
    } catch (error) {
      if (!isCurrentRead()) return;
      setNotice(error instanceof Error ? error.message : "读取本机缓存失败");
    } finally {
      if (isCurrentRead()) setLoading(false);
    }
  }, [beginResourceRead]);

  useEffect(() => { void refreshAccounts(); }, [refreshAccounts]);
  useEffect(() => {
    if (tab === "servers" && selectedAccountId !== null) void refreshServers(selectedAccountId);
    else if (tab === "servers") setServers([]);
  }, [tab, selectedAccountId, refreshServers]);

  const refreshDomains = useCallback(async (accountId: number) => {
    const isCurrentRead = beginResourceRead("domains", accountId);
    setLoading(true);
    try {
      const result = await resourcesClient.listLocal({ accountId, resourceType: "domain" });
      if (!isCurrentRead()) return;
      setDomains(result);
      setSelectedDomain(null);
      setDnsRecords([]);
      setNotice("");
    } catch (error) {
      if (!isCurrentRead()) return;
      setNotice(error instanceof Error ? error.message : "读取域名缓存失败");
    } finally { if (isCurrentRead()) setLoading(false); }
  }, [beginResourceRead]);

  useEffect(() => {
    if (tab === "domains" && selectedAccountId !== null) void refreshDomains(selectedAccountId);
    else if (tab === "domains") { setDomains([]); setSelectedDomain(null); setDnsRecords([]); }
  }, [tab, selectedAccountId, refreshDomains]);

  const refreshBuckets = useCallback(async (accountId: number) => {
    const isCurrentRead = beginResourceRead("storage", accountId);
    setLoading(true);
    try {
      const result = await resourcesClient.listLocal({ accountId, resourceType: "oss" });
      if (!isCurrentRead()) return;
      setBuckets(result); setSelectedBucket(null); setObjectListing(null); setNotice("");
    }
    catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取存储桶失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }, [beginResourceRead]);

  useEffect(() => {
    if (tab === "storage" && selectedAccountId !== null) void refreshBuckets(selectedAccountId);
    else if (tab === "storage") { setBuckets([]); setSelectedBucket(null); setObjectListing(null); }
  }, [tab, selectedAccountId, refreshBuckets]);

  const refreshDatabases = useCallback(async (accountId: number) => {
    const isCurrentRead = beginResourceRead("databases", accountId);
    setLoading(true);
    try {
      const result = await resourcesClient.listLocal({ accountId, resourceType: "rds" });
      if (!isCurrentRead()) return;
      setDatabaseAssets(result); setSelectedDatabase(null); setDatabaseDetails([]); setNotice("");
    }
    catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取数据库实例失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }, [beginResourceRead]);

  useEffect(() => {
    if (tab === "databases" && selectedAccountId !== null) void refreshDatabases(selectedAccountId);
    else if (tab === "databases") { setDatabaseAssets([]); setSelectedDatabase(null); setDatabaseDetails([]); }
  }, [tab, selectedAccountId, refreshDatabases]);

  const refreshRedis = useCallback(async (accountId: number) => {
    const isCurrentRead = beginResourceRead("redis", accountId);
    setLoading(true);
    try {
      const result = await resourcesClient.listLocal({ accountId, resourceType: "redis" });
      if (!isCurrentRead()) return;
      setRedisAssets(result); setSelectedRedis(null); setRedisAccounts([]); setNotice("");
    }
    catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取 Redis 实例失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }, [beginResourceRead]);

  useEffect(() => {
    if (tab === "redis" && selectedAccountId !== null) void refreshRedis(selectedAccountId);
    else if (tab === "redis") { setRedisAssets([]); setSelectedRedis(null); setRedisAccounts([]); }
  }, [tab, selectedAccountId, refreshRedis]);

  async function loadRedisAccounts(instance: LocalAsset) {
    if (!selectedAccount) return;
    if (!["aliyun", "tencent"].includes(selectedAccount.cloud_type)) { setNotice(`${cloudProvider(selectedAccount.cloud_type).label}暂未接入 Redis 账号查询`); return; }
    const instanceId = payloadText(instance.payload, ["InstanceId", "instanceId", "Id", "id"]);
    const regionId = instance.region_id || selectedAccount.region_id || "";
    if (instanceId === "—") { setNotice("Redis 实例缓存缺少实例 ID"); return; }
    const isCurrentRead = beginResourceRead("redis", selectedAccount.id);
    setSelectedRedis(instance); setLoading(true);
    try {
      const result = await resourcesClient.redisAccounts(selectedAccount.id, regionId, instanceId);
      if (!isCurrentRead()) return;
      setRedisAccounts(result); setNotice("");
    }
    catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取 Redis 账号失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }

  async function refreshRedisFromCloud() {
    if (!selectedAccount || syncing) return;
    setSyncing(true); setNotice("");
    try { const result = await resourcesClient.sync(selectedAccount.id, ["redis"]); await refreshRedis(selectedAccount.id); setNotice(`已刷新 ${result.fetched} 个 Redis 实例`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Redis 实例同步失败"); }
    finally { setSyncing(false); }
  }

  async function refreshCertificates() {
    const accountId = selectedAccountId;
    const isCurrentRead = beginResourceRead("certificates", accountId);
    setLoading(true);
    try {
      const result = await certificatesClient.list(accountId ?? undefined);
      if (!isCurrentRead()) return;
      setCertificates(result); setNotice("");
    }
    catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取证书失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }

  useEffect(() => {
    if (tab === "certificates") void refreshCertificates();
  }, [tab, selectedAccountId]);

  async function refreshManagedHosts() {
    setLoading(true);
    try { setManagedHosts(await serversClient.listManaged()); setNotice(""); }
    catch (error) { setNotice(error instanceof Error ? error.message : "读取 SSH 主机失败"); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (tab === "ssh") void refreshManagedHosts();
  }, [tab]);

  const refreshPanelConnections = useCallback(async () => {
    setPanelLoading(true);
    try { setPanelConnections(await remoteClient.listPanels()); }
    catch (error) { setNotice(error instanceof Error ? error.message : "读取面板配置失败"); }
    finally { setPanelLoading(false); }
  }, []);

  useEffect(() => {
    if (tab === "more") void refreshPanelConnections();
  }, [tab, refreshPanelConnections]);

  useEffect(() => {
    if (tab === "sync") { void refreshManagedHosts(); void refreshPanelConnections(); }
  }, [tab, refreshPanelConnections]);

  async function refreshPanelStatus(panel: PanelConnection) {
    if (panelActionId !== null) return;
    setPanelActionId(panel.id); setNotice("");
    try {
      const updated = await remoteClient.refreshPanel(panel.id);
      setPanelConnections((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice(updated.status === "online" ? `已刷新面板“${updated.name}”状态` : `面板“${updated.name}”当前无法连接`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "刷新面板状态失败"); }
    finally { setPanelActionId(null); }
  }

  async function openPanel(panel: PanelConnection) {
    if (panelActionId !== null) return;
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
    if (!selectedAccount) return;
    const payload = instance.payload;
    const instanceId = payloadText(payload, ["DBInstanceId", "InstanceId", "instanceId", "id"]);
    const regionId = instance.region_id || selectedAccount.region_id || "";
    if (instanceId === "—") { setNotice("数据库实例缓存缺少实例 ID"); return; }
    const isCurrentRead = beginResourceRead("databases", selectedAccount.id);
    setSelectedDatabase(instance); setLoading(true);
    try {
      const result = await resourcesClient.rdsDetails("databases", selectedAccount.id, regionId, instanceId);
      if (!isCurrentRead()) return;
      setDatabaseDetails(result); setNotice("");
    }
    catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取数据库清单失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }

  async function refreshDatabasesFromCloud() {
    if (!selectedAccount || syncing) return;
    setSyncing(true); setNotice("");
    try { const result = await resourcesClient.sync(selectedAccount.id, ["rds"]); await refreshDatabases(selectedAccount.id); setNotice(`已刷新 ${result.fetched} 个数据库实例`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "数据库实例同步失败"); }
    finally { setSyncing(false); }
  }

  async function browseBucket(bucket: LocalAsset, prefix = "", marker = "") {
    if (!selectedAccount) return;
    const bucketName = payloadText(bucket.payload, ["Name", "Bucket", "name"]);
    const location = payloadText(bucket.payload, ["Location", "location", "Region"]);
    if (bucketName === "—" || location === "—") { setNotice("存储桶缓存缺少名称或地域"); return; }
    const isCurrentRead = beginResourceRead("storage", selectedAccount.id);
    setSelectedBucket(bucket); setObjectPrefix(prefix); setLoading(true);
    try {
      const result = await storageClient.objects(selectedAccount.id, bucketName, location, prefix, marker);
      if (!isCurrentRead()) return;
      setObjectListing(marker && objectListing ? { ...result, objects: [...objectListing.objects, ...result.objects], prefixes: [...objectListing.prefixes, ...result.prefixes] } : result);
      setNotice("");
    } catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取对象列表失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }

  async function refreshBucketsFromCloud() {
    if (!selectedAccount || syncing) return;
    setSyncing(true); setNotice("");
    try { const result = await resourcesClient.sync(selectedAccount.id, ["oss"]); await refreshBuckets(selectedAccount.id); setNotice(`已刷新 ${result.fetched} 个存储桶`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "存储桶同步失败"); }
    finally { setSyncing(false); }
  }

  async function loadDns(domainAsset: LocalAsset) {
    if (!selectedAccount) return;
    const domain = payloadText(domainAsset.payload, ["DomainName", "domain", "domainName", "name"]);
    if (domain === "—") { setNotice("缓存中缺少域名名称，请先刷新云端数据"); return; }
    const isCurrentRead = beginResourceRead("domains", selectedAccount.id);
    setSelectedDomain(domainAsset);
    setLoading(true);
    try {
      const response = await domainsClient.records(selectedAccount.id, domain, { page: 1, pageSize: 100 });
      if (!isCurrentRead()) return;
      setDnsRecords(Array.isArray(response.items) ? response.items as Record<string, unknown>[] : []);
      setNotice("");
    } catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取 DNS 记录失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }

  async function refreshDomainsFromCloud() {
    if (!selectedAccount || syncing) return;
    setSyncing(true); setNotice("");
    try {
      const result = await resourcesClient.sync(selectedAccount.id, ["domain"]);
      await refreshDomains(selectedAccount.id);
      setNotice(`已刷新 ${result.fetched} 项域名数据`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "域名同步失败"); }
    finally { setSyncing(false); }
  }

  async function changeDnsRecord(row: Record<string, unknown>, action: "toggle" | "delete") {
    if (!selectedAccount || !selectedDomain || selectedAccount.cloud_type !== "aliyun") return;
    const recordId = String(row.RecordId ?? "");
    if (!recordId) { setNotice("记录缺少云端 ID，无法操作"); return; }
    if (action === "delete" && !window.confirm(`确认删除 ${String(row.RR ?? "")} 记录吗？`)) return;
    try {
      if (action === "delete") await domainsClient.remove(selectedAccount.id, recordId);
      else await domainsClient.toggle(selectedAccount.id, recordId, String(row.Status).toUpperCase() === "ENABLE" ? "Disable" : "Enable");
      await loadDns(selectedDomain);
      setNotice(action === "delete" ? "DNS 记录已删除" : "DNS 记录状态已更新");
    } catch (error) { setNotice(error instanceof Error ? error.message : "DNS 操作失败"); }
  }

  async function saveDnsRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAccount || !selectedDomain || selectedAccount.cloud_type !== "aliyun") return;
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
      if (dnsEditor) await domainsClient.update(selectedAccount.id, { recordId: String(dnsEditor.RecordId), ...input });
      else await domainsClient.add(selectedAccount.id, domain, input);
      setDnsEditor(undefined);
      await loadDns(selectedDomain);
      setNotice(dnsEditor ? "DNS 记录已更新" : "DNS 记录已添加");
    } catch (error) { setNotice(error instanceof Error ? error.message : "保存 DNS 记录失败"); }
  }

  async function syncServers() {
    if (!selectedAccount || syncing) return;
    setSyncing(true);
    setNotice("");
    try {
      const result = await resourcesClient.sync(selectedAccount.id, ["ecs"]);
      await refreshServers(selectedAccount.id);
      setNotice(`已从云厂商刷新 ${result.fetched} 项服务器数据`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "服务器同步失败");
    } finally {
      setSyncing(false);
    }
  }

  async function runServerAction(server: LocalAsset, action: InstanceAction) {
    if (!selectedAccount || !["aliyun", "tencent"].includes(selectedAccount.cloud_type)) return;
    const instanceId = payloadText(server.payload, ["instanceId", "InstanceId", "id", "Id"]);
    const name = payloadText(server.payload, ["instanceName", "InstanceName", "name", "Name", "serverName"]);
    const actionLabel = action === "reboot" ? "重启" : action === "start" ? "启动" : "停止";
    if (instanceId === "—" || !window.confirm(`确认${actionLabel}服务器“${name}”吗？`)) return;
    const key = `${server.account_id}:${server.asset_key}`;
    setActiveAction(key);
    setNotice("");
    try {
      const payload = { id: server.account_id, regionId: server.region_id || selectedAccount.region_id || "", instanceId, action, forceStop: false };
      if (selectedAccount.cloud_type === "aliyun") await serversClient.aliyunAction(payload);
      else await serversClient.providerAction("tencent", payload);
      setNotice(`已提交${actionLabel}请求，云厂商状态可能需要片刻更新`);
      await refreshServers(server.account_id);
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
      setNotice("账号及其本地数据已删除");
    } catch (error) { setNotice(error instanceof Error ? error.message : "删除云账号失败"); }
    finally { setRemovingAccountId(null); }
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

  return (
    <main className="mobile-shell">
      <header className="mobile-header">
        <div className="mobile-brand"><span className="mobile-brand-icon"><Cloud size={19} /></span><div><strong>云枢 Tools</strong><small>手机端 · 本机加密存储</small></div></div>
        <button className="mobile-icon-button" type="button" aria-label="刷新" disabled={loading} onClick={() => void refreshAccounts()}><RefreshCw size={19} className={loading ? "mobile-spin" : ""} /></button>
      </header>

      <section className="mobile-content">
        {tab === "accounts" ? <>
          <div className="mobile-page-title"><div><p>本机保险库</p><h1>云账号</h1></div><button type="button" className="mobile-primary" onClick={openAddAccount}><Plus size={17} />添加</button></div>
          <div className="mobile-security-note"><ShieldCheck size={18} /><span>凭据只保存在这台设备的本地加密数据库中。</span></div>
          {loading && accounts.length === 0 ? <div className="mobile-empty"><Activity className="mobile-spin" />正在读取本机账号…</div> : accounts.length === 0 ? <div className="mobile-empty"><Cloud size={30} /><strong>还没有云账号</strong><span>添加账号后，手机可以独立查询云资源。</span><button className="mobile-primary" type="button" onClick={openAddAccount}><Plus size={17} />添加云账号</button></div> : <div className="mobile-account-list">{accounts.map((account) => <article key={account.id} className={`mobile-account-card${selectedAccountId === account.id ? " selected" : ""}`}><button type="button" className="mobile-account-select" onClick={() => { setSelectedAccountId(account.id); setTab("servers"); }}><span className="mobile-provider-avatar">{cloudProvider(account.cloud_type).avatar}</span><span className="mobile-account-copy"><strong>{account.account_name}</strong><small>{cloudProvider(account.cloud_type).label} · {account.region_id || "默认地域"}</small></span><span className="mobile-account-arrow">›</span></button><button type="button" className="mobile-account-edit" aria-label={`编辑本机账号 ${account.account_name}`} title="编辑账号配置" onClick={() => openEditAccount(account)}><Pencil size={17} /></button><button type="button" className="mobile-account-delete" aria-label={`删除本机账号 ${account.account_name}`} title="删除此设备上的账号和数据" disabled={removingAccountId !== null} onClick={() => void removeAccount(account)}>{removingAccountId === account.id ? <RefreshCw size={17} className="mobile-spin" /> : <Trash2 size={17} />}</button></article>)}</div>}
        </> : tab === "servers" ? <>
          <div className="mobile-page-title"><div><p>{selectedAccount?.account_name ?? "云资源"}</p><h1>服务器</h1></div><button type="button" className="mobile-primary" disabled={!selectedAccount || syncing} onClick={() => void syncServers()}><ArrowDownToLine size={17} />{syncing ? "刷新中" : "云端刷新"}</button></div>
          {!selectedAccount ? <div className="mobile-empty"><Cloud size={30} /><strong>先添加云账号</strong><button type="button" className="mobile-primary" onClick={() => setTab("accounts")}>查看账号</button></div> : servers.length === 0 && !loading ? <div className="mobile-empty"><Server size={30} /><strong>暂无缓存的服务器</strong><span>点击“云端刷新”从 {cloudProvider(selectedAccount.cloud_type).label} 查询。</span></div> : <div className="mobile-server-list">{servers.map((server) => { const key = `${server.account_id}:${server.asset_key}`; const busy = activeAction === key; return <article className="mobile-server-card" key={key}><div className="mobile-server-heading"><span className="mobile-server-dot" /><strong>{payloadText(server.payload, ["instanceName", "InstanceName", "name", "Name", "serverName"])}</strong></div><p>{payloadText(server.payload, ["instanceId", "InstanceId", "id", "Id"])}</p><div className="mobile-server-meta"><span>{server.region_id || "地域未知"}</span><span>{payloadText(server.payload, ["status", "Status", "instanceStatus"])}</span></div><small>缓存于 {new Date(server.fetched_at * 1000).toLocaleString()}</small>{["aliyun", "tencent"].includes(selectedAccount.cloud_type) && <div className="mobile-server-actions"><button type="button" disabled={busy || syncing} onClick={() => void runServerAction(server, "start")}><Power size={14} />启动</button><button type="button" disabled={busy || syncing} onClick={() => void runServerAction(server, "stop")}><Power size={14} />停止</button><button type="button" disabled={busy || syncing} onClick={() => void runServerAction(server, "reboot")}><RotateCw size={14} />重启</button>{busy && <span role="status">提交中…</span>}</div>}</article>; })}</div>}
        </> : tab === "domains" ? <>
          <div className="mobile-page-title"><div><p>{selectedAccount?.account_name ?? "云资源"}</p><h1>域名与 DNS</h1></div><button type="button" className="mobile-primary" disabled={!selectedAccount || syncing} onClick={() => void refreshDomainsFromCloud()}><ArrowDownToLine size={17} />{syncing ? "刷新中" : "云端刷新"}</button></div>
          {!selectedAccount ? <div className="mobile-empty"><Globe2 size={30} /><strong>先添加云账号</strong><button type="button" className="mobile-primary" onClick={() => setTab("accounts")}>查看账号</button></div> : selectedDomain ? <>
            <button type="button" className="mobile-domain-back" onClick={() => { setSelectedDomain(null); setDnsRecords([]); }}>‹ 返回域名列表</button>
            <div className="mobile-domain-heading"><h2 className="mobile-domain-name">{payloadText(selectedDomain.payload, ["DomainName", "domain", "domainName", "name"])}</h2>{selectedAccount.cloud_type === "aliyun" && <button className="mobile-primary" type="button" onClick={() => setDnsEditor(null)}><Plus size={16} />新增记录</button>}</div>
            {loading && dnsRecords.length === 0 ? <div className="mobile-empty">正在读取 DNS 记录…</div> : dnsRecords.length === 0 ? <div className="mobile-empty"><strong>暂无 DNS 记录</strong></div> : <div className="mobile-domain-list">{dnsRecords.map((row, index) => <article className="mobile-domain-card" key={String(row.RecordId ?? index)}><div className="mobile-server-heading"><span className="mobile-domain-type">{String(row.Type ?? "DNS")}</span><strong>{String(row.RR ?? "@")}</strong></div><p>{String(row.Value ?? "—")}</p><div className="mobile-server-meta"><span>TTL {String(row.TTL ?? "—")}</span><span>{String(row.Status ?? "未知")}</span></div>{selectedAccount.cloud_type === "aliyun" && <div className="mobile-server-actions"><button type="button" onClick={() => setDnsEditor(row)}>编辑</button><button type="button" onClick={() => void changeDnsRecord(row, "toggle")}>{String(row.Status).toUpperCase() === "ENABLE" ? "暂停" : "启用"}</button><button type="button" aria-label={`删除 ${String(row.RR ?? "")} 记录`} onClick={() => void changeDnsRecord(row, "delete")}><Trash2 size={15} />删除</button></div>}</article>)}</div>}
          </> : domains.length === 0 && !loading ? <div className="mobile-empty"><Globe2 size={30} /><strong>暂无缓存的域名</strong><span>点击“云端刷新”读取已购买的域名。</span></div> : <div className="mobile-domain-list">{domains.map((domain) => { const key = `${domain.account_id}:${domain.asset_key}`; return <button className="mobile-account-card" key={key} type="button" onClick={() => void loadDns(domain)}><span className="mobile-provider-avatar"><Globe2 size={20} /></span><span className="mobile-account-copy"><strong>{payloadText(domain.payload, ["DomainName", "domain", "domainName", "name"])}</strong><small>点击查看解析记录</small></span><span className="mobile-account-arrow">›</span></button>; })}</div>}
        </> : tab === "storage" ? <>
          <div className="mobile-page-title"><div><p>{selectedAccount?.account_name ?? "云资源"}</p><h1>对象存储</h1></div><button type="button" className="mobile-primary" disabled={!selectedAccount || syncing} onClick={() => void refreshBucketsFromCloud()}><ArrowDownToLine size={17} />{syncing ? "刷新中" : "云端刷新"}</button></div>
          {!selectedAccount ? <div className="mobile-empty"><Folder size={30} /><strong>先添加云账号</strong></div> : selectedBucket ? <>
            <button type="button" className="mobile-domain-back" onClick={() => { if (objectPrefix) { const parts = objectPrefix.replace(/\/$/, "").split("/"); parts.pop(); void browseBucket(selectedBucket, parts.length ? `${parts.join("/")}/` : ""); } else { setSelectedBucket(null); setObjectListing(null); } }}>‹ {objectPrefix ? "上一级目录" : "存储桶列表"}</button>
            <h2 className="mobile-domain-name">{payloadText(selectedBucket.payload, ["Name", "Bucket", "name"])}</h2>
            {objectPrefix && <p className="mobile-object-prefix">/{objectPrefix}</p>}
            {objectListing && <div className="mobile-domain-list">{objectListing.prefixes.map((prefix) => <button type="button" className="mobile-object-row" key={prefix} onClick={() => void browseBucket(selectedBucket, prefix)}><Folder size={19} /><span>{prefix.slice(objectPrefix.length)}</span><b>›</b></button>)}{objectListing.objects.map((object) => <article className="mobile-object-row" key={object.Key}><File size={18} /><span><strong>{object.Key.slice(objectPrefix.length)}</strong><small>{Number(object.Size).toLocaleString()} bytes · {object.LastModified ? new Date(object.LastModified).toLocaleDateString() : ""}</small></span></article>)}</div>}
            {objectListing?.isTruncated && <button className="mobile-primary mobile-load-more" type="button" disabled={loading} onClick={() => void browseBucket(selectedBucket, objectPrefix, objectListing.nextMarker)}>{loading ? "加载中…" : "加载更多"}</button>}
          </> : buckets.length === 0 && !loading ? <div className="mobile-empty"><Folder size={30} /><strong>暂无缓存的存储桶</strong><span>点击“云端刷新”获取清单。</span></div> : <div className="mobile-domain-list">{buckets.map((bucket) => <button className="mobile-account-card" key={`${bucket.account_id}:${bucket.asset_key}`} type="button" onClick={() => void browseBucket(bucket)}><span className="mobile-provider-avatar"><Folder size={20} /></span><span className="mobile-account-copy"><strong>{payloadText(bucket.payload, ["Name", "Bucket", "name"])}</strong><small>{payloadText(bucket.payload, ["Location", "location", "Region"])}</small></span><span className="mobile-account-arrow">›</span></button>)}</div>}
        </> : tab === "databases" ? <>
          <div className="mobile-page-title"><div><p>{selectedAccount?.account_name ?? "云资源"}</p><h1>云数据库</h1></div><button type="button" className="mobile-primary" disabled={!selectedAccount || syncing} onClick={() => void refreshDatabasesFromCloud()}><ArrowDownToLine size={17} />{syncing ? "刷新中" : "云端刷新"}</button></div>
          {!selectedAccount ? <div className="mobile-empty"><Database size={30} /><strong>先添加云账号</strong></div> : selectedDatabase ? <>
            <button type="button" className="mobile-domain-back" onClick={() => { setSelectedDatabase(null); setDatabaseDetails([]); }}>‹ 返回实例列表</button>
            <h2 className="mobile-domain-name">{payloadText(selectedDatabase.payload, ["DBInstanceDescription", "DBInstanceId", "InstanceName", "name"])}</h2>
            {loading && databaseDetails.length === 0 ? <div className="mobile-empty">正在读取数据库…</div> : databaseDetails.length === 0 ? <div className="mobile-empty"><strong>没有返回数据库清单</strong><span>当前云账号或实例可能不支持此查询。</span></div> : <div className="mobile-domain-list">{databaseDetails.map((item, index) => <article className="mobile-domain-card" key={String(item.DBName ?? item.AccountName ?? index)}><div className="mobile-server-heading"><Database size={17} /><strong>{String(item.DBName ?? item.AccountName ?? item.Name ?? "数据库")}</strong></div><p>{String(item.CharacterSetName ?? item.AccountDescription ?? item.Description ?? "")}</p><div className="mobile-server-meta"><span>{String(item.DBStatus ?? item.AccountStatus ?? "")}</span><span>{String(item.DBInstanceId ?? "")}</span></div></article>)}</div>}
          </> : databaseAssets.length === 0 && !loading ? <div className="mobile-empty"><Database size={30} /><strong>暂无缓存的数据库实例</strong><span>点击“云端刷新”获取实例列表。</span></div> : <div className="mobile-domain-list">{databaseAssets.map((instance) => <button className="mobile-account-card" key={`${instance.account_id}:${instance.asset_key}`} type="button" onClick={() => void loadDatabaseDetails(instance)}><span className="mobile-provider-avatar"><Database size={20} /></span><span className="mobile-account-copy"><strong>{payloadText(instance.payload, ["DBInstanceDescription", "DBInstanceId", "InstanceName", "name"])}</strong><small>{instance.region_id} · {payloadText(instance.payload, ["DBInstanceStatus", "InstanceStatus", "status"])}</small></span><span className="mobile-account-arrow">›</span></button>)}</div>}
        </> : tab === "redis" ? <>
          <div className="mobile-page-title"><div><p>{selectedAccount?.account_name ?? "云资源"}</p><h1>Redis</h1></div><button type="button" className="mobile-primary" disabled={!selectedAccount || syncing} onClick={() => void refreshRedisFromCloud()}><ArrowDownToLine size={17} />{syncing ? "刷新中" : "云端刷新"}</button></div>
          {!selectedAccount ? <div className="mobile-empty"><Database size={30} /><strong>先添加云账号</strong></div> : selectedRedis ? <>
            <button type="button" className="mobile-domain-back" onClick={() => { setSelectedRedis(null); setRedisAccounts([]); }}>‹ 返回实例列表</button>
            <h2 className="mobile-domain-name">{payloadText(selectedRedis.payload, ["InstanceName", "InstanceId", "instanceId", "Id"])}</h2>
            {loading && redisAccounts.length === 0 ? <div className="mobile-empty">正在读取 Redis 账号…</div> : redisAccounts.length === 0 ? <div className="mobile-empty"><strong>没有返回账号信息</strong><span>实例可能没有自定义账号，或当前凭据缺少读取权限。</span></div> : <div className="mobile-domain-list">{redisAccounts.map((item, index) => <article className="mobile-domain-card" key={String(item.AccountName ?? index)}><div className="mobile-server-heading"><Database size={17} /><strong>{String(item.AccountName ?? "默认账号")}</strong></div><div className="mobile-server-meta"><span>{String(item.AccountType ?? "")}</span><span>{String(item.AccountStatus ?? "")}</span></div>{typeof item.AccountDescription === "string" && item.AccountDescription && <p>{item.AccountDescription}</p>}</article>)}</div>}
          </> : redisAssets.length === 0 && !loading ? <div className="mobile-empty"><Database size={30} /><strong>暂无缓存的 Redis 实例</strong><span>点击“云端刷新”获取实例清单。</span></div> : <div className="mobile-domain-list">{redisAssets.map((instance) => <button className="mobile-account-card" key={`${instance.account_id}:${instance.asset_key}`} type="button" onClick={() => void loadRedisAccounts(instance)}><span className="mobile-provider-avatar"><Database size={20} /></span><span className="mobile-account-copy"><strong>{payloadText(instance.payload, ["InstanceName", "InstanceId", "instanceId", "Id"])}</strong><small>{instance.region_id} · {payloadText(instance.payload, ["InstanceStatus", "Status", "status"])}</small></span><span className="mobile-account-arrow">›</span></button>)}</div>}
        </> : tab === "certificates" ? <>
          <div className="mobile-page-title"><div><p>{selectedAccount?.account_name ?? "全账号"}</p><h1>证书管理</h1></div><button type="button" className="mobile-icon-button" aria-label="刷新证书" disabled={loading} onClick={() => void refreshCertificates()}><RefreshCw size={18} className={loading ? "mobile-spin" : ""} /></button></div>
          {loading && certificates.length === 0 ? <div className="mobile-empty">正在读取证书…</div> : certificates.length === 0 ? <div className="mobile-empty"><Award size={30} /><strong>暂无证书</strong><span>手机端暂提供证书状态查看；签发、下载与私钥查看仍保留在桌面端。</span></div> : <div className="mobile-domain-list">{certificates.map((certificate) => <article className="mobile-domain-card" key={certificate.id}><div className="mobile-server-heading"><Award size={17} /><strong>{certificate.primaryDomain}</strong></div><p>{certificate.domains.join(" · ")}</p><div className="mobile-server-meta"><span>{certificate.status}</span><span>{certificate.provider}</span></div><small className="mobile-cert-expiry">到期时间：{certificate.notAfter ? new Date(certificate.notAfter * 1000).toLocaleDateString() : "未知"}</small>{certificate.issuer && <small className="mobile-cert-expiry">签发者：{certificate.issuer}</small>}</article>)}</div>}
        </> : tab === "ssh" ? <>
          <div className="mobile-page-title"><div><p>本机已保存的托管主机</p><h1>SSH 终端</h1></div><div className="mobile-title-actions"><button type="button" className="mobile-icon-button" aria-label="重新读取主机" disabled={loading} onClick={() => void refreshManagedHosts()}><RefreshCw size={18} className={loading ? "mobile-spin" : ""} /></button><button type="button" className="mobile-primary" onClick={() => setShowAddSshHost(true)}><Plus size={17} />添加主机</button></div></div>
          {sshSessionId ? <section className="mobile-terminal"><div className="mobile-terminal-heading"><span><Terminal size={16} />{sshHost?.name ?? sshHost?.host ?? "SSH"}</span><button type="button" onClick={() => void disconnectManagedHost()}>断开</button></div><pre className="mobile-terminal-output" aria-live="polite">{sshOutput || "已连接，等待远端输出…"}</pre><form className="mobile-terminal-input" onSubmit={(event) => void sendSshCommand(event)}><label className="mobile-sr-only" htmlFor="mobile-ssh-command">输入 SSH 命令</label><input id="mobile-ssh-command" value={sshCommand} onChange={(event) => setSshCommand(event.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="输入命令并发送" /><button className="mobile-primary" type="submit" disabled={!sshCommand.trim()}>发送</button></form><p>命令会直接在远程 Shell 执行。敏感凭据仅由原生层读取。</p></section> : loading && managedHosts.length === 0 ? <div className="mobile-empty">正在读取托管主机…</div> : managedHosts.length === 0 ? <div className="mobile-empty"><Terminal size={30} /><strong>暂无托管主机</strong><span>可以直接在手机上添加 SSH 主机并将凭据加密保存在本机。</span><button type="button" className="mobile-primary" onClick={() => setShowAddSshHost(true)}><Plus size={17} />添加 SSH 主机</button></div> : <div className="mobile-domain-list">{managedHosts.map((host) => <article className="mobile-domain-card" key={host.id}><div className="mobile-server-heading"><Terminal size={17} /><strong>{host.name}</strong></div><p>{host.username}@{host.host}:{host.port}</p><div className="mobile-server-meta"><span>{host.platform === "windows" ? "Windows / RDP" : "SSH"}</span><span>{host.status}</span></div><small>{host.password_saved || host.private_key_saved ? "凭据已加密保存在本机" : "缺少已保存凭据"}</small><button type="button" className="mobile-primary mobile-host-connect" disabled={sshConnecting || host.platform === "windows" || (!host.password_saved && !host.private_key_saved)} onClick={() => void connectManagedHost(host)}>{sshConnecting ? "连接中…" : "连接终端"}</button></article>)}</div>}
        </> : tab === "sync" ? <SyncTransferPanel mode="mobile" accounts={accounts} managedHosts={managedHosts} panels={panelConnections} onClose={() => setTab("more")} onImported={() => { void refreshAccounts(); void refreshManagedHosts(); void refreshPanelConnections(); }} /> : <>
          <div className="mobile-page-title"><div><p>本机资源</p><h1>更多管理</h1></div></div>
          <div className="mobile-security-note"><ShieldCheck size={18} /><span>证书列表只显示元数据，不会在手机界面展开私钥。</span></div>
          <div className="mobile-domain-list">
            <button type="button" className="mobile-account-card" onClick={() => setTab("storage")}><span className="mobile-provider-avatar"><Folder size={20} /></span><span className="mobile-account-copy"><strong>对象存储</strong><small>桶、目录和对象列表</small></span><span className="mobile-account-arrow">›</span></button>
            <button type="button" className="mobile-account-card" onClick={() => setTab("databases")}><span className="mobile-provider-avatar"><Database size={20} /></span><span className="mobile-account-copy"><strong>云数据库</strong><small>RDS 实例和数据库清单</small></span><span className="mobile-account-arrow">›</span></button>
            <button type="button" className="mobile-account-card" onClick={() => setTab("redis")}><span className="mobile-provider-avatar"><Database size={20} /></span><span className="mobile-account-copy"><strong>Redis</strong><small>实例和账号列表</small></span><span className="mobile-account-arrow">›</span></button>
            <button type="button" className="mobile-account-card" onClick={() => setTab("certificates")}><span className="mobile-provider-avatar"><Award size={20} /></span><span className="mobile-account-copy"><strong>证书管理</strong><small>查看证书状态和有效期</small></span><span className="mobile-account-arrow">›</span></button>
            <button type="button" className="mobile-account-card" onClick={() => setTab("ssh")}><span className="mobile-provider-avatar"><Terminal size={20} /></span><span className="mobile-account-copy"><strong>SSH 终端</strong><small>连接本机已保存的托管主机</small></span><span className="mobile-account-arrow">›</span></button>
            <button type="button" className="mobile-account-card" onClick={() => setTab("sync")}><span className="mobile-provider-avatar"><ShieldCheck size={20} /></span><span className="mobile-account-copy"><strong>从电脑迁移配置</strong><small>导入加密云账号与 SSH 主机配置</small></span><span className="mobile-account-arrow">›</span></button>
          </div>
          <section className="mobile-panel-section" aria-labelledby="mobile-panels-title">
            <div className="mobile-panel-section-heading"><h2 id="mobile-panels-title">运维面板</h2><div className="mobile-panel-heading-actions"><button type="button" className="mobile-icon-button" aria-label="添加面板" onClick={addPanel}><Plus size={18} /></button><button type="button" className="mobile-icon-button" aria-label="刷新面板列表" disabled={panelLoading} onClick={() => void refreshPanelConnections()}><RefreshCw size={17} className={panelLoading ? "mobile-spin" : ""} /></button></div></div>
            {panelLoading && panelConnections.length === 0 ? <div className="mobile-empty">正在读取面板配置…</div> : panelConnections.length === 0 ? <div className="mobile-empty"><Monitor size={28} /><strong>暂无已配置的面板</strong><span>可直接在手机添加面板，也可以从电脑迁移已有的加密配置。</span><button type="button" className="mobile-primary" onClick={addPanel}>添加运维面板</button><button type="button" className="mobile-domain-back" onClick={() => setTab("sync")}>从电脑迁移面板</button></div> : <div className="mobile-domain-list">{panelConnections.map((panel) => <article className="mobile-domain-card mobile-panel-card" key={panel.id}><div className="mobile-server-heading"><Monitor size={17} /><strong>{panel.name}</strong></div><p>{panel.panel_url}</p><div className="mobile-server-meta"><span>{panel.group_name || "未分组"}</span><span className={`mobile-panel-status ${panel.status === "online" ? "online" : panel.status === "offline" ? "offline" : "unknown"}`}>{panel.status === "online" ? "在线" : panel.status === "offline" ? "离线" : "未检查"}</span></div><small>{panel.api_key_saved ? "API 密钥已加密保存在本机" : "缺少面板 API 密钥"}</small><div className="mobile-panel-actions"><button type="button" disabled={panelActionId !== null} onClick={() => void refreshPanelStatus(panel)}><RefreshCw size={15} className={panelActionId === panel.id ? "mobile-spin" : ""} />刷新状态</button><button type="button" className="primary" disabled={panelActionId !== null || !panel.api_key_saved || panel.status === "offline"} onClick={() => void openPanel(panel)}><ExternalLink size={15} />{panelActionId === panel.id ? "处理中…" : "打开面板"}</button><button type="button" aria-label={`编辑面板 ${panel.name}`} disabled={panelActionId !== null} onClick={() => editPanel(panel)}><Pencil size={16} /></button><button type="button" className="danger" aria-label={`删除面板 ${panel.name}`} disabled={panelActionId !== null} onClick={() => void removePanel(panel)}><Trash2 size={16} /></button></div></article>)}</div>}
          </section>
        </>}
        {notice && <p className="mobile-notice" role="status">{notice}</p>}
      </section>

      <nav className="mobile-tab-bar" aria-label="主导航"><button type="button" className={tab === "accounts" ? "active" : ""} onClick={() => setTab("accounts")}><Cloud size={19} /><span>账号</span></button><button type="button" className={tab === "servers" ? "active" : ""} onClick={() => setTab("servers")}><Server size={19} /><span>服务器</span></button><button type="button" className={tab === "domains" ? "active" : ""} onClick={() => setTab("domains")}><Globe2 size={19} /><span>域名</span></button><button type="button" className={tab === "more" || tab === "storage" || tab === "databases" || tab === "redis" || tab === "certificates" || tab === "ssh" || tab === "sync" ? "active" : ""} onClick={() => setTab("more")}><MoreHorizontal size={19} /><span>更多</span></button></nav>

      {showAddAccount && <div className="mobile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setShowAddAccount(false); setEditingAccount(null); } }}><form className="mobile-account-form" onSubmit={(event) => void saveAccount(event)}><div className="mobile-modal-heading"><div><small>凭据由 Rust 原生层加密保存</small><h2>{editingAccount ? "编辑云账号" : "添加云账号"}</h2></div><button className="mobile-icon-button" type="button" aria-label="关闭" onClick={() => { setShowAddAccount(false); setEditingAccount(null); }}><X size={20} /></button></div>
        <label>云厂商<select value={newAccountCloud} disabled={!!editingAccount} onChange={(event) => setNewAccountCloud(event.target.value)}>{cloudProviders.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}</select></label>
        <label>账号名称<input name="accountName" required maxLength={80} autoComplete="organization" defaultValue={editingAccount?.account_name} placeholder="生产环境" /></label>
        {newAccountCloud === "oracle" && <><label>Tenancy OCID<input name="tenancyOcid" required maxLength={256} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "tenancy_ocid")} placeholder="ocid1.tenancy..." /></label><label>Key Fingerprint<input name="keyFingerprint" required maxLength={100} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "key_fingerprint")} placeholder="aa:bb:cc:..." /></label></>}
        {newAccountCloud === "azure" && <><label>Tenant ID<input name="tenantId" required maxLength={100} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "tenant_id")} /></label><label>Subscription ID<input name="subscriptionId" required maxLength={100} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "subscription_id")} /></label></>}
        {newAccountCloud === "gcp" && <label>Project ID<input name="projectId" required maxLength={100} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "project_id")} /></label>}
        <label>{cloudProvider(newAccountCloud).idLabel}<input name="accessKeyId" required={newAccountCloud !== "vultr"} maxLength={2048} autoComplete="off" defaultValue={editingAccount?.access_key_id} placeholder={newAccountCloud === "vultr" ? "可留空，账号名称用于本地识别" : undefined} /></label>
        <label>{cloudProvider(newAccountCloud).secretLabel}{newAccountCloud === "oracle" || newAccountCloud === "gcp" ? <textarea name="accessKeySecret" required={!editingAccount} maxLength={32768} rows={6} autoComplete="off" spellCheck={false} /> : <input name="accessKeySecret" required={!editingAccount} maxLength={8192} type="password" autoComplete="new-password" />}</label>
        {editingAccount && <p className="mobile-form-hint">留空会保留本机加密凭据。更改密钥 ID 时必须同时输入新 Secret。</p>}
        <label>默认地域<input name="regionId" maxLength={100} defaultValue={editingAccount?.region_id} placeholder={cloudProvider(newAccountCloud).regionPlaceholder} autoComplete="off" /></label>
        <label>分组<input name="groupName" maxLength={80} defaultValue={editingAccount?.group_name} placeholder="例如：生产环境" /></label>
        <label>账号状态<select name="enabled" defaultValue={editingAccount?.enabled === false ? "false" : "true"}><option value="true">启用</option><option value="false">停用</option></select></label>
        <label>备注<input name="remark" maxLength={500} defaultValue={editingAccount?.remark} /></label>
        <p className="mobile-form-hint">账号密钥由 Rust 原生层加密保存；云厂商可能需要额外授予只读权限。</p><button className="mobile-primary mobile-submit" type="submit"><ShieldCheck size={17} />{editingAccount ? "保存配置" : "保存到本机"}</button></form></div>}

      {showAddSshHost && <div className="mobile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAddSshHost(false); }}><form className="mobile-account-form" onSubmit={(event) => void addManagedHost(event)}><div className="mobile-modal-heading"><div><small>主机信息和凭据仅保存在本机</small><h2>添加 SSH 主机</h2></div><button className="mobile-icon-button" type="button" aria-label="关闭" onClick={() => setShowAddSshHost(false)}><X size={20} /></button></div><label>显示名称<input name="name" maxLength={100} autoComplete="off" placeholder="例如：生产 Web 服务器" /></label><label>主机地址<input name="host" required maxLength={253} autoCapitalize="off" autoComplete="url" placeholder="主机名或 IP 地址" /></label><div className="mobile-form-grid"><label>SSH 端口<input name="port" type="number" min="1" max="65535" defaultValue="22" inputMode="numeric" /></label><label>用户名<input name="username" required maxLength={128} defaultValue="root" autoComplete="username" /></label></div><label>认证方式<select value={newSshAuthMethod} onChange={(event) => setNewSshAuthMethod(event.target.value as "password" | "private_key")}><option value="password">密码</option><option value="private_key">SSH 私钥</option></select></label>{newSshAuthMethod === "password" ? <label>SSH 密码<input name="password" required type="password" maxLength={8192} autoComplete="new-password" /></label> : <><label>SSH 私钥<textarea name="privateKey" required maxLength={32768} rows={7} autoComplete="off" spellCheck={false} placeholder="粘贴 OpenSSH 或 PEM 私钥" /></label><label>私钥口令（可选）<input name="keyPassphrase" type="password" maxLength={8192} autoComplete="new-password" /></label></>}<p className="mobile-form-hint">保存时凭据会在 Rust 原生层加密；连接时会校验并记住主机指纹。</p><button className="mobile-primary mobile-submit" type="submit"><ShieldCheck size={17} />加密保存主机</button></form></div>}

      {panelDraft && <div className="mobile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !panelSaving) setPanelDraft(null); }}><form className="mobile-account-form" onSubmit={(event) => void savePanel(event)}><div className="mobile-modal-heading"><div><small>密钥由 Rust 原生层加密后保存在本机</small><h2 id="mobile-panel-form-title">{panelDraft.id ? "编辑运维面板" : "添加运维面板"}</h2></div><button className="mobile-icon-button" type="button" aria-label="关闭面板表单" disabled={panelSaving} onClick={() => setPanelDraft(null)}><X size={20} /></button></div><label>面板名称<input required maxLength={100} autoComplete="off" value={panelDraft.name} onChange={(event) => setPanelDraft({ ...panelDraft, name: event.target.value })} placeholder="例如：生产环境" /></label><label>面板根地址<input required type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" maxLength={2048} autoComplete="url" value={panelDraft.panel_url} onChange={(event) => setPanelDraft({ ...panelDraft, panel_url: event.target.value })} placeholder="https://panel.example.com" /></label><label>API 密钥<input type="password" maxLength={8192} autoComplete="new-password" value={panelDraft.api_key} onChange={(event) => setPanelDraft({ ...panelDraft, api_key: event.target.value })} placeholder={panelDraft.id ? "留空以保留已保存的密钥" : "首次添加必须填写"} required={!panelDraft.id} /></label><div className="mobile-form-grid"><label>分组<input maxLength={80} autoComplete="off" value={panelDraft.group_name} onChange={(event) => setPanelDraft({ ...panelDraft, group_name: event.target.value })} placeholder="例如：生产" /></label><label>排序<input type="number" min="0" max="100000" inputMode="numeric" value={panelDraft.sort_order} onChange={(event) => setPanelDraft({ ...panelDraft, sort_order: Number(event.target.value) })} /></label></div><label>备注<input maxLength={500} autoComplete="off" value={panelDraft.remark} onChange={(event) => setPanelDraft({ ...panelDraft, remark: event.target.value })} /></label><label className="mobile-panel-check"><input type="checkbox" checked={panelDraft.allow_insecure_tls} onChange={(event) => setPanelDraft({ ...panelDraft, allow_insecure_tls: event.target.checked })} />允许不安全 TLS 证书（仅在面板使用自签名证书时开启）</label><p className="mobile-form-hint">手机会直接连接面板验证配置。编辑时密钥不会回显，留空会保留本机已加密密钥。</p><button className="mobile-primary mobile-submit" type="submit" disabled={panelSaving}><ShieldCheck size={17} />{panelSaving ? "正在验证并保存…" : "验证并加密保存"}</button></form></div>}

      {dnsEditor !== undefined && <div className="mobile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDnsEditor(undefined); }}><form className="mobile-account-form" onSubmit={(event) => void saveDnsRecord(event)}><div className="mobile-modal-heading"><div><small>{payloadText(selectedDomain?.payload ?? {}, ["DomainName", "domain", "domainName", "name"])}</small><h2>{dnsEditor ? "编辑 DNS 记录" : "新增 DNS 记录"}</h2></div><button className="mobile-icon-button" type="button" aria-label="关闭" onClick={() => setDnsEditor(undefined)}><X size={20} /></button></div><label>记录类型<select name="recordType" defaultValue={String(dnsEditor?.Type ?? "A")}><option>A</option><option>AAAA</option><option>CNAME</option><option>MX</option><option>TXT</option><option>NS</option><option>SRV</option><option>CAA</option></select></label><label>主机记录<input name="rr" required maxLength={253} defaultValue={String(dnsEditor?.RR ?? "")} placeholder="@ 或 www" /></label><label>记录值<input name="value" required maxLength={2048} defaultValue={String(dnsEditor?.Value ?? "")} /></label><label>TTL（秒）<input name="ttl" type="number" min="1" max="86400" defaultValue={Number(dnsEditor?.TTL ?? 600)} /></label><label>MX 优先级<input name="priority" type="number" min="1" max="50" defaultValue={Number(dnsEditor?.Priority ?? 10)} /></label><label>线路<input name="line" required maxLength={80} defaultValue={String(dnsEditor?.Line ?? "default")} /></label><p className="mobile-form-hint">保存后会直接修改云厂商 DNS 配置，请核对主机记录和值。</p><button className="mobile-primary mobile-submit" type="submit"><ShieldCheck size={17} />保存记录</button></form></div>}
    </main>
  );
}
