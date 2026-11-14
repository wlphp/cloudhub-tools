import { ToastNotice } from "../shared/ToastNotice";
import { CloudflareManager } from "../features/cloud/CloudflareManager";
import { GroupNameInput } from "../shared/GroupNameInput";
import { DialogField, DialogNotice } from "../shared/DialogForm";
import { SharedDialog } from "../shared/SharedDialog";
import { useDialogDragging } from "../shared/useDialogDragging";
import { KeyRound, LockKeyhole } from "lucide-react";
import { AuthenticatorPanel } from "../features/authenticator/AuthenticatorPanel";
import { Format, requestPermissions, scan } from "@tauri-apps/plugin-barcode-scanner";
import { AiAssistButton } from "../features/ai/AiAssistButton";
import { panelAiFields } from "../features/ai/panelDraft";
import { parseDnsPaste } from "../features/domains/parseDnsPaste";
import { normalizeDnsHost } from "../features/domains/dnsHost";
import type { AiFields } from "../platform/clients/ai";
import { MobileCertificateRequest } from "./MobileCertificateRequest";
import { MobileCertificates } from "./MobileCertificates";
import type { CertificateSummary } from "../platform/clients/certificates";
import { SecretField } from "../shared/SecretField";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useConfirmDialog } from "../shared/useConfirmDialog";
import { useCallback, useEffect, useRef, useState, type Dispatch, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import { Activity, ArrowLeft, BadgeCheck, CloudDownload, Crown, House, BellRing, Mail, Store, UserRound, ScanLine, ArrowDownToLine, ArrowUpDown, ChevronDown, ChevronRight, Cloud, Database, File, FileText, Filter, Folder, Globe2, HardDrive, Plus, Power, RefreshCw, RotateCw, Search, Server, ShieldCheck, SunMoon, Trash2, Award, Terminal, Pencil, ExternalLink, Monitor, Upload, Sparkles, Settings, SlidersHorizontal, Star } from "lucide-react";
import type { Account, ApiLog, LocalAsset, ManagedHost, PanelConnection, PanelConnectionDraft, TransferAccount } from "../shared/types";
import packageJson from "../../package.json";
import { accountsClient, certificatesClient, domainsClient, logsClient, preferencesClient, remoteClient, resourcesClient, storageClient } from "../platform/clients";
import type { OssObjectListing } from "../platform/clients/storage";
import { assetTypes, cloudProvider, cloudProviders, matchCloudTypeFromText, resourceLabels, syncAssetTypes } from "../features/cloud/catalog";
import { cloudHubBackFabPositionStorageKey, cloudHubFavoriteAssetsStorageKey, cloudHubUiThemeStorageKey, readUiTheme } from "../features/app/constants";
import { assetFavoriteKey, savedFavoriteAssetKeys, stringListFromValue } from "../features/assets/preferences";
import type { AccountSaveInput } from "../platform/clients/accounts";
import { serversClient, type InstanceAction } from "../platform/clients/servers";
import { SyncTransferPanel } from "../features/accounts/SyncTransferPanel";
import { NetworkSettingsPage } from "../features/settings/NetworkSettingsPage";
import { runningInTauri } from "../platform/api";
import { MobileResourceOverview } from "./MobileResourceOverview";
import { MobilePanelMetrics } from "./MobilePanelMetrics";
import { IpLocation } from "../features/servers/IpLocation";
import { MobileMorePage, type MobileFeatureDestination } from "./MobileMorePage";
import { MobileHomePage } from "./MobileHomePage";
import { MobileMonitorAlertsPage } from "./MobileMonitorAlertsPage";
import { OfficialPluginsPage } from "../features/plugins/OfficialPluginsPage";
import { applicationCatalog, type ApplicationSection } from "../features/plugins/applicationCatalog";
import { useApplicationPreferences } from "../features/plugins/useApplicationPreferences";
import { useMobileUpdates } from "./useMobileUpdates";
import { MobileUpdatePanel } from "./MobileUpdatePanel";
import { FlowPanel } from "../features/flow/FlowPanel";
import { MobileAccountSwipeCard } from "./MobileAccountSwipeCard";
import { MobilePullRefresh } from "./MobilePullRefresh";
import { MobileLoadingSkeleton } from "./MobileLoadingSkeleton";
import { MobileEsaProducts } from "./MobileEsaProducts";
import { MobileServerDetails, serverExpiryLabel } from "./MobileServerDetails";
import { MobileProviderMark } from "./MobileProviderMark";
import { PaginationBar } from "../shared/PaginationBar";
import { panelRefreshIntervals, useMobilePanelRefresh } from "./useMobilePanelRefresh";
import { MobileMemberPage } from "./MobileMemberPage";
import { MobilePersonalProfile } from "./MobilePersonalProfile";
import { MobileMemberIdentityDialog, type MemberIdentityKind } from "./MobileMemberIdentityDialog";
import { MemberAvatar } from "../features/member/MemberDialog";
import { memberClient, memberHasExperienceOfficerIdentity, type Member } from "../platform/clients/member";
import { openUrl } from "@tauri-apps/plugin-opener";

type MobileTab = "accounts" | "servers" | "domains" | "assets" | "favorites" | "storage" | "databases" | "redis" | "certificates" | "ssh" | "panels" | "sync" | "settings" | "settingsMenu" | "networkSettings" | "operationLogs" | "apiLogs" | "about" | "flow" | "authenticator" | "personalProfile" | "member" | "more" | "home" | "monitorAlerts" | "softwareStore";

function mobilePanelIp(panelUrl: string): string {
  try {
    const hostname = new URL(panelUrl).hostname;
    if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
    const parts = hostname.split(".");
    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) ? hostname : "";
  } catch { return ""; }
}

type MobileQrKind = "authenticator" | "transfer" | "link" | "text";
function mobileQrKind(content: string): MobileQrKind {
  if (content.startsWith("otpauth://")) return "authenticator";
  try {
    const url = new URL(content);
    if (url.protocol === "http:" && /^\/v1\/transfer\/[^/]+$/.test(url.pathname) && url.hash.length > 1) return "transfer";
    if (url.protocol === "https:" || url.protocol === "http:") return "link";
  } catch { /* 普通文本二维码 */ }
  return "text";
}

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

function serverPowerState(payload: Record<string, unknown>): "running" | "stopped" | "pending" {
  const status = payloadText(payload, ["InstanceStatus", "instanceStatus", "status", "Status"]).toLowerCase();
  if (["running", "active", "运行中", "正常"].includes(status)) return "running";
  if (["stopped", "stop", "已停止", "停止"].includes(status)) return "stopped";
  return "pending";
}

function domainRecordCountLabel(payload: Record<string, unknown>): string {
  const value = payload.RecordCount ?? payload.recordCount ?? payload.record_count;
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return "解析记录：未获取";
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? `解析记录 ${count} 条` : "解析记录：未获取";
}

function serverStatusClass(payload: Record<string, unknown>): string {
  return `mobile-server-status is-${serverPowerState(payload)}`;
}

/** 资产总览的状态词映射为语义徽章，无法识别的状态沿用中性色。 */
function assetStatusTone(status: string): "running" | "stopped" | "pending" {
  const value = status.trim().toLowerCase();
  if (!value) return "pending";
  if (["running", "active", "运行中", "正常", "available", "enabled", "online", "ok", "salesok", "in_use"].includes(value)) return "running";
  if (["stopped", "已停止", "停止", "disabled", "offline", "inactive"].includes(value)) return "stopped";
  return "pending";
}

function MemberIdentityBadges({ member, className, onSelect }: { member: Member | null; className: string; onSelect?: (identity: MemberIdentityKind) => void }) {
  return <span className={className} role="group" aria-label="账户身份">
    {member && (onSelect ? <button type="button" className="mobile-member-status-button" aria-label="查看 VIP 身份卡" onClick={() => onSelect("vip")}><span className={`mobile-member-status-badge is-vip${member.is_vip ? " is-active" : ""}`}><Crown size={13} aria-hidden="true" /><span>VIP</span></span></button> : <span className={`mobile-member-status-badge is-vip${member.is_vip ? " is-active" : ""}`}><Crown size={13} aria-hidden="true" /><span>VIP</span></span>)}
    {memberHasExperienceOfficerIdentity(member) && (onSelect ? <button type="button" className="mobile-member-status-button" aria-label="查看产品体验官身份卡" onClick={() => onSelect("experience_officer")}><span className="mobile-member-status-badge is-experience-officer"><BadgeCheck size={13} aria-hidden="true" /><span>体验官</span></span></button> : <span className="mobile-member-status-badge is-experience-officer"><BadgeCheck size={13} aria-hidden="true" /><span>体验官</span></span>)}
    {member?.id === 1 && member.is_admin && (onSelect ? <button type="button" className="mobile-member-status-button" aria-label="查看超级管理员身份卡" onClick={() => onSelect("super_admin")}><span className="mobile-member-status-badge is-super-admin"><ShieldCheck size={13} aria-hidden="true" /><span>超级管理</span></span></button> : <span className="mobile-member-status-badge is-super-admin"><ShieldCheck size={13} aria-hidden="true" /><span>超级管理</span></span>)}
  </span>;
}

function fetchedAtLabel(timestamp: number): string {
  const date = new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString();
}

const mobileDnsValueHints: Record<string, string> = {
  A: "填写服务器 IPv4 地址，例如 192.0.2.10。",
  AAAA: "填写服务器 IPv6 地址。",
  CNAME: "填写目标域名，不要添加 http:// 或路径。",
  MX: "填写邮件服务器域名；优先级在高级选项中设置。",
  TXT: "填写平台提供的完整文本，保留内容中的空格。",
  NS: "填写 DNS 服务器域名。",
  SRV: "填写优先级、权重、端口和目标，按服务商格式核对。",
  CAA: "填写标志、标签和证书颁发机构，例如 0 issue letsencrypt.org。",
};

function accountMetaValue(account: Account | null | undefined, key: string): string {
  if (!account?.credential_meta) return "";
  try {
    const meta = JSON.parse(account.credential_meta) as Record<string, unknown>;
    return typeof meta[key] === "string" ? meta[key] as string : "";
  } catch { return ""; }
}

function applyFormFields(form: HTMLFormElement | null, fields: AiFields, allowed: readonly string[]) {
  if (!form) throw new Error("表单已关闭，请重新打开后再应用");
  for (const key of allowed) {
    const value = fields[key];
    if (value === null || value === undefined || typeof value === "object") continue;
    const control = form.elements.namedItem(key);
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) continue;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")?.set;
    setter?.call(control, String(value));
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function panelCloudType(panel: PanelConnection, accounts: Account[]) {
  return accounts.find((account) => account.id === panel.source_account_id)?.cloud_type || matchCloudTypeFromText(`${panel.name} ${panel.remark || ""}`);
}

export function MobileApp() {
  const { confirm, confirmationDialog } = useConfirmDialog();
  const [cloudflareTarget, setCloudflareTarget] = useState<{ account: Account; kind?: string } | null>(null);
  const applicationSettings = useApplicationPreferences();
  const [storePluginId, setStorePluginId] = useState<string | null>(null);
  useDialogDragging();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [mobileAssetRows, setMobileAssetRows] = useState<LocalAsset[]>([]);
  const [mobileAssetSearch, setMobileAssetSearch] = useState("");
  const [mobileAssetTypeFilter, setMobileAssetTypeFilter] = useState("");
  const [mobileAssetAccountFilter, setMobileAssetAccountFilter] = useState<number | null>(null);
  const [mobileAssetPage, setMobileAssetPage] = useState(1);
  const [mobileAssetPageSize, setMobileAssetPageSize] = useState(10);
  const [panelListPage, setPanelListPage] = useState(1);
  const [panelListPageSize, setPanelListPageSize] = useState(10);
  const [panelGroupFilter, setPanelGroupFilter] = useState("");
  const [sshListPage, setSshListPage] = useState(1);
  const [sshListPageSize, setSshListPageSize] = useState(10);
  const [sshGroupFilter, setSshGroupFilter] = useState("");
  const [resourceListPage, setResourceListPage] = useState(1);
  const [resourceListPageSize, setResourceListPageSize] = useState(10);
  const [mobileAssetFiltersOpen, setMobileAssetFiltersOpen] = useState(true);
  const [mobileAssetsLoading, setMobileAssetsLoading] = useState(false);
  const [mobileFavoriteKeys, setMobileFavoriteKeys] = useState<string[]>(savedFavoriteAssetKeys);
  const [mobileFavoritesReady, setMobileFavoritesReady] = useState(false);
  const [accountProductCounts, setAccountProductCounts] = useState<Record<number, Record<string, number>>>({});
  const [accountAssetsRevision, setAccountAssetsRevision] = useState(0);
  const [uiTheme, setUiTheme] = useState<"light" | "dark">(readUiTheme);
  const [member, setMember] = useState<Member | null>(null);
  const [memberUnreadCount, setMemberUnreadCount] = useState(0);
  const [mobileActiveAlertCount, setMobileActiveAlertCount] = useState(0);
  const [memberInboxRequested, setMemberInboxRequested] = useState(false);
  const [activeMemberIdentity, setActiveMemberIdentity] = useState<MemberIdentityKind | null>(null);
  useEffect(() => {
    let active = true;
    if (!member) { setMemberUnreadCount(0); return; }
    const refreshUnread = () => { void memberClient.messages(1).then(page => { if (active) setMemberUnreadCount(page.unread_count); }).catch(() => {}); };
    refreshUnread();
    const timer = window.setInterval(refreshUnread, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [member?.id]);
  const [settingsDrawerDirection, setSettingsDrawerDirection] = useState<"forward" | "back">("forward");
  const [settingsTransitionUnderlayVisible, setSettingsTransitionUnderlayVisible] = useState(false);
  const settingsReturnToMenuRef = useRef(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsCloseButtonRef = useRef<HTMLButtonElement>(null);
  const closeSettingsDrawer = () => {
    settingsReturnToMenuRef.current = false;
    setTab("more");
    requestAnimationFrame(() => settingsButtonRef.current?.focus());
  };
  const openSettingsTab = (destination: MobileTab) => {
    settingsReturnToMenuRef.current = true;
    setSettingsTransitionUnderlayVisible(true);
    setSettingsDrawerDirection("forward");
    setTab(destination);
  };
  const returnToSettingsMenu = () => {
    settingsReturnToMenuRef.current = true;
    setSettingsTransitionUnderlayVisible(false);
    setSettingsDrawerDirection("back");
    setTab("settingsMenu");
  };
  useEffect(() => {
    document.body.classList.toggle("theme-light", uiTheme === "light");
    let themeColorMeta = document.head.querySelector('meta[name="theme-color"]');
    if (!themeColorMeta) { themeColorMeta = document.createElement("meta"); themeColorMeta.setAttribute("name", "theme-color"); document.head.appendChild(themeColorMeta); }
    themeColorMeta.setAttribute("content", uiTheme === "light" ? "#f7f7f8" : "#121212");
    try { localStorage.setItem(cloudHubUiThemeStorageKey, uiTheme); } catch { /* 存储不可用时仅本次会话生效 */ }
  }, [uiTheme]);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [productDialog, setProductDialog] = useState<{ account: Account; type: string; previousAccountId: number | null; searches: { server: string; domain: string; resources: Partial<Record<MobileTab, string>> } } | null>(null);

  function openAccountProduct(account: Account, type: string) {
    if (account.cloud_type === "cloudflare") { setCloudflareTarget({ account, kind: type }); return; }
    const productTabs: Record<string, MobileTab> = { ecs: "servers", swas: "servers", domain: "domains", oss: "storage", rds: "databases", redis: "redis", esa: "accounts" };
    const target = productTabs[type];
    if (!target) return;
    setProductDialog({ account, type, previousAccountId: selectedAccountId, searches: { server: serverSearch, domain: domainSearch, resources: resourceSearch } });
    setSelectedAccountId(account.id);
    setSelectedDomain(null);
    setSelectedBucket(null);
    setSelectedDatabase(null);
    setSelectedRedis(null);
    setServerSearch("");
    setDomainSearch("");
    setResourceSearch({});
    setTab(target);
  }

  function closeAccountProduct() {
    if (productDialog) {
      setServerSearch(productDialog.searches.server);
      setDomainSearch(productDialog.searches.domain);
      setResourceSearch(productDialog.searches.resources);
    }
    setSelectedAccountId(productDialog?.previousAccountId ?? null);
    setProductDialog(null);
    setSelectedDomain(null);
    setDnsRecords([]);
    setSelectedBucket(null);
    setObjectListing(null);
    setSelectedDatabase(null);
    setSelectedRedis(null);
    setNotice("");
    setTab("accounts");
  }
  const [accountSearch, setAccountSearch] = useState("");
  const [accountProviderFilter, setAccountProviderFilter] = useState("");
  const [accountSortAscending, setAccountSortAscending] = useState(true);
  const [accountListPage, setAccountListPage] = useState(1);
  const [accountPageSize, setAccountPageSize] = useState(10);
  const [assetAccountFilterId, setAssetAccountFilterId] = useState<number | null>(null);
  const [serverSearch, setServerSearch] = useState("");
  const [serverSortAscending, setServerSortAscending] = useState(true);
  const [servers, setServers] = useState<LocalAsset[]>([]);
  const [serverKind, setServerKind] = useState<"all" | "ecs" | "swas">("all");
  const [serverAccountFilterIds, setServerAccountFilterIds] = useState<number[]>([]);
  const [serverAccountFilterOpen, setServerAccountFilterOpen] = useState(false);
  const [serverActionConfirmation, setServerActionConfirmation] = useState<{ server: LocalAsset; action: InstanceAction; forceStop?: boolean } | null>(null);
  const [domains, setDomains] = useState<LocalAsset[]>([]);
  const [domainSearch, setDomainSearch] = useState("");
  const [domainSortAscending, setDomainSortAscending] = useState(true);
  const [resourceSearch, setResourceSearch] = useState<Partial<Record<MobileTab, string>>>({});
  const [resourceAscending, setResourceAscending] = useState<Partial<Record<MobileTab, boolean>>>({});
  const [resourceStatus, setResourceStatus] = useState<Partial<Record<MobileTab, string>>>({});
  const [selectedDomain, setSelectedDomain] = useState<LocalAsset | null>(null);
  const [dnsRecords, setDnsRecords] = useState<Record<string, unknown>[]>([]);
  const dnsFormRef = useRef<HTMLFormElement | null>(null);
  const [dnsRecordType, setDnsRecordType] = useState("A");
  const [dnsHostRecord, setDnsHostRecord] = useState("");
  const [dnsHostError, setDnsHostError] = useState("");
  const [dnsSaving, setDnsSaving] = useState(false);
  const sshHostFormRef = useRef<HTMLFormElement | null>(null);
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
  const [showCertificateRequest, setShowCertificateRequest] = useState(false);
  const [certificates, setCertificates] = useState<CertificateSummary[]>([]);
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
  const [panelOpeningId, setPanelOpeningId] = useState<number | null>(null);
  const [panelDraft, setPanelDraft] = useState<PanelConnectionDraft | null>(null);
  const [panelSaving, setPanelSaving] = useState(false);
  const [sshSessionId, setSshSessionId] = useState<string | null>(null);
  const [sshHost, setSshHost] = useState<ManagedHost | null>(null);
  const [sshOutput, setSshOutput] = useState("");
  const [sshCommand, setSshCommand] = useState("");
  const [sshConnecting, setSshConnecting] = useState(false);
  const [showAddSshHost, setShowAddSshHost] = useState(false);
  const [editingSshHost, setEditingSshHost] = useState<ManagedHost | null>(null);
  const [sshHostSaving, setSshHostSaving] = useState(false);
  const [newSshAuthMethod, setNewSshAuthMethod] = useState<"password" | "private_key">("password");
  const [dnsEditor, setDnsEditor] = useState<Record<string, unknown> | null | undefined>(undefined);
  const [tab, setTab] = useState<MobileTab>("home");
  // 云效流水线/HTTPS 证书/身份验证器从商店或首页进入时记录来源，供返回按钮回到来源页。
  const sectionOriginRef = useRef<"softwareStore" | "home" | null>(null);
  const [homeSearch, setHomeSearch] = useState("");
  const [mobileQrResult, setMobileQrResult] = useState<string | null>(null);
  const [pendingOtpUri, setPendingOtpUri] = useState<string | null>(null);
  const [pendingTransferQr, setPendingTransferQr] = useState<string | null>(null);
  async function scanMobileQr() {
    if (!runningInTauri) { setNotice("扫一扫仅支持手机 App，请在 App 内使用相机扫描。"); return; }
    try {
      if (await requestPermissions() !== "granted") { setNotice("请在系统设置中允许相机权限后重试。"); return; }
      const result = await scan({ windowed: false, formats: [Format.QRCode] });
      const content = result.content?.trim();
      if (!content) { setNotice("没有读取到有效二维码。"); return; }
      setMobileQrResult(content);
    } catch { setNotice("扫码已取消或相机不可用，请重试。"); }
  }
  function closeMobileQrResult() { setMobileQrResult(null); }
  async function copyMobileQrResult() {
    if (!mobileQrResult) return;
    try { await navigator.clipboard.writeText(mobileQrResult); setMobileQrResult(null); setNotice("已复制二维码内容。"); }
    catch { setNotice("复制失败，请检查系统剪贴板权限。"); }
  }
  useEffect(() => {
    if (tab !== "settingsMenu") return;
    settingsCloseButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeSettingsDrawer(); return; }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [tab]);
  const [startupAnimationEnabled, setStartupAnimationEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void preferencesClient.list().then(preferences => { if (active) setStartupAnimationEnabled(preferences["cloudhub-startup-animation"] !== "0"); }).catch(() => { if (active) setStartupAnimationEnabled(true); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (startupAnimationEnabled === null) return;
    void preferencesClient.save("cloudhub-startup-animation", startupAnimationEnabled ? "1" : "0").catch(() => {});
  }, [startupAnimationEnabled]);
  useEffect(() => { const open = () => { settingsReturnToMenuRef.current = false; setStorePluginId("cloudhub.model-suppliers"); setTab("softwareStore"); }; window.addEventListener("cloudhub-ai-settings", open); return () => window.removeEventListener("cloudhub-ai-settings", open); }, []);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncingAccountId, setSyncingAccountId] = useState<number | null>(null);
  const [accountSyncProgress, setAccountSyncProgress] = useState<{ accountId: number; completed: number; total: number; resourceType: string; status: string } | null>(null);
  const [cleaningUnknownResource, setCleaningUnknownResource] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [removingAccountId, setRemovingAccountId] = useState<number | null>(null);
  const [importingAccounts, setImportingAccounts] = useState(false);
  const accountImportInput = useRef<HTMLInputElement>(null);
  const mobileContentRef = useRef<HTMLElement>(null);
  const pullRefreshActionRef = useRef<(() => Promise<void>) | null>(null);
  const monitorRefreshRef = useRef<(() => Promise<void>) | null>(null);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [newAccountCloud, setNewAccountCloud] = useState("aliyun");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    setAccountSyncProgress(null);
    if (!runningInTauri || syncingAccountId === null) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ accountId: number; completed: number; total: number; resourceType: string; status: string }>("asset-sync-progress", (event) => {
      if (!disposed && event.payload.accountId === syncingAccountId) setAccountSyncProgress(event.payload);
    }).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup; });
    return () => { disposed = true; unlisten?.(); };
  }, [syncingAccountId]);
  useEffect(() => {
    let active = true;
    const refreshMember = () => { void memberClient.me().then(value => { if (active) setMember(value); }).catch(reason => { if (active && String(reason).includes("登录已失效")) setMember(null); }); };
    refreshMember(); window.addEventListener("focus", refreshMember);
    return () => { active = false; window.removeEventListener("focus", refreshMember); };
  }, []);
  const accountForAsset = useCallback((asset: LocalAsset | null) => asset ? accounts.find((account) => account.id === asset.account_id) ?? null : null, [accounts]);
  const selectedDomainAccount = accountForAsset(selectedDomain);
  const selectedDomainName = selectedDomain ? payloadText(selectedDomain.payload, ["DomainName", "domain", "domainName", "name"]) : "";
  let dnsHostPreview = "";
  try {
    const normalizedHost = normalizeDnsHost(dnsHostRecord, selectedDomainName);
    if (normalizedHost && selectedDomainName) dnsHostPreview = normalizedHost === "@" ? selectedDomainName : `${normalizedHost}.${selectedDomainName}`;
  } catch { /* Keep invalid host text editable and show its inline error. */ }
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

  const refreshServers = useCallback(async (accountId: number | null = selectedAccountId, preserveNotice = false) => {
    const isCurrentRead = beginResourceRead("servers", accountId);
    setLoading(true);
    try {
      const results = await Promise.all(["ecs", "swas"].map((resourceType) => resourcesClient.listLocal({ resourceType })));
      const result = results.flat();
      if (!isCurrentRead()) return;
      setServers(result);
      if (!preserveNotice) setNotice("");
    } catch (error) {
      if (!isCurrentRead()) return;
      setNotice(error instanceof Error ? error.message : "读取本机缓存失败");
    } finally {
      if (isCurrentRead()) setLoading(false);
    }
  }, [beginResourceRead, selectedAccountId]);

  const refreshMobileAssets = useCallback(async () => {
    setMobileAssetsLoading(true);
    try {
      setMobileAssetRows(await resourcesClient.listLocal());
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取本机资产失败");
    } finally {
      setMobileAssetsLoading(false);
    }
  }, []);

  useEffect(() => { void refreshAccounts(); }, [refreshAccounts]);

  useEffect(() => {
    let active = true;
    void preferencesClient.list().then((preferences) => {
      if (active && preferences[cloudHubFavoriteAssetsStorageKey] !== undefined) {
        const keys = stringListFromValue(preferences[cloudHubFavoriteAssetsStorageKey]);
        setMobileFavoriteKeys(keys);
        try { localStorage.setItem(cloudHubFavoriteAssetsStorageKey, JSON.stringify(keys)); } catch { /* 客户端偏好仍可用 */ }
      }
    }).catch(() => undefined).finally(() => { if (active) setMobileFavoritesReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!mobileFavoritesReady) return;
    const value = JSON.stringify(mobileFavoriteKeys);
    try { localStorage.setItem(cloudHubFavoriteAssetsStorageKey, value); } catch { /* 客户端偏好仍可用 */ }
    void preferencesClient.save(cloudHubFavoriteAssetsStorageKey, value).catch(() => undefined);
  }, [mobileFavoriteKeys, mobileFavoritesReady]);

  useEffect(() => { if (tab === "home" || tab === "assets" || tab === "favorites" || tab === "more" || tab === "monitorAlerts") void refreshMobileAssets(); }, [tab, refreshMobileAssets]);

  useEffect(() => {
    if (tab !== "accounts" || accounts.length === 0) return;
    let cancelled = false;
    // One local cache read for all accounts; never query providers for badges.
    void resourcesClient.listLocal().then(assets => {
      const counts: Record<number, Record<string, number>> = {};
      for (const asset of assets) {
        if (!Object.prototype.hasOwnProperty.call(resourceLabels, asset.resource_type)) continue;
        const products = counts[asset.account_id] ??= {};
        products[asset.resource_type] = (products[asset.resource_type] ?? 0) + 1;
      }
      if (!cancelled) setAccountProductCounts(counts);
    }).catch(() => { if (!cancelled) setAccountProductCounts({}); });
    return () => { cancelled = true; };
  }, [accounts, tab, accountAssetsRevision]);

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
      const result = await certificatesClient.summaries();
      if (!isCurrentRead()) return;
      setCertificates(result); setNotice("");
    }
    catch (error) { if (isCurrentRead()) setNotice(error instanceof Error ? error.message : "读取证书失败"); }
    finally { if (isCurrentRead()) setLoading(false); }
  }, [beginResourceRead, selectedAccountId]);

  useEffect(() => {
    if (tab === "servers" || tab === "more") void refreshServers();
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
    if (tab === "ssh" || tab === "more") void refreshManagedHosts();
    if (tab === "panels" || tab === "more") void refreshPanelConnections();
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
    if (!await confirm({ message: `确定清空${label}吗？此操作不可恢复。` })) return;
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
    if (panelOpeningId !== null || panelAutoRefresh.inFlight.current) return;
    setPanelOpeningId(panel.id); setNotice("");
    try {
      await remoteClient.openPanelTemporaryLogin(panel.id);
      setNotice(`正在打开面板“${panel.name}”`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "打开面板失败"); }
    finally { setPanelOpeningId(null); }
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
    if (!await confirm({ message: `删除本机保存的面板“${panel.name}”？不会删除云服务器或面板中的数据。` })) return;
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
    if (account.cloud_type === "cloudflare") { setCloudflareTarget({ account, kind: "oss" }); return; }
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
    if (account.cloud_type === "cloudflare") { setCloudflareTarget({ account, kind: "domain" }); return; }
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
    if (action === "delete" && !await confirm({ message: `确认删除 ${String(row.RR ?? "")} 记录吗？` })) return;
    try {
      if (action === "delete") await domainsClient.remove(account.id, recordId);
      else await domainsClient.toggle(account.id, recordId, String(row.Status).toUpperCase() === "ENABLE" ? "Disable" : "Enable");
      await loadDns(selectedDomain);
      setNotice(action === "delete" ? "DNS 记录已删除" : "DNS 记录状态已更新");
    } catch (error) { setNotice(error instanceof Error ? error.message : "DNS 操作失败"); }
  }

  function openDnsEditor(record: Record<string, unknown> | null) {
    setDnsRecordType(String(record?.Type ?? "A"));
    setDnsHostRecord(String(record?.RR ?? ""));
    setDnsHostError("");
    setDnsEditor(record);
  }

  async function saveDnsRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (dnsSaving) return;
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
    let normalizedRr: string;
    try { normalizedRr = normalizeDnsHost(rr, selectedDomainName); setDnsHostError(""); }
    catch (error) { setDnsHostError(error instanceof Error ? error.message : "无法识别主机记录。"); return; }
    const octets = value.split(".");
    if (type === "A" && (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255))) { setNotice("A 记录需要有效的 IPv4 地址"); return; }
    if (type === "AAAA" && !value.includes(":")) { setNotice("AAAA 记录需要 IPv6 地址"); return; }
    if (type === "MX" && (!Number.isInteger(priority) || priority < 1 || priority > 50)) { setNotice("MX 优先级需为 1 到 50 的整数"); return; }
    const input = { recordType: type, rr: normalizedRr, value, ttl, priority: type === "MX" ? priority : undefined, line };
    setDnsSaving(true);
    setNotice("");
    try {
      if (dnsEditor) await domainsClient.update(account.id, { recordId: String(dnsEditor.RecordId), ...input });
      else await domainsClient.add(account.id, selectedDomainName, input);
      setDnsEditor(undefined);
      await loadDns(selectedDomain);
      setNotice(dnsEditor ? "DNS 记录已更新" : "DNS 记录已添加");
    } catch (error) { setNotice(error instanceof Error ? error.message : "保存 DNS 记录失败"); }
    finally { setDnsSaving(false); }
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
    setAccountSyncProgress(null);
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
      setAccountAssetsRevision(revision => revision + 1);
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

  async function runServerAction(server: LocalAsset, action: InstanceAction, forceStop = false) {
    const account = accountForAsset(server);
    if (!account || !["aliyun", "tencent"].includes(account.cloud_type) || activeAction !== null) return;
    const power = serverPowerState(server.payload);
    if (power === "pending" || action === "start" && power !== "stopped" || action !== "start" && power !== "running") return;
    const instanceId = payloadText(server.payload, ["instanceId", "InstanceId", "id", "Id"]);
    const actionLabel = action === "reboot" ? (forceStop ? "强制重启" : "普通重启") : action === "start" ? "启动" : "停止";
    if (instanceId === "—") return;
    const key = `${server.account_id}:${server.asset_key}`;
    setActiveAction(key);
    setNotice("");
    try {
      const payload = { id: server.account_id, regionId: server.region_id || account.region_id || "", instanceId, action, forceStop: action === "reboot" && forceStop };
      if (server.resource_type === "swas") await serversClient.swasAction(payload);
      else if (account.cloud_type === "aliyun") await serversClient.aliyunAction(payload);
      else await serversClient.providerAction("tencent", payload);
      setNotice(`已提交${actionLabel}请求，云厂商状态可能需要片刻更新`);
      await refreshServers(undefined, true);
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
    if (!await confirm({ message: `确认从这台设备删除“${account.account_name}”及其本地加密凭据和缓存吗？此操作不会注销云厂商账号。` })) return;
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
      if (!await confirm({ message: `准备导入 ${rows.length} 个云账号。此 JSON 含明文凭据；确认后凭据会写入本机加密数据库。请确保你信任该文件来源。继续导入？` })) return;
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

  function openSshHostForm(host: ManagedHost | null = null) {
    setEditingSshHost(host);
    setNewSshAuthMethod(host?.auth_method === "private_key" ? "private_key" : "password");
    setShowAddSshHost(true);
  }

  async function addManagedHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sshHostSaving) return;
    const element = event.currentTarget;
    const form = new FormData(element);
    const hostAddress = String(form.get("host") || "").trim();
    const hostName = String(form.get("name") || "").trim() || hostAddress;
    const port = Number(form.get("port") || 22);
    if (!hostAddress || !Number.isInteger(port) || port < 1 || port > 65535) { setNotice("请填写有效主机地址和 1–65535 端口"); return; }
    const password = String(form.get("password") || "");
    const privateKey = String(form.get("privateKey") || "");
    if (newSshAuthMethod === "password" && !password.trim() && !editingSshHost?.password_saved) { setNotice("请输入 SSH 密码"); return; }
    if (newSshAuthMethod === "private_key" && !privateKey.trim() && !editingSshHost?.private_key_saved) { setNotice("请粘贴 SSH 私钥"); return; }
    setSshHostSaving(true);
    try {
      await serversClient.saveManaged({
        id: editingSshHost?.id,
        name: hostName, host: hostAddress, port, username: String(form.get("username") || "root").trim(),
        platform: editingSshHost?.platform === "windows" ? "windows" : "linux", auth_method: newSshAuthMethod, password, private_key: privateKey,
        key_passphrase: String(form.get("keyPassphrase") || "") || undefined,
        group_name: editingSshHost?.group_name ?? "mobile", tags: editingSshHost?.tags ?? "",
        source_account_id: editingSshHost?.source_account_id, source_asset_key: editingSshHost?.source_asset_key,
        remark: editingSshHost?.remark ?? "由手机端添加",
      });
      element.reset(); setShowAddSshHost(false); setEditingSshHost(null); setNewSshAuthMethod("password");
      await refreshManagedHosts(); setNotice("托管主机已加密保存在本机");
    } catch (error) { setNotice(error instanceof Error ? error.message : "保存 SSH 主机失败"); }
    finally { setSshHostSaving(false); }
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
    : tab === "home" ? async () => { await Promise.all([refreshAccounts(), refreshMobileAssets(), monitorRefreshRef.current?.()]); }
      : tab === "monitorAlerts" ? monitorRefreshRef.current
      : tab === "more" ? async () => { await Promise.all([refreshMobileAssets(), refreshServers(), refreshManagedHosts(), refreshPanelConnections()]); }
      : tab === "accounts" ? refreshAccounts
      : tab === "assets" || tab === "favorites" ? refreshMobileAssets
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

  const accountFilteredServers = servers.filter((server) => productDialog ? server.account_id === productDialog.account.id && server.resource_type === productDialog.type : serverAccountFilterIds.length === 0 || serverAccountFilterIds.includes(server.account_id));
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
  const visibleServers = filteredServers.filter((server) => productDialog || serverKind === "all" || server.resource_type === serverKind).sort((left, right) => {
    const leftName = payloadText(left.payload, ["instanceName", "InstanceName", "name", "Name", "serverName"]);
    const rightName = payloadText(right.payload, ["instanceName", "InstanceName", "name", "Name", "serverName"]);
    const order = leftName.localeCompare(rightName, "zh-CN", { numeric: true, sensitivity: "base" });
    return serverSortAscending ? order : -order;
  });
  const serverPageCount = Math.max(1, Math.ceil(visibleServers.length / resourceListPageSize));
  const safeServerPage = Math.min(resourceListPage, serverPageCount);
  const pagedVisibleServers = visibleServers.slice((safeServerPage - 1) * resourceListPageSize, safeServerPage * resourceListPageSize);
  const standardServerCount = filteredServers.filter((server) => server.resource_type === "ecs").length;
  const lightServerCount = filteredServers.filter((server) => server.resource_type === "swas").length;
  const runningServerCount = filteredServers.filter((server) => serverStatusClass(server.payload).includes("is-running")).length;
  const serverAccountFilterAll = accounts.length > 0 && serverAccountFilterIds.length === accounts.length;
  const serverAccountFilterLabel = serverAccountFilterIds.length === 0 ? "全部账号" : serverAccountFilterIds.length === 1 ? accounts.find((account) => account.id === serverAccountFilterIds[0])?.account_name || "已选 1 个账号" : `已选 ${serverAccountFilterIds.length} 个账号`;
  const filteredDomains = domains.filter((domain) => {
    if (productDialog ? domain.account_id !== productDialog.account.id : assetAccountFilterId !== null && domain.account_id !== assetAccountFilterId) return false;
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
  const domainPageCount = Math.max(1, Math.ceil(filteredDomains.length / resourceListPageSize));
  const safeDomainPage = Math.min(resourceListPage, domainPageCount);
  const pagedDomains = filteredDomains.slice((safeDomainPage - 1) * resourceListPageSize, safeDomainPage * resourceListPageSize);
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
  const visibleMobileAssetRows = mobileAssetRows.filter((asset) =>
    (!mobileAssetTypeFilter || asset.resource_type === mobileAssetTypeFilter)
    && (mobileAssetAccountFilter === null || asset.account_id === mobileAssetAccountFilter)
    && (!mobileAssetSearch.trim() || `${assetSearchText(asset)} ${resourceLabels[asset.resource_type as keyof typeof resourceLabels] ?? asset.resource_type}`.toLocaleLowerCase().includes(mobileAssetSearch.trim().toLocaleLowerCase()))
  ).sort((left, right) => right.fetched_at - left.fetched_at);
  const favoriteMobileAssetRows = visibleMobileAssetRows.filter((asset) => mobileFavoriteKeys.includes(assetFavoriteKey(asset)));
  const mobileAssetPageRows = tab === "favorites" ? favoriteMobileAssetRows : visibleMobileAssetRows;
  const mobileAssetPageCount = Math.max(1, Math.ceil(mobileAssetPageRows.length / mobileAssetPageSize));
  const safeMobileAssetPage = Math.min(mobileAssetPage, mobileAssetPageCount);
  const pagedMobileAssetRows = mobileAssetPageRows.slice((safeMobileAssetPage - 1) * mobileAssetPageSize, safeMobileAssetPage * mobileAssetPageSize);
  useEffect(() => { setMobileAssetPage(1); }, [tab, mobileAssetSearch, mobileAssetTypeFilter, mobileAssetAccountFilter, mobileFavoriteKeys]);
  const mobileAssetTypeCounts = assetTypes.map(([type, label]) => ({ type, label, count: mobileAssetRows.filter((asset) => asset.resource_type === type).length }));
  const toggleMobileAssetFavorite = (asset: LocalAsset) => {
    const key = assetFavoriteKey(asset);
    setMobileFavoriteKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  };
  const openMobileAssetOperations = (asset: LocalAsset) => {
    const owner = accountForAsset(asset);
    if (owner?.cloud_type === "cloudflare") { setCloudflareTarget({ account: owner, kind: asset.resource_type }); return; }
    setSelectedAccountId(asset.account_id);
    setAssetAccountFilterId(asset.account_id);
    setMobileAssetSearch("");
    if (asset.resource_type === "ecs" || asset.resource_type === "swas") {
      setServerAccountFilterIds([asset.account_id]);
      setServerSearch(asset.asset_key);
      setTab("servers");
    } else if (asset.resource_type === "domain") {
      setDomainSearch(asset.asset_key);
      setTab("domains");
    } else if (asset.resource_type === "oss") {
      setResourceSearch((current) => ({ ...current, storage: asset.asset_key }));
      setTab("storage");
    } else if (asset.resource_type === "rds") {
      setResourceSearch((current) => ({ ...current, databases: asset.asset_key }));
      setTab("databases");
    } else if (asset.resource_type === "redis") {
      setResourceSearch((current) => ({ ...current, redis: asset.asset_key }));
      setTab("redis");
    } else if (asset.resource_type === "certificate") {
      sectionOriginRef.current = null;
      setTab("certificates");
    } else if (asset.resource_type.toLowerCase() === "esa") {
      const owner = accountForAsset(asset);
      const consoleUrl = owner?.cloud_type === "tencent"
        ? "https://console.cloud.tencent.com/edgeone"
        : owner?.cloud_type === "volcengine"
          ? "https://console.volcengine.com/cdn/"
          : "https://esa.console.aliyun.com/";
      const consoleName = owner?.cloud_type === "tencent" ? "腾讯云 EdgeOne" : owner?.cloud_type === "volcengine" ? "火山引擎 CDN" : "阿里云 ESA";
      if (runningInTauri) void openUrl(consoleUrl).then(() => setNotice(`已打开${consoleName}控制台`)).catch((error) => setNotice(error instanceof Error ? error.message : "打开云厂商控制台失败"));
      else {
        window.open(consoleUrl, "_blank", "noopener,noreferrer");
        setNotice(`已请求打开${consoleName} 控制台；若未打开，请允许浏览器弹出窗口`);
      }
    } else {
      setNotice("桌面端暂未为该类型提供专用操作，可在对应云厂商控制台管理");
    }
  };
  const accountAssets = (rows: LocalAsset[]) => rows.filter((asset) => productDialog ? asset.account_id === productDialog.account.id : assetAccountFilterId === null || asset.account_id === assetAccountFilterId);
  const filteredBuckets = filterNamed("storage", accountAssets(buckets), assetName, assetSearchText);
  const filteredDatabaseAssets = filterNamed("databases", accountAssets(databaseAssets), assetName, assetSearchText);
  const filteredRedisAssets = filterNamed("redis", accountAssets(redisAssets), assetName, assetSearchText);
  const safeResourceListPage = (total: number) => Math.min(resourceListPage, Math.max(1, Math.ceil(total / resourceListPageSize)));
  const pagedBuckets = filteredBuckets.slice((safeResourceListPage(filteredBuckets.length) - 1) * resourceListPageSize, safeResourceListPage(filteredBuckets.length) * resourceListPageSize);
  const pagedDatabaseAssets = filteredDatabaseAssets.slice((safeResourceListPage(filteredDatabaseAssets.length) - 1) * resourceListPageSize, safeResourceListPage(filteredDatabaseAssets.length) * resourceListPageSize);
  const pagedRedisAssets = filteredRedisAssets.slice((safeResourceListPage(filteredRedisAssets.length) - 1) * resourceListPageSize, safeResourceListPage(filteredRedisAssets.length) * resourceListPageSize);
  useEffect(() => { setResourceListPage(1); }, [tab, serverSearch, serverKind, serverSortAscending, domainSearch, assetAccountFilterId, assetName, assetSearchText, resourceSearch, resourceStatus, servers, domains, buckets, databaseAssets, redisAssets]);
  const sshGroups = [...new Set(managedHosts.map((host) => host.group_name?.trim() || "未分组"))].sort((left, right) => left.localeCompare(right, "zh-CN"));
  const filteredHosts = filterNamed("ssh", managedHosts.filter((host) => (!resourceStatus.ssh || host.status === resourceStatus.ssh) && (!sshGroupFilter || (host.group_name?.trim() || "未分组") === sshGroupFilter)), (host) => host.name, (host) => [host.name, host.host, host.username, host.platform, host.status, host.group_name].join(" "));
  const sshListPageCount = Math.max(1, Math.ceil(filteredHosts.length / sshListPageSize));
  const safeSshListPage = Math.min(sshListPage, sshListPageCount);
  const pagedHosts = filteredHosts.slice((safeSshListPage - 1) * sshListPageSize, safeSshListPage * sshListPageSize);
  useEffect(() => { setSshListPage(1); }, [resourceSearch.ssh, resourceStatus.ssh, sshGroupFilter, managedHosts]);
  const panelGroups = [...new Set(panelConnections.map((panel) => panel.group_name || "未分组"))].sort((left, right) => left.localeCompare(right));
  const filteredPanels = filterNamed("panels", panelConnections.filter((panel) => (!resourceStatus.panels || panel.status === resourceStatus.panels) && (!panelGroupFilter || (panel.group_name || "未分组") === panelGroupFilter)), (panel) => panel.name, (panel) => [panel.name, panel.panel_url, panel.group_name, panel.status].join(" "));
  const panelListPageCount = Math.max(1, Math.ceil(filteredPanels.length / panelListPageSize));
  const safePanelListPage = Math.min(panelListPage, panelListPageCount);
  const pagedPanels = filteredPanels.slice((safePanelListPage - 1) * panelListPageSize, safePanelListPage * panelListPageSize);
  useEffect(() => { setPanelListPage(1); }, [resourceSearch.panels, resourceStatus.panels, panelGroupFilter, panelConnections]);
  const operationLogRows = operationLogAssets.flatMap((asset) => {
    const account = accountForAsset(asset);
    return account && asset.fetched_at > operationLogClearedAt ? [{ asset, account }] : [];
  }).sort((left, right) => right.asset.fetched_at - left.asset.fetched_at);
  const filteredOperationLogs = filterNamed("operationLogs", operationLogRows.filter((row) => assetAccountFilterId === null || row.account.id === assetAccountFilterId), (row) => row.asset.asset_key, (row) => [row.asset.asset_key, row.account.account_name, resourceLabels[row.asset.resource_type as keyof typeof resourceLabels]].join(" "));
  const filteredApiLogs = filterNamed("apiLogs", apiLogs.filter((log) => !resourceStatus.apiLogs || log.status === resourceStatus.apiLogs), (log) => log.action, (log) => [log.action, log.endpoint, log.account_name, log.status].join(" "));
  const pagedOperationLogs = filteredOperationLogs.slice((safeResourceListPage(filteredOperationLogs.length) - 1) * resourceListPageSize, safeResourceListPage(filteredOperationLogs.length) * resourceListPageSize);
  const pagedApiLogs = filteredApiLogs.slice((safeResourceListPage(filteredApiLogs.length) - 1) * resourceListPageSize, safeResourceListPage(filteredApiLogs.length) * resourceListPageSize);
  const resourceConfigs = {
    storage: { title: "对象存储", description: "管理多云存储桶，浏览文件与目录", icon: Folder, count: filteredBuckets.length, unit: "存储桶", second: linkedResourceAccountCount(filteredBuckets), secondLabel: "关联账号", accounts: true },
    databases: { title: "云数据库", description: "查看数据库实例，管理多云数据资源", icon: Database, count: filteredDatabaseAssets.length, unit: "数据库实例", second: linkedResourceAccountCount(filteredDatabaseAssets), secondLabel: "关联账号", accounts: true },
    redis: { title: "Redis", description: "查看缓存实例与账号，掌握资源状态", icon: Database, count: filteredRedisAssets.length, unit: "Redis 实例", second: linkedResourceAccountCount(filteredRedisAssets), secondLabel: "关联账号", accounts: true },
    certificates: { title: "证书管理", description: "查看域名证书、签发状态与有效期", icon: Award, count: certificates.length, unit: "证书", second: certificates.filter((item) => item.notAfter && item.notAfter * 1000 > Date.now() && item.notAfter * 1000 <= Date.now() + 30 * 86400000).length, secondLabel: "即将到期", accounts: false },
    ssh: { title: "SSH 终端", description: "管理本机托管主机，安全连接远程终端", icon: Terminal, count: filteredHosts.length, unit: "托管主机", second: filteredHosts.filter((host) => host.password_saved || host.private_key_saved).length, secondLabel: "已存凭据", accounts: false },
    panels: { title: "运维面板", description: "统一管理已保存的面板与连接状态", icon: Monitor, count: filteredPanels.length, unit: "运维面板", second: filteredPanels.filter((panel) => panel.status === "online").length, secondLabel: "在线面板", accounts: false },
    operationLogs: { title: "操作日志", description: "查看本机资源管理记录，追踪操作历史", icon: FileText, count: filteredOperationLogs.length, unit: "操作记录", second: new Set(filteredOperationLogs.map((row) => row.account.id)).size, secondLabel: "关联账号", accounts: true },
    apiLogs: { title: "API 日志", description: "查看接口调用记录与执行状态", icon: Terminal, count: filteredApiLogs.length, unit: "调用记录", second: filteredApiLogs.filter((log) => log.status === "成功").length, secondLabel: "成功调用", accounts: false },
  };
  const resourceConfig = tab in resourceConfigs ? resourceConfigs[tab as keyof typeof resourceConfigs] : null;
  const statusOptions = [...new Set((tab === "ssh" ? managedHosts : tab === "panels" ? panelConnections : tab === "apiLogs" ? apiLogs : []).map((row) => row.status).filter(Boolean))];
  const statusFilter = statusOptions.length ? <select aria-label="按状态筛选" value={resourceStatus[tab] ?? ""} onChange={(event) => { const value = event.currentTarget.value; setResourceStatus((current) => ({ ...current, [tab]: value })); }}><option value="">全部状态</option>{statusOptions.map((status) => <option value={status} key={status}>{status === "online" ? "在线" : status === "offline" ? "离线" : status === "unknown" ? "未检查" : status}</option>)}</select> : undefined;
  const panelGroupCounts = new Map<string, number>();
  for (const panel of panelConnections) { const group = panel.group_name || "未分组"; panelGroupCounts.set(group, (panelGroupCounts.get(group) || 0) + 1); }
  const panelFilters = <span className="mobile-panel-filter-options">{statusFilter}<select aria-label="按分组筛选面板" value={panelGroupFilter} onChange={(event) => setPanelGroupFilter(event.currentTarget.value)}><option value="">全部分组（{panelConnections.length}）</option>{panelGroups.map((group) => <option key={group} value={group}>{group}（{panelGroupCounts.get(group) || 0}）</option>)}</select></span>;
  const sshFilters = <span className="mobile-panel-filter-options">{statusFilter}<select aria-label="按分组筛选 SSH 主机" value={sshGroupFilter} onChange={(event) => setSshGroupFilter(event.currentTarget.value)}><option value="">全部分组</option>{sshGroups.map((group) => <option key={group} value={group}>{group}</option>)}</select></span>;
  const resourcePageOverview = resourceConfig && <MobileResourceOverview inlineActions={tab === "ssh" || tab === "panels"} filterLayout={tab === "ssh" || tab === "panels" ? "stacked" : undefined} title={resourceConfig.title} description={resourceConfig.description} icon={resourceConfig.icon} count={resourceConfig.count} countLabel={resourceConfig.unit} secondaryCount={resourceConfig.second} secondaryLabel={resourceConfig.secondLabel} search={resourceSearch[tab] ?? ""} onSearch={(value) => setResourceSearch((current) => ({ ...current, [tab]: value }))} ascending={resourceAscending[tab] !== false} onSort={() => setResourceAscending((current) => ({ ...current, [tab]: current[tab] === false }))} filter={resourceConfig.accounts ? <select aria-label={`按账号筛选${resourceConfig.title}`} value={assetAccountFilterId ?? ""} onChange={(event) => setAssetAccountFilterId(event.currentTarget.value ? Number(event.currentTarget.value) : null)}><option value="">全部账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.account_name}</option>)}</select> : tab === "panels" ? panelFilters : tab === "ssh" ? sshFilters : statusFilter} actions={tab === "ssh" ? <button type="button" className="mobile-primary" onClick={() => openSshHostForm()}><Plus size={17} />添加主机</button> : tab === "panels" ? <button type="button" className="mobile-primary" onClick={addPanel}><Plus size={17} />添加面板</button> : tab === "operationLogs" || tab === "apiLogs" ? <button type="button" className="mobile-icon-button" aria-label="清空日志" title="清空日志" disabled={operationLogsLoading || apiLogsLoading} onClick={() => void clearMobileLogs(tab === "operationLogs" ? "operation" : "api")}><Trash2 size={18} /></button> : undefined} />;
  const cloudPullAction = tab === "servers" ? syncServers : tab === "domains" && !selectedDomain ? refreshDomainsFromCloud : tab === "storage" && !selectedBucket ? refreshBucketsFromCloud : tab === "databases" && !selectedDatabase ? refreshDatabasesFromCloud : tab === "redis" && !selectedRedis ? refreshRedisFromCloud : null;
  function linkedResourceAccountCount(assets: LocalAsset[]) { return new Set(assets.filter((asset) => accountForAsset(asset)).map((asset) => asset.account_id)).size; }
  const unknownDomains = domains.filter((domain) => accountForAsset(domain) === null);
  const unknownBuckets = buckets.filter((bucket) => accountForAsset(bucket) === null);
  const unknownDatabases = databaseAssets.filter((instance) => accountForAsset(instance) === null);
  const unknownRedisInstances = redisAssets.filter((instance) => accountForAsset(instance) === null);

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
  const accountPageCount = Math.max(1, Math.ceil(filteredAccounts.length / accountPageSize));
  const safeAccountPage = Math.min(accountListPage, accountPageCount);
  const pagedAccounts = filteredAccounts.slice((safeAccountPage - 1) * accountPageSize, safeAccountPage * accountPageSize);
  useEffect(() => { setAccountListPage(1); }, [accountSearch, accountProviderFilter, accountSortAscending]);

  const isSubPageTab = tab !== "more" && tab !== "home";
  const settingsPageOpen = settingsReturnToMenuRef.current && tab !== "more" && tab !== "settingsMenu";
  const settingsPageTitle: Partial<Record<MobileTab, string>> = {
    settings: "通用",
    networkSettings: "网络与代理",
    sync: "数据导入与迁移",
    authenticator: "身份验证器",
    operationLogs: "操作日志",
    apiLogs: "API 日志",
    about: "关于",
    personalProfile: "个人资料",
  };
  const backAction = (() => {
    if (tab === "settingsMenu") return null;
    if (tab === "monitorAlerts" || tab === "softwareStore") return { label: "返回首页", onClick: () => setTab("home") };
    if (tab === "favorites") return { label: "返回我的资产", onClick: () => setTab("assets") };
    if (settingsPageOpen) return { label: "返回设置", onClick: returnToSettingsMenu };
    if (tab === "domains" && selectedDomain) return { label: "返回域名列表", onClick: () => { setSelectedDomain(null); setDnsRecords([]); } };
    if (tab === "storage" && selectedBucket) return {
      label: objectPrefix ? "返回上一级目录" : "返回存储桶列表",
      onClick: () => {
        if (objectPrefix) {
          const parts = objectPrefix.replace(/\/$/, "").split("/");
          parts.pop();
          void browseBucket(selectedBucket, parts.length ? `${parts.join("/")}/` : "");
        } else { setSelectedBucket(null); setObjectListing(null); }
      },
    };
    if (tab === "databases" && selectedDatabase) return { label: "返回实例列表", onClick: () => { setSelectedDatabase(null); setDatabaseDetails([]); } };
    if (tab === "redis" && selectedRedis) return { label: "返回实例列表", onClick: () => { setSelectedRedis(null); setRedisAccounts([]); } };
    if (tab === "networkSettings" || tab === "sync") return { label: "返回系统设置", onClick: () => setTab("settings") };
    // 云效流水线/HTTPS 证书/身份验证器从商店或首页进入时，返回来源页而不是固定回“我的”。
    if ((tab === "flow" || tab === "certificates" || tab === "authenticator") && sectionOriginRef.current) {
      const origin = sectionOriginRef.current;
      return { label: origin === "softwareStore" ? "返回软件商店" : "返回首页", onClick: () => setTab(origin) };
    }
    if (isSubPageTab) return { label: "返回我的", onClick: () => setTab("more") };
    return null;
  })();
  const isBottomNavigationTab = tab === "home" || tab === "monitorAlerts" || tab === "softwareStore" || tab === "more";

  const [backFabPos, setBackFabPos] = useState<{ right: number; bottom: number } | null>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(cloudHubBackFabPositionStorageKey) || "null");
      return typeof parsed?.right === "number" && typeof parsed?.bottom === "number" ? parsed : null;
    } catch { return null; }
  });
  const backFabPosRef = useRef(backFabPos);
  const backFabDragRef = useRef<{ pointerId: number; startX: number; startY: number; grabOffsetX: number; grabOffsetY: number; dragging: boolean } | null>(null);
  const suppressBackFabClickRef = useRef(false);
  const startBackFabDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0 || backFabDragRef.current) return;
    const button = event.currentTarget;
    const buttonRect = button.getBoundingClientRect();
    backFabDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabOffsetX: event.clientX - buttonRect.left,
      grabOffsetY: event.clientY - buttonRect.top,
      dragging: false,
    };
    suppressBackFabClickRef.current = false;
    try { button.setPointerCapture(event.pointerId); } catch { /* 指针可能已释放 */ }
  };
  const dragBackFab = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = backFabDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 6) {
      drag.dragging = true;
      suppressBackFabClickRef.current = true;
      event.currentTarget.classList.add("is-dragging");
    }
    if (!drag.dragging) return;
    const shellRect = event.currentTarget.closest(".mobile-shell")?.getBoundingClientRect();
    if (!shellRect) return;
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const left = Math.min(Math.max(event.clientX - drag.grabOffsetX - shellRect.left, 8), shellRect.width - buttonRect.width - 8);
    const top = Math.min(Math.max(event.clientY - drag.grabOffsetY - shellRect.top, 8), shellRect.height - buttonRect.height - 8);
    const pos = { right: Math.round(shellRect.width - buttonRect.width - left), bottom: Math.round(shellRect.height - buttonRect.height - top) };
    backFabPosRef.current = pos;
    setBackFabPos(pos);
  };
  const endBackFabDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = backFabDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    backFabDragRef.current = null;
    event.currentTarget.classList.remove("is-dragging");
    if (drag.dragging && !cancelled) {
      try { localStorage.setItem(cloudHubBackFabPositionStorageKey, JSON.stringify(backFabPosRef.current)); } catch { /* 存储不可用时仅本次会话生效 */ }
    } else if (cancelled) {
      suppressBackFabClickRef.current = false;
    }
  };
  const clickBackFab = () => {
    if (suppressBackFabClickRef.current) { suppressBackFabClickRef.current = false; return; }
    if (!backAction) return;
    backAction.onClick();
  };
  const moveBackFabByKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (!direction) return;
    const shell = event.currentTarget.closest(".mobile-shell");
    if (!shell) return;
    event.preventDefault();
    const shellRect = shell.getBoundingClientRect();
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const step = event.shiftKey ? 24 : 8;
    const left = Math.min(Math.max(buttonRect.left - shellRect.left + direction[0] * step, 8), shellRect.width - buttonRect.width - 8);
    const top = Math.min(Math.max(buttonRect.top - shellRect.top + direction[1] * step, 8), shellRect.height - buttonRect.height - 8);
    const pos = { right: Math.round(shellRect.width - buttonRect.width - left), bottom: Math.round(shellRect.height - buttonRect.height - top) };
    backFabPosRef.current = pos;
    setBackFabPos(pos);
    try { localStorage.setItem(cloudHubBackFabPositionStorageKey, JSON.stringify(pos)); } catch { /* 存储不可用时仅本次会话生效 */ }
  };

  const accountPage = <>
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
            {filteredAccounts.length > 0 && <p className="mobile-account-swipe-hint">点击账号卡片右侧的更多按钮，可获取资产、编辑或删除</p>}
          </>}
          {loading && accounts.length === 0 ? <MobileLoadingSkeleton variant="list" label="正在读取云账号" /> : accounts.length === 0 ? <div className="mobile-empty"><Cloud size={30} /><strong>还没有云账号</strong><span>添加账号后，手机可以独立查询云资源。</span><button className="mobile-primary" type="button" onClick={openAddAccount}><Plus size={17} />添加云账号</button></div> : filteredAccounts.length === 0 ? <div className="mobile-empty"><Search size={30} /><strong>没有匹配的云账号</strong><span>试试其他关键词或选择全部云厂商。</span><button className="mobile-primary" type="button" onClick={() => { setAccountSearch(""); setAccountProviderFilter(""); }}>清除筛选</button></div> : <><div className="mobile-account-list">{pagedAccounts.map((account) => {
            const canSync = syncAssetTypes(account).length > 0;
            const productStats = Object.entries(accountProductCounts[account.id] ?? {}).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            return <MobileAccountSwipeCard key={account.id} label={account.account_name} details={
              <details className="mobile-account-product-details">
                <summary aria-label={`${account.account_name} 产品详情`}>产品详情{productStats.length > 0 && <span>（{productStats.length} 项）</span>}</summary>
                {productStats.length > 0 ? <dl aria-label={`${account.account_name} 全部产品统计`}>{productStats.map(([type, count]) => <div key={type}><dt><button type="button" aria-haspopup="dialog" aria-label={`${(resourceLabels[type as keyof typeof resourceLabels] || type)}（${count}）`} onClick={() => openAccountProduct(account, type)}>{(resourceLabels[type as keyof typeof resourceLabels] || type)}</button></dt><dd>{count}</dd></div>)}</dl> : <p>暂无缓存产品，请通过“获取资产”同步。</p>}
              </details>
            }>
              <div className="mobile-account-select">
                <span className="mobile-provider-avatar" data-provider={account.cloud_type}>{<MobileProviderMark cloudType={account.cloud_type} />}</span>
                <span className="mobile-account-copy"><strong>{account.account_name}</strong><small>{cloudProvider(account.cloud_type).label} · {account.region_id || "默认地域"}</small>{syncingAccountId === account.id && <small className="mobile-account-sync-progress" role="status" aria-live="polite">正在获取{accountSyncProgress ? ` · ${accountSyncProgress.completed}/${accountSyncProgress.total}${accountSyncProgress.resourceType ? ` · ${resourceLabels[accountSyncProgress.resourceType as keyof typeof resourceLabels] ?? accountSyncProgress.resourceType}` : ""}` : "资产…"}</small>}</span>
                {productStats.length > 0 && <span className="mobile-account-products" role="group" aria-label={`${account.account_name} 产品统计`}>{productStats.slice(0, 3).map(([type, count]) => <button type="button" aria-haspopup="dialog" className="mobile-account-product" key={type} onClick={() => openAccountProduct(account, type)}><span>{(resourceLabels[type as keyof typeof resourceLabels] || type)}</span><strong>{count}</strong></button>)}</span>}
              </div>
              <div className="mobile-account-swipe-actions" role="group" aria-label={`${account.account_name} 操作`}>
                <button type="button" className="mobile-account-fetch" aria-label={syncingAccountId === account.id ? `正在获取 ${account.account_name} 资产` : `获取 ${account.account_name} 资产`} title={canSync ? "获取并保存此账号已接入的全部资产" : "此云厂商暂未接入资产同步"} disabled={!canSync || syncing} onClick={() => void syncAccountAssets(account)}>{syncingAccountId === account.id ? <RefreshCw size={17} className="mobile-spin" /> : <ArrowDownToLine size={17} />}<span>{syncingAccountId === account.id ? "获取中" : "获取资产"}</span></button>
                <button type="button" className="mobile-account-edit" aria-label={`编辑本机账号 ${account.account_name}`} title="编辑账号配置" onClick={() => openEditAccount(account)}><Pencil size={17} /><span>编辑</span></button>
                <button type="button" className="mobile-account-delete" aria-label={`删除本机账号 ${account.account_name}`} title="删除此设备上的账号和数据" disabled={removingAccountId !== null} onClick={() => void removeAccount(account)}>{removingAccountId === account.id ? <RefreshCw size={17} className="mobile-spin" /> : <Trash2 size={17} />}<span>删除</span></button>
              </div>
            </MobileAccountSwipeCard>;
          })}</div><PaginationBar className="store-pagination" page={safeAccountPage} pageSize={accountPageSize} total={filteredAccounts.length} onPageChange={setAccountListPage} onPageSizeChange={(size) => { setAccountPageSize(size); setAccountListPage(1); }} /></>}
        </>;

  const renderSettingsMenuContent = () => <div className="mobile-settings-menu-content">
    <div className="mobile-settings-profile">
      <span className={`mobile-settings-profile-avatar${member ? "" : " is-guest"}${member?.is_vip ? " is-vip" : ""}`}><MemberAvatar member={member} size={member ? 52 : 36} /></span>
      <span className="mobile-settings-profile-copy">
        <span className="mobile-settings-profile-identity">
          <span className="mobile-profile-account-line">
            <button type="button" className="mobile-settings-profile-name" onClick={() => {
              if (!member) { openSettingsTab("member"); return; }
              settingsReturnToMenuRef.current = true;
              setSettingsDrawerDirection("forward");
              setTab("personalProfile");
            }}>
              {member ? (member.nickname?.trim() && member.nickname.trim() !== "匿名用户" ? member.nickname.trim() : member.email) : "登录 / 注册"}
            </button>
            {member?.nickname?.trim() && member.nickname.trim() !== "匿名用户" && <small>{member.email}</small>}
          </span>
          <MemberIdentityBadges member={member} className="mobile-member-status-badges" onSelect={setActiveMemberIdentity} />
        </span>
        {member && <small className="mobile-settings-profile-joined">注册日期：{member.created_at.slice(0, 10)}</small>}
      </span>
    </div>
    <section className="mobile-settings-group" aria-label="通用设置">
      <button type="button" onClick={() => openSettingsTab("settings")}><span>通用设置</span><ChevronRight size={18} aria-hidden="true" /></button>
      <button type="button" onClick={() => openSettingsTab("networkSettings")}><span>网络与代理</span><ChevronRight size={18} aria-hidden="true" /></button>
    </section>
    <section className="mobile-settings-group" aria-label="数据与工具">
      <button type="button" onClick={() => openSettingsTab("sync")}><span>数据导入与迁移</span><ChevronRight size={18} aria-hidden="true" /></button>
    </section>
    <section className="mobile-settings-group" aria-label="关于与支持">
      <button type="button" onClick={() => openSettingsTab("about")}><span>更新与关于</span><ChevronRight size={18} aria-hidden="true" /></button>
    </section>
    <p className="mobile-settings-version">云枢工具箱 · v{packageJson.version}</p>
  </div>;

  const resourcePage = tab === "settingsMenu" ? renderSettingsMenuContent() : tab === "assets" || tab === "favorites" ? <>
          <div className="mobile-page-title mobile-assets-title"><div><p>本机 SQLite · 不实时请求云端</p><h1>{tab === "favorites" ? "我的收藏" : "我的资产"}</h1></div><span>{(tab === "favorites" ? favoriteMobileAssetRows : mobileAssetRows).length} 项 <ChevronRight size={17} aria-hidden="true" /></span></div>
          <div className="mobile-assets-page-switch" role="tablist" aria-label="资产视图"><button type="button" role="tab" aria-selected={tab === "assets"} className={tab === "assets" ? "is-active" : ""} onClick={() => setTab("assets")}>全部资产</button><button type="button" role="tab" aria-selected={tab === "favorites"} className={tab === "favorites" ? "is-active" : ""} onClick={() => setTab("favorites")}>我的收藏 <span>{mobileFavoriteKeys.length}</span></button></div>
          {tab === "assets" && <>
          <div className="mobile-assets-summary"><div><HardDrive size={19} aria-hidden="true" /><strong>{mobileAssetRows.length}</strong><span>本机资产</span></div><div><Cloud size={19} aria-hidden="true" /><strong>{new Set(mobileAssetRows.map((asset) => asset.account_id)).size}</strong><span>关联账号</span></div></div>
          </>}
          <div className="mobile-assets-filters"><label className="mobile-account-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索资产名称、ID 或账号" value={mobileAssetSearch} onChange={(event) => setMobileAssetSearch(event.currentTarget.value)} placeholder="搜索资产名称 / ID / 账号…" /></label>{mobileAssetFiltersOpen && <><label className="mobile-account-provider-filter mobile-assets-filter-row"><Filter size={18} aria-hidden="true" /><select aria-label="筛选资产类型" value={mobileAssetTypeFilter} onChange={(event) => setMobileAssetTypeFilter(event.currentTarget.value)}><option value="">全部类型</option>{mobileAssetTypeCounts.filter((item) => item.count > 0).map((item) => <option key={item.type} value={item.type}>{item.label}（{item.count}）</option>)}</select><ChevronRight size={18} aria-hidden="true" /></label><label className="mobile-account-provider-filter mobile-assets-filter-row"><Cloud size={18} aria-hidden="true" /><select aria-label="筛选云账号" value={mobileAssetAccountFilter ?? ""} onChange={(event) => setMobileAssetAccountFilter(event.currentTarget.value ? Number(event.currentTarget.value) : null)}><option value="">全部账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.account_name}</option>)}</select><ChevronRight size={18} aria-hidden="true" /></label></>}</div>
          <div className="mobile-asset-list-heading"><h2>{tab === "favorites" ? "收藏资产" : "资产列表"} <span>{mobileAssetPageRows.length}</span></h2><button type="button" className={`mobile-asset-filter-toggle${mobileAssetFiltersOpen ? " is-open" : ""}`} aria-label={mobileAssetFiltersOpen ? "收起筛选条件" : "展开筛选条件"} aria-expanded={mobileAssetFiltersOpen} onClick={() => setMobileAssetFiltersOpen((open) => !open)}><SlidersHorizontal size={18} aria-hidden="true" /></button></div>
          {mobileAssetsLoading && mobileAssetRows.length === 0 ? <MobileLoadingSkeleton variant="list" label="正在读取本机资产" /> : mobileAssetPageRows.length === 0 ? <div className="mobile-empty"><HardDrive size={28} /><strong>{tab === "favorites" ? "还没有收藏资产" : mobileAssetRows.length ? "没有匹配的资产" : "本机暂无已缓存资产"}</strong><span>{tab === "favorites" ? "在资产卡片上点亮星标后，会集中显示在这里。" : mobileAssetRows.length ? "试试其他关键词或筛选条件。" : "在账号页获取并保存云资源后，资产会汇总显示在这里。"}</span>{tab === "favorites" && <button type="button" className="mobile-primary" onClick={() => setTab("assets")}>去浏览资产</button>}{(mobileAssetSearch || mobileAssetTypeFilter || mobileAssetAccountFilter !== null) && <button type="button" className="mobile-primary" onClick={() => { setMobileAssetSearch(""); setMobileAssetTypeFilter(""); setMobileAssetAccountFilter(null); }}>清除筛选</button>}</div> : <><div className="mobile-asset-list">{pagedMobileAssetRows.map((asset) => {
            const owner = accountForAsset(asset);
            const typeLabel = assetTypes.find(([type]) => type === asset.resource_type)?.[1] ?? resourceLabels[asset.resource_type as keyof typeof resourceLabels] ?? asset.resource_type;
            const region = asset.region_id || payloadText(asset.payload, ["RegionId", "Location", "Region", "region"]);
            const status = payloadText(asset.payload, ["Status", "InstanceStatus", "DBInstanceStatus", "DomainStatus", "status"]);
            // 总览里的资产都已是本机缓存；识别不了的状态（如厂商枚举值）统一显示“已缓存”，不暴露裸枚举。
            const assetStatus = status === "—" ? "" : status.trim();
            const assetTone = assetStatusTone(assetStatus);
            const assetStatusLabel = assetTone === "pending" ? "已缓存" : assetStatus;
            const isFavorite = mobileFavoriteKeys.includes(assetFavoriteKey(asset));
            return <article className="mobile-asset-card" key={`${asset.account_id}:${asset.resource_type}:${asset.asset_key}`}><span className="mobile-provider-avatar" data-provider={owner?.cloud_type ?? "other"} aria-hidden="true">{owner ? <MobileProviderMark cloudType={owner.cloud_type} /> : <HardDrive size={18} />}</span><div className="mobile-asset-card-copy"><div className="mobile-asset-card-title"><span>{typeLabel}</span><strong title={assetName(asset)}>{assetName(asset)}</strong></div><small>{owner ? `${owner.account_name} · ${cloudProvider(owner.cloud_type).label}` : `未知账号 · ${asset.account_id}`}</small>{asset.asset_key !== assetName(asset) && <small className="mobile-asset-id">{asset.asset_key}</small>}<div className="mobile-asset-card-actions"><button type="button" className="mobile-asset-action" onClick={() => openMobileAssetOperations(asset)}>操作</button><button type="button" className={`mobile-asset-favorite${isFavorite ? " is-favorite" : ""}`} aria-label={isFavorite ? `取消收藏 ${assetName(asset)}` : `收藏 ${assetName(asset)}`} aria-pressed={isFavorite} onClick={() => toggleMobileAssetFavorite(asset)}><Star size={17} fill={isFavorite ? "currentColor" : "none"} aria-hidden="true" />{isFavorite ? "已收藏" : "收藏"}</button></div></div><div className="mobile-asset-card-meta"><span className={`mobile-server-status-pill is-${assetTone === "pending" ? "stopped" : assetTone}`}><i aria-hidden="true" />{assetStatusLabel}</span><small>{region === "—" ? "地域未知" : region}</small></div></article>;
          })}</div><PaginationBar className="store-pagination" page={safeMobileAssetPage} pageSize={mobileAssetPageSize} total={mobileAssetPageRows.length} onPageChange={setMobileAssetPage} onPageSizeChange={(size) => { setMobileAssetPageSize(size); setMobileAssetPage(1); }} /></>}
        </> : tab === "servers" ? <>
          <div className="mobile-page-title"><h1>云服务器</h1></div>
          <div className="mobile-server-overview"><div className="mobile-server-stats" aria-label="服务器统计"><div className="server-stat-total"><span className="mobile-account-stat-icon"><Server size={21} /></span><span className="mobile-account-stat-copy"><strong>{filteredServers.length}</strong><small>服务器</small></span></div><div className="server-stat-running"><span className="mobile-account-stat-icon"><Activity size={21} /></span><span className="mobile-account-stat-copy"><strong>{runningServerCount}</strong><small>运行中</small></span></div></div></div>
          <div className="mobile-security-note"><ShieldCheck size={18} /><span>云服务器数据保存在本机，账号凭据由加密数据库保护。</span></div>
          <div className="mobile-server-tabs" role="group" aria-label="筛选服务器类型">
            <button type="button" aria-pressed={serverKind === "all"} className={serverKind === "all" ? "active" : ""} onClick={() => setServerKind("all")}>全部 <span>({filteredServers.length})</span></button>
            <button type="button" aria-pressed={serverKind === "ecs"} className={serverKind === "ecs" ? "active" : ""} onClick={() => setServerKind("ecs")}>云服务器 <span>({standardServerCount})</span></button>
            <button type="button" aria-pressed={serverKind === "swas"} className={serverKind === "swas" ? "active" : ""} onClick={() => setServerKind("swas")}>轻量服务器 <span>({lightServerCount})</span></button>
          </div>
          {accounts.length > 0 && <div className="mobile-server-tools"><label className="mobile-account-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索云服务器" value={serverSearch} onChange={(event) => setServerSearch(event.currentTarget.value)} placeholder="搜索云厂商 / 服务器名称 / 地域…" /></label><button type="button" className={`mobile-account-filter-toggle${serverAccountFilterOpen ? " is-open" : ""}${serverAccountFilterIds.length ? " has-selection" : ""}`} aria-label="按云账号筛选服务器" aria-expanded={serverAccountFilterOpen} onClick={() => setServerAccountFilterOpen((open) => !open)}><Filter size={16} aria-hidden="true" /><span>{serverAccountFilterLabel}</span><ChevronDown size={15} aria-hidden="true" className="mobile-account-filter-chevron" /></button></div>}
          {accounts.length > 0 && serverAccountFilterOpen && <div className="mobile-account-filter-card"><label className="mobile-account-filter-head"><input ref={(element) => { if (element) element.indeterminate = serverAccountFilterIds.length > 0 && !serverAccountFilterAll; }} type="checkbox" aria-label="全选账号" checked={serverAccountFilterAll} onChange={() => setServerAccountFilterIds(serverAccountFilterAll ? [] : accounts.map((account) => account.id))} /><span>账号名称</span></label><div className="mobile-account-filter-list">{accounts.map((account) => <label key={account.id} className="mobile-account-filter-row"><input type="checkbox" aria-label={`筛选账号 ${account.account_name}`} checked={serverAccountFilterIds.includes(account.id)} onChange={() => setServerAccountFilterIds((ids) => ids.includes(account.id) ? ids.filter((id) => id !== account.id) : [...ids, account.id])} /><span className="mobile-provider-avatar" data-provider={account.cloud_type} aria-hidden="true">{<MobileProviderMark cloudType={account.cloud_type} />}</span><span className="mobile-account-filter-name">{account.account_name}</span></label>)}</div></div>}
          {accounts.length > 0 && unknownServers.length > 0 && <button type="button" className="mobile-clean-unknown" disabled={loading || syncing || cleaningUnknownResource !== null} onClick={() => void removeUnknownRecords("servers", "服务器", servers, (server) => accountForAsset(server) === null, (server) => `${server.account_id}:${server.resource_type}:${server.asset_key}`, resourcesClient.removeLocal, setServers)}>{cleaningUnknownResource === "servers" ? "正在移除…" : `移除未知账号服务器（${unknownServers.length}）`}</button>}
          <div className="mobile-server-list-heading"><h2>云服务器列表 <span>{visibleServers.length}</span></h2><button type="button" className="mobile-account-sort" aria-label={`按名称${serverSortAscending ? "升序" : "降序"}排列`} onClick={() => setServerSortAscending((ascending) => !ascending)}><ArrowUpDown size={16} />{serverSortAscending ? "按名称" : "名称倒序"}</button></div>
          {accounts.length === 0 ? <div className="mobile-empty"><Cloud size={30} /><strong>先添加云账号</strong><button type="button" className="mobile-primary" onClick={() => setTab("accounts")}>查看账号</button></div> : servers.length === 0 && (loading || syncing) ? <div className="mobile-empty" role="status"><RefreshCw size={30} className="mobile-spin" /><strong>{syncing ? "正在查询云端服务器" : "正在读取本机缓存"}</strong><span>正在查询云端资源，请稍候。</span></div> : visibleServers.length === 0 ? <div className="mobile-empty"><Server size={30} /><strong>{serverSearch ? "没有匹配的服务器" : `暂无${serverKind === "ecs" ? "普通" : serverKind === "swas" ? "轻量" : ""}服务器`}</strong><span>{serverSearch ? "试试其他关键词或清除搜索条件。" : filteredServers.length ? "切换上方标签查看另一类服务器。" : servers.length && serverAccountFilterIds.length > 0 ? "所选账号下暂无缓存服务器。" : "点击“拉取云端”同步已接入账号的服务器。"}</span>{(serverSearch || serverAccountFilterIds.length > 0) && <button className="mobile-primary" type="button" onClick={() => { setServerSearch(""); setServerAccountFilterIds([]); }}>清除筛选</button>}</div> : <div className="mobile-server-list">{pagedVisibleServers.map((server) => {
            const key = `${server.account_id}:${server.asset_key}`;
            const busy = activeAction === key;
            const owner = accountForAsset(server);
            const status = payloadText(server.payload, ["InstanceStatus", "instanceStatus", "status", "Status"]);
            const power = serverPowerState(server.payload);
            const unavailable = busy || syncing || activeAction !== null;
            return <article className="mobile-server-card mobile-server-card-featured" key={key}>
              <div className="mobile-server-featured-main"><span className="mobile-provider-avatar" data-provider={owner?.cloud_type ?? "other"}>{<MobileProviderMark cloudType={owner?.cloud_type ?? "other"} />}</span><div className="mobile-server-featured-copy"><div className="mobile-server-featured-title"><strong title={payloadText(server.payload, ["instanceName", "InstanceName", "name", "Name", "serverName"])}>{payloadText(server.payload, ["instanceName", "InstanceName", "name", "Name", "serverName"])}</strong>{owner && <span className="mobile-server-provider">{cloudProvider(owner.cloud_type).label}</span>}</div><p>{owner?.account_name ?? "未知账号"} · {server.region_id || "地域未知"}</p></div><span className={`${serverStatusClass(server.payload)} mobile-server-status-pill`}><i aria-hidden="true" />{status}</span></div>
              <p className="mobile-server-expiry">到期时间：{serverExpiryLabel(server.payload)}</p>
<details className="mobile-server-options"><summary>详情与操作</summary><div className="mobile-server-metadata"><span>{payloadText(server.payload, ["instanceId", "InstanceId", "id", "Id"])} · {server.resource_type === "swas" ? "轻量服务器" : "云服务器"} · 缓存于 {fetchedAtLabel(server.fetched_at)}</span></div><MobileServerDetails server={server} cloudType={owner?.cloud_type} />{owner && ["aliyun", "tencent"].includes(owner.cloud_type) && <div className="mobile-server-actions"><button type="button" disabled={unavailable || power !== "stopped"} onClick={() => setServerActionConfirmation({ server, action: "start" })}><Power size={14} />启动</button><button type="button" disabled={unavailable || power !== "running"} onClick={() => setServerActionConfirmation({ server, action: "stop" })}><Power size={14} />停止</button><button type="button" disabled={unavailable || power !== "running"} onClick={() => setServerActionConfirmation({ server, action: "reboot", forceStop: true })}><RotateCw size={14} />重启</button>{power === "pending" && <span role="status">状态待确认，请刷新</span>}{busy && <span role="status">提交中…</span>}</div>}</details>
            </article>;
          })}</div>}{visibleServers.length > 0 && <PaginationBar className="store-pagination" page={safeServerPage} pageSize={resourceListPageSize} total={visibleServers.length} onPageChange={setResourceListPage} onPageSizeChange={(size) => { setResourceListPageSize(size); setResourceListPage(1); }} />}
        </> : tab === "domains" ? <>
          {!selectedDomain && <>
            <div className="mobile-page-title"><h1>域名与 DNS</h1></div>
            <div className="mobile-domain-overview"><div className="mobile-domain-stats" aria-label="域名统计"><div className="domain-stat-total"><span className="mobile-account-stat-icon"><Globe2 size={21} /></span><span className="mobile-account-stat-copy"><strong>{filteredDomains.length}</strong><small>域名</small></span></div><div className="domain-stat-accounts"><span className="mobile-account-stat-icon"><Cloud size={21} /></span><span className="mobile-account-stat-copy"><strong>{new Set(filteredDomains.map((domain) => domain.account_id)).size}</strong><small>关联账号</small></span></div></div></div>
            {accounts.length > 0 && <div className="mobile-domain-tools"><label className="mobile-account-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索域名、账号或备注" value={domainSearch} onChange={(event) => setDomainSearch(event.currentTarget.value)} placeholder="搜索域名 / 账号名 / 备注…" /></label><label className="mobile-account-provider-filter"><Filter size={16} aria-hidden="true" /><select aria-label="按云账号筛选域名" value={assetAccountFilterId ?? ""} onChange={(event) => setAssetAccountFilterId(event.currentTarget.value ? Number(event.currentTarget.value) : null)}><option value="">全部</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.account_name}</option>)}</select></label></div>}
            {accounts.length > 0 && unknownDomains.length > 0 && <button type="button" className="mobile-clean-unknown" disabled={loading || syncing || cleaningUnknownResource !== null} onClick={() => void removeUnknownRecords("domains", "域名", domains, (domain) => accountForAsset(domain) === null, (domain) => `${domain.account_id}:${domain.resource_type}:${domain.asset_key}`, resourcesClient.removeLocal, setDomains)}>{cleaningUnknownResource === "domains" ? "正在移除…" : `移除未知账号域名（${unknownDomains.length}）`}</button>}
            <div className="mobile-domain-list-heading"><h2>域名与 DNS 列表 <span>{filteredDomains.length}</span></h2><button type="button" className="mobile-account-sort" aria-label={`按名称${domainSortAscending ? "升序" : "降序"}排列`} onClick={() => setDomainSortAscending((ascending) => !ascending)}><ArrowUpDown size={16} />{domainSortAscending ? "按名称" : "名称倒序"}</button></div>
          </>}
          {accounts.length === 0 ? <div className="mobile-empty"><Globe2 size={30} /><strong>先添加云账号</strong><button type="button" className="mobile-primary" onClick={() => setTab("accounts")}>查看账号</button></div> : selectedDomain ? <>
            <div className="mobile-domain-heading"><div><h2 className="mobile-domain-name">{payloadText(selectedDomain.payload, ["DomainName", "domain", "domainName", "name"])}</h2><small>{selectedDomainAccount?.account_name ?? "未知账号"}</small></div>{selectedDomainAccount?.cloud_type === "aliyun" && <button className="mobile-primary" type="button" onClick={() => openDnsEditor(null)}><Plus size={16} />新增记录</button>}</div>
            {loading && dnsRecords.length === 0 ? <div className="mobile-empty">正在读取 DNS 记录…</div> : dnsRecords.length === 0 ? <div className="mobile-empty"><strong>暂无 DNS 记录</strong></div> : <div className="mobile-domain-list">{dnsRecords.map((row, index) => <article className="mobile-domain-card" key={String(row.RecordId ?? index)}><div className="mobile-server-heading"><span className="mobile-domain-type">{String(row.Type ?? "DNS")}</span><strong>{String(row.RR ?? "@")}</strong></div><p>{String(row.Value ?? "—")}</p><div className="mobile-server-meta"><span>TTL {String(row.TTL ?? "—")}</span><span>{String(row.Status ?? "未知")}</span></div>{selectedDomainAccount?.cloud_type === "aliyun" && <div className="mobile-server-actions"><button type="button" onClick={() => openDnsEditor(row)}>编辑</button><button type="button" onClick={() => void changeDnsRecord(row, "toggle")}>{String(row.Status).toUpperCase() === "ENABLE" ? "暂停" : "启用"}</button><button type="button" aria-label={`删除 ${String(row.RR ?? "")} 记录`} onClick={() => void changeDnsRecord(row, "delete")}><Trash2 size={15} />删除</button></div>}</article>)}</div>}
          </> : loading && domains.length === 0 ? <div className="mobile-empty" role="status"><Activity className="mobile-spin" /><strong>正在读取本机域名缓存</strong></div> : filteredDomains.length === 0 ? <div className="mobile-empty"><Globe2 size={30} /><strong>{domainSearch || assetAccountFilterId !== null ? "没有匹配的域名" : domains.length ? "该账号下暂无缓存的域名" : "暂无缓存的域名"}</strong><span>{domainSearch || assetAccountFilterId !== null ? "试试其他关键词或清除筛选条件。" : "点击“拉取云端”汇总已接入账号的域名。"}</span>{(domainSearch || assetAccountFilterId !== null) && <button className="mobile-primary" type="button" onClick={() => { setDomainSearch(""); setAssetAccountFilterId(null); }}>清除筛选</button>}</div> : <div className="mobile-domain-list mobile-domain-resource-list">{pagedDomains.map((domain) => { const key = `${domain.account_id}:${domain.asset_key}`; const owner = accountForAsset(domain); const domainName = payloadText(domain.payload, ["DomainName", "domain", "domainName", "name"]); return <button className="mobile-server-card mobile-server-card-featured mobile-domain-resource-card" key={key} type="button" onClick={() => void loadDns(domain)}><span className="mobile-provider-avatar" data-provider={owner?.cloud_type ?? "other"}><MobileProviderMark cloudType={owner?.cloud_type ?? "other"} /></span><span className="mobile-domain-resource-copy"><span className="mobile-domain-resource-title"><strong title={domainName}>{domainName}</strong>{owner && <span className="mobile-server-provider">{cloudProvider(owner.cloud_type).label}</span>}</span><small>{owner?.account_name ?? "未知账号"} · {domainRecordCountLabel(domain.payload)} · {fetchedAtLabel(domain.fetched_at)}</small></span><span className="mobile-server-status-pill is-running mobile-domain-cached"><i aria-hidden="true" />已缓存</span><span className="mobile-account-arrow">›</span></button>; })}</div>}{!selectedDomain && filteredDomains.length > 0 && <PaginationBar className="store-pagination" page={safeDomainPage} pageSize={resourceListPageSize} total={filteredDomains.length} onPageChange={setResourceListPage} onPageSizeChange={(size) => { setResourceListPageSize(size); setResourceListPage(1); }} />}
        </> : tab === "storage" ? <>
          {!selectedBucket && resourcePageOverview}
          {accounts.length > 0 && unknownBuckets.length > 0 && <button type="button" className="mobile-clean-unknown" disabled={loading || syncing || cleaningUnknownResource !== null} onClick={() => void removeUnknownRecords("storage", "存储桶", buckets, (bucket) => accountForAsset(bucket) === null, (bucket) => `${bucket.account_id}:${bucket.resource_type}:${bucket.asset_key}`, resourcesClient.removeLocal, setBuckets)}>{cleaningUnknownResource === "storage" ? "正在移除…" : `移除未知账号存储桶（${unknownBuckets.length}）`}</button>}
          {accounts.length === 0 ? <div className="mobile-empty"><Folder size={30} /><strong>先添加云账号</strong></div> : selectedBucket ? <>
            <h2 className="mobile-domain-name">{payloadText(selectedBucket.payload, ["Name", "Bucket", "name"])}</h2><small>{selectedBucketAccount?.account_name ?? "未知账号"}</small>
            {objectPrefix && <p className="mobile-object-prefix">/{objectPrefix}</p>}
            {objectListing && <div className="mobile-domain-list">{objectListing.prefixes.map((prefix) => <button type="button" className="mobile-object-row" key={prefix} onClick={() => void browseBucket(selectedBucket, prefix)}><Folder size={19} /><span>{prefix.slice(objectPrefix.length)}</span><b>›</b></button>)}{objectListing.objects.map((object) => <article className="mobile-object-row" key={object.Key}><File size={18} /><span><strong>{object.Key.slice(objectPrefix.length)}</strong><small>{Number(object.Size).toLocaleString()} bytes · {object.LastModified ? new Date(object.LastModified).toLocaleDateString() : ""}</small></span></article>)}</div>}
            {objectListing?.isTruncated && <button className="mobile-primary mobile-load-more" type="button" disabled={loading} onClick={() => void browseBucket(selectedBucket, objectPrefix, objectListing.nextMarker)}>{loading ? "加载中…" : "加载更多"}</button>}
          </> : filteredBuckets.length === 0 && !loading ? <div className="mobile-empty"><Folder size={30} /><strong>{buckets.length ? "该账号下暂无缓存的存储桶" : "暂无缓存的存储桶"}</strong><span>点击“拉取云端”汇总已接入账号的存储桶。</span></div> : <div className="mobile-domain-list">{pagedBuckets.map((bucket) => { const owner = accountForAsset(bucket); return <button className="mobile-account-card mobile-resource-list-card" key={`${bucket.account_id}:${bucket.asset_key}`} type="button" onClick={() => void browseBucket(bucket)}><span className="mobile-provider-avatar" data-provider={owner?.cloud_type ?? "other"}><MobileProviderMark cloudType={owner?.cloud_type ?? "other"} /></span><span className="mobile-account-copy"><span className="mobile-resource-card-title"><strong>{payloadText(bucket.payload, ["Name", "Bucket", "name"])}</strong>{owner && <span className="mobile-server-provider">{cloudProvider(owner.cloud_type).label}</span>}</span><small>{owner?.account_name ?? "未知账号"} · {payloadText(bucket.payload, ["Location", "location", "Region"])} · 缓存于 {fetchedAtLabel(bucket.fetched_at)}</small></span><span className="mobile-resource-state">已缓存</span><span className="mobile-account-arrow">›</span></button>; })}</div>}{filteredBuckets.length > 0 && <PaginationBar className="store-pagination" page={safeResourceListPage(filteredBuckets.length)} pageSize={resourceListPageSize} total={filteredBuckets.length} onPageChange={setResourceListPage} onPageSizeChange={(size) => { setResourceListPageSize(size); setResourceListPage(1); }} />}

        </> : tab === "databases" ? <>
          {!selectedDatabase && resourcePageOverview}
          {accounts.length > 0 && unknownDatabases.length > 0 && <button type="button" className="mobile-clean-unknown" disabled={loading || syncing || cleaningUnknownResource !== null} onClick={() => void removeUnknownRecords("databases", "数据库实例", databaseAssets, (instance) => accountForAsset(instance) === null, (instance) => `${instance.account_id}:${instance.resource_type}:${instance.asset_key}`, resourcesClient.removeLocal, setDatabaseAssets)}>{cleaningUnknownResource === "databases" ? "正在移除…" : `移除未知账号数据库实例（${unknownDatabases.length}）`}</button>}
          {accounts.length === 0 ? <div className="mobile-empty"><Database size={30} /><strong>先添加云账号</strong></div> : selectedDatabase ? <>
            <h2 className="mobile-domain-name">{payloadText(selectedDatabase.payload, ["DBInstanceDescription", "DBInstanceId", "InstanceName", "name"])}</h2><small>{selectedDatabaseAccount?.account_name ?? "未知账号"}</small>
            {loading && databaseDetails.length === 0 ? <div className="mobile-empty">正在读取数据库…</div> : databaseDetails.length === 0 ? <div className="mobile-empty"><strong>没有返回数据库清单</strong><span>当前云账号或实例可能不支持此查询。</span></div> : <div className="mobile-domain-list">{databaseDetails.map((item, index) => <article className="mobile-domain-card" key={String(item.DBName ?? item.AccountName ?? index)}><div className="mobile-server-heading"><Database size={17} /><strong>{String(item.DBName ?? item.AccountName ?? item.Name ?? "数据库")}</strong></div><p>{String(item.CharacterSetName ?? item.AccountDescription ?? item.Description ?? "")}</p><div className="mobile-server-meta"><span>{String(item.DBStatus ?? item.AccountStatus ?? "")}</span><span>{String(item.DBInstanceId ?? "")}</span></div></article>)}</div>}
          </> : filteredDatabaseAssets.length === 0 && !loading ? <div className="mobile-empty"><Database size={30} /><strong>{databaseAssets.length ? "该账号下暂无缓存的数据库实例" : "暂无缓存的数据库实例"}</strong><span>点击“拉取云端”汇总已接入账号的实例。</span></div> : <div className="mobile-domain-list">{pagedDatabaseAssets.map((instance) => { const owner = accountForAsset(instance); return <button className="mobile-account-card mobile-resource-list-card" key={`${instance.account_id}:${instance.asset_key}`} type="button" onClick={() => void loadDatabaseDetails(instance)}><span className="mobile-provider-avatar" data-provider={owner?.cloud_type ?? "other"}><MobileProviderMark cloudType={owner?.cloud_type ?? "other"} /></span><span className="mobile-account-copy"><span className="mobile-resource-card-title"><strong>{payloadText(instance.payload, ["DBInstanceDescription", "DBInstanceId", "InstanceName", "name"])}</strong>{owner && <span className="mobile-server-provider">{cloudProvider(owner.cloud_type).label}</span>}</span><small>{owner?.account_name ?? "未知账号"} · {instance.region_id} · {payloadText(instance.payload, ["DBInstanceStatus", "InstanceStatus", "status"])} · 缓存于 {fetchedAtLabel(instance.fetched_at)}</small></span><span className="mobile-resource-state">已缓存</span><span className="mobile-account-arrow">›</span></button>; })}</div>}{filteredDatabaseAssets.length > 0 && <PaginationBar className="store-pagination" page={safeResourceListPage(filteredDatabaseAssets.length)} pageSize={resourceListPageSize} total={filteredDatabaseAssets.length} onPageChange={setResourceListPage} onPageSizeChange={(size) => { setResourceListPageSize(size); setResourceListPage(1); }} />}

        </> : tab === "redis" ? <>
          {!selectedRedis && resourcePageOverview}
          {accounts.length > 0 && unknownRedisInstances.length > 0 && <button type="button" className="mobile-clean-unknown" disabled={loading || syncing || cleaningUnknownResource !== null} onClick={() => void removeUnknownRecords("redis", "Redis 实例", redisAssets, (instance) => accountForAsset(instance) === null, (instance) => `${instance.account_id}:${instance.resource_type}:${instance.asset_key}`, resourcesClient.removeLocal, setRedisAssets)}>{cleaningUnknownResource === "redis" ? "正在移除…" : `移除未知账号 Redis 实例（${unknownRedisInstances.length}）`}</button>}
          {accounts.length === 0 ? <div className="mobile-empty"><Database size={30} /><strong>先添加云账号</strong></div> : selectedRedis ? <>
            <h2 className="mobile-domain-name">{payloadText(selectedRedis.payload, ["InstanceName", "InstanceId", "instanceId", "Id"])}</h2><small>{selectedRedisAccount?.account_name ?? "未知账号"}</small>
            {loading && redisAccounts.length === 0 ? <div className="mobile-empty">正在读取 Redis 账号…</div> : redisAccounts.length === 0 ? <div className="mobile-empty"><strong>没有返回账号信息</strong><span>实例可能没有自定义账号，或当前凭据缺少读取权限。</span></div> : <div className="mobile-domain-list">{redisAccounts.map((item, index) => <article className="mobile-domain-card" key={String(item.AccountName ?? index)}><div className="mobile-server-heading"><Database size={17} /><strong>{String(item.AccountName ?? "默认账号")}</strong></div><div className="mobile-server-meta"><span>{String(item.AccountType ?? "")}</span><span>{String(item.AccountStatus ?? "")}</span></div>{typeof item.AccountDescription === "string" && item.AccountDescription && <p>{item.AccountDescription}</p>}</article>)}</div>}
          </> : filteredRedisAssets.length === 0 && !loading ? <div className="mobile-empty"><Database size={30} /><strong>{redisAssets.length ? "该账号下暂无缓存的 Redis 实例" : "暂无缓存的 Redis 实例"}</strong><span>点击“拉取云端”汇总已接入账号的实例。</span></div> : <div className="mobile-domain-list">{pagedRedisAssets.map((instance) => { const owner = accountForAsset(instance); return <button className="mobile-account-card mobile-resource-list-card" key={`${instance.account_id}:${instance.asset_key}`} type="button" onClick={() => void loadRedisAccounts(instance)}><span className="mobile-provider-avatar" data-provider={owner?.cloud_type ?? "other"}><MobileProviderMark cloudType={owner?.cloud_type ?? "other"} /></span><span className="mobile-account-copy"><span className="mobile-resource-card-title"><strong>{payloadText(instance.payload, ["InstanceName", "InstanceId", "instanceId", "Id"])}</strong>{owner && <span className="mobile-server-provider">{cloudProvider(owner.cloud_type).label}</span>}</span><small>{owner?.account_name ?? "未知账号"} · {instance.region_id} · {payloadText(instance.payload, ["InstanceStatus", "Status", "status"])} · 缓存于 {fetchedAtLabel(instance.fetched_at)}</small></span><span className="mobile-resource-state">已缓存</span><span className="mobile-account-arrow">›</span></button>; })}</div>}{filteredRedisAssets.length > 0 && <PaginationBar className="store-pagination" page={safeResourceListPage(filteredRedisAssets.length)} pageSize={resourceListPageSize} total={filteredRedisAssets.length} onPageChange={setResourceListPage} onPageSizeChange={(size) => { setResourceListPageSize(size); setResourceListPage(1); }} />}

        </> : tab === "certificates" ? <>
          <MobileCertificates items={certificates} loading={loading} onSync={() => setTab("sync")} onRequest={() => setShowCertificateRequest(true)} />

        </> : tab === "ssh" ? <>
          {!sshSessionId && resourcePageOverview}
          {sshSessionId ? <section className="mobile-terminal"><div className="mobile-terminal-heading"><span><Terminal size={16} />{sshHost?.name ?? sshHost?.host ?? "SSH"}</span><button type="button" onClick={() => void disconnectManagedHost()}>断开</button></div><pre className="mobile-terminal-output" aria-live="polite">{sshOutput || "已连接，等待远端输出…"}</pre><form className="mobile-terminal-input" onSubmit={(event) => void sendSshCommand(event)}><label className="mobile-sr-only" htmlFor="mobile-ssh-command">输入 SSH 命令</label><input id="mobile-ssh-command" value={sshCommand} onChange={(event) => setSshCommand(event.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="输入命令并发送" /><button className="mobile-primary" type="submit" disabled={!sshCommand.trim()}>发送</button></form><p>命令会直接在远程 Shell 执行。敏感凭据仅由原生层读取。</p></section> : loading && filteredHosts.length === 0 ? <div className="mobile-empty">正在读取托管主机…</div> : filteredHosts.length === 0 ? <div className="mobile-empty"><Terminal size={30} /><strong>{resourceSearch.ssh ? "没有匹配的主机" : "暂无托管主机"}</strong><span>可以直接在手机上添加 SSH 主机并将凭据加密保存在本机。</span><button type="button" className="mobile-primary" onClick={() => openSshHostForm()}><Plus size={17} />添加 SSH 主机</button></div> : <><div className="mobile-ssh-host-list">{pagedHosts.map((host) => <article className="mobile-ssh-host-row" key={host.id}>
            <span className={`mobile-ssh-host-icon is-${host.platform === "windows" ? "windows" : "linux"}`} title={host.platform === "windows" ? "Windows" : "Linux"} aria-label={host.platform === "windows" ? "Windows 主机" : "Linux 主机"}>{host.platform === "windows" ? <Monitor size={17} aria-hidden="true" /> : <Terminal size={17} aria-hidden="true" />}</span>
            <div className="mobile-ssh-host-copy"><strong>{host.name}</strong><p>{host.username}@{host.host}:{host.port}</p><div className="mobile-ssh-host-meta"><span className={`mobile-ssh-host-status is-${host.status === "online" ? "online" : host.status === "offline" ? "offline" : "unknown"}`}><i aria-hidden="true" />{host.status === "online" ? "在线" : host.status === "offline" ? "离线" : "未检查"}</span><span>{host.platform === "windows" ? "Windows · RDP · 手机端暂不支持" : !host.password_saved && !host.private_key_saved ? "Linux · 未配置凭据" : "Linux · SSH"}</span>{(() => { const source = accounts.find((account) => account.id === host.source_account_id); const provider = source?.cloud_type || matchCloudTypeFromText(`${host.name} ${host.remark ?? ""}`); return provider && ["aliyun", "tencent"].includes(provider) ? <span className="mobile-ssh-provider" title={cloudProvider(provider).label}><MobileProviderMark cloudType={provider} /><span>{cloudProvider(provider).label}</span></span> : null; })()}</div></div>
            <div className="mobile-ssh-host-actions"><button type="button" className="mobile-ssh-edit" aria-label={`编辑主机 ${host.name}`} title="编辑主机" onClick={() => openSshHostForm(host)}><Pencil size={16} aria-hidden="true" /><span>编辑</span></button><button type="button" className="mobile-ssh-connect" aria-label={`连接终端 ${host.name}`} disabled={sshConnecting || host.platform === "windows" || (!host.password_saved && !host.private_key_saved)} onClick={() => void connectManagedHost(host)}>{sshConnecting ? "连接中" : "连接"}</button></div>
          </article>)}</div><PaginationBar className="store-pagination" page={safeSshListPage} pageSize={sshListPageSize} total={filteredHosts.length} onPageChange={setSshListPage} onPageSizeChange={(size) => { setSshListPageSize(size); setSshListPage(1); }} /></>}

        </> : tab === "panels" ? <>
          {resourcePageOverview}
          <div className="mobile-panel-refresh-control">
            <div><strong>自动刷新监控</strong><small>{panelAutoRefresh.seconds === 0 ? "已关闭 · 打开页面先读缓存" : panelAutoRefresh.busy ? "正在更新…" : panelAutoRefresh.failed ? "部分更新失败，将自动重试" : runningInTauri ? "前台定时更新，后台暂停" : "网页预览仅定时读取本机缓存"}</small></div>
            <select aria-label="自动刷新监控间隔" value={panelAutoRefresh.seconds} onChange={(event) => panelAutoRefresh.setSeconds(Number(event.target.value))}>{panelRefreshIntervals.map((seconds) => <option key={seconds} value={seconds}>{seconds === 0 ? "关闭" : `${seconds} 秒`}</option>)}</select>
          </div>
          {panelLoading && filteredPanels.length === 0 ? <div className="mobile-empty">正在读取面板配置…</div> : filteredPanels.length === 0 ? <div className="mobile-empty"><Monitor size={28} /><strong>{resourceSearch.panels ? "没有匹配的面板" : "暂无已配置的面板"}</strong><span>可直接在手机添加面板，也可以导入电脑中的加密配置。</span><button type="button" className="mobile-primary" onClick={addPanel}>添加运维面板</button><button type="button" className="mobile-domain-back" onClick={() => setTab("sync")}>导入电脑配置</button></div> : <><div className="mobile-domain-list">{pagedPanels.map((panel) => { const cloudType = panelCloudType(panel, accounts); const panelIp = mobilePanelIp(panel.panel_url); return <article className="mobile-domain-card mobile-panel-card" key={panel.id}><div className="mobile-panel-card-heading"><div className="mobile-server-heading">{cloudType && <span className="mobile-provider-avatar mobile-panel-cloud" data-provider={cloudType} title={`云厂商：${cloudProvider(cloudType).label}`}>{<MobileProviderMark cloudType={cloudType} />}</span>}<Monitor size={17} /><strong>{panel.name}</strong></div><span className={`mobile-panel-status ${panel.status === "online" ? "online" : panel.status === "offline" ? "offline" : "unknown"}`}>{panel.status === "online" ? "在线" : panel.status === "offline" ? "离线" : "未检查"}</span></div><div className="mobile-panel-identity"><p className="mobile-panel-url">{panel.panel_url}</p>{panelIp && <IpLocation ip={panelIp} />}<div className="mobile-panel-card-meta"><span>{panel.group_name || "未分组"}</span><small><ShieldCheck size={13} />{panel.api_key_saved ? "密钥已加密" : "缺少 API 密钥"}</small></div></div><details className="mobile-server-options"><summary>监控详情</summary><MobilePanelMetrics panel={panel} /></details><div className="mobile-panel-actions"><button type="button" aria-label={`刷新面板 ${panel.name} 状态`} title="刷新状态" disabled={panelAutoRefresh.busy || panelActionId !== null} onClick={() => void refreshPanelStatus(panel)}><RefreshCw size={17} className={panelActionId === panel.id ? "mobile-spin" : ""} /><span>刷新</span></button><button type="button" className="primary" aria-label={`打开面板 ${panel.name}`} title="打开面板" disabled={panelAutoRefresh.busy || panelOpeningId === panel.id || !panel.api_key_saved || panel.status === "offline"} onClick={() => void openPanel(panel)}><ExternalLink size={17} /><span>{panelOpeningId === panel.id ? "打开中" : "打开"}</span></button><button type="button" aria-label={`编辑面板 ${panel.name}`} title="编辑面板" disabled={panelAutoRefresh.busy || panelActionId !== null} onClick={() => editPanel(panel)}><Pencil size={17} aria-hidden="true" /><span>编辑</span></button><button type="button" className="danger" aria-label={`删除面板 ${panel.name}`} title="删除面板" disabled={panelAutoRefresh.busy || panelActionId !== null} onClick={() => void removePanel(panel)}><Trash2 size={17} aria-hidden="true" /><span>删除</span></button></div></article>; })}</div><PaginationBar className="store-pagination" page={safePanelListPage} pageSize={panelListPageSize} total={filteredPanels.length} onPageChange={setPanelListPage} onPageSizeChange={(size) => { setPanelListPageSize(size); setPanelListPage(1); }} /></>}

        </> : tab === "sync" ? <>
          <div className="mobile-page-title"><div><p>系统设置</p><h1 id="sync-transfer-title">导入数据</h1></div></div>
          <SyncTransferPanel mode="mobile" mobilePage accounts={accounts} managedHosts={managedHosts} panels={panelConnections} initialPairingUrl={pendingTransferQr ?? undefined} onInitialPairingHandled={() => setPendingTransferQr(null)} onImported={() => { void refreshAccounts(); void refreshManagedHosts(); void refreshPanelConnections(); }} />
        </> : tab === "networkSettings" ? <>
          <div className="mobile-page-title mobile-network-page-title"><div><p>系统设置</p><h1>网络设置</h1></div></div>
          <NetworkSettingsPage mobile />
        </> : tab === "settings" ? <>
          <div className="mobile-page-title"><div><p>通用</p><h1>通用设置</h1></div></div>
          <div className="mobile-domain-list mobile-more-list mobile-general-settings">
            <div className="mobile-account-card mobile-startup-switch"><span className="mobile-provider-avatar"><Sparkles size={20} aria-hidden="true" /></span><span className="mobile-account-copy"><strong>启用开机动画</strong><small>下次启动时先播放动画，再进入主界面</small></span><input type="checkbox" aria-label="启用开机动画" checked={startupAnimationEnabled ?? true} disabled={startupAnimationEnabled === null} onChange={event => setStartupAnimationEnabled(event.target.checked)} /></div>
            <div className="mobile-account-card mobile-theme-card"><span className="mobile-provider-avatar"><SunMoon size={20} /></span><span className="mobile-account-copy"><strong>外观主题</strong><small>切换深色或浅色界面</small></span><div className="mobile-theme-toggle" role="radiogroup" aria-label="外观主题"><button type="button" role="radio" aria-checked={uiTheme === "dark"} className={uiTheme === "dark" ? "active" : ""} onClick={() => setUiTheme("dark")}>深色</button><button type="button" role="radio" aria-checked={uiTheme === "light"} className={uiTheme === "light" ? "active" : ""} onClick={() => setUiTheme("light")}>浅色</button></div></div>
          </div>
        </> : tab === "operationLogs" ? <>
          {resourcePageOverview}
          {operationLogsLoading && filteredOperationLogs.length === 0 ? <div className="mobile-empty">正在读取操作日志…</div> : filteredOperationLogs.length === 0 ? <div className="mobile-empty"><FileText size={30} /><strong>暂无操作日志</strong><span>获取并保存云资源后会在这里显示记录。</span></div> : <div className="mobile-domain-list">{pagedOperationLogs.map(({ asset, account }) => <article className="mobile-domain-card mobile-log-card" key={`${asset.account_id}:${asset.resource_type}:${asset.asset_key}`}><div className="mobile-server-heading"><i className="mobile-log-indicator" aria-hidden="true" /><strong>获取并保存资产</strong></div><p>{asset.asset_key}</p><div className="mobile-server-meta"><span className="mobile-log-owner"><span className="mobile-log-provider" data-provider={account.cloud_type} title={`云厂商：${cloudProvider(account.cloud_type).label}`} aria-hidden="true"><MobileProviderMark cloudType={account.cloud_type} /></span>{account.account_name} · {resourceLabels[asset.resource_type as keyof typeof resourceLabels] ?? asset.resource_type}</span><time>{new Date(asset.fetched_at).toLocaleString()}</time></div></article>)}</div>}{filteredOperationLogs.length > 0 && <PaginationBar className="store-pagination" page={safeResourceListPage(filteredOperationLogs.length)} pageSize={resourceListPageSize} total={filteredOperationLogs.length} onPageChange={setResourceListPage} onPageSizeChange={(size) => { setResourceListPageSize(size); setResourceListPage(1); }} />}

        </> : tab === "apiLogs" ? <>
          {resourcePageOverview}
          {apiLogsLoading && filteredApiLogs.length === 0 ? <div className="mobile-empty">正在读取 API 日志…</div> : filteredApiLogs.length === 0 ? <div className="mobile-empty"><Terminal size={30} /><strong>暂无 API 日志</strong><span>调用云资源接口后会在这里显示记录。</span></div> : <div className="mobile-domain-list">{pagedApiLogs.map((log) => { const cloudType = accounts.find((account) => account.id === log.account_id)?.cloud_type ?? matchCloudTypeFromText(log.account_name || "") ?? "other"; return <article className="mobile-domain-card mobile-log-card" key={log.id}><div className="mobile-server-heading"><i className={`mobile-log-indicator${log.status === "成功" ? "" : " is-error"}`} aria-hidden="true" /><strong>{log.action}</strong></div><p>{log.endpoint}</p><div className="mobile-server-meta"><span className="mobile-log-owner"><span className="mobile-log-provider" data-provider={cloudType} title={`云厂商：${cloudProvider(cloudType).label}`} aria-hidden="true"><MobileProviderMark cloudType={cloudType} /></span>{log.account_name || "未知账号"}</span><span className={log.status === "成功" ? "mobile-log-success" : "mobile-log-failure"}>{log.status}</span><time>{new Date(log.created_at).toLocaleString()}</time></div></article>; })}</div>}{filteredApiLogs.length > 0 && <PaginationBar className="store-pagination" page={safeResourceListPage(filteredApiLogs.length)} pageSize={resourceListPageSize} total={filteredApiLogs.length} onPageChange={setResourceListPage} onPageSizeChange={(size) => { setResourceListPageSize(size); setResourceListPage(1); }} />}

        </> : tab === "authenticator" ? <AuthenticatorPanel mobile initialOtpUri={pendingOtpUri ?? undefined} onInitialOtpUriHandled={() => setPendingOtpUri(null)} /> : tab === "flow" ? <FlowPanel mobile /> : tab === "about" ? <>
          <div className="mobile-page-title"><div><p>系统设置</p><h1>更新与关于</h1></div></div>
          <div className="mobile-about-layout">
            <section className="mobile-about-card"><span className="mobile-about-logo"><img src="/cloudhub-logo.png" alt="" /></span><strong>云枢工具箱</strong><span>本地多云资源管理</span><small>当前版本 <b>v{packageJson.version}</b></small></section>
            <MobileUpdatePanel update={mobileUpdate} />
            <section className="mobile-about-platform" aria-labelledby="mobile-about-desktop-title">
              <span className="mobile-about-platform-icon"><Monitor size={20} aria-hidden="true" /></span>
              <div className="mobile-about-platform-copy"><strong id="mobile-about-desktop-title">PC 桌面版</strong><small>Windows 与 macOS 版本可在 GitHub Releases 查看并下载。</small></div>
              <a className="mobile-about-platform-action" href="https://github.com/wlphp/cloudhub-tools/releases" target="_blank" rel="noreferrer">查看下载<ExternalLink size={14} aria-hidden="true" /></a>
            </section>
            <section className="mobile-about-links" aria-label="CloudHub 服务入口">
              <a href="https://yun.wlphp.com/member.html" target="_blank" rel="noreferrer"><UserRound size={17} aria-hidden="true" /><span>会员中心</span><ExternalLink size={14} aria-hidden="true" /></a>
              <a href="https://yun.wlphp.com/" target="_blank" rel="noreferrer"><Globe2 size={17} aria-hidden="true" /><span>访问官网</span><ExternalLink size={14} aria-hidden="true" /></a>
              <a href="https://github.com/wlphp/cloudhub-tools" target="_blank" rel="noreferrer"><Star size={17} aria-hidden="true" /><span>给个好评 · GitHub</span><ExternalLink size={14} aria-hidden="true" /></a>
            </section>
          </div>
        </> : tab === "personalProfile" && member ? <MobilePersonalProfile member={member} onMember={setMember} onBack={settingsPageOpen ? returnToSettingsMenu : () => setTab("more")} onNotice={setNotice} showHeader={!settingsPageOpen} /> : tab === "member" ? <MobileMemberPage member={member} onMember={setMember} onBack={settingsPageOpen ? returnToSettingsMenu : () => setTab("more")} onNotice={setNotice} openInbox={memberInboxRequested} onInboxOpened={() => setMemberInboxRequested(false)} onUnreadCount={setMemberUnreadCount} /> : <MobileMorePage onNavigate={(destination, resourceType) => {
    if (resourceType === "swas") {
      setServerKind("swas");
      setServerSearch("");
      setServerAccountFilterIds([]);
    } else if (resourceType === "esa") {
      setMobileAssetTypeFilter("esa");
      setMobileAssetSearch("");
      setMobileAssetAccountFilter(null);
    }
    setTab(destination);
  }} accounts={accounts} assets={mobileAssetRows} favoriteCount={mobileFavoriteKeys.length} sshCount={managedHosts.length} panelCount={panelConnections.length} />;

  const initialPageLoading =
    (tab === "home" && (loading && accounts.length === 0 || mobileAssetsLoading && mobileAssetRows.length === 0)) ||
    ((tab === "accounts") && loading && accounts.length === 0) ||
    ((tab === "assets" || tab === "favorites") && mobileAssetsLoading && mobileAssetRows.length === 0) ||
    (tab === "servers" && loading && servers.length === 0) ||
    (tab === "domains" && loading && (selectedDomain ? dnsRecords.length === 0 : domains.length === 0)) ||
    (tab === "storage" && loading && (selectedBucket ? !objectListing : buckets.length === 0)) ||
    (tab === "databases" && loading && (selectedDatabase ? databaseDetails.length === 0 : databaseAssets.length === 0)) ||
    (tab === "redis" && loading && (selectedRedis ? redisAccounts.length === 0 : redisAssets.length === 0)) ||
    (tab === "certificates" && loading && certificates.length === 0) ||
    (tab === "ssh" && loading && !sshSessionId && managedHosts.length === 0) ||
    (tab === "panels" && panelLoading && panelConnections.length === 0) ||
    (tab === "operationLogs" && operationLogsLoading && operationLogAssets.length === 0) ||
    (tab === "apiLogs" && apiLogsLoading && apiLogs.length === 0) ||
    (tab === "more" && (loading && servers.length === 0 || mobileAssetsLoading && mobileAssetRows.length === 0 || panelLoading && panelConnections.length === 0));
  const initialSkeletonVariant = tab === "home" ? "dashboard" as const : selectedDomain || selectedBucket || selectedDatabase || selectedRedis ? "detail" as const : "list" as const;

  // 归属功能分区的应用（云效流水线/HTTPS 证书/身份验证器）跳转独立页面，未适配移动端的（Codex/内网穿透）提示去 PC 端；
  // 商店列表与首页常用软件共用该路由，避免首页捷径打开一个空白插件页。
  const openApplicationSection = (section: ApplicationSection): boolean => {
    const destination: Partial<Record<ApplicationSection, MobileFeatureDestination>> = { flow: "flow", certificates: "certificates", authenticator: "authenticator" };
    if (destination[section]) {
      // 记录进入来源（商店/首页），返回按钮优先回到来源页；其他入口（资产、扫码）不记录，沿用“返回我的”。
      sectionOriginRef.current = tab === "softwareStore" ? "softwareStore" : tab === "home" ? "home" : null;
      // 跳转即离开当前页，遗留的提示条（如 Codex/内网穿透的“去 PC 端”）不能跟着带进新页面。
      setNotice("");
      setTab(destination[section]!);
      return true;
    }
    if (section === "codex" || section === "frp") {
      // 提示条固定在内容区顶部；列表滚动在下方时必须滚回顶部，否则看起来像点了没反应。
      setNotice("该应用目前尚未提供移动端界面，请在 PC 端使用。");
      mobileContentRef.current?.scrollTo({ top: 0 });
      return true;
    }
    return true;
  };
  // Claude 管理与备忘录虽归属分区，但界面就是插件页，与其余插件一样整页打开。
  const openHomeApplication = (pluginId: string) => {
    const section = applicationCatalog.find(app => app.id === pluginId)?.section;
    if (section && section !== "claude" && section !== "notes") { openApplicationSection(section); return; }
    // 打开插件页前清掉首页遗留提示，避免“请在 PC 端使用”等旧提示挂在备忘录等本就可用的页面顶部。
    setNotice("");
    setStorePluginId(pluginId);
    setTab("softwareStore");
  };

  return (
    <main className={"mobile-shell" + (backAction && !isBottomNavigationTab && !productDialog ? " mobile-subpage" : "") + (tab === "personalProfile" ? " mobile-personal-profile-open" : "") + (settingsPageOpen ? " mobile-settings-page-active" : "") + (tab === "settingsMenu" ? ` mobile-settings-menu-open${settingsDrawerDirection === "back" ? " is-returning" : ""}` : "")}>
      <ToastNotice message={notice} onDismiss={() => setNotice("")} />
      {tab === "home" && <header className="mobile-home-topbar" aria-label="首页快捷栏">
        <label className="mobile-home-top-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索应用" value={homeSearch} onChange={event => setHomeSearch(event.currentTarget.value)} placeholder="搜索" /></label>
        <button type="button" className="mobile-home-top-action" aria-label={`监控预警，${mobileActiveAlertCount} 条未解除`} title="监控预警" onClick={() => setTab("monitorAlerts")}><BellRing size={20} aria-hidden="true" /><span className="mobile-home-alert-count">{mobileActiveAlertCount > 99 ? "99+" : mobileActiveAlertCount}</span></button>
        <button type="button" className="mobile-home-top-action" aria-label="扫一扫" title="扫一扫" onClick={() => void scanMobileQr()}><ScanLine size={21} aria-hidden="true" /></button>
      </header>}
      {tab === "settingsMenu" ? <header className={`mobile-settings-drawer-header${settingsDrawerDirection === "back" ? " is-returning" : ""}`}><button ref={settingsCloseButtonRef} type="button" aria-label="返回我的页面" onClick={closeSettingsDrawer}><ArrowLeft size={20} aria-hidden="true" /></button><h1>设置</h1><span aria-hidden="true" /></header> : tab === "more" && !productDialog && <header className="mobile-header">
        <div className="mobile-profile-header">
        <button type="button" className="mobile-profile-header-main" aria-label={member ? `个人资料：${member.nickname?.trim() && member.nickname.trim() !== "匿名用户" ? member.nickname.trim() : member.email}` : "登录或注册会员"} onClick={() => setTab(member ? "personalProfile" : "member")}>
          <span className={`mobile-profile-header-avatar${member ? "" : " is-guest"}${member?.is_vip ? " is-vip" : ""}`}><MemberAvatar member={member} size={member ? 42 : 36} /></span>
          <span className="mobile-profile-header-copy">
              <span className="mobile-profile-header-identity">
              <span className="mobile-profile-account-line">
                <strong>{member ? (member.nickname?.trim() && member.nickname.trim() !== "匿名用户" ? member.nickname.trim() : member.email) : "登录 / 注册"}</strong>
                {member?.nickname?.trim() && member.nickname.trim() !== "匿名用户" && <small>{member.email}</small>}
              </span>
            </span>
            {member && <small className="mobile-profile-header-joined">注册日期：{member.created_at.slice(0, 10)}</small>}
          </span>
        </button>
        <MemberIdentityBadges member={member} className="mobile-member-status-badges" onSelect={setActiveMemberIdentity} />
        </div>
        <div className="mobile-header-actions">
          {member ? <button className="mobile-icon-button mobile-notifications-button mobile-member-inbox-header-button" type="button" aria-label={`会员消息，${memberUnreadCount} 条未读`} title="会员消息" onClick={() => { setMemberInboxRequested(true); setTab("member"); }}><Mail size={19} aria-hidden="true" />{memberUnreadCount > 0 && <span className="mobile-member-unread-badge">{memberUnreadCount > 99 ? "99+" : memberUnreadCount}</span>}</button> : <button className="mobile-icon-button mobile-notifications-button" type="button" aria-label="通知与监控预警" title="通知与监控预警" onClick={() => setTab("monitorAlerts")}><BellRing size={19} aria-hidden="true" /></button>}
          {cloudPullAction && <button className="mobile-primary mobile-header-fetch" type="button" aria-label={syncing ? "正在拉取云端" : "拉取云端"} title="从云端拉取资源并更新本机缓存" disabled={accounts.length === 0 || loading || syncing} onClick={() => void cloudPullAction()}><CloudDownload size={20} /><span>{syncing ? "拉取中" : "拉取云端"}</span></button>}
          <button ref={settingsButtonRef} className="mobile-icon-button mobile-settings-button" type="button" aria-label="系统设置" title="系统设置" onClick={() => { settingsReturnToMenuRef.current = false; setSettingsDrawerDirection("forward"); setTab("settingsMenu"); }}><Settings size={19} aria-hidden="true" /></button>
        </div>
      </header>}

      {settingsPageOpen && tab !== "member" && <header className="mobile-settings-page-header">
        <button type="button" aria-label="返回设置" onClick={returnToSettingsMenu}><ArrowLeft size={20} aria-hidden="true" /></button>
        <h1>{settingsPageTitle[tab] ?? "设置"}</h1>
        <span aria-hidden="true" />
      </header>}

      {settingsPageOpen && settingsTransitionUnderlayVisible && <div className="mobile-settings-menu-underlay" aria-hidden="true" inert onAnimationEnd={(event) => { if (event.target === event.currentTarget) setSettingsTransitionUnderlayVisible(false); }}>
        <header className="mobile-settings-drawer-header"><span aria-hidden="true" /><h1>设置</h1><span aria-hidden="true" /></header>
        <section className="mobile-content mobile-settings-menu-page-content">{renderSettingsMenuContent()}</section>
      </div>}

      <section ref={mobileContentRef} className={(resourceConfig && !productDialog ? "mobile-content mobile-resource-page" : "mobile-content") + (settingsPageOpen ? " mobile-settings-page-content" : "") + (tab === "settingsMenu" ? ` mobile-settings-menu-page-content${settingsDrawerDirection === "back" ? " is-returning" : ""}` : "")}>
        <MobilePullRefresh containerRef={mobileContentRef} actionRef={pullRefreshActionRef} scopeKey={`${tab}:${selectedAccountId}:${selectedDomain?.asset_key ?? ""}:${selectedBucket?.asset_key ?? ""}:${objectPrefix}:${selectedDatabase?.asset_key ?? ""}:${selectedRedis?.asset_key ?? ""}`} disabled={!!productDialog || tab === "settingsMenu"} onError={setNotice}>

        {mobileUpdate.info?.available && tab !== "about" && tab !== "settingsMenu" && <button type="button" className="mobile-update-banner" onClick={() => setTab("about")}><ArrowDownToLine size={15} aria-hidden="true" />发现新版 v{mobileUpdate.info.version} · 查看更新</button>}
        {initialPageLoading ? <MobileLoadingSkeleton variant={initialSkeletonVariant} label={tab === "home" ? "正在准备首页数据" : "正在加载页面内容"} /> : tab === "home" ? <MobileHomePage accounts={accounts} assets={mobileAssetRows} search={homeSearch} favoriteCount={mobileFavoriteKeys.length} applicationSettings={applicationSettings} onActiveAlertCount={setMobileActiveAlertCount} onNavigate={setTab} onOpenSoftware={openHomeApplication} refreshRef={monitorRefreshRef} /> : tab === "monitorAlerts" ? <MobileMonitorAlertsPage accounts={accounts} onActiveCount={setMobileActiveAlertCount} refreshRef={monitorRefreshRef} cachedAssets={mobileAssetRows} /> : tab === "softwareStore" ? <OfficialPluginsPage mobile key={storePluginId ?? "catalog"} initialPluginId={storePluginId ?? undefined} forceInitialPageMode={!!storePluginId} applicationSettings={applicationSettings} accounts={accounts} localAssets={mobileAssetRows} onStatus={setNotice} onConfirm={message => confirm({ message })} refreshActionRef={pullRefreshActionRef} onOpenSection={openApplicationSection} onOpenPlugin={() => setNotice("")} onReturnCatalog={() => { setStorePluginId(null); setTab("softwareStore"); }} /> : productDialog || tab === "accounts" ? accountPage : resourcePage}
        </MobilePullRefresh>
      </section>

      <nav className="mobile-tab-bar" aria-label="主导航">
        <button type="button" aria-current={tab === "home" ? "page" : undefined} className={tab === "home" ? "active" : ""} onClick={() => { setNotice(""); setTab("home"); }}><House size={20} aria-hidden="true" /><span>首页</span></button>
        <button type="button" aria-current={tab === "monitorAlerts" ? "page" : undefined} className={tab === "monitorAlerts" ? "active" : ""} onClick={() => { setNotice(""); setTab("monitorAlerts"); }}><BellRing size={20} aria-hidden="true" /><span>监控预警</span></button>
        <button type="button" aria-current={tab === "softwareStore" ? "page" : undefined} className={tab === "softwareStore" ? "active" : ""} onClick={() => { setNotice(""); setStorePluginId(null); setTab("softwareStore"); }}><Store size={20} aria-hidden="true" /><span>软件商店</span></button>
        <button type="button" aria-current={tab === "more" || tab === "member" || tab === "assets" || tab === "favorites" || tab === "authenticator" || tab === "flow" || tab === "storage" || tab === "databases" || tab === "redis" || tab === "certificates" || tab === "ssh" || tab === "panels" || tab === "sync" || tab === "settings" || tab === "networkSettings" || tab === "operationLogs" || tab === "apiLogs" || tab === "about" || tab === "accounts" || tab === "servers" || tab === "domains" ? "page" : undefined} className={tab === "more" || tab === "member" || tab === "assets" || tab === "favorites" || tab === "authenticator" || tab === "flow" || tab === "storage" || tab === "databases" || tab === "redis" || tab === "certificates" || tab === "ssh" || tab === "panels" || tab === "sync" || tab === "settings" || tab === "networkSettings" || tab === "operationLogs" || tab === "apiLogs" || tab === "about" || tab === "accounts" || tab === "servers" || tab === "domains" ? "active" : ""} onClick={() => { setNotice(""); setTab("more"); }}><UserRound size={20} aria-hidden="true" /><span>我的</span></button>
      </nav>

      {backAction && !isBottomNavigationTab && !settingsPageOpen && tab !== "member" && tab !== "personalProfile" && <button type="button" className="mobile-back-fab" aria-label={`${backAction.label}，可拖动调整位置`} title={`${backAction.label}（拖动调整位置，方向键微调）`} style={backFabPos ? { left: "auto", top: "auto", right: backFabPos.right, bottom: backFabPos.bottom } : undefined} onPointerDown={startBackFabDrag} onPointerMove={dragBackFab} onPointerUp={endBackFabDrag} onPointerCancel={(event) => endBackFabDrag(event, true)} onLostPointerCapture={(event) => endBackFabDrag(event, true)} onKeyDown={moveBackFabByKeyboard} onContextMenu={(event) => { if (backFabDragRef.current?.dragging) event.preventDefault(); }} onClick={clickBackFab}><ArrowLeft size={20} /></button>}
      {productDialog && <SharedDialog title={resourceLabels[productDialog.type as keyof typeof resourceLabels]} subtitle={productDialog.account.account_name} className="mobile-account-product-dialog" onClose={closeAccountProduct} footer={<>
        {(selectedDomain || selectedBucket || selectedDatabase || selectedRedis) && backAction && <button type="button" className="secondary" onClick={backAction.onClick}><ArrowLeft size={16} />{backAction.label}</button>}
        <button type="button" className="secondary" onClick={closeAccountProduct}>关闭</button>
        {productDialog.type !== "esa" && <button type="button" className="primary" disabled={loading || syncing} onClick={() => void pullRefreshActionRef.current?.()}><RefreshCw size={16} />刷新</button>}
      </>}>

        {productDialog.type === "esa" ? <MobileEsaProducts account={productDialog.account} accounts={accounts} onConfirm={message => confirm({ message })} /> : resourcePage}
      </SharedDialog>}
      {showCertificateRequest && <MobileCertificateRequest accounts={accounts} onClose={() => setShowCertificateRequest(false)} onIssued={() => void refreshCertificates()} />}
      {showAddAccount && <SharedDialog title={editingAccount ? "编辑云账号" : "添加云账号"} subtitle="填写云厂商账号信息，统一管理云资源" icon={<Cloud size={22} />} size="small" className="mobile-cloud-account-dialog" onSubmit={(event) => void saveAccount(event)} onClose={() => { setShowAddAccount(false); setEditingAccount(null); }} footer={<><button className="secondary" type="button" onClick={() => { setShowAddAccount(false); setEditingAccount(null); }}>取消</button><button className="primary" type="submit"><ShieldCheck size={16} aria-hidden="true" />{editingAccount ? "保存配置" : "保存到本机"}</button></>}>
        <DialogField label="云厂商" required icon={<MobileProviderMark cloudType={newAccountCloud} />}><select aria-label="云厂商" value={newAccountCloud} disabled={!!editingAccount} onChange={(event) => setNewAccountCloud(event.target.value)}>{cloudProviders.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}</select></DialogField>
        <DialogField label="账号名称" required icon={<FileText size={18} />} hint="自定义名称，便于区分生产、测试等不同账号"><input name="accountName" required maxLength={80} autoComplete="organization" defaultValue={editingAccount?.account_name} placeholder="生产环境" /></DialogField>
        {newAccountCloud === "oracle" && <><DialogField label="Tenancy OCID" required><input name="tenancyOcid" required maxLength={256} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "tenancy_ocid")} placeholder="ocid1.tenancy..." /></DialogField><DialogField label="Key Fingerprint" required><input name="keyFingerprint" required maxLength={100} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "key_fingerprint")} placeholder="aa:bb:cc:..." /></DialogField></>}
        {newAccountCloud === "azure" && <><DialogField label="Tenant ID" required><input name="tenantId" required maxLength={100} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "tenant_id")} /></DialogField><DialogField label="Subscription ID" required><input name="subscriptionId" required maxLength={100} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "subscription_id")} /></DialogField></>}
        {newAccountCloud === "gcp" && <DialogField label="Project ID" required><input name="projectId" required maxLength={100} autoComplete="off" defaultValue={accountMetaValue(editingAccount, "project_id")} /></DialogField>}
        <DialogField label={cloudProvider(newAccountCloud).idLabel} required={newAccountCloud !== "vultr"} icon={<KeyRound size={18} />}><input name="accessKeyId" required={newAccountCloud !== "vultr"} maxLength={2048} autoComplete="off" defaultValue={editingAccount?.access_key_id} placeholder={newAccountCloud === "vultr" ? "可留空，账号名称用于本地识别" : `请输入 ${cloudProvider(newAccountCloud).idLabel}`} /></DialogField>
        <DialogField label={cloudProvider(newAccountCloud).secretLabel} required={!editingAccount} icon={<LockKeyhole size={18} />}>{newAccountCloud === "oracle" || newAccountCloud === "gcp" ? <SecretField key={`${editingAccount?.id ?? "new"}:${newAccountCloud}`} multiline secretLabel={cloudProvider(newAccountCloud).secretLabel} reveal={editingAccount ? () => accountsClient.revealSecret(editingAccount.id) : undefined} name="accessKeySecret" required={!editingAccount} maxLength={32768} rows={6} autoComplete="off" spellCheck={false} /> : <SecretField key={`${editingAccount?.id ?? "new"}:${newAccountCloud}`} secretLabel={cloudProvider(newAccountCloud).secretLabel} reveal={editingAccount ? () => accountsClient.revealSecret(editingAccount.id) : undefined} name="accessKeySecret" required={!editingAccount} maxLength={8192} autoComplete="new-password" placeholder={`请输入 ${cloudProvider(newAccountCloud).secretLabel}`} />}</DialogField>
        {editingAccount && <p className="mobile-form-hint">留空会保留本机加密凭据。更改密钥 ID 时必须同时输入新 Secret。</p>}
        <DialogField label="默认地域" icon={<Globe2 size={18} />}><input name="regionId" maxLength={100} defaultValue={editingAccount?.region_id} placeholder={cloudProvider(newAccountCloud).regionPlaceholder} autoComplete="off" /></DialogField>
        <DialogField label="分组" icon={<Folder size={18} />}><GroupNameInput groups={accounts.map(account => account.group_name || "")} name="groupName" placeholder="选择或新建分组" maxLength={80} defaultValue={editingAccount?.group_name} /></DialogField>
        <DialogField label="账号状态" icon={<Power size={18} />}><select name="enabled" defaultValue={editingAccount?.enabled === false ? "false" : "true"}><option value="true">启用</option><option value="false">停用</option></select></DialogField>
        <DialogField label="备注" showCount><textarea name="remark" maxLength={500} rows={2} defaultValue={editingAccount?.remark} placeholder="选填，添加备注便于后续管理" /></DialogField>
        <DialogNotice>密钥仅加密保存在本机，建议授予只读权限。</DialogNotice>
      </SharedDialog>}

      {showAddSshHost && <SharedDialog title={editingSshHost ? "编辑 SSH 主机" : "添加 SSH 主机"} subtitle="保存连接信息，随时安全连接主机" icon={<Server size={22} />} size="small" className="mobile-ssh-dialog" formRef={sshHostFormRef} busy={sshHostSaving} closeDisabled={sshHostSaving} onSubmit={(event) => void addManagedHost(event)} onClose={() => setShowAddSshHost(false)} footer={<><button className="secondary" type="button" disabled={sshHostSaving} onClick={() => setShowAddSshHost(false)}>取消</button><button className="primary" type="submit" disabled={sshHostSaving}><ShieldCheck size={17} aria-hidden="true" />{sshHostSaving ? "正在保存…" : editingSshHost ? "保存修改" : "加密保存主机"}</button></>}>
        <AiAssistButton task="server" title="AI 识别主机信息" current={{name:editingSshHost?.name ?? "",host:editingSshHost?.host ?? "",port:editingSshHost?.port ?? 22,username:editingSshHost?.username ?? "root"}} onApply={({fields})=>applyFormFields(sshHostFormRef.current,fields,["name","host","port","username"])} /><DialogField label="显示名称"><input defaultValue={editingSshHost?.name ?? ""} name="name" maxLength={100} autoComplete="off" placeholder="例如：生产 Web 服务器" /></DialogField><DialogField label="主机地址"><input defaultValue={editingSshHost?.host ?? ""} name="host" required maxLength={253} autoCapitalize="off" autoComplete="url" placeholder="主机名或 IP 地址" /></DialogField><div className="mobile-form-grid"><DialogField label="SSH 端口"><input name="port" type="number" min="1" max="65535" defaultValue={editingSshHost?.port ?? 22} inputMode="numeric" /></DialogField><DialogField label="用户名"><input name="username" required maxLength={128} defaultValue={editingSshHost?.username ?? "root"} autoComplete="username" /></DialogField></div><DialogField label="认证方式"><select disabled={editingSshHost?.platform === "windows"} value={newSshAuthMethod} onChange={(event) => setNewSshAuthMethod(event.target.value as "password" | "private_key")}><option value="password">密码</option><option value="private_key">SSH 私钥</option></select></DialogField>{newSshAuthMethod === "password" ? <DialogField label="SSH 密码"><SecretField name="password" required={!editingSshHost?.password_saved} placeholder={editingSshHost?.password_saved ? "留空保留已保存密码" : "输入 SSH 密码"} secretLabel="SSH 密码" maxLength={8192} autoComplete="new-password" /></DialogField> : <><DialogField label="SSH 私钥"><SecretField multiline secretLabel="SSH 私钥" name="privateKey" required={!editingSshHost?.private_key_saved} maxLength={32768} rows={7} autoComplete="off" spellCheck={false} placeholder={editingSshHost?.private_key_saved ? "留空保留已保存私钥" : "粘贴 OpenSSH 或 PEM 私钥"} /></DialogField><DialogField label="私钥口令（可选）"><SecretField name="keyPassphrase" secretLabel="私钥口令" maxLength={8192} autoComplete="new-password" /></DialogField></>}{editingSshHost && <p className="mobile-form-hint">密码、私钥及口令留空保留原凭据；更换私钥时请同时填写新私钥的口令（如有）。</p>}<p className="mobile-form-hint">AI 只识别名称、地址、端口和用户名；密码与私钥须手动填写。保存时凭据会在 Rust 原生层加密；连接时会校验并记住主机指纹。</p>
      </SharedDialog>}

      {panelDraft && <SharedDialog title={panelDraft.id ? "编辑运维面板" : "添加运维面板"} subtitle="连接面板，统一管理服务器与站点" size="small" className="mobile-panel-dialog" closeLabel="关闭面板表单" closeDisabled={panelSaving} busy={panelSaving} onSubmit={(event) => void savePanel(event)} onClose={() => setPanelDraft(null)} footer={<><button className="secondary" type="button" disabled={panelSaving} onClick={() => setPanelDraft(null)}>取消</button><button className="primary" type="submit" disabled={panelSaving}><ShieldCheck size={17} aria-hidden="true" />{panelSaving ? "正在验证并保存…" : "验证并加密保存"}</button></>}>
        <AiAssistButton task="panel" title="AI 识别面板信息" current={{name:panelDraft.name,panel_url:panelDraft.panel_url,group_name:panelDraft.group_name,remark:panelDraft.remark}} disabled={panelSaving} onApply={({fields})=>{const candidate=panelAiFields(fields);setPanelDraft(current=>current?({...current,...candidate}):current);}} /><DialogField label="面板名称"><input placeholder="例如：生产环境" required maxLength={100} autoComplete="off" value={panelDraft.name} onChange={(event) => setPanelDraft({ ...panelDraft, name: event.target.value })} /></DialogField><DialogField label="面板根地址"><input required type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" maxLength={2048} autoComplete="url" value={panelDraft.panel_url} onChange={(event) => setPanelDraft({ ...panelDraft, panel_url: event.target.value })} placeholder="https://panel.example.com" /></DialogField><DialogField label="API 密钥"><SecretField key={panelDraft.id ?? "new"} secretLabel="API 密钥" reveal={panelDraft.id ? () => remoteClient.revealPanelApiKey(panelDraft.id!) : undefined} maxLength={8192} autoComplete="new-password" value={panelDraft.api_key} onChange={(event) => setPanelDraft({ ...panelDraft, api_key: event.target.value })} placeholder={panelDraft.id ? "留空以保留已保存的密钥" : "首次添加必须填写"} required={!panelDraft.id} /></DialogField><div className="mobile-form-grid"><DialogField label="分组"><GroupNameInput groups={panelConnections.map(panel => panel.group_name || "")} maxLength={80} value={panelDraft.group_name} onChange={(event) => setPanelDraft({ ...panelDraft, group_name: event.target.value })} /></DialogField><DialogField label="排序"><input type="number" min="0" max="100000" inputMode="numeric" value={panelDraft.sort_order} onChange={(event) => setPanelDraft({ ...panelDraft, sort_order: Number(event.target.value) })} /></DialogField></div><DialogField label="备注"><input maxLength={500} autoComplete="off" value={panelDraft.remark} onChange={(event) => setPanelDraft({ ...panelDraft, remark: event.target.value })} /></DialogField><label className="mobile-panel-check"><input type="checkbox" checked={panelDraft.allow_insecure_tls} onChange={(event) => setPanelDraft({ ...panelDraft, allow_insecure_tls: event.target.checked })} />允许不安全 TLS 证书（仅在面板使用自签名证书时开启）</label><p className="mobile-form-hint">手机会直接连接面板验证配置。点击小眼睛可查看密钥，留空会保留本机已加密密钥。</p>
      </SharedDialog>}

      {dnsEditor !== undefined && <SharedDialog title={dnsEditor ? "编辑 DNS 记录" : "新增 DNS 记录"} subtitle={selectedDomainName} size="small" className="mobile-dns-dialog" closeLabel="关闭 DNS 表单" formRef={dnsFormRef} closeDisabled={dnsSaving} busy={dnsSaving} onSubmit={(event) => void saveDnsRecord(event)} onClose={() => setDnsEditor(undefined)} footer={<><button className="secondary" type="button" disabled={dnsSaving} onClick={() => setDnsEditor(undefined)}>取消</button><button className="primary" type="submit" disabled={dnsSaving}><ShieldCheck size={17} aria-hidden="true" />{dnsSaving ? "正在保存…" : "保存记录"}</button></>}>

        <div className="mobile-dns-body">
          <div className="mobile-dns-ai"><AiAssistButton task="dns" title="AI 识别 DNS 草稿" current={{type:dnsRecordType,rr:dnsHostRecord,value:String(dnsEditor?.Value??""),ttl:Number(dnsEditor?.TTL??600),priority:Number(dnsEditor?.Priority??10),line:String(dnsEditor?.Line??"default")}} text={`当前域名：${selectedDomainName}`} disabled={dnsSaving} onApply={({fields})=>{const form=dnsFormRef.current;if(!form)throw new Error("表单已关闭，请重新打开后再应用");const data=new FormData(form);const candidate=parseDnsPaste(JSON.stringify({type:data.get("recordType"),...Object.fromEntries(data.entries()),...fields}),selectedDomainName)[0];if(!candidate)throw new Error("未得到有效 DNS 记录，请核对字段");if(!["A","AAAA","CNAME","MX","TXT","NS","SRV","CAA"].includes(candidate.type))throw new Error("手机端暂不支持此 DNS 记录类型，请在桌面端核对后手动填写");setDnsRecordType(candidate.type);setDnsHostRecord(candidate.rr??"@");setDnsHostError("");applyFormFields(form,{value:candidate.value,ttl:candidate.ttl??600,priority:candidate.priority??10,line:candidate.line??"default"},["value","ttl","priority","line"]);}} /></div>
          <DialogField label="记录类型"><select name="recordType" value={dnsRecordType} disabled={dnsSaving} onChange={(event) => setDnsRecordType(event.currentTarget.value)}><option>A</option><option>AAAA</option><option>CNAME</option><option>MX</option><option>TXT</option><option>NS</option><option>SRV</option><option>CAA</option></select></DialogField>
          <DialogField label="主机记录"><input name="rr" required maxLength={253} value={dnsHostRecord} disabled={dnsSaving} onChange={(event) => {setDnsHostRecord(event.currentTarget.value);setDnsHostError("");}} onBlur={() => {try {setDnsHostRecord(normalizeDnsHost(dnsHostRecord, selectedDomainName));setDnsHostError("");} catch (error) {setDnsHostError(error instanceof Error ? error.message : "无法识别主机记录。");}}} autoFocus placeholder="@ 或 www" aria-invalid={!!dnsHostError} aria-describedby="mobile-dns-host-help mobile-dns-host-feedback" /></DialogField>
          <div className="mobile-dns-host-shortcuts" role="group" aria-label="主机记录快捷录入">{["@","www","*","api","mail",...(dnsRecordType==="TXT"?["_acme-challenge","_dmarc","default._domainkey"]:[]),...(dnsRecordType==="SRV"?["_sip._tcp"]:[])].map((host)=><button key={host} type="button" disabled={dnsSaving} aria-pressed={dnsHostRecord===host} onClick={()=>{setDnsHostRecord(host);setDnsHostError("");}}>{host==="@"?"根域名 @":host==="*"?"泛域名 *":host==="www"?"网站 www":host==="_acme-challenge"?"证书验证":host==="_dmarc"?"DMARC":host==="default._domainkey"?"DKIM 示例":host==="_sip._tcp"?"SIP 示例":host}</button>)}</div>
          {dnsHostError ? <small id="mobile-dns-host-feedback" className="mobile-dns-error" role="alert">{dnsHostError}</small> : dnsHostPreview ? <small id="mobile-dns-host-feedback" className="mobile-dns-preview" aria-live="polite">完整域名：<strong>{dnsHostPreview}</strong></small> : null}
          <small id="mobile-dns-host-help" className="mobile-dns-help">只填写域名前缀；@ 表示根域名，* 表示泛域名。也可粘贴当前域名或网址。</small>
          <DialogField label="记录值"><input name="value" required maxLength={2048} defaultValue={String(dnsEditor?.Value ?? "")} disabled={dnsSaving} placeholder="请输入记录值" aria-describedby="mobile-dns-value-help" /></DialogField>
          <small id="mobile-dns-value-help" className="mobile-dns-help">{mobileDnsValueHints[dnsRecordType] ?? "按 DNS 服务商要求填写记录值。"}</small>
          <details className="mobile-dns-advanced"><summary>高级选项</summary>
            <DialogField label="TTL"><select name="ttl" defaultValue={String(dnsEditor?.TTL ?? 600)} disabled={dnsSaving}>{![60,120,300,600,1800,3600,43200,86400].includes(Number(dnsEditor?.TTL ?? 600))&&<option value={String(dnsEditor?.TTL)}>{String(dnsEditor?.TTL)} 秒（当前）</option>}<option value="60">1 分钟</option><option value="120">2 分钟</option><option value="300">5 分钟</option><option value="600">10 分钟</option><option value="1800">30 分钟</option><option value="3600">1 小时</option><option value="43200">12 小时</option><option value="86400">1 天</option></select></DialogField>
            <DialogField label="解析线路"><select name="line" defaultValue={String(dnsEditor?.Line ?? "default")} disabled={dnsSaving}>{!["default","telecom","unicom","mobile","oversea","edu","search"].includes(String(dnsEditor?.Line ?? "default"))&&<option value={String(dnsEditor?.Line)}>{String(dnsEditor?.Line)}（当前线路）</option>}<option value="default">默认</option><option value="telecom">电信</option><option value="unicom">联通</option><option value="mobile">移动</option><option value="oversea">境外</option><option value="edu">教育网</option><option value="search">搜索引擎</option></select></DialogField>
            {dnsRecordType === "MX" && <DialogField label="MX 优先级"><input name="priority" type="number" min="1" max="50" inputMode="numeric" defaultValue={Number(dnsEditor?.Priority ?? 10)} disabled={dnsSaving} /></DialogField>}
          </details>
          <p className="mobile-dns-warning">AI 生成的 DNS 记录仍需核对；保存后会直接修改云厂商配置。</p>
        </div>

      </SharedDialog>}
      {serverActionConfirmation && <ConfirmDialog title="确认服务器操作" message={`确认${serverActionConfirmation.action === "reboot" ? "重启" : serverActionConfirmation.action === "start" ? "启动" : "停止"}服务器“${payloadText(serverActionConfirmation.server.payload, ["instanceName", "InstanceName", "name", "Name", "serverName"])}”吗？`} confirmLabel="确认操作" onResolve={confirmed => {
        const target = serverActionConfirmation;
        setServerActionConfirmation(null);
        if (confirmed) void runServerAction(target.server, target.action, target.forceStop);
      }}>
        {serverActionConfirmation.action === "reboot" && <>
          <DialogField label="重启方式"><select value={serverActionConfirmation.forceStop ? "force" : "normal"} onChange={event => setServerActionConfirmation(current => current ? { ...current, forceStop: event.target.value === "force" } : current)}><option value="normal">普通重启</option><option value="force">强制重启</option></select></DialogField>
          <DialogNotice>{serverActionConfirmation.forceStop ? "强制重启会立即中断服务，可能导致未保存的数据丢失。仅在服务器无响应时使用。" : "普通重启会尝试正常关闭系统后重新启动，服务将暂时中断。"}</DialogNotice>
        </>}
      </ConfirmDialog>}
      {cloudflareTarget && <CloudflareManager key={cloudflareTarget.account.id} account={cloudflareTarget.account} initialKind={cloudflareTarget.kind} onClose={() => setCloudflareTarget(null)} onChanged={refreshMobileAssets} onConfirm={message => confirm({ message })} />}
      {confirmationDialog}
      {member && activeMemberIdentity && <MobileMemberIdentityDialog member={member} identity={activeMemberIdentity} onClose={() => setActiveMemberIdentity(null)} />}
      {mobileQrResult && <SharedDialog title="识别到二维码" subtitle="请选择接下来要执行的操作" size="small" showResize={false} className="mobile-qr-result-dialog" onClose={closeMobileQrResult} footer={<button type="button" className="secondary" onClick={closeMobileQrResult}>取消</button>}>
        {mobileQrKind(mobileQrResult) === "authenticator" ? <>
          <p>识别到身份验证器二维码。添加前会进入现有验证器流程进行解析和确认。</p>
          <button type="button" className="primary mobile-qr-result-action" onClick={() => { setPendingOtpUri(mobileQrResult); closeMobileQrResult(); sectionOriginRef.current = null; setTab("authenticator"); }}><ShieldCheck size={17} aria-hidden="true" />添加到身份验证器</button>
        </> : mobileQrKind(mobileQrResult) === "transfer" ? <>
          <p>识别到 CloudHub 配置迁移二维码。继续后将请求电脑端确认，并由你选择导入范围。</p>
          <button type="button" className="primary mobile-qr-result-action" onClick={() => { setPendingTransferQr(mobileQrResult); closeMobileQrResult(); setTab("sync"); }}><CloudDownload size={17} aria-hidden="true" />接收电脑配置</button>
        </> : mobileQrKind(mobileQrResult) === "link" ? <>
          <p>识别到网页链接：<strong>{new URL(mobileQrResult).host}</strong></p>
          <button type="button" className="primary mobile-qr-result-action" onClick={() => { const url = new URL(mobileQrResult); if (url.protocol !== "https:" && url.protocol !== "http:") return; void openUrl(url.toString()).then(closeMobileQrResult).catch(() => setNotice("无法打开此链接，请重试。")); }}><ExternalLink size={17} aria-hidden="true" />打开链接</button>
        </> : <>
          <p>识别到文本二维码（{mobileQrResult.length} 个字符）。为避免直接展示敏感内容，你可以选择复制到剪贴板。</p>
          <button type="button" className="primary mobile-qr-result-action" onClick={() => void copyMobileQrResult()}><FileText size={17} aria-hidden="true" />复制识别内容</button>
        </>}
      </SharedDialog>}
    </main>
  );
}
