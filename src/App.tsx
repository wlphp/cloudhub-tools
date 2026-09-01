import { FormEvent, PointerEvent, type CSSProperties, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  ArrowUp,
  ArrowUpCircle,
  ArrowDown,
  AlertTriangle,
  Bookmark,
  BookmarkCheck,
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Cloud,
  Copy,
  Database,
  Download,
  FileCode2,
  FolderOpen,
  FolderPlus,
  Globe2,
  GripVertical,
  Eye,
  EyeOff,
  MoreHorizontal,
  MoreVertical,
  Monitor,
  List,
  Terminal,
  FileText,
  Plus,
  Power,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings,
  Square,
  Star,
  Trash2,
  Upload,
  UserRound,
  X,
  Maximize2,
  Minimize2,
  Minus,
  Keyboard,
  PanelRightClose,
  PanelRightOpen,
  Palette,
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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, runningInTauri, webApi } from "./platform/api";
import {
  assetFavoriteKey,
  savedFavoriteAssetKeys,
  stringListFromValue,
  stringRecordFromValue,
} from "./features/assets/preferences";
import {
  assetTypes as catalogAssetTypes,
  cloudProvider as getCloudProvider,
  cloudProviders as catalogCloudProviders,
  emptyAccountDraft,
  emptyManagedHostDraft,
  emptyPanelConnectionDraft,
  providerSyncDescription as getProviderSyncDescription,
  resourceLabels,
  supportsResourceSync as accountSupportsResourceSync,
  syncAssetTypes as getSyncAssetTypes,
} from "./features/cloud/catalog";
import { DnsEditorDialog } from "./features/domains/DnsEditorDialog";
import { FavoriteServerDetails, ServerCard } from "./features/servers/ServerCards";
import { SwasCard } from "./features/servers/SwasCard";
import { RdsCard } from "./features/resources/RdsCard";
import { RedisCard } from "./features/resources/RedisCard";
import { BucketCard } from "./features/storage/BucketCard";
import type {
  Account,
  ApiLog,
  ConfirmRequest,
  DomainTool,
  Draft,
  EsaOverview,
  LocalAsset,
  ManagedHost,
  ManagedHostDraft,
  PanelConnection,
  PanelConnectionDraft,
  PromptRequest,
  ResourceResponse,
  SavedRdpConnection,
  SavedSshConnection,
  SshAuthMethod,
  SshConnectResult,
  SshDirectoryListing,
  SshFileEntry,
  SshTarget,
  TerminalWorkspaceTab,
  TransferAccount,
  View,
} from "./shared/types";


const cloudHubFavoriteAssetsStorageKey = "cloudhub-tools-favorite-assets";
const cloudHubFavoriteAssetOrderStorageKey = "cloudhub-tools-favorite-asset-order";
const cloudHubAssetNotesStorageKey = "cloudhub-tools-asset-notes";
const cloudHubAssetOrderStorageKey = "cloudhub-tools-asset-order";
const cloudHubAssetDisplayNamesStorageKey = "cloudhub-tools-asset-display-names";
const cloudHubManagedHostOrderStorageKey = "cloudhub-tools-managed-host-order";
const cloudHubManagedHostGroupOrderStorageKey = "cloudhub-tools-managed-host-group-order";
const cloudHubTerminalThemeStorageKey = "cloudhub-tools-terminal-theme";

const terminalThemes = {
  dark: {
    label: "深色",
    background: "#000000", foreground: "#f5f5f5", cursor: "#f5f5f5", selectionBackground: "#295b91",
    black: "#000000", brightBlack: "#8a8a8a", red: "#ff6b6b", brightRed: "#ff8b8b", green: "#61d095", brightGreen: "#7ff0b0", yellow: "#f6d365", brightYellow: "#ffe38c", blue: "#70b7ff", brightBlue: "#9dceff", magenta: "#d29cff", brightMagenta: "#e5bfff", cyan: "#66d9ef", brightCyan: "#9beaff", white: "#e6e6e6", brightWhite: "#ffffff",
  },
  blue: {
    label: "蓝墨",
    background: "#071523", foreground: "#dceeff", cursor: "#7fc8ff", selectionBackground: "#22527d",
    black: "#071523", brightBlack: "#607d98", red: "#ff7788", brightRed: "#ff9dab", green: "#69dca5", brightGreen: "#9befc2", yellow: "#f4cf72", brightYellow: "#ffe39c", blue: "#6ab6ff", brightBlue: "#9ad2ff", magenta: "#d4a5ff", brightMagenta: "#e8c7ff", cyan: "#65d7e8", brightCyan: "#a7f0f7", white: "#c6dceb", brightWhite: "#ffffff",
  },
  green: {
    label: "松绿",
    background: "#081914", foreground: "#d5f2df", cursor: "#7ce6a4", selectionBackground: "#1e5741",
    black: "#081914", brightBlack: "#668b7b", red: "#f07878", brightRed: "#ffaaaa", green: "#5fd492", brightGreen: "#8df1bb", yellow: "#e8c96a", brightYellow: "#ffe596", blue: "#68bfff", brightBlue: "#9bd5ff", magenta: "#d1a7ff", brightMagenta: "#e4c6ff", cyan: "#65d8c5", brightCyan: "#a4f4e5", white: "#cce4d5", brightWhite: "#ffffff",
  },
  amber: {
    label: "暖琥珀",
    background: "#1a1208", foreground: "#f8ead2", cursor: "#ffd080", selectionBackground: "#65451a",
    black: "#1a1208", brightBlack: "#927957", red: "#ef7e72", brightRed: "#ffafa2", green: "#9ed27d", brightGreen: "#c6ef9e", yellow: "#f2c35f", brightYellow: "#ffe19a", blue: "#79b7ed", brightBlue: "#a9d5ff", magenta: "#d6a2ed", brightMagenta: "#eac5fb", cyan: "#6ed3c7", brightCyan: "#aaf0e6", white: "#e7d4b5", brightWhite: "#fff7e9",
  },
} as const;

type TerminalThemeName = keyof typeof terminalThemes;

const empty = emptyAccountDraft;
const emptyManagedHost = emptyManagedHostDraft;
const emptyPanelConnection = emptyPanelConnectionDraft;
const labels = resourceLabels;
const cloudProviders = catalogCloudProviders;
type AccountResourceType = (typeof catalogAssetTypes)[number][0];
type AccountResourceView = Exclude<View, "summary">;
const accountResourceViews: readonly AccountResourceView[] = ["ecs", "domain", "oss", "rds", "redis", "swas", "esa"];
const accountResourceActionLabels: Record<AccountResourceType, string> = {
  ecs: "服务器",
  domain: "域名",
  oss: "对象存储",
  rds: "云数据库",
  redis: "Redis",
  swas: "轻量服务器",
  esa: "边缘安全加速",
  block: "块存储",
  network: "私有网络",
  firewall: "防火墙",
  ip: "保留 IP",
  loadbalancer: "负载均衡",
  snapshot: "快照",
  kubernetes: "Kubernetes",
};

function cloudProvider(value: string) {
  return getCloudProvider(value);
}

function supportsResourceSync(account: Account) {
  return accountSupportsResourceSync(account);
}

function providerSyncDescription(cloudType: string) {
  return getProviderSyncDescription(cloudType);
}

function syncAssetTypes(account: Account): ReadonlyArray<(typeof assetTypes)[number]> {
  return getSyncAssetTypes(account);
}
const assetTypes = catalogAssetTypes;

const bundledVersion = "0.1.22";
const isDevelopmentBuild = import.meta.env.DEV;

type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "available"; version: string; notes?: string }
  | { phase: "downloading"; version: string; downloaded: number; total?: number }
  | { phase: "ready"; version: string }
  | { phase: "current" }
  | { phase: "error"; message: string };

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (Array.isArray(value))
    return value.length
      ? value.map((item) => displayValue(item)).join("、")
      : "-";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("IpAddress" in obj) return displayValue(obj.IpAddress);
    const values = Object.values(obj).filter((v) => v !== null && v !== undefined && v !== "");
    return values.length ? values.map((v) => displayValue(v)).join(", ") : "-";
  }
  return String(value);
}
function firstAddress(value: unknown): string {
  if (Array.isArray(value)) return firstAddress(value[0]);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return firstAddress(record.IpAddress || record.Address || Object.values(record)[0]);
  }
  return String(value || "").trim();
}
function remotePlatformFromPayload(payload: Record<string, unknown>): "linux" | "windows" {
  const system = [payload.OSName, payload.OSType, payload.ImageName, payload.ImageId, payload.Platform, payload.SystemType]
    .map((value) => displayValue(value))
    .join(" ");
  return /windows|win(?:dows)?\s*(?:server)?/i.test(system) ? "windows" : "linux";
}
function formatJson(value: string | null | undefined): string {
  if (!value) return "-";
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}
function parseDateValue(value: unknown): Date {
  if (typeof value === "number") {
    const milliseconds = value < 100000000000 ? value * 1000 : value;
    return new Date(milliseconds);
  }
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    return new Date(numeric < 100000000000 ? numeric * 1000 : numeric);
  }
  return new Date(text);
}
function formatAssetDate(value: unknown): string {
  if (!value) return "未获取";
  const date = parseDateValue(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function formatChineseDateTime(value: unknown): string {
  if (!value) return "-";
  const date = parseDateValue(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function displayDnsServers(value: unknown): string {
  if (Array.isArray(value))
    return value.map(displayDnsServers).filter(Boolean).join(", ");
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const values = Object.values(object).map(displayDnsServers).filter(Boolean);
    return values.join(", ");
  }
  return value == null || value === "" ? "" : String(value);
}
function formatMoney(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : displayValue(value);
}
function daysUntil(value: unknown) {
  if (!value) return null;
  const time = Date.parse(String(value).replace(" ", "T"));
  return Number.isNaN(time) ? null : Math.ceil((time - Date.now()) / 86400000);
}
function domainStatus(item: Record<string, unknown>): [string, string] {
  const days = daysUntil(item.ExpirationDate);
  if (days !== null && days < 0) return ["已过期", "status-expired"];
  if (item.DomainStatus === "PAUSE") return ["暂停", "status-other"];
  return ["正常", "status-normal"];
}
function cloudStatusText(value: unknown): string {
  const status = String(value || "-");
  return (
    (
      {
        Running: "运行中",
        Normal: "运行中",
        Stopped: "已停止",
        Creating: "创建中",
        Deleting: "删除中",
        Rebooting: "重启中",
        running: "运行中",
        stopped: "已停止",
        pending: "处理中",
        active: "已启用",
        inactive: "未启用",
        suspended: "已暂停",
        rebuilding: "重建中",
      } as Record<string, string>
    )[status] || status
  );
}
function formatBytes(value: unknown): string {
  let bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index += 1;
  }
  return `${bytes.toFixed(index ? 2 : 0)} ${units[index]}`;
}
function formatMetric(value: unknown): string {
  const number = Number(value || 0);
  return Number.isFinite(number) ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(number) : "0";
}
function panelAddress(value: string): string {
  try { return new URL(value).hostname; } catch { return value.replace(/^https?:\/\//, "").split(/[/:?#]/)[0] || value; }
}
function hiddenPanelAddress(value: string): string {
  const address = panelAddress(value);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    const parts = address.split(".");
    return `${parts[0]}.***.***.${parts[3]}`;
  }
  return address.includes(":") ? "****" : address;
}
function panelMetricNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (match) return Number(match[0]);
  }
  return null;
}
function panelMetricRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function panelMetricField(value: unknown, keys: string[]): unknown {
  const record = panelMetricRecord(value);
  return record ? keys.map((key) => record[key]).find((item) => item !== undefined && item !== null && item !== "") : undefined;
}
function panelPercent(value: unknown): number | null {
  const percent = panelMetricNumber(value);
  return percent === null ? null : Math.max(0, Math.min(100, percent <= 1 ? percent * 100 : percent));
}
function formatPanelNumber(value: unknown): string {
  const number = panelMetricNumber(value);
  return number === null ? displayValue(value) : formatMetric(number);
}
function panelLoadText(value: unknown): string {
  const values = Array.isArray(value)
    ? value.slice(0, 3)
    : [panelMetricField(value, ["one"]), panelMetricField(value, ["five"]), panelMetricField(value, ["fifteen"])];
  const visible = values.filter((item) => item !== undefined && item !== null && item !== "").map(formatPanelNumber);
  return visible.length ? visible.join(" / ") : "-";
}
function panelCpuInfo(value: unknown): { detail: string; percent: number | null } {
  const usage = Array.isArray(value) ? value[0] : panelMetricField(value, ["used_percent", "usage", "used", "cpuRealUsed"]);
  const cores = Array.isArray(value) ? value[1] : panelMetricField(value, ["cores", "cpuNum", "count"]);
  const percent = panelPercent(usage);
  const coreText = cores === undefined || cores === null || cores === "" ? "-" : `${formatPanelNumber(cores)} 核`;
  return { detail: percent === null ? coreText : `${coreText} (${formatPanelNumber(percent)}%)`, percent };
}
function panelMemoryInfo(value: unknown): { detail: string; percent: number | null } {
  const used = panelMetricField(value, ["used", "memRealUsed", "realUsed"]);
  const total = panelMetricField(value, ["total", "memTotal"]);
  const unit = String(panelMetricField(value, ["unit"]) || "MB");
  const calculated = panelMetricNumber(used) !== null && panelMetricNumber(total) !== null && Number(total) > 0 ? Number(used) / Number(total) * 100 : null;
  const percent = panelPercent(panelMetricField(value, ["used_percent", "percent", "usage"]) ?? calculated);
  if (used === undefined || total === undefined) return { detail: "-", percent };
  return { detail: `${formatPanelNumber(used)} / ${formatPanelNumber(total)} ${unit}${percent === null ? "" : ` (${formatPanelNumber(percent)}%)`}`, percent };
}
function formatPanelStorage(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "-";
  if (/^\d+(?:\.\d+)?\s*G$/i.test(text)) return text.replace(/\s*G$/i, " GB");
  if (/^\d+(?:\.\d+)?\s*M$/i.test(text)) return text.replace(/\s*M$/i, " MB");
  return text;
}
type PanelDiskInfo = { path: string; detail: string; percent: number | null };
function panelDiskItems(value: unknown): PanelDiskInfo[] {
  const record = panelMetricRecord(value);
  const disks = Array.isArray(value) ? value : Array.isArray(record?.volumes) ? record.volumes : [value];
  return disks.map((disk) => {
  const size = panelMetricField(disk, ["size"]);
  const used = panelMetricField(disk, ["used", "use"]) ?? (Array.isArray(size) ? size[1] : undefined);
  const total = panelMetricField(disk, ["total", "size_total"]) ?? (Array.isArray(size) ? size[0] : undefined);
  const percent = panelPercent(panelMetricField(disk, ["used_percent", "percent", "usage"]) ?? (Array.isArray(size) ? size[3] : undefined));
  const path = panelMetricField(disk, ["path", "rname", "mount"]);
    return {
      path: String(path || "-"),
      detail: used === undefined || total === undefined ? "-" : `${formatPanelStorage(used)} / ${formatPanelStorage(total)}${percent === null ? "" : ` (${formatPanelNumber(percent)}%)`}`,
      percent,
    };
  }).sort((left, right) => (left.path === "/" ? -1 : right.path === "/" ? 1 : left.path.localeCompare(right.path)));
}
function panelDiskInfo(value: unknown): PanelDiskInfo {
  return panelDiskItems(value)[0] || { path: "-", detail: "-", percent: null };
}
function panelNetworkInfo(value: unknown): { up: string; down: string } {
  const record = panelMetricRecord(value);
  const directUp = panelMetricField(value, ["up", "upload"]);
  const directDown = panelMetricField(value, ["down", "download"]);
  const interfaces = Object.entries(record || {}).filter(([, item]) => panelMetricRecord(item));
  const legacyRate = (keys: string[]) => {
    let hasValue = false;
    const total = interfaces.reduce((sum, [, item]) => {
      const amount = panelMetricNumber(panelMetricField(item, keys));
      if (amount === null) return sum;
      hasValue = true;
      return sum + amount;
    }, 0);
    return hasValue ? total : null;
  };
  const up = panelMetricNumber(directUp) ?? legacyRate(["up", "upload"]);
  const down = panelMetricNumber(directDown) ?? legacyRate(["down", "download"]);
  const rate = (amount: number | null) => {
    if (amount === null) return "-";
    const units = ["KB", "MB", "GB", "TB"];
    let value = amount;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${formatMetric(value)} ${units[index]}/s`;
  };
  return { up: rate(up), down: rate(down) };
}
function formatEsaTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "-";
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const columnLabels: Record<string, string> = {
  InstanceName: "实例名称",
  InstanceId: "实例 ID",
  Status: "状态",
  RegionId: "地域",
  PublicIpAddress: "公网 IP",
  PrivateIpAddress: "内网 IP",
  Cpu: "CPU",
  Memory: "内存(MB)",
  OSType: "系统类型",
  OSName: "操作系统",
  ExpiredTime: "到期时间",
  CreationTime: "创建时间",
  DomainName: "域名",
  DomainStatus: "域名状态",
  RegistrationDate: "注册时间",
  ExpirationDate: "到期时间",
  DBInstanceDescription: "实例名称",
  DBInstanceId: "实例 ID",
  DBInstanceStatus: "状态",
  DBInstanceType: "实例类型",
  DBInstanceClass: "规格",
  Engine: "引擎",
  EngineVersion: "引擎版本",
  ConnectionString: "连接地址",
  Port: "端口",
  KVStoreInstanceId: "实例 ID",
  ConnectionDomain: "连接地址",
  InstanceStatus: "状态",
  Capacity: "容量(GB)",
  Bandwidth: "带宽",
  CreateTime: "创建时间",
  EndTime: "到期时间",
  BucketName: "存储桶",
  Location: "地域",
  Name: "名称",
  PlanName: "套餐",
};
function columnLabel(key: string) {
  return columnLabels[key] || key.replace(/([A-Z])/g, " $1").trim();
}

function resourceColumns(items: Record<string, unknown>[]) {
  const preferred = [
    "InstanceName",
    "InstanceId",
    "Status",
    "RegionId",
    "PublicIpAddress",
    "PublicIp",
    "DomainName",
    "DBInstanceDescription",
    "DBInstanceId",
    "KVStoreInstanceId",
    "AssetId",
    "BucketName",
    "Name",
    "IpAddress",
    "SizeGb",
    "AttachedTo",
    "CreatedAt",
    "PlanName",
  ];
  const keys = Array.from(
    new Set(
      items.flatMap((item) =>
        Object.keys(item).filter((key) => !key.startsWith("_")),
      ),
    ),
  );
  const ordered = preferred.filter((key) => keys.includes(key));
  return [...ordered, ...keys.filter((key) => !ordered.includes(key))].slice(
    0,
    7,
  );
}

function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<number>>(() => new Set());
  const [keyword, setKeyword] = useState("");
  const [dialog, setDialog] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [promptRequest, setPromptRequest] = useState<PromptRequest | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [verifyingAccount, setVerifyingAccount] = useState(false);
  const [draft, setDraft] = useState<Draft>(empty);
  const [status, setStatus] = useState("");
  const [active, setActive] = useState<{ account: Account; view: View; source: "cache" | "live" } | null>(
    null,
  );
  const [ossQuickTool, setOssQuickTool] = useState<{
    accountId: number;
    bucket: string;
    kind: "files" | "stat";
  } | null>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [resources, setResources] = useState<ResourceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [moreId, setMoreId] = useState<number | null>(null);
  const [morePosition, setMorePosition] = useState<{ top: number; left: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const [filterField, setFilterField] = useState<
    "account_name" | "access_key_id"
  >("account_name");
  const [groupFilter, setGroupFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("1");
  const [cloudFilter, setCloudFilter] = useState("");
  const [domainKeyword, setDomainKeyword] = useState("");
  const [domainKeywordDraft, setDomainKeywordDraft] = useState("");
  const [domainSearchLoading, setDomainSearchLoading] = useState(false);
  const [accountSearchLoading, setAccountSearchLoading] = useState(false);
  const [domainTool, setDomainTool] = useState<DomainTool | null>(null);
  const [domainToolLoading, setDomainToolLoading] = useState(false);
  const [domainToolError, setDomainToolError] = useState("");
  const [domainToolData, setDomainToolData] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [domainToolFilter, setDomainToolFilter] = useState("");
  const [domainToolType, setDomainToolType] = useState("");
  const [domainToolDraftFilter, setDomainToolDraftFilter] = useState("");
  const [domainToolDraftType, setDomainToolDraftType] = useState("");
  const [domainToolPage, setDomainToolPage] = useState(1);
  const [domainToolPageSize] = useState(20);
  const [domainToolTotal, setDomainToolTotal] = useState(0);
  const [domainToolMaximized, setDomainToolMaximized] = useState(false);
  const [activeMaximized, setActiveMaximized] = useState(false);
  const [dnsEditor, setDnsEditor] = useState<{
    mode: "add" | "edit" | "quick";
    row?: Record<string, unknown>;
    preset?: { type?: string; rr?: string };
  } | null>(null);
  const [dnsInlineEdit, setDnsInlineEdit] = useState<{ recordId: string; field: "Value" | "RR" | "TTL" | "Priority" | "Line" } | null>(null);
  const [esaTab, setEsaTab] = useState<"overview" | "sites" | "functions">(
    "overview",
  );
  const [esaRange, setEsaRange] = useState("today");
  const [esaTrend, setEsaTrend] = useState<keyof EsaOverview["trend"]>("traffic");
  const [esaSelectedSiteId, setEsaSelectedSiteId] = useState("");
  const [esaOverview, setEsaOverview] = useState<EsaOverview | null>(null);
  const [esaSiteKeyword, setEsaSiteKeyword] = useState("");
  const [section, setSection] = useState<"accounts" | "resources" | "panels" | "servers" | "favorites" | "logs" | "api_logs" | "settings">("accounts");
  const [localAssets, setLocalAssets] = useState<LocalAsset[]>([]);
  const [panelConnections, setPanelConnections] = useState<PanelConnection[]>([]);
  const [panelDialog, setPanelDialog] = useState(false);
  const [panelDraft, setPanelDraft] = useState<PanelConnectionDraft>(emptyPanelConnection);
  const [panelSaving, setPanelSaving] = useState(false);
  const [panelLoadingId, setPanelLoadingId] = useState<number | null>(null);
  const [panelOpeningId, setPanelOpeningId] = useState<number | null>(null);
  const [panelSorting, setPanelSorting] = useState(false);
  const [draggedPanelId, setDraggedPanelId] = useState<number | null>(null);
  const [panelKeyword, setPanelKeyword] = useState("");
  const [panelGroup, setPanelGroup] = useState("");
  const [editingPanelRemark, setEditingPanelRemark] = useState<{ id: number; value: string; initial: string } | null>(null);
  const [selectedPanelIds, setSelectedPanelIds] = useState<Set<number>>(() => new Set());
  const [expandedPanelDisks, setExpandedPanelDisks] = useState<Set<number>>(() => new Set());
  const [panelImporting, setPanelImporting] = useState(false);
  const [hidePanelIps, setHidePanelIps] = useState(() => localStorage.getItem("aliyun-panel-hide-ip") === "1");
  const [panelOpenMode, setPanelOpenMode] = useState<"browser" | "copy">(() => localStorage.getItem("aliyun-panel-open-mode") === "copy" ? "copy" : "browser");
  const [panelRefreshSeconds, setPanelRefreshSeconds] = useState(() => {
    const value = Number(localStorage.getItem("aliyun-panel-refresh-seconds") || "0");
    return [0, 5, 10, 30, 60].includes(value) ? value : 0;
  });
  const panelRefreshInFlightRef = useRef(false);
  const panelDragIdRef = useRef<number | null>(null);
  const panelImportInputRef = useRef<HTMLInputElement>(null);
  const [managedHosts, setManagedHosts] = useState<ManagedHost[]>([]);
  const [managedHostImporting, setManagedHostImporting] = useState(false);
  const managedHostImportInputRef = useRef<HTMLInputElement>(null);
  const [managedHostDialog, setManagedHostDialog] = useState(false);
  const [managedHostDraft, setManagedHostDraft] = useState<ManagedHostDraft>(emptyManagedHost);
  const [managedHostSaving, setManagedHostSaving] = useState(false);
  const [managedHostLoadingId, setManagedHostLoadingId] = useState<number | null>(null);
  const [managedHostKeyword, setManagedHostKeyword] = useState("");
  const [managedHostGroup, setManagedHostGroup] = useState("");
  const [managedHostOrder, setManagedHostOrder] = useState<string[]>(() => stringListFromValue(localStorage.getItem(cloudHubManagedHostOrderStorageKey) || undefined));
  const [managedHostGroupOrder, setManagedHostGroupOrder] = useState<string[]>(() => stringListFromValue(localStorage.getItem(cloudHubManagedHostGroupOrderStorageKey) || undefined));
  const [managedHostSorting, setManagedHostSorting] = useState(false);
  const [draggedManagedHostId, setDraggedManagedHostId] = useState<number | null>(null);
  const [draggedManagedHostGroup, setDraggedManagedHostGroup] = useState<string | null>(null);
  const [collapsedManagedHostGroups, setCollapsedManagedHostGroups] = useState<Set<string>>(() => new Set());
  const [managedHostMoreId, setManagedHostMoreId] = useState<number | null>(null);
  const [terminalSelectedHostId, setTerminalSelectedHostId] = useState<number | null>(null);
  const [favoriteAssetKeys, setFavoriteAssetKeys] = useState<string[]>(savedFavoriteAssetKeys);
  const [clientPreferencesReady, setClientPreferencesReady] = useState(!runningInTauri);
  const [apiLogs, setApiLogs] = useState<ApiLog[]>([]);
  const [apiLogDetail, setApiLogDetail] = useState<ApiLog | null>(null);
  const [assetDetail, setAssetDetail] = useState<{ asset: LocalAsset; account: Account } | null>(null);
  const [operationLogClearedAt, setOperationLogClearedAt] = useState(() => Number(localStorage.getItem("aliyun-operation-log-cleared-at") || "0"));
  const [autoRefresh, setAutoRefresh] = useState(() => localStorage.getItem("aliyun-auto-refresh") !== "0");
  const [compactMode, setCompactMode] = useState(() => localStorage.getItem("aliyun-compact-mode") === "1");
  const [appVersion, setAppVersion] = useState(bundledVersion);
  const [updateState, setUpdateState] = useState<UpdateState>({ phase: "idle" });
  const [logFilter, setLogFilter] = useState("");
  const [logTypeFilter, setLogTypeFilter] = useState("");
  const [resourceAccountId, setResourceAccountId] = useState<number | null>(null);
  const [resourceTypeFilter, setResourceTypeFilter] = useState<string | null>(null);
  const [assetKeyword, setAssetKeyword] = useState("");
  const [assetRegionFilter, setAssetRegionFilter] = useState("");
  const [assetStatusFilter, setAssetStatusFilter] = useState("");
  const [favoriteTypeFilter, setFavoriteTypeFilter] = useState<string | null>(null);
  const [favoriteKeyword, setFavoriteKeyword] = useState("");
  const [favoriteRegionFilter, setFavoriteRegionFilter] = useState("");
  const [syncAccount, setSyncAccount] = useState<Account | null>(null);
  const [syncTypes, setSyncTypes] = useState<string[]>(assetTypes.map(([value]) => value));
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ fetched: number; counts: Record<string, number>; errors: string[] } | null>(null);
  const [pageSize, setPageSize] = useState(() => { const value = Number(localStorage.getItem("aliyun-page-size") || "10"); return [10, 20, 50, 100].includes(value) ? value : 10; });
  const [accountPage, setAccountPage] = useState(1);
  const [assetPage, setAssetPage] = useState(1);
  const [favoritePage, setFavoritePage] = useState(1);
  const [editingAssetName, setEditingAssetName] = useState<{ key: string; value: string; initial: string } | null>(null);
  const [savingAssetName, setSavingAssetName] = useState<string | null>(null);
  const [assetNotes, setAssetNotes] = useState<Record<string, string>>(() => stringRecordFromValue(localStorage.getItem(cloudHubAssetNotesStorageKey) || undefined));
  const [assetOrder, setAssetOrder] = useState<string[]>(() => stringListFromValue(localStorage.getItem(cloudHubAssetOrderStorageKey) || undefined));
  const [favoriteAssetOrder, setFavoriteAssetOrder] = useState<string[]>(() => stringListFromValue(localStorage.getItem(cloudHubFavoriteAssetOrderStorageKey) || undefined));
  const [assetDisplayNames, setAssetDisplayNames] = useState<Record<string, string>>(() => stringRecordFromValue(localStorage.getItem(cloudHubAssetDisplayNamesStorageKey) || undefined));
  const [editingAssetNote, setEditingAssetNote] = useState<{ key: string; value: string; initial: string } | null>(null);
  const [favoriteRefreshingKey, setFavoriteRefreshingKey] = useState<string | null>(null);
  const [draggedAssetKey, setDraggedAssetKey] = useState<string | null>(null);
  const [draggedFavoriteKey, setDraggedFavoriteKey] = useState<string | null>(null);
  const assetDragKeyRef = useRef<string | null>(null);
  const favoriteDragKeyRef = useRef<string | null>(null);
  const managedHostDragIdRef = useRef<number | null>(null);
  const managedHostGroupDragRef = useRef<string | null>(null);
  const [assetMoreKey, setAssetMoreKey] = useState<string | null>(null);
  const [logPage, setLogPage] = useState(1);
  const [apiLogPage, setApiLogPage] = useState(1);
  const [sshTarget, setSshTarget] = useState<SshTarget | null>(null);
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState(22);
  const [sshUsername, setSshUsername] = useState("root");
  const [sshPassword, setSshPassword] = useState("");
  const [showSshPassword, setShowSshPassword] = useState(false);
  const [sshPlatform, setSshPlatform] = useState<"linux" | "windows">("linux");
  const [sshAuthMethod, setSshAuthMethod] = useState<SshAuthMethod>("password");
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  const [sshKeyPassphrase, setSshKeyPassphrase] = useState("");
  const [sshTesting, setSshTesting] = useState(false);
  const [sshSavePassword, setSshSavePassword] = useState(false);
  const [sshPasswordSaved, setSshPasswordSaved] = useState(false);
  const [sshPasswordRevealing, setSshPasswordRevealing] = useState(false);
  const [terminalThemeName, setTerminalThemeName] = useState<TerminalThemeName>(() => {
    const saved = localStorage.getItem(cloudHubTerminalThemeStorageKey);
    return saved && saved in terminalThemes ? saved as TerminalThemeName : "dark";
  });
  const [terminalThemeMenuOpen, setTerminalThemeMenuOpen] = useState(false);
  const [sshSessionId, setSshSessionId] = useState("");
  const [terminalTabs, setTerminalTabs] = useState<TerminalWorkspaceTab[]>([]);
  const [activeTerminalTabId, setActiveTerminalTabId] = useState<string | null>(null);
  const [sshError, setSshError] = useState("");
  const [sshConnecting, setSshConnecting] = useState(false);
  const [sshModalMaximized, setSshModalMaximized] = useState(false);
  const [sshFiles, setSshFiles] = useState<SshFileEntry[]>([]);
  const [sshFilePath, setSshFilePath] = useState("/");
  const [sshFilesLoading, setSshFilesLoading] = useState(false);
  const [sshFileError, setSshFileError] = useState("");
  const [sshFileEditor, setSshFileEditor] = useState<{ path: string; content: string } | null>(null);
  const [sshFileSaving, setSshFileSaving] = useState(false);
  const [sshFilePaneWidth, setSshFilePaneWidth] = useState(520);
  const [sshFilePaneCollapsed, setSshFilePaneCollapsed] = useState(false);
  const [sshFileDragActive, setSshFileDragActive] = useState(false);
  const [appSidebarWidth, setAppSidebarWidth] = useState(() => Math.min(340, Math.max(190, Number(localStorage.getItem("cloudhub-app-sidebar-width") || "235"))));
  const [terminalHostSidebarWidth, setTerminalHostSidebarWidth] = useState(() => Math.min(420, Math.max(190, Number(localStorage.getItem("cloudhub-terminal-host-sidebar-width") || "250"))));
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const terminalWorkbenchRef = useRef<HTMLDivElement | null>(null);
  const sshTerminalHostRef = useRef<HTMLDivElement | null>(null);
  const sshTerminalRef = useRef<XtermTerminal | null>(null);
  const sshPendingOutputRef = useRef("");
  const terminalTabsRef = useRef<TerminalWorkspaceTab[]>([]);
  const sshUploadInputRef = useRef<HTMLInputElement | null>(null);
  const sshWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const updateRef = useRef<Update | null>(null);

  function requestConfirm(message: string) {
    return new Promise<boolean>((resolve) => setConfirmRequest({ message, resolve }));
  }
  function resolveConfirm(confirmed: boolean) {
    confirmRequest?.resolve(confirmed);
    setConfirmRequest(null);
  }
  function requestPrompt(message: string, initialValue = "") {
    setPromptValue(initialValue);
    return new Promise<string | null>((resolve) => setPromptRequest({ message, resolve }));
  }
  function resolvePrompt(value: string | null) {
    promptRequest?.resolve(value);
    setPromptRequest(null);
  }
  async function performWindowAction(action: "minimize" | "toggleMaximize" | "close") {
    if (!runningInTauri) return;
    try {
      await getCurrentWindow()[action]();
    } catch (error) {
      setStatus(`窗口操作失败：${String(error)}`);
    }
  }

  function handleTitlebarMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (!runningInTauri || event.button !== 0) return;
    if (event.detail !== 1) return;
    void getCurrentWindow().startDragging();
  }

  function handleTitlebarDoubleClick(event: MouseEvent<HTMLDivElement>) {
    if (!runningInTauri || event.button !== 0) return;
    event.preventDefault();
    void performWindowAction("toggleMaximize");
  }

  useEffect(() => {
    if (!confirmRequest && !promptRequest) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (confirmRequest) resolveConfirm(false);
      else resolvePrompt(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmRequest, promptRequest]);

  useEffect(() => {
    terminalTabsRef.current = terminalTabs;
  }, [terminalTabs]);

  useEffect(() => {
    if (!sshSessionId) return;
    let disposed = false;
    const read = async () => {
      try {
        const output = await invoke<string>("ssh_read", { sessionId: sshSessionId });
        if (!disposed && output) {
          setTerminalTabs((current) => current.map((tab) => tab.sessionId === sshSessionId
            ? { ...tab, output: `${tab.output}${output}`.slice(-160_000) }
            : tab));
          if (sshTerminalRef.current) sshTerminalRef.current.write(output);
        }
      } catch (error) {
        if (!disposed) setSshError(`SSH 会话已断开：${String(error)}`);
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 250);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [sshSessionId]);

  useEffect(() => {
    if (!sshSessionId || !sshTerminalHostRef.current) return;
    let disposed = false;
    let terminal: XtermTerminal | null = null;
    let observer: ResizeObserver | null = null;
    let inputSubscription: { dispose: () => void } | null = null;

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xterm, addon]) => {
      if (disposed || !sshTerminalHostRef.current) return;
      terminal = new xterm.Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
        fontSize: 14,
        lineHeight: 1.25,
        scrollback: 8_000,
        theme: terminalThemes[terminalThemeName],
      });
      const fitAddon = new addon.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(sshTerminalHostRef.current);
      sshTerminalRef.current = terminal;
      const savedOutput = terminalTabsRef.current.find((tab) => tab.sessionId === sshSessionId)?.output || sshPendingOutputRef.current;
      if (savedOutput) terminal.write(savedOutput);
      sshPendingOutputRef.current = "";

      const syncSize = () => {
        fitAddon.fit();
        void invoke("ssh_resize", { sessionId: sshSessionId, cols: terminal?.cols, rows: terminal?.rows })
          .catch((error) => setSshError(`调整 SSH 终端大小失败：${String(error)}`));
      };
      inputSubscription = terminal.onData((data) => {
        void invoke("ssh_write", { sessionId: sshSessionId, data })
          .catch((error) => setSshError(`发送 SSH 输入失败：${String(error)}`));
      });
      observer = new ResizeObserver(syncSize);
      observer.observe(sshTerminalHostRef.current);
      window.requestAnimationFrame(() => {
        syncSize();
        terminal?.focus();
      });
    }).catch((error) => {
      if (!disposed) setSshError(`加载 SSH 终端失败：${String(error)}`);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      inputSubscription?.dispose();
      if (sshTerminalRef.current === terminal) sshTerminalRef.current = null;
      terminal?.dispose();
    };
  }, [sshSessionId]);

  useEffect(() => {
    const terminal = sshTerminalRef.current;
    if (!terminal) return;
    terminal.options.theme = terminalThemes[terminalThemeName];
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
  }, [terminalThemeName]);

  useEffect(() => {
    if (sshSessionId) void loadSshFiles("/");
  }, [sshSessionId]);

  async function keepLoadingVisible(startedAt: number) {
    const remaining = 320 - (Date.now() - startedAt);
    if (remaining > 0)
      await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
  }

  async function checkForUpdates(quiet = false) {
    if (!runningInTauri) {
      setUpdateState({ phase: "idle" });
      return;
    }
    setUpdateState({ phase: "checking" });
    try {
      const update = await check();
      const previous = updateRef.current;
      updateRef.current = update;
      if (previous && previous !== update) void previous.close();
      if (update) {
        setUpdateState({ phase: "available", version: update.version, notes: update.body });
        if (!quiet) setStatus(`已检查更新：当前 v${appVersion}，发现最新 v${update.version}`);
      } else {
        setUpdateState({ phase: "current" });
        if (!quiet) setStatus(`已检查更新：当前 v${appVersion}，最新版本也是 v${appVersion}`);
      }
    } catch (error) {
      updateRef.current = null;
      setUpdateState(quiet ? { phase: "idle" } : { phase: "error", message: String(error) });
    }
  }

  async function installUpdate() {
    const update = updateRef.current;
    if (!update) {
      await checkForUpdates();
      return;
    }
    let downloaded = 0;
    let total: number | undefined;
    setUpdateState({ phase: "downloading", version: update.version, downloaded, total });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
        }
        setUpdateState({ phase: "downloading", version: update.version, downloaded, total });
      });
      updateRef.current = null;
      setUpdateState({ phase: "ready", version: update.version });
      await relaunch();
    } catch (error) {
      setUpdateState({ phase: "error", message: `安装更新失败：${String(error)}` });
    }
  }

  async function loadLocalAssets() {
    try {
      setLocalAssets(runningInTauri
        ? await invoke<LocalAsset[]>("list_local_assets", {})
        : await webApi<LocalAsset[]>("/api/local-assets"));
    } catch (error) { setStatus(`读取本地资产失败：${String(error)}`); }
  }
  async function loadManagedHosts() {
    if (!runningInTauri) return;
    try { setManagedHosts(await invoke<ManagedHost[]>("list_managed_hosts")); }
    catch (error) { setStatus(`读取服务器管理列表失败：${String(error)}`); }
  }
  async function loadPanelConnections() {
    if (!runningInTauri) return;
    try { setPanelConnections(await invoke<PanelConnection[]>("list_panel_connections")); }
    catch (error) { setStatus(`读取面板管理列表失败：${String(error)}`); }
  }
  function openPanelDialog(panel?: PanelConnection) {
    setPanelDraft(panel ? {
      id: panel.id, name: panel.name, panel_url: panel.panel_url, sort_order: panel.sort_order ?? 0, api_key: "", allow_insecure_tls: panel.allow_insecure_tls, group_name: panel.group_name || "",
      source_account_id: panel.source_account_id, source_asset_key: panel.source_asset_key, remark: panel.remark || "",
    } : { ...emptyPanelConnection, sort_order: Math.max(-1, ...panelConnections.map((item) => item.sort_order ?? 0)) + 1 });
    setPanelDialog(true);
  }
  function openPanelFromAsset(asset: LocalAsset, account: Account) {
    const payload = asset.payload || {};
    const ip = firstAddress(payload.PublicIpAddress || payload.PublicAddresses || payload.PublicIp || payload.InternetIp || payload.EipAddress);
    setPanelDraft({ ...emptyPanelConnection, name: String(payload.InstanceName || asset.asset_key), panel_url: ip ? `https://${ip}:8888` : "", sort_order: Math.max(-1, ...panelConnections.map((item) => item.sort_order ?? 0)) + 1, group_name: account.group_name || "", source_account_id: account.id, source_asset_key: asset.asset_key, remark: `来源：${account.account_name} / ${asset.resource_type}` });
    setPanelDialog(true);
  }
  async function savePanelConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runningInTauri) { setStatus("面板管理仅支持桌面客户端"); return; }
    setPanelSaving(true);
    try {
      await invoke<PanelConnection>("save_panel_connection", { input: panelDraft });
      await loadPanelConnections();
      setPanelDialog(false); setStatus("面板验证成功，已加入面板管理");
    } catch (error) { setStatus(`绑定面板失败：${String(error)}`); }
    finally { setPanelSaving(false); }
  }
  async function reorderPanels(sourceId: number, targetId: number) {
    if (sourceId === targetId) return;
    const visibleIds = visiblePanels.map((panel) => panel.id);
    const sourceIndex = visibleIds.indexOf(sourceId);
    const targetIndex = visibleIds.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextVisibleIds = [...visibleIds];
    nextVisibleIds.splice(sourceIndex, 1);
    nextVisibleIds.splice(targetIndex, 0, sourceId);
    const visibleIdSet = new Set(nextVisibleIds);
    const remainingIds = panelConnections.filter((panel) => !visibleIdSet.has(panel.id)).map((panel) => panel.id);
    const orderedIds = [...nextVisibleIds, ...remainingIds];
    const order = new Map(orderedIds.map((id, index) => [id, index]));
    setPanelConnections((current) => [...current].sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)).map((panel, index) => ({ ...panel, sort_order: index })));
    try {
      await invoke("update_panel_connection_order", { ids: orderedIds });
    } catch (error) {
      setStatus(`保存面板排序失败：${String(error)}`);
      await loadPanelConnections();
    }
  }
  function startPanelDrag(event: PointerEvent<HTMLButtonElement>, sourceId: number) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panelDragIdRef.current = sourceId;
    setDraggedPanelId(sourceId);
    const endDrag = (endEvent: globalThis.PointerEvent) => {
      const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest<HTMLElement>("[data-panel-id]");
      const targetId = Number(target?.dataset.panelId);
      if (panelDragIdRef.current !== null && Number.isInteger(targetId)) void reorderPanels(panelDragIdRef.current, targetId);
      panelDragIdRef.current = null;
      setDraggedPanelId(null);
      document.removeEventListener("pointercancel", cancelDrag);
    };
    const cancelDrag = () => {
      panelDragIdRef.current = null;
      setDraggedPanelId(null);
      document.removeEventListener("pointerup", endDrag);
    };
    document.addEventListener("pointerup", endDrag, { once: true });
    document.addEventListener("pointercancel", cancelDrag, { once: true });
  }
  async function refreshAllPanelConnections(quiet = false) {
    if (!runningInTauri || panelRefreshInFlightRef.current || !panelConnections.length) return;
    panelRefreshInFlightRef.current = true;
    setPanelLoadingId(-1);
    let online = 0;
    let offline = 0;
    let failed = 0;
    try {
      for (const panel of panelConnections) {
        try {
          const updated = await invoke<PanelConnection>("refresh_panel_connection", { id: panel.id });
          setPanelConnections((current) => current.map((item) => item.id === panel.id ? updated : item));
          if (updated.status === "online") online += 1; else offline += 1;
        } catch {
          failed += 1;
        }
      }
      if (!quiet) setStatus(`监控已刷新：${online} 台在线${offline ? `，${offline} 台离线` : ""}${failed ? `，${failed} 台失败` : ""}`);
    } finally {
      panelRefreshInFlightRef.current = false;
      setPanelLoadingId(null);
    }
  }
  async function openPanelTemporaryLogin(panel: PanelConnection) {
    if (!runningInTauri || panelOpeningId !== null) return;
    setPanelOpeningId(panel.id);
    try {
      const temporaryUrl = await invoke<string>("panel_temporary_login", { id: panel.id });
      if (panelOpenMode === "copy") {
        await navigator.clipboard.writeText(temporaryUrl);
        setStatus(`${panel.name} 的临时面板 URL 已复制`);
      } else {
        await openUrl(temporaryUrl);
        setStatus(`${panel.name} 已在默认浏览器中打开`);
      }
    } catch (error) {
      setStatus(`${panelOpenMode === "copy" ? "复制" : "打开"}面板失败：${String(error)}`);
    } finally {
      setPanelOpeningId(null);
    }
  }
  async function openDataDirectory() {
    if (!runningInTauri) { setStatus("打开数据目录仅支持桌面客户端"); return; }
    try {
      await invoke("open_app_data_directory");
      setStatus("已在文件资源管理器中打开数据目录");
    } catch (error) {
      setStatus(`打开数据目录失败：${String(error)}`);
    }
  }
  async function copyPanelAddress(panel: PanelConnection) {
    try {
      await navigator.clipboard.writeText(panel.panel_url);
      setStatus(`${panel.name} 面板地址已复制`);
    } catch {
      setStatus("复制面板地址失败，请手动复制");
    }
  }
  async function savePanelRemark(panel: PanelConnection) {
    const draft = editingPanelRemark;
    if (!draft || draft.id !== panel.id) return;
    const remark = draft.value.trim();
    setEditingPanelRemark(null);
    if (remark === draft.initial) return;
    try {
      const updated = await invoke<PanelConnection>("update_panel_connection_remark", { id: panel.id, remark: remark || null });
      setPanelConnections((current) => current.map((item) => item.id === updated.id ? updated : item));
      setStatus("面板备注已保存");
    } catch (error) { setStatus(`保存面板备注失败：${String(error)}`); }
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
  async function deletePanelConnection(panel: PanelConnection) {
    if (!(await requestConfirm(`确认移除面板“${panel.name}”吗？本机保存的 API 密钥也会删除。`))) return;
    try { await invoke("delete_panel_connection", { id: panel.id }); setPanelConnections((current) => current.filter((item) => item.id !== panel.id)); setSelectedPanelIds((current) => { const next = new Set(current); next.delete(panel.id); return next; }); setStatus("面板已移除"); }
    catch (error) { setStatus(`移除面板失败：${String(error)}`); }
  }
  function togglePanelSelection(id: number) {
    setSelectedPanelIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAllVisiblePanels() {
    setSelectedPanelIds((current) => {
      const ids = visiblePanels.map((panel) => panel.id);
      const allSelected = ids.length > 0 && ids.every((id) => current.has(id));
      const next = new Set(current);
      ids.forEach((id) => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  }
  async function exportPanels() {
    if (!panelConnections.length) { setStatus("没有可导出的面板"); return; }
    const panelIds = selectedPanelIds.size ? [...selectedPanelIds] : undefined;
    const count = panelIds?.length || panelConnections.length;
    if (!(await requestConfirm(`导出文件会包含 ${count} 个面板的 API 密钥明文，请妥善保管。确定继续吗？`))) return;
    try {
      const path = await invoke<string>("export_panel_connections_file", { panelIds });
      setStatus(`已导出 ${count} 个面板，明文文件已保存到：${path}`);
    } catch (error) { setStatus(`导出面板失败：${String(error)}`); }
  }
  async function importPanels(file: File) {
    setPanelImporting(true);
    try {
      const parsed = JSON.parse(await file.text());
      const panels = Array.isArray(parsed) ? parsed : parsed.panels;
      if (!Array.isArray(panels) || !panels.length) throw new Error("文件中没有面板配置");
      const count = await invoke<number>("import_panel_connections", { panels });
      await loadPanelConnections();
      setSelectedPanelIds(new Set());
      setStatus(`已导入 ${count} 个面板`);
    } catch (error) { setStatus(`导入面板失败：${String(error)}`); }
    finally { setPanelImporting(false); }
  }
  function openManagedHostDialog(host?: ManagedHost) {
    setManagedHostDraft(host ? {
      id: host.id, name: host.name, host: host.host, port: host.port, username: host.username, password: "",
      platform: host.platform === "windows" ? "windows" : "linux", auth_method: host.auth_method === "private_key" ? "private_key" : "password", private_key: "", key_passphrase: "",
      group_name: host.group_name || "", tags: host.tags || "", source_account_id: host.source_account_id,
      source_asset_key: host.source_asset_key, remark: host.remark || "",
    } : emptyManagedHost);
    setManagedHostDialog(true);
  }
  async function saveManagedHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runningInTauri) { setStatus("服务器管理仅支持桌面客户端"); return; }
    setManagedHostSaving(true);
    try {
      const saved = await invoke<ManagedHost>("save_managed_host", { input: managedHostDraft });
      setManagedHosts((current) => current.some((item) => item.id === saved.id) ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved]);
      setManagedHostDialog(false);
      setStatus(managedHostDraft.id ? "服务器已更新" : "服务器已加入管理，点击刷新状态完成首次探测");
    } catch (error) { setStatus(`保存服务器失败：${String(error)}`); }
    finally { setManagedHostSaving(false); }
  }
  async function probeManagedHost(id: number) {
    if (!runningInTauri || managedHostLoadingId !== null) return;
    setManagedHostLoadingId(id);
    try {
      const updated = await invoke<ManagedHost>("probe_managed_host", { id });
      setManagedHosts((current) => current.map((item) => item.id === id ? updated : item));
      setStatus(updated.status === "online" ? `${updated.name} 状态已更新` : `${updated.name} 暂时无法连接`);
    } catch (error) { setStatus(`读取服务器状态失败：${String(error)}`); }
    finally { setManagedHostLoadingId(null); }
  }
  async function deleteManagedHost(host: ManagedHost) {
    if (!(await requestConfirm(`确认从服务器管理中移除“${host.name}”吗？本机保存的连接凭据也会删除。`))) return;
    try { await invoke("delete_managed_host", { id: host.id }); setManagedHosts((current) => current.filter((item) => item.id !== host.id)); setStatus("服务器已移除"); }
    catch (error) { setStatus(`移除服务器失败：${String(error)}`); }
  }
  async function exportManagedHosts() {
    if (!managedHosts.length) { setStatus("没有可导出的服务器"); return; }
    if (!(await requestConfirm(`导出文件会包含 ${managedHosts.length} 台服务器的连接凭据明文（SSH 密码/私钥或 RDP 密码），请妥善保管。确定继续吗？`))) return;
    try {
      const path = await invoke<string>("export_managed_hosts_file");
      setStatus(`已导出 ${managedHosts.length} 台服务器的连接凭据明文文件：${path}`);
    } catch (error) { setStatus(`导出服务器失败：${String(error)}`); }
  }
  async function importManagedHosts(file: File) {
    setManagedHostImporting(true);
    try {
      const parsed = JSON.parse(await file.text());
      const hosts = Array.isArray(parsed) ? parsed : parsed.hosts;
      if (!Array.isArray(hosts) || !hosts.length) throw new Error("文件中没有服务器配置");
      const count = await invoke<number>("import_managed_hosts", { hosts });
      await loadManagedHosts();
      setStatus(`已导入 ${count} 台服务器`);
    } catch (error) { setStatus(`导入服务器失败：${String(error)}`); }
    finally { setManagedHostImporting(false); }
  }
  function reorderManagedHosts(sourceId: number, targetId: number) {
    if (sourceId === targetId) return;
    const source = managedHosts.find((host) => host.id === sourceId);
    const target = managedHosts.find((host) => host.id === targetId);
    if (!source || !target || (source.group_name || "未分组") !== (target.group_name || "未分组")) return;
    const order = new Map(managedHostOrder.map((id, index) => [id, index]));
    const groupHostIds = managedHosts
      .filter((host) => (host.group_name || "未分组") === (source.group_name || "未分组"))
      .sort((left, right) => (order.get(String(left.id)) ?? Number.MAX_SAFE_INTEGER) - (order.get(String(right.id)) ?? Number.MAX_SAFE_INTEGER))
      .map((host) => String(host.id));
    const movedId = String(sourceId);
    const nextGroupHostIds = groupHostIds.filter((id) => id !== movedId);
    nextGroupHostIds.splice(nextGroupHostIds.indexOf(String(targetId)), 0, movedId);
    const groupHostIdSet = new Set(groupHostIds);
    setManagedHostOrder((current) => [...current.filter((id) => !groupHostIdSet.has(id)), ...nextGroupHostIds]);
  }
  function startManagedHostDrag(event: PointerEvent<HTMLButtonElement>, sourceId: number) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    managedHostDragIdRef.current = sourceId;
    setDraggedManagedHostId(sourceId);
    const endDrag = (endEvent: globalThis.PointerEvent) => {
      const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest<HTMLElement>("[data-managed-host-id]");
      const targetId = Number(target?.dataset.managedHostId);
      if (managedHostDragIdRef.current !== null && Number.isInteger(targetId)) reorderManagedHosts(managedHostDragIdRef.current, targetId);
      managedHostDragIdRef.current = null;
      setDraggedManagedHostId(null);
      document.removeEventListener("pointercancel", cancelDrag);
    };
    const cancelDrag = () => {
      managedHostDragIdRef.current = null;
      setDraggedManagedHostId(null);
      document.removeEventListener("pointerup", endDrag);
    };
    document.addEventListener("pointerup", endDrag, { once: true });
    document.addEventListener("pointercancel", cancelDrag, { once: true });
  }
  function reorderManagedHostGroups(sourceGroup: string, targetGroup: string) {
    if (!sourceGroup || sourceGroup === targetGroup) return;
    const nextGroups = managedHostGroups.filter((group) => group !== sourceGroup);
    nextGroups.splice(nextGroups.indexOf(targetGroup), 0, sourceGroup);
    setManagedHostGroupOrder(nextGroups);
  }
  function startManagedHostGroupDrag(event: PointerEvent<HTMLButtonElement>, sourceGroup: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    managedHostGroupDragRef.current = sourceGroup;
    setDraggedManagedHostGroup(sourceGroup);
    const endDrag = (endEvent: globalThis.PointerEvent) => {
      const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest<HTMLElement>("[data-managed-host-group]");
      const targetGroup = target?.dataset.managedHostGroup;
      if (managedHostGroupDragRef.current && targetGroup) reorderManagedHostGroups(managedHostGroupDragRef.current, targetGroup);
      managedHostGroupDragRef.current = null;
      setDraggedManagedHostGroup(null);
      document.removeEventListener("pointercancel", cancelDrag);
    };
    const cancelDrag = () => {
      managedHostGroupDragRef.current = null;
      setDraggedManagedHostGroup(null);
      document.removeEventListener("pointerup", endDrag);
    };
    document.addEventListener("pointerup", endDrag, { once: true });
    document.addEventListener("pointercancel", cancelDrag, { once: true });
  }
  function activateTerminalTab(tab: TerminalWorkspaceTab) {
    setActiveTerminalTabId(tab.id);
    if (tab.target.managedHostId) setTerminalSelectedHostId(tab.target.managedHostId);
    setSshTarget(tab.target);
    setSshHost(tab.host);
    setSshPort(tab.port);
    setSshUsername(tab.username);
    setSshSessionId(tab.sessionId);
    setSshPassword("");
    setSshError("");
    setSshFiles([]);
    setSshFilePath("/");
    setSshFileError("");
    setSshFileEditor(null);
  }
  async function closeTerminalTab(tabId: string) {
    const tab = terminalTabsRef.current.find((item) => item.id === tabId);
    if (!tab) return;
    const remaining = terminalTabsRef.current.filter((item) => item.id !== tabId);
    const closingActiveTab = activeTerminalTabId === tabId;
    const nextTab = closingActiveTab ? remaining[remaining.length - 1] || null : null;
    setTerminalTabs(remaining);
    if (nextTab) activateTerminalTab(nextTab);
    else if (closingActiveTab) {
      setActiveTerminalTabId(null);
      setSshSessionId("");
      setSshTarget(null);
      setSshFiles([]);
      setSshFileEditor(null);
      setSshFileError("");
      setSshFilePaneCollapsed(true);
    }
    if (runningInTauri) {
      try { await invoke("ssh_disconnect", { sessionId: tab.sessionId }); } catch { /* session already closed */ }
    }
  }
  function openManagedHostSsh(host: ManagedHost) {
    if (!runningInTauri) { setStatus("远程连接仅支持桌面客户端"); return; }
    setTerminalSelectedHostId(host.id);
    if (host.platform === "windows") {
      void invoke("launch_managed_host_rdp", { id: host.id }).then(() => setStatus(`已打开 ${host.name} 的 Windows 远程桌面连接`)).catch((error) => setStatus(`打开 RDP 失败：${String(error)}`));
      return;
    }
    const existingTab = terminalTabsRef.current.find((tab) => tab.target.managedHostId === host.id);
    if (existingTab) {
      activateTerminalTab(existingTab);
      return;
    }
    setActiveTerminalTabId(null);
    const placeholderAccount: Account = { id: 0, account_name: "服务器管理", cloud_type: "other", access_key_id: "managed-host", enabled: true, sort_order: 0, created_at: host.created_at, updated_at: host.updated_at };
    const placeholderAsset: LocalAsset = { account_id: 0, resource_type: "managed", asset_key: `managed-host-${host.id}`, payload: { InstanceName: host.name }, fetched_at: host.updated_at };
    setSshTarget({ account: placeholderAccount, asset: placeholderAsset, managedHostId: host.id });
    setSshHost(host.host); setSshPort(host.port || 22); setSshUsername(host.username || "root"); setSshPassword(""); setShowSshPassword(false);
    setSshPlatform("linux"); setSshAuthMethod(host.auth_method === "private_key" ? "private_key" : "password"); setSshPrivateKey(""); setSshKeyPassphrase("");
    setSshSavePassword(false); setSshPasswordSaved(host.password_saved || host.private_key_saved); setSshModalMaximized(false); setSshSessionId("");
    sshPendingOutputRef.current = ""; setSshError(""); setSshFiles([]); setSshFilePath("/"); setSshFileError(""); setSshFileEditor(null); setSshFilePaneCollapsed(true);
  }
  async function rebootLocalAsset(asset: LocalAsset, forceStop: boolean) {
    const account = accounts.find((item) => item.id === asset.account_id);
    const instanceId = String(asset.payload?.InstanceId || asset.asset_key);
    const regionId = String(asset.region_id || asset.payload?.RegionId || account?.region_id || "");
    if (!account || !regionId || !instanceId) { setStatus("服务器缺少账号、地域或实例 ID"); return; }
    const resourceLabel = asset.resource_type === "swas" ? "轻量服务器" : "服务器";
    if (!(await requestConfirm(`确认${forceStop ? "强制" : "正常"}重启${resourceLabel}“${String(asset.payload?.InstanceName || instanceId)}”吗？`))) return;
    try {
      if (asset.resource_type === "swas") {
        if (account.cloud_type !== "aliyun" && account.cloud_type !== "tencent") throw new Error("当前轻量服务器暂不支持重启操作");
        const supportsForcedReboot = account.cloud_type === "aliyun" || account.cloud_type === "tencent";
        if (runningInTauri) await invoke("swas_instance_action", { id: account.id, regionId, instanceId, action: "reboot", forceStop: supportsForcedReboot && forceStop });
        else await webApi("/api/swas-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: account.id, regionId, instanceId, action: "reboot", forceStop: supportsForcedReboot && forceStop }) });
      } else if (account.cloud_type === "tencent") {
        if (runningInTauri) await invoke("cvm_instance_reboot", { id: account.id, regionId, instanceId, forceStop });
        else await webApi("/api/cvm-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: account.id, regionId, instanceId, forceStop }) });
      } else if (account.cloud_type === "oracle") {
        const payload = { id: account.id, regionId, instanceId, action: forceStop ? "forceReboot" : "reboot" };
        if (runningInTauri) await invoke("oracle_instance_action", payload);
        else await webApi("/api/oracle-instance-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "baidu") {
        const payload = { id: account.id, regionId, instanceId, action: "reboot", forceStop };
        if (runningInTauri) await invoke("baidu_instance_action", payload);
        else await webApi("/api/bcc-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "vultr") {
        const payload = { id: account.id, instanceId, action: "reboot" };
        if (runningInTauri) await invoke("vultr_instance_action", payload);
        else await webApi("/api/vultr-instance-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else {
        if (!runningInTauri) throw new Error("网页端暂不支持阿里云服务器重启，请使用客户端操作");
        await invoke("reboot_instance", { id: account.id, regionId, instanceId, forceStop });
      }
      setStatus(`${forceStop ? "强制" : "正常"}重启${resourceLabel}指令已提交`);
      await loadApiLogs();
    } catch (error) { setStatus(`${resourceLabel}重启失败：${String(error)}`); }
  }
  async function stopLocalAsset(asset: LocalAsset) {
    const account = accounts.find((item) => item.id === asset.account_id);
    const instanceId = String(asset.payload?.InstanceId || asset.asset_key);
    const regionId = String(asset.region_id || asset.payload?.RegionId || account?.region_id || "");
    if (!account || !regionId || !instanceId) { setStatus("服务器缺少账号、地域或实例 ID"); return; }
    const resourceLabel = asset.resource_type === "swas" ? "轻量服务器" : "服务器";
    if (!(await requestConfirm(`确认关机${resourceLabel}“${String(asset.payload?.InstanceName || instanceId)}”吗？`))) return;
    try {
      if (asset.resource_type === "swas") {
        if (account.cloud_type !== "aliyun" && account.cloud_type !== "tencent") throw new Error("当前轻量服务器暂不支持关机操作");
        const payload = { id: account.id, regionId, instanceId, action: "stop", forceStop: false };
        if (runningInTauri) await invoke("swas_instance_action", payload);
        else await webApi("/api/swas-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "tencent") {
        const payload = { id: account.id, regionId, instanceId, action: "stop", forceStop: false };
        if (runningInTauri) await invoke("cvm_instance_action", payload);
        else await webApi("/api/cvm-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "oracle") {
        const payload = { id: account.id, regionId, instanceId, action: "stop" };
        if (runningInTauri) await invoke("oracle_instance_action", payload);
        else await webApi("/api/oracle-instance-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "baidu") {
        const payload = { id: account.id, regionId, instanceId, action: "stop", forceStop: false };
        if (runningInTauri) await invoke("baidu_instance_action", payload);
        else await webApi("/api/bcc-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "vultr") {
        const payload = { id: account.id, instanceId, action: "stop" };
        if (runningInTauri) await invoke("vultr_instance_action", payload);
        else await webApi("/api/vultr-instance-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else {
        const payload = { id: account.id, regionId, instanceId, action: "stop" };
        if (runningInTauri) await invoke("stop_instance", payload);
        else await webApi("/api/ecs-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      }
      setStatus(`${resourceLabel}关机指令已提交`);
      await loadApiLogs();
    } catch (error) { setStatus(`${resourceLabel}关机失败：${String(error)}`); }
  }
  async function saveServerName(asset: LocalAsset, account: Account, key: string) {
    const draft = editingAssetName;
    if (!draft || draft.key !== key || savingAssetName === key) return;
    const instanceName = draft.value.trim();
    setEditingAssetName(null);
    if (!instanceName || instanceName === draft.initial) return;
    const instanceId = String(asset.payload.InstanceId || asset.asset_key);
    const regionId = String(asset.region_id || asset.payload.RegionId || account.region_id || "");
    if (!instanceId || !regionId) { setStatus("服务器缺少地域或实例 ID，无法修改名称"); return; }
    setSavingAssetName(key);
    try {
      if (runningInTauri) {
        await invoke("rename_server", { id: account.id, regionId, instanceId, instanceName });
      } else {
        await webApi("/api/server-name", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: account.id, regionId, instanceId, instanceName }) });
      }
      setLocalAssets((items) => items.map((item) => item.account_id === asset.account_id && item.resource_type === asset.resource_type && item.asset_key === asset.asset_key
        ? { ...item, payload: { ...item.payload, InstanceName: instanceName } }
        : item));
      setStatus("服务器名称已更新");
      await loadApiLogs();
    } catch (error) {
      const message = String(error);
      setStatus(message.includes("Not found")
        ? "当前桌面客户端尚未包含服务器改名功能，请关闭客户端并安装 0.1.1 或更高版本后重试"
        : `修改服务器名称失败：${message}`);
    } finally {
      setSavingAssetName(null);
    }
  }
  function saveAssetNote(key: string) {
    const draft = editingAssetNote;
    if (!draft || draft.key !== key) return;
    const note = draft.value.trim();
    setEditingAssetNote(null);
    if (note === draft.initial) return;
    setAssetNotes((current) => {
      const next = { ...current };
      if (note) next[key] = note;
      else delete next[key];
      return next;
    });
  }
  function moveAssetBefore(sourceKey: string, targetKey: string) {
    if (!sourceKey || sourceKey === targetKey) return;
    const visibleKeys = visibleLocalAssets.map(assetFavoriteKey);
    const sourceIndex = visibleKeys.indexOf(sourceKey);
    const targetIndex = visibleKeys.indexOf(targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextVisible = [...visibleKeys];
    nextVisible.splice(sourceIndex, 1);
    nextVisible.splice(targetIndex, 0, sourceKey);
    const visibleKeySet = new Set(nextVisible);
    const remaining = localAssets.map(assetFavoriteKey).filter((key) => !visibleKeySet.has(key));
    setAssetOrder([...nextVisible, ...remaining]);
  }
  function startAssetDrag(event: PointerEvent<HTMLButtonElement>, sourceKey: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    assetDragKeyRef.current = sourceKey;
    setDraggedAssetKey(sourceKey);
    const endDrag = (endEvent: globalThis.PointerEvent) => {
      const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest<HTMLElement>("[data-asset-row-key]");
      const targetKey = target?.dataset.assetRowKey;
      if (assetDragKeyRef.current && targetKey) moveAssetBefore(assetDragKeyRef.current, targetKey);
      assetDragKeyRef.current = null;
      setDraggedAssetKey(null);
      document.removeEventListener("pointercancel", cancelDrag);
    };
    const cancelDrag = () => {
      assetDragKeyRef.current = null;
      setDraggedAssetKey(null);
      document.removeEventListener("pointerup", endDrag);
    };
    document.addEventListener("pointerup", endDrag, { once: true });
    document.addEventListener("pointercancel", cancelDrag, { once: true });
  }
  function moveFavoriteBefore(sourceKey: string, targetKey: string) {
    if (!sourceKey || sourceKey === targetKey) return;
    const visibleKeys = visibleFavoriteAssets.map(assetFavoriteKey);
    const sourceIndex = visibleKeys.indexOf(sourceKey);
    const targetIndex = visibleKeys.indexOf(targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextVisible = [...visibleKeys];
    nextVisible.splice(sourceIndex, 1);
    nextVisible.splice(targetIndex, 0, sourceKey);
    const visibleKeySet = new Set(nextVisible);
    const remaining = favoriteAssets.map(assetFavoriteKey).filter((key) => !visibleKeySet.has(key));
    setFavoriteAssetOrder([...nextVisible, ...remaining]);
  }
  function startFavoriteCardDrag(event: PointerEvent<HTMLButtonElement>, sourceKey: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    favoriteDragKeyRef.current = sourceKey;
    setDraggedFavoriteKey(sourceKey);
    const endDrag = (endEvent: globalThis.PointerEvent) => {
      const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest<HTMLElement>("[data-favorite-asset-key]");
      const targetKey = target?.dataset.favoriteAssetKey;
      if (favoriteDragKeyRef.current && targetKey) moveFavoriteBefore(favoriteDragKeyRef.current, targetKey);
      favoriteDragKeyRef.current = null;
      setDraggedFavoriteKey(null);
      document.removeEventListener("pointercancel", cancelDrag);
    };
    const cancelDrag = () => {
      favoriteDragKeyRef.current = null;
      setDraggedFavoriteKey(null);
      document.removeEventListener("pointerup", endDrag);
    };
    document.addEventListener("pointerup", endDrag, { once: true });
    document.addEventListener("pointercancel", cancelDrag, { once: true });
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
  async function openSshClient(asset: LocalAsset, account: Account) {
    if (!runningInTauri) { setStatus("远程连接仅支持桌面客户端，请从客户端打开资源管理"); return; }
    const payload = asset.payload || {};
    const defaultHost = firstAddress(payload.PublicIpAddress || payload.PublicAddresses || payload.PublicIp || payload.InternetIp || payload.EipAddress);
    const platform = remotePlatformFromPayload(payload);
    const windows = platform === "windows";
    setSshTarget({ account, asset });
    setSshHost(defaultHost);
    setSshPort(windows ? 3389 : 22);
    setSshUsername(windows ? "administrator" : "root");
    setSshPassword("");
    setShowSshPassword(false);
    setSshPlatform(platform);
    setSshAuthMethod("password");
    setSshPrivateKey("");
    setSshKeyPassphrase("");
    setSshSavePassword(false);
    setSshPasswordSaved(false);
    setSshModalMaximized(false);
    setSshSessionId("");
    sshPendingOutputRef.current = "";
    setSshError("");
    setSshFiles([]);
    setSshFilePath("/");
    setSshFileError("");
    setSshFileEditor(null);
    setSshFilePaneCollapsed(false);
    setSshFileDragActive(false);
    try {
      const saved = windows
        ? await invoke<SavedRdpConnection | null>("get_rdp_connection", { targetKey: `asset:${account.id}:${asset.asset_key}` })
        : await invoke<SavedSshConnection | null>("get_ssh_connection", { accountId: account.id, assetKey: asset.asset_key });
      if (saved) {
        setSshHost(saved.host || defaultHost);
        setSshPort(saved.port || (windows ? 3389 : 22));
        setSshUsername(saved.username || (windows ? "administrator" : "root"));
        setSshSavePassword(saved.passwordSaved);
        setSshPasswordSaved(saved.passwordSaved);
      }
    } catch (error) { setSshError(`读取本地${windows ? "RDP" : "SSH"}配置失败：${String(error)}`); }
  }
  async function closeSshClient() {
    if (section === "servers" && activeTerminalTabId) {
      await closeTerminalTab(activeTerminalTabId);
      return;
    }
    const sessionId = sshSessionId;
    setSshSessionId("");
    setSshTarget(null);
    setShowSshPassword(false);
    setSshModalMaximized(false);
    setSshFiles([]);
    setSshFileEditor(null);
    setSshFileError("");
    setSshFilePaneCollapsed(false);
    setSshFileDragActive(false);
    if (sessionId && runningInTauri) {
      try { await invoke("ssh_disconnect", { sessionId }); } catch { /* session already closed */ }
    }
  }
  function rdpTargetKey(target = sshTarget) {
    if (!target || target.direct) return "";
    return target.managedHostId ? `managed:${target.managedHostId}` : `asset:${target.account.id}:${target.asset.asset_key}`;
  }
  async function setRemotePlatform(platform: "linux" | "windows") {
    setSshPlatform(platform);
    setSshError("");
    setShowSshPassword(false);
    if (platform === "linux") {
      setSshAuthMethod("password");
      setSshPort((port) => port === 3389 ? 22 : port);
      if (!sshUsername || sshUsername === "administrator") setSshUsername("root");
      setSshPassword("");
      setSshSavePassword(false);
      setSshPasswordSaved(false);
      if (!sshTarget || sshTarget.direct || sshTarget.managedHostId) return;
      try {
        const saved = await invoke<SavedSshConnection | null>("get_ssh_connection", { accountId: sshTarget.account.id, assetKey: sshTarget.asset.asset_key });
        if (!saved) return;
        setSshHost(saved.host || sshHost);
        setSshPort(saved.port || 22);
        setSshUsername(saved.username || "root");
        setSshSavePassword(saved.passwordSaved);
        setSshPasswordSaved(saved.passwordSaved);
      } catch (error) { setSshError(`读取本地 SSH 配置失败：${String(error)}`); }
      return;
    }
    setSshAuthMethod("password");
    setSshPrivateKey("");
    setSshKeyPassphrase("");
    setSshPort(3389);
    if (!sshUsername || sshUsername === "root") setSshUsername("administrator");
    setSshPassword("");
    setSshSavePassword(false);
    setSshPasswordSaved(false);
    const targetKey = rdpTargetKey();
    if (!targetKey) return;
    try {
      const saved = await invoke<SavedRdpConnection | null>("get_rdp_connection", { targetKey });
      if (!saved) return;
      setSshHost(saved.host || sshHost);
      setSshPort(saved.port || 3389);
      setSshUsername(saved.username || "administrator");
      setSshSavePassword(true);
      setSshPasswordSaved(saved.passwordSaved);
    } catch (error) { setSshError(`读取本地 RDP 配置失败：${String(error)}`); }
  }
  async function launchRdpClient() {
    if (!sshTarget) return;
    if (!sshHost.trim() || !sshUsername.trim()) { setSshError("请填写 RDP 主机和用户名"); return; }
    setSshConnecting(true);
    setSshError("");
    try {
      await invoke("launch_rdp_connection", {
        input: {
          targetKey: rdpTargetKey() || `direct:${Date.now()}`,
          host: sshHost.trim(), port: sshPort || 3389, username: sshUsername.trim(),
          password: sshPassword || null, savePassword: !sshTarget.direct && sshSavePassword,
        },
      });
      setSshPassword("");
      setSshPasswordSaved(!sshTarget.direct && sshSavePassword && Boolean(sshPassword || sshPasswordSaved));
      setStatus("已打开 Windows 远程桌面连接");
      await closeSshClient();
    } catch (error) { setSshError(String(error)); }
    finally { setSshConnecting(false); }
  }
  async function connectSshClient() {
    if (!sshTarget) return;
    if (sshPlatform === "windows") { await launchRdpClient(); return; }
    if (!sshHost.trim() || !sshUsername.trim()) { setSshError("请填写 SSH 主机和用户名"); return; }
    if (sshAuthMethod === "password" && !sshPassword && !sshPasswordSaved) { setSshError("请输入 SSH 密码，或使用已保存的密码连接"); return; }
    if (sshAuthMethod === "private_key" && !sshPrivateKey.trim() && !sshPasswordSaved) { setSshError("请粘贴 SSH 私钥，或使用已保存私钥连接"); return; }
    setSshConnecting(true);
    setSshError("");
    try {
      const result = await invoke<SshConnectResult>("ssh_connect", {
        input: {
          ...(sshTarget.managedHostId ? { managedHostId: sshTarget.managedHostId } : sshTarget.direct ? { direct: true } : { accountId: sshTarget.account.id, assetKey: sshTarget.asset.asset_key }),
          host: sshHost.trim(),
          port: sshPort || 22,
          username: sshUsername.trim(),
          authMethod: sshAuthMethod,
          password: sshAuthMethod === "password" ? sshPassword || null : null,
          privateKey: sshAuthMethod === "private_key" ? sshPrivateKey : null,
          keyPassphrase: sshAuthMethod === "private_key" ? sshKeyPassphrase || null : null,
          savePassword: sshAuthMethod === "password" && !sshTarget.direct && sshSavePassword,
          cols: 112,
          rows: 30,
        },
      });
      setSshSessionId(result.sessionId);
      if (section === "servers") {
        const tab: TerminalWorkspaceTab = {
          id: result.sessionId,
          target: sshTarget,
          host: sshHost.trim(),
          port: sshPort || 22,
          username: sshUsername.trim(),
          sessionId: result.sessionId,
          output: "",
        };
        setTerminalTabs((current) => [...current.filter((item) => item.id !== tab.id), tab]);
        setActiveTerminalTabId(tab.id);
      } else if (!sshTarget.managedHostId && !sshTarget.direct) {
        void loadManagedHosts();
        setStatus("SSH 已连接，并已自动加入终端管理");
      }
      setSshPassword("");
      setSshPasswordSaved(sshTarget.managedHostId ? (sshAuthMethod === "private_key" || sshSavePassword || sshPasswordSaved) : sshAuthMethod === "password" && sshSavePassword);
    } catch (error) { setSshError(String(error)); }
    finally { setSshConnecting(false); }
  }
  async function testSshConnection() {
    if (!sshTarget) return;
    if (!sshHost.trim() || !sshUsername.trim()) { setSshError("请填写 SSH 主机和用户名"); return; }
    if (sshAuthMethod === "password" && !sshPassword && !sshPasswordSaved) { setSshError("请输入 SSH 密码，或使用已保存的密码测试"); return; }
    if (sshAuthMethod === "private_key" && !sshPrivateKey.trim() && !sshPasswordSaved) { setSshError("请粘贴 SSH 私钥，或使用已保存私钥测试"); return; }
    setSshTesting(true); setSshError("");
    try {
      await invoke("ssh_test_connection", { input: {
        ...(sshTarget.managedHostId ? { managedHostId: sshTarget.managedHostId } : sshTarget.direct ? { direct: true } : { accountId: sshTarget.account.id, assetKey: sshTarget.asset.asset_key }),
        host: sshHost.trim(), port: sshPort || 22, username: sshUsername.trim(), authMethod: sshAuthMethod,
        password: sshAuthMethod === "password" ? sshPassword || null : null,
        privateKey: sshAuthMethod === "private_key" ? sshPrivateKey : null,
        keyPassphrase: sshAuthMethod === "private_key" ? sshKeyPassphrase || null : null,
        savePassword: false,
      } });
      setStatus("SSH 测试连接成功");
    } catch (error) { setSshError(`测试连接失败：${String(error)}`); }
    finally { setSshTesting(false); }
  }
  function joinSshPath(parent: string, name: string) {
    return parent === "/" ? `/${name}` : `${parent.replace(/\/+$/, "")}/${name}`;
  }
  function parentSshPath(path: string) {
    const normalized = path.replace(/\/+$/, "") || "/";
    if (normalized === "/") return "/";
    const parent = normalized.slice(0, normalized.lastIndexOf("/"));
    return parent || "/";
  }
  function sshFileSize(size: number) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  async function loadSshFiles(path = sshFilePath) {
    if (!sshSessionId) return;
    setSshFilesLoading(true);
    setSshFileError("");
    try {
      const result = await invoke<SshDirectoryListing>("ssh_list_files", { sessionId: sshSessionId, path });
      setSshFilePath(result.path);
      setSshFiles(result.entries.sort((left, right) => Number(right.isDir) - Number(left.isDir) || left.name.localeCompare(right.name)));
    } catch (error) { setSshFileError(`读取远程目录失败：${String(error)}`); }
    finally { setSshFilesLoading(false); }
  }
  function startSshFileResize(event: PointerEvent<HTMLDivElement>) {
    const workspace = sshWorkspaceRef.current;
    if (!workspace || window.innerWidth <= 900) return;
    event.preventDefault();
    const initialX = event.clientX;
    const initialWidth = sshFilePaneWidth;
    const maxWidth = Math.max(360, workspace.clientWidth - 360);
    const resize = (moveEvent: globalThis.PointerEvent) => {
      setSshFilePaneWidth(Math.min(maxWidth, Math.max(360, initialWidth - (moveEvent.clientX - initialX))));
    };
    const finish = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
      document.body.classList.remove("ssh-resizing");
    };
    document.body.classList.add("ssh-resizing");
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish, { once: true });
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
  async function openSshFile(entry: SshFileEntry) {
    if (entry.isDir) { await loadSshFiles(entry.path); return; }
    if (!entry.isFile) { setSshFileError("暂不支持打开该类型的远程条目"); return; }
    setSshFileError("");
    try { setSshFileEditor({ path: entry.path, content: await invoke<string>("ssh_read_text_file", { sessionId: sshSessionId, path: entry.path }) }); }
    catch (error) { setSshFileError(`打开文件失败：${String(error)}`); }
  }
  async function saveSshFile() {
    if (!sshFileEditor || !sshSessionId) return;
    setSshFileSaving(true);
    setSshFileError("");
    try { await invoke("ssh_write_text_file", { sessionId: sshSessionId, path: sshFileEditor.path, content: sshFileEditor.content }); setStatus(`已保存远程文件：${sshFileEditor.path}`); }
    catch (error) { setSshFileError(`保存文件失败：${String(error)}`); }
    finally { setSshFileSaving(false); }
  }
  async function uploadSshFiles(files: Iterable<globalThis.File>) {
    if (!sshSessionId) return;
    const pendingFiles = Array.from(files);
    if (!pendingFiles.length) return;
    const oversized = pendingFiles.find((file) => file.size > 20 * 1024 * 1024);
    if (oversized) { setSshFileError(`“${oversized.name}”超过单文件 20 MB 上传限制`); return; }
    const existingFiles = pendingFiles.filter((file) => sshFiles.some((entry) => entry.name === file.name));
    if (existingFiles.length && !(await requestConfirm(`“${existingFiles.map((file) => file.name).join("、")}”已存在，确定覆盖吗？`))) return;
    setSshFilesLoading(true);
    setSshFileError("");
    try {
      for (const file of pendingFiles) {
        const contentBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || "").split(",")[1] || ""); reader.onerror = () => reject(new Error("读取本地文件失败")); reader.readAsDataURL(file); });
        await invoke("ssh_upload_file", { sessionId: sshSessionId, path: joinSshPath(sshFilePath, file.name), contentBase64 });
      }
      await loadSshFiles(); setStatus(`已上传 ${pendingFiles.length} 个文件`);
    } catch (error) { setSshFileError(`上传文件失败：${String(error)}`); }
    finally { setSshFilesLoading(false); }
  }
  function completeSshCommand() {
    if (!sshSessionId) return;
    void invoke("ssh_write", { sessionId: sshSessionId, data: "\t" })
      .catch((error) => setSshError(`发送命令补全失败：${String(error)}`));
    sshTerminalRef.current?.focus();
  }
  async function downloadSshFile(entry: SshFileEntry) {
    if (!sshSessionId || !entry.isFile) return;
    setSshFileError("");
    try {
      const path = await invoke<string>("ssh_download_file", { sessionId: sshSessionId, path: entry.path });
      await revealItemInDir(path);
      setStatus(`已下载并在本机定位：${path}`);
    }
    catch (error) { setSshFileError(`下载文件失败：${String(error)}`); }
  }
  async function makeSshDirectory() {
    if (!sshSessionId) return;
    const name = await requestPrompt("新建文件夹名称");
    if (!name?.trim() || /[\\/\0]/.test(name)) { if (name) setSshFileError("文件夹名称不能包含 / 或 \\ "); return; }
    try { await invoke("ssh_make_directory", { sessionId: sshSessionId, path: joinSshPath(sshFilePath, name.trim()) }); await loadSshFiles(); }
    catch (error) { setSshFileError(`新建文件夹失败：${String(error)}`); }
  }
  async function deleteSshEntry(entry: SshFileEntry) {
    if (!sshSessionId || !(await requestConfirm(`确定删除${entry.isDir ? "文件夹及其全部内容" : "文件"}“${entry.name}”？此操作不可恢复。`))) return;
    try { await invoke("ssh_delete_path", { sessionId: sshSessionId, path: entry.path }); if (sshFileEditor?.path === entry.path) setSshFileEditor(null); await loadSshFiles(); }
    catch (error) { setSshFileError(`删除失败：${String(error)}`); }
  }
  async function clearSavedSshConnection() {
    if (!sshTarget) return;
    try {
      if (sshPlatform === "windows") {
        const targetKey = rdpTargetKey();
        if (!targetKey) return;
        await invoke("delete_rdp_connection", { targetKey });
      } else {
        if (sshTarget.managedHostId) return;
        await invoke("delete_ssh_connection", { accountId: sshTarget.account.id, assetKey: sshTarget.asset.asset_key });
      }
      setSshPasswordSaved(false);
      setSshSavePassword(false);
      setSshPassword("");
      setShowSshPassword(false);
      setSshError("");
    } catch (error) { setSshError(`清除本地连接配置失败：${String(error)}`); }
  }
  async function toggleSshPasswordVisibility() {
    if (showSshPassword) {
      setShowSshPassword(false);
      return;
    }
    if (sshPasswordSaved && sshTarget) {
      setSshPasswordRevealing(true);
      try {
        const password = sshPlatform === "windows"
          ? await invoke<string>("reveal_rdp_password", { targetKey: rdpTargetKey() })
          : await invoke<string>("reveal_ssh_password", sshTarget.managedHostId
            ? { managedHostId: sshTarget.managedHostId }
            : { accountId: sshTarget.account.id, assetKey: sshTarget.asset.asset_key });
        setSshPassword(password);
        setSshError("");
      } catch (error) {
        setSshError(`读取已保存密码失败：${String(error)}`);
        return;
      } finally {
        setSshPasswordRevealing(false);
      }
    }
    setShowSshPassword(true);
  }
  async function loadApiLogs() {
    try {
      setApiLogs(runningInTauri ? await invoke<ApiLog[]>("list_api_logs", {}) : await webApi<ApiLog[]>("/api/api-logs"));
    } catch (error) { setStatus(`读取 API 日志失败：${String(error)}`); }
  }
  async function clearLogs(kind: "api" | "operation") {
    const title = kind === "api" ? "API 日志" : "操作日志";
    if (!(await requestConfirm(`确定清空全部${title}吗？此操作不可恢复。`))) return;
    try {
      if (runningInTauri) await invoke(kind === "api" ? "clear_api_logs" : "clear_operation_logs", {});
      else await webApi(kind === "api" ? "/api/api-logs" : "/api/operation-logs", { method: "DELETE" });
      if (kind === "api") setApiLogs([]);
      else { const clearedAt = Date.now(); setOperationLogClearedAt(clearedAt); localStorage.setItem("aliyun-operation-log-cleared-at", String(clearedAt)); }
      setStatus(`${title}已清空`);
    } catch (error) { setStatus(`清空${title}失败：${String(error)}`); }
  }
  async function syncAssets(account: Account) {
    if (!supportsResourceSync(account)) {
      setSyncResult({ fetched: 0, counts: {}, errors: [`${cloudProvider(account.cloud_type).label}资源实时拉取尚未接入。账号可正常保存、筛选和管理。`] });
      setStatus(`${cloudProvider(account.cloud_type).label}资源 API 尚未接入`);
      return;
    }
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = runningInTauri
        ? await invoke<{ fetched: number; counts: Record<string, number>; errors: string[] }>("sync_cloud_assets", { id: account.id, resourceTypes: syncTypes })
        : await webApi<{ fetched: number; counts: Record<string, number>; errors: string[] }>("/api/sync-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: account.id, resource_types: syncTypes }) });
      setSyncResult(result);
      setStatus(`${account.account_name} 已获取 ${result.fetched} 项资产${result.errors.length ? `，${result.errors.length} 项失败` : ""}`);
      await loadLocalAssets();
      await loadApiLogs();
    } catch (error) { setStatus(`资产获取失败：${String(error)}`); }
    finally { setSyncing(false); }
  }

  const syncResultLevel = syncResult?.errors.length ? (syncResult.fetched > 0 ? "warning" : "has-errors") : "success";
  const showOracleDatabasePermissionHint = syncAccount?.cloud_type === "oracle" && Boolean(syncResult?.errors.some((error) => /rds:.*Authorization failed or requested resource not found/i.test(error)));

  async function cachedResourceResponse(account: Account, view: Exclude<View, "summary">): Promise<ResourceResponse> {
    const assets = runningInTauri
      ? await invoke<LocalAsset[]>("list_local_assets", { accountId: account.id, resourceType: view })
      : await webApi<LocalAsset[]>(`/api/local-assets?account_id=${account.id}&resource_type=${encodeURIComponent(view)}`);
    const items = assets.map((asset) => ({
      ...asset.payload,
      _region_id: asset.region_id || asset.payload._region_id || asset.payload.RegionId || undefined,
    }));
    return {
      resource_type: view,
      items,
      errors: [],
      fetched_at: assets.reduce((latest, asset) => Math.max(latest, asset.fetched_at), 0),
    };
  }

  async function cachedSummary(account: Account): Promise<Record<string, unknown>> {
    const assets = runningInTauri
      ? await invoke<LocalAsset[]>("list_local_assets", { accountId: account.id, resourceType: null })
      : await webApi<LocalAsset[]>(`/api/local-assets?account_id=${account.id}`);
    const count = (type: string) => assets.filter((asset) => asset.resource_type === type).length;
    const dnsRecordCount = assets
      .filter((asset) => asset.resource_type === "domain")
      .reduce((total, asset) => total + Number(asset.payload.RecordCount || 0), 0);
    return {
      account_id: account.access_key_id,
      account_type: "本地缓存",
      available_amount: "-",
      available_cash_amount: "-",
      credit_amount: "-",
      month_consume: "-",
      month_bill: "-",
      ecs_count: count("ecs"),
      domain_count: count("domain"),
      dns_record_count: dnsRecordCount,
      oss_count: count("oss"),
      rds_count: count("rds"),
      redis_count: count("redis"),
      swas_count: count("swas"),
      esa_count: count("esa"),
      cached_at: assets.reduce((latest, asset) => Math.max(latest, asset.fetched_at), 0),
    };
  }

  async function openCachedSummary(account: Account) {
    const startedAt = Date.now();
    setMoreId(null);
    setActive({ account, view: "summary", source: "cache" });
    setSummary(null);
    setResources(null);
    setLoading(true);
    try {
      setSummary(await cachedSummary(account));
      setStatus(`${account.account_name} · 汇总（本地缓存）`);
    } catch (error) {
      setStatus(`读取本地汇总失败：${String(error)}`);
    } finally {
      await keepLoadingVisible(startedAt);
      setLoading(false);
    }
  }

  async function openCachedView(account: Account, view: Exclude<View, "summary">) {
    const startedAt = Date.now();
    setMoreId(null);
    setActive({ account, view, source: "cache" });
    setResources(null);
    setLoading(true);
    try {
      setResources(await cachedResourceResponse(account, view));
      setStatus(`${account.account_name} · ${labels[view]}（本地缓存）`);
    } catch (error) {
      setStatus(`读取本地缓存失败：${String(error)}`);
    } finally {
      await keepLoadingVisible(startedAt);
      setLoading(false);
    }
  }

  function openAccountResource(account: Account, resourceType: AccountResourceType) {
    if (accountResourceViews.includes(resourceType as AccountResourceView)) {
      void openCachedView(account, resourceType as AccountResourceView);
      return;
    }
    setMoreId(null);
    setMorePosition(null);
    setResourceAccountId(account.id);
    setResourceTypeFilter(resourceType);
    setSection("resources");
    void loadLocalAssets();
  }

  async function pullLatestResources(account: Account, view: Exclude<View, "summary">) {
    if (!supportsResourceSync(account)) {
      setStatus(`${cloudProvider(account.cloud_type).label}的${labels[view]}实时拉取尚未接入`);
      return;
    }
    if (!syncAssetTypes(account).some(([type]) => type === view)) {
      setStatus(`${cloudProvider(account.cloud_type).label}暂未接入${labels[view]}实时拉取`);
      return;
    }
    const startedAt = Date.now();
    setLoading(true);
    try {
      const result = runningInTauri
        ? await invoke<{ fetched: number; counts: Record<string, number>; errors: string[] }>("sync_cloud_assets", { id: account.id, resourceTypes: [view] })
        : await webApi<{ fetched: number; counts: Record<string, number>; errors: string[] }>("/api/sync-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: account.id, resource_types: [view] }) });
      setResources(await cachedResourceResponse(account, view));
      setActive({ account, view, source: "live" });
      await loadLocalAssets();
      await loadApiLogs();
      setStatus(`${account.account_name} · 已实时拉取 ${result.counts[view] ?? result.fetched} 项${labels[view]}${result.errors.length ? `，${result.errors.length} 项失败` : ""}`);
    } catch (error) {
      setStatus(`实时拉取失败：${String(error)}`);
    } finally {
      await keepLoadingVisible(startedAt);
      setLoading(false);
    }
  }

  async function pullLatestEsaOverview(account: Account) {
    if (!supportsResourceSync(account)) {
      setStatus(`${cloudProvider(account.cloud_type).label}的边缘安全加速实时拉取尚未接入`);
      return;
    }
    const startedAt = Date.now();
    setLoading(true);
    try {
      const syncResult = runningInTauri
        ? await invoke<{ fetched: number; counts: Record<string, number>; errors: string[] }>("sync_cloud_assets", { id: account.id, resourceTypes: ["esa"] })
        : await webApi<{ fetched: number; counts: Record<string, number>; errors: string[] }>("/api/sync-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: account.id, resource_types: ["esa"] }) });
      const overview = runningInTauri
        ? await invoke<EsaOverview>("esa_overview", { id: account.id, range: esaRange, siteId: esaSelectedSiteId || null })
        : await webApi<EsaOverview>(`/api/esa-overview?id=${account.id}&range=${encodeURIComponent(esaRange)}${esaSelectedSiteId ? `&site_id=${encodeURIComponent(esaSelectedSiteId)}` : ""}`);
      setResources(await cachedResourceResponse(account, "esa"));
      setEsaOverview(overview);
      setActive({ account, view: "esa", source: "live" });
      await loadLocalAssets();
      await loadApiLogs();
      setStatus(`${account.account_name} · 边缘安全加速实时数据已更新${syncResult.errors.length ? `，${syncResult.errors.length} 项失败` : ""}`);
    } catch (error) {
      setStatus(`边缘安全加速实时拉取失败：${String(error)}`);
    } finally {
      await keepLoadingVisible(startedAt);
      setLoading(false);
    }
  }

  async function pullLatestSummary(account: Account) {
    if (!supportsResourceSync(account)) {
      setStatus(`${cloudProvider(account.cloud_type).label}汇总实时拉取尚未接入`);
      return;
    }
    const startedAt = Date.now();
    setLoading(true);
    try {
      const types = syncAssetTypes(account).map(([type]) => type);
      const syncResult = runningInTauri
        ? await invoke<{ fetched: number; errors: string[] }>("sync_cloud_assets", { id: account.id, resourceTypes: types })
        : await webApi<{ fetched: number; errors: string[] }>("/api/sync-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: account.id, resource_types: types }) });
      const latestSummary = ["vultr", "oracle", "huawei", "baidu", "ucloud", "qiniu", "aws", "azure", "gcp", "jdcloud", "qingcloud", "ksyun"].includes(account.cloud_type)
        ? await cachedSummary(account)
        : runningInTauri
        ? await invoke<Record<string, unknown>>("cloud_account_summary", { id: account.id })
        : await webApi<Record<string, unknown>>(`/api/cloud-summary?id=${account.id}`);
      setSummary(latestSummary);
      setActive({ account, view: "summary", source: "live" });
      await loadLocalAssets();
      await loadApiLogs();
      setStatus(`${account.account_name} · 汇总已实时拉取并更新 ${syncResult.fetched} 项本地资产${syncResult.errors.length ? `，${syncResult.errors.length} 项失败` : ""}`);
    } catch (error) {
      setStatus(`实时拉取汇总失败：${String(error)}`);
    } finally {
      await keepLoadingVisible(startedAt);
      setLoading(false);
    }
  }

  async function loadDomainTool(tool: DomainTool) {
    const startedAt = Date.now();
    setDomainToolLoading(true);
    setDomainToolError("");
    try {
      if (tool.kind === "whois") {
        const data = runningInTauri
          ? await invoke<string>("query_whois", {
              id: tool.account.id,
              domain: tool.domain,
            })
          : await webApi<string>(
              `/api/whois?id=${tool.account.id}&domain=${encodeURIComponent(tool.domain)}`,
            );
        setDomainToolData({ text: data });
      } else {
        const data = runningInTauri
          ? await invoke<Record<string, unknown>>(
              tool.kind === "dns" ? "list_dns_records" : "list_domain_logs",
              tool.kind === "dns"
                ? {
                    id: tool.account.id,
                    domain: tool.domain,
                    recordType: domainToolType || null,
                    keyword: domainToolFilter || null,
                    pageNumber: domainToolPage,
                    pageSize: domainToolPageSize,
                  }
                : {
                    id: tool.account.id,
                    domain: tool.domain,
                    startDate: null,
                    endDate: null,
                    keyword: domainToolFilter || null,
                    pageNumber: domainToolPage,
                    pageSize: domainToolPageSize,
                  },
            )
          : await webApi<Record<string, unknown>>(
              `/api/${tool.kind === "dns" ? "dns-records" : "domain-logs"}?id=${tool.account.id}&domain=${encodeURIComponent(tool.domain)}&page=${domainToolPage}&pageSize=${domainToolPageSize}${domainToolFilter ? `&keyword=${encodeURIComponent(domainToolFilter)}` : ""}${tool.kind === "dns" && domainToolType ? `&type=${domainToolType}` : ""}`,
            );
        setDomainToolData(data);
        const total = Number((data as Record<string, unknown>)?.total ?? 0);
        if (!Number.isNaN(total)) setDomainToolTotal(total);
      }
    } catch (error) {
      setDomainToolError(String(error));
    } finally {
      await keepLoadingVisible(startedAt);
      setDomainToolLoading(false);
    }
  }
  useEffect(() => {
    if (!domainTool) return;
    if (domainTool.kind === "whois") return;
    void loadDomainTool(domainTool);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainToolType, domainToolFilter]);

  useEffect(() => {
    if (!domainTool) return;
    if (domainTool.kind === "whois") return;
    void loadDomainTool(domainTool);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainToolPage]);

  function searchDomainTool() {
    if (!domainTool) return;
    const filtersChanged =
      domainToolDraftType !== domainToolType ||
      domainToolDraftFilter !== domainToolFilter;
    if (filtersChanged) {
      setDomainToolPage(1);
      setDomainToolType(domainToolDraftType);
      setDomainToolFilter(domainToolDraftFilter);
      return;
    }
    void loadDomainTool(domainTool);
  }

  function searchDomains() {
    setDomainSearchLoading(true);
    setDomainKeyword(domainKeywordDraft);
    window.setTimeout(() => setDomainSearchLoading(false), 320);
  }

  async function dnsAdd() {
    if (!domainTool || domainTool.kind !== "dns") return;
    if (["tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud", "aws", "jdcloud", "qingcloud", "ksyun", "azure", "gcp"].includes(domainTool.account.cloud_type)) { setStatus(`${cloudProvider(domainTool.account.cloud_type).label} DNS 解析当前仅支持只读查看`); return; }
    console.log("[dnsAdd] open editor");
    setDnsEditor({ mode: "add" });
  }
  async function dnsQuickAdd(recordType: string, rr: string) {
    if (!domainTool || domainTool.kind !== "dns") return;
    if (["tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud", "aws", "jdcloud", "qingcloud", "ksyun", "azure", "gcp"].includes(domainTool.account.cloud_type)) { setStatus(`${cloudProvider(domainTool.account.cloud_type).label} DNS 解析当前仅支持只读查看`); return; }
    console.log("[dnsQuickAdd] open editor", recordType, rr);
    setDnsEditor({ mode: "quick", preset: { type: recordType, rr } });
  }
  async function submitDnsEditor(input: {
    type: string;
    rr: string;
    value: string;
    ttl: number;
    priority: number;
    line: string;
  }) {
    if (!domainTool || domainTool.kind !== "dns") return;
    if (["tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud", "aws", "jdcloud", "qingcloud", "ksyun", "azure", "gcp"].includes(domainTool.account.cloud_type)) throw new Error(`${cloudProvider(domainTool.account.cloud_type).label} DNS 解析当前仅支持只读查看`);
    const isEdit = dnsEditor?.mode === "edit" && dnsEditor.row;
    if (runningInTauri) {
      if (isEdit)
        await invoke("update_dns_record", {
          id: domainTool.account.id,
          recordId: String(dnsEditor!.row!.RecordId),
          recordType: input.type,
          rr: input.rr,
          value: input.value,
          ttl: input.ttl,
          priority: input.priority,
          line: input.line,
        });
      else
        await invoke("add_dns_record", {
          id: domainTool.account.id,
          domain: domainTool.domain,
          recordType: input.type,
          rr: input.rr,
          value: input.value,
          ttl: input.ttl,
          priority: input.priority || undefined,
          line: input.line,
        });
    } else {
      if (isEdit)
        await webApi("/api/dns-records", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: domainTool.account.id,
            recordId: String(dnsEditor!.row!.RecordId),
            recordType: input.type,
            rr: input.rr,
            value: input.value,
            ttl: input.ttl,
            priority: input.priority,
            line: input.line,
          }),
        });
      else
        await webApi("/api/dns-records", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: domainTool.account.id,
            domain: domainTool.domain,
            recordType: input.type,
            rr: input.rr,
            value: input.value,
            ttl: input.ttl,
            priority: input.priority || undefined,
            line: input.line,
          }),
        });
    }
    await loadDomainTool(domainTool);
    setStatus(isEdit ? "解析记录已更新" : "解析记录已添加");
    setDnsEditor(null);
  }
  async function updateDnsField(
    row: Record<string, unknown>,
    field: "Value" | "RR" | "TTL" | "Priority" | "Line",
    next: string,
  ) {
    if (!domainTool || domainTool.kind !== "dns") return;
    if (["tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud", "aws", "jdcloud", "qingcloud", "ksyun", "azure", "gcp"].includes(domainTool.account.cloud_type)) { setStatus(`${cloudProvider(domainTool.account.cloud_type).label} DNS 解析当前仅支持只读查看`); return; }
    setDnsInlineEdit(null);
    const normalized = next.trim();
    if (normalized === String(row[field] ?? "")) return;
    try {
      const payload = {
        id: domainTool.account.id,
        recordId: String(row.RecordId),
        recordType: String(row.Type || "A"),
        rr: String(row.RR || ""),
        value: String(row.Value || ""),
        ttl: Number(row.TTL || 600),
        priority: Number(row.Priority || 10),
        line: String(row.Line || "default"),
        ...(field === "Value" ? { value: normalized } : {}),
        ...(field === "RR" ? { rr: normalized } : {}),
        ...(field === "TTL" ? { ttl: Number(normalized) || 600 } : {}),
        ...(field === "Priority" ? { priority: Number(normalized) || 10 } : {}),
        ...(field === "Line" ? { line: normalized } : {}),
      };
      if (runningInTauri)
        await invoke("update_dns_record", payload);
      else
        await webApi("/api/dns-records", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      await loadDomainTool(domainTool);
      setStatus(`${field} 已更新`);
    } catch (error) {
      setDomainToolError(String(error));
    }
  }

  async function dnsRowAction(
    row: Record<string, unknown>,
    action: "toggle" | "delete" | "edit",
  ) {
    if (!domainTool || domainTool.kind !== "dns") return;
    if (["tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud", "aws", "jdcloud", "qingcloud", "ksyun", "azure", "gcp"].includes(domainTool.account.cloud_type)) { setStatus(`${cloudProvider(domainTool.account.cloud_type).label} DNS 解析当前仅支持只读查看`); return; }
    try {
      if (
        action === "delete" &&
        !(await requestConfirm(`确定删除 ${String(row.RR || "")} 记录吗？`))
      )
        return;
      if (action === "edit") {
        setDnsEditor({ mode: "edit", row });
        return;
      } else if (runningInTauri) {
        await invoke(
          action === "delete" ? "delete_dns_record" : "toggle_dns_record",
          action === "delete"
            ? { id: domainTool.account.id, recordId: String(row.RecordId) }
            : {
                id: domainTool.account.id,
                recordId: String(row.RecordId),
                status:
                  String(row.Status).toUpperCase() === "ENABLE"
                    ? "Disable"
                    : "Enable",
              },
        );
      } else {
        await webApi("/api/dns-records", {
          method: action === "delete" ? "DELETE" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: domainTool.account.id,
            recordId: String(row.RecordId),
            status:
              String(row.Status).toUpperCase() === "ENABLE"
                ? "Disable"
                : "Enable",
          }),
        });
      }
      await loadDomainTool(domainTool);
      setStatus(action === "delete" ? "解析记录已删除" : "解析记录状态已更新");
    } catch (error) {
      setDomainToolError(String(error));
    }
  }

  async function load() {
    const startedAt = Date.now();
    setAccountSearchLoading(true);
    try {
      setAccounts(
        runningInTauri
          ? await invoke<Account[]>("list_accounts", {
              keyword: keyword || null,
            })
          : await webApi<Account[]>(
              `/api/accounts?keyword=${encodeURIComponent(keyword)}`,
            ),
      );
    } catch (error) {
      setStatus(String(error));
    } finally {
      await keepLoadingVisible(startedAt);
      setAccountSearchLoading(false);
    }
  }
  useEffect(() => {
    void load();
    void loadLocalAssets();
    void loadManagedHosts();
    void loadPanelConnections();
    void loadApiLogs();
    if (runningInTauri) {
      void getVersion().then(setAppVersion).catch(() => {});
    }
    void checkForUpdates(true);
    return () => {
      const update = updateRef.current;
      updateRef.current = null;
      if (update) void update.close();
    };
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
      if (preferences[cloudHubManagedHostOrderStorageKey] !== undefined) setManagedHostOrder(stringListFromValue(preferences[cloudHubManagedHostOrderStorageKey]));
      if (preferences[cloudHubManagedHostGroupOrderStorageKey] !== undefined) setManagedHostGroupOrder(stringListFromValue(preferences[cloudHubManagedHostGroupOrderStorageKey]));
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
  function saveClientPreference(key: string, value: string) {
    if (runningInTauri && clientPreferencesReady) void invoke("save_client_preference", { key, value }).catch(() => {});
  }
  useEffect(() => { const value = autoRefresh ? "1" : "0"; localStorage.setItem("aliyun-auto-refresh", value); saveClientPreference("aliyun-auto-refresh", value); }, [autoRefresh, clientPreferencesReady]);
  useEffect(() => { const value = compactMode ? "1" : "0"; localStorage.setItem("aliyun-compact-mode", value); document.documentElement.classList.toggle("compact-mode", compactMode); saveClientPreference("aliyun-compact-mode", value); }, [compactMode, clientPreferencesReady]);
  useEffect(() => { const value = hidePanelIps ? "1" : "0"; localStorage.setItem("aliyun-panel-hide-ip", value); saveClientPreference("aliyun-panel-hide-ip", value); }, [hidePanelIps, clientPreferencesReady]);
  useEffect(() => { localStorage.setItem("aliyun-panel-open-mode", panelOpenMode); saveClientPreference("aliyun-panel-open-mode", panelOpenMode); }, [panelOpenMode, clientPreferencesReady]);
  useEffect(() => { const value = String(panelRefreshSeconds); localStorage.setItem("aliyun-panel-refresh-seconds", value); saveClientPreference("aliyun-panel-refresh-seconds", value); }, [panelRefreshSeconds, clientPreferencesReady]);
  useEffect(() => {
    if (!runningInTauri || section !== "panels" || panelRefreshSeconds <= 0 || !panelConnections.length) return;
    const timer = window.setInterval(() => { void refreshAllPanelConnections(true); }, panelRefreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [section, panelRefreshSeconds, panelConnections]);
  useEffect(() => { const value = String(pageSize); localStorage.setItem("aliyun-page-size", value); saveClientPreference("aliyun-page-size", value); setAccountPage(1); setAssetPage(1); setFavoritePage(1); setLogPage(1); setApiLogPage(1); }, [pageSize, clientPreferencesReady]);
  useEffect(() => { const value = JSON.stringify(favoriteAssetKeys); localStorage.setItem(cloudHubFavoriteAssetsStorageKey, value); saveClientPreference(cloudHubFavoriteAssetsStorageKey, value); }, [favoriteAssetKeys, clientPreferencesReady]);
  useEffect(() => { const value = JSON.stringify(favoriteAssetOrder); localStorage.setItem(cloudHubFavoriteAssetOrderStorageKey, value); saveClientPreference(cloudHubFavoriteAssetOrderStorageKey, value); }, [favoriteAssetOrder, clientPreferencesReady]);
  useEffect(() => { const value = JSON.stringify(assetNotes); localStorage.setItem(cloudHubAssetNotesStorageKey, value); saveClientPreference(cloudHubAssetNotesStorageKey, value); }, [assetNotes, clientPreferencesReady]);
  useEffect(() => { const value = JSON.stringify(assetOrder); localStorage.setItem(cloudHubAssetOrderStorageKey, value); saveClientPreference(cloudHubAssetOrderStorageKey, value); }, [assetOrder, clientPreferencesReady]);
  useEffect(() => { const value = JSON.stringify(assetDisplayNames); localStorage.setItem(cloudHubAssetDisplayNamesStorageKey, value); saveClientPreference(cloudHubAssetDisplayNamesStorageKey, value); }, [assetDisplayNames, clientPreferencesReady]);
  useEffect(() => { const value = JSON.stringify(managedHostOrder); localStorage.setItem(cloudHubManagedHostOrderStorageKey, value); saveClientPreference(cloudHubManagedHostOrderStorageKey, value); }, [managedHostOrder, clientPreferencesReady]);
  useEffect(() => { const value = JSON.stringify(managedHostGroupOrder); localStorage.setItem(cloudHubManagedHostGroupOrderStorageKey, value); saveClientPreference(cloudHubManagedHostGroupOrderStorageKey, value); }, [managedHostGroupOrder, clientPreferencesReady]);
  useEffect(() => { localStorage.setItem(cloudHubTerminalThemeStorageKey, terminalThemeName); saveClientPreference(cloudHubTerminalThemeStorageKey, terminalThemeName); }, [terminalThemeName, clientPreferencesReady]);
  useEffect(() => { const value = String(operationLogClearedAt); localStorage.setItem("aliyun-operation-log-cleared-at", value); saveClientPreference("aliyun-operation-log-cleared-at", value); }, [operationLogClearedAt, clientPreferencesReady]);
  useEffect(() => {
    setSelectedAccountIds((current) => {
      const accountIds = new Set(accounts.map((account) => account.id));
      const next = new Set([...current].filter((id) => accountIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [accounts]);
  useEffect(() => { setAccountPage(1); }, [keyword, filterField, groupFilter, statusFilter, cloudFilter]);
  useEffect(() => { setAssetPage(1); }, [resourceAccountId, resourceTypeFilter, assetKeyword, assetRegionFilter, assetStatusFilter]);
  useEffect(() => { setFavoritePage(1); }, [favoriteTypeFilter, favoriteKeyword, favoriteRegionFilter]);
  useEffect(() => { setLogPage(1); }, [logFilter, logTypeFilter]);
  useEffect(() => { setApiLogPage(1); }, [logFilter]);
  useEffect(() => { if (!status) return; const timer = window.setTimeout(() => setStatus(""), 2600); return () => window.clearTimeout(timer); }, [status]);
  useEffect(() => { if (moreId === null) return; const close = (event: globalThis.MouseEvent) => { const target = event.target as HTMLElement; if (!target.closest(".more-wrap")) { setMoreId(null); setMorePosition(null); } }; document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close); }, [moreId]);

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
  async function save(event: FormEvent) {
    event.preventDefault();
    setStatus("保存中…");
    try {
      const normalizedDraft = {
        ...draft,
        account_name: draft.account_name.trim(),
        group_name: draft.group_name.trim(),
        access_key_id: draft.access_key_id.trim(),
        access_key_secret: draft.access_key_secret.trim(),
        tenancy_ocid: draft.tenancy_ocid.trim(),
        key_fingerprint: draft.key_fingerprint.trim(),
        tenant_id: draft.tenant_id.trim(),
        subscription_id: draft.subscription_id.trim(),
        project_id: draft.project_id.trim(),
        region_id: draft.region_id.trim(),
        remark: draft.remark.trim(),
      };
      const input = {
        ...normalizedDraft,
        access_key_id: normalizedDraft.access_key_id || (normalizedDraft.cloud_type === "vultr" ? normalizedDraft.account_name : ""),
        group_name: normalizedDraft.group_name || null,
        region_id: normalizedDraft.region_id || null,
        remark: normalizedDraft.remark || null,
        access_key_secret: normalizedDraft.access_key_secret || null,
        credential_meta: normalizedDraft.cloud_type === "oracle" ? JSON.stringify({ tenancy_ocid: normalizedDraft.tenancy_ocid, key_fingerprint: normalizedDraft.key_fingerprint }) : normalizedDraft.cloud_type === "azure" ? JSON.stringify({ tenant_id: normalizedDraft.tenant_id, subscription_id: normalizedDraft.subscription_id }) : normalizedDraft.cloud_type === "gcp" ? JSON.stringify({ project_id: normalizedDraft.project_id }) : null,
      };
      const saved = runningInTauri ? await invoke<Account>("save_account", { input }) : await webApi<Account>("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (saved.cloud_type !== draft.cloud_type)
        throw new Error(`账号保存类型异常：期望 ${cloudProvider(draft.cloud_type).label}，实际为 ${cloudProvider(saved.cloud_type).label}。请重启本地服务后重试。`);
      setDialog(false);
      setDraft(empty);
      setStatus("账号已保存");
      await load();
    } catch (error) {
      setStatus(String(error));
    }
  }
  async function verifyCloudAccount() {
    if (!draft.id || !["vultr", "ctyun", "huawei", "baidu", "jdcloud", "ucloud", "qingcloud", "ksyun", "qiniu", "aws", "azure", "gcp"].includes(draft.cloud_type)) return;
    setVerifyingAccount(true);
    try {
      const result = runningInTauri
        ? await invoke<{ region_count: number; default_region: string }>(`verify_${draft.cloud_type}_account`, { id: draft.id })
        : await webApi<{ region_count: number; default_region: string }>("/api/verify-account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: draft.id }) });
      setStatus(`${cloudProvider(draft.cloud_type).label}账号验证成功，已读取 ${result.region_count} 个地域`);
      if (!draft.region_id && result.default_region) setDraft((current) => ({ ...current, region_id: result.default_region }));
    } catch (error) {
      setStatus(`${cloudProvider(draft.cloud_type).label}账号验证失败：${String(error)}`);
    } finally { setVerifyingAccount(false); }
  }
  async function remove(id: number) {
    if (!(await requestConfirm("确定删除这个本地云账号吗？"))) return;
    try {
      if (runningInTauri) await invoke("delete_account", { id });
      else await webApi(`/api/accounts?id=${id}`, { method: "DELETE" });
      setStatus("账号已删除");
      await load();
    } catch (error) {
      setStatus(String(error));
    }
  }
  async function exportAccounts() {
    const accountIds = [...selectedAccountIds];
    const exportCount = accountIds.length || accounts.length;
    const exportScope = accountIds.length ? `已勾选的 ${accountIds.length} 个` : `全部 ${exportCount} 个`;
    if (!(await requestConfirm(`导出文件会包含 AccessKey Secret，将导出${exportScope}云账号，请妥善保管。确定继续吗？`)))
      return;
    try {
      if (runningInTauri) {
        const path = await invoke<string>("export_accounts_file", { accountIds: accountIds.length ? accountIds : null });
        setStatus(`已导出云账号，文件已保存到：${path}`);
        return;
      }
      const query = accountIds.length ? `?${accountIds.map((id) => `id=${encodeURIComponent(id)}`).join("&")}` : "";
      const data = (await webApi<{ accounts: TransferAccount[] }>(`/api/export${query}`)).accounts;
      downloadJson(
        { format: "cloudhub-tools-account-export", version: 2, encryption: "plaintext", secret_exported: true, exported_at: new Date().toISOString(), accounts: data },
        `cloudhub-tools-accounts-${new Date().toISOString().slice(0, 10)}.json`,
      );
      setStatus(`已导出 ${data.length} 个云账号`);
    } catch (error) {
      setStatus(`导出失败：${String(error)}`);
    }
  }
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
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importAccounts(file: File) {
    setImporting(true);
    try {
      const parsed = JSON.parse(await file.text());
      const data = Array.isArray(parsed) ? parsed : parsed.accounts;
      if (!Array.isArray(data))
        throw new Error("文件格式无效，需要 accounts 数组");
      if (!data.length) throw new Error("导入文件中没有云账号");
      const missingSecret = data.findIndex((item) => !String(item?.access_key_secret || "").trim());
      if (missingSecret >= 0) throw new Error(`第 ${missingSecret + 1} 条账号没有 AccessKey Secret，请使用完整导出文件`);
      const count = runningInTauri
        ? await invoke<number>("import_accounts", { accounts: data })
        : (
            await webApi<{ imported: number }>("/api/import", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ accounts: data }),
            })
          ).imported;
      setStatus(`已导入 ${count} 个云账号`);
      await load();
    } catch (error) {
      setStatus(`导入失败：${String(error)}`);
    } finally {
      setImporting(false);
    }
  }
  async function openOssQuickTool(account: Account, asset: LocalAsset, kind: "files" | "stat") {
    const bucket = String(asset.payload?.Name || asset.asset_key || "").trim();
    if (!bucket) { setStatus("对象存储资产缺少存储桶名称"); return; }
    setSection("resources");
    setOssQuickTool({ accountId: account.id, bucket, kind });
    await openCachedView(account, "oss");
  }
  const activeTitle = active
    ? `【${active.account.account_name}】${active.view === "summary" ? "账号汇总" : labels[active.view]}`
    : "";
  const tableColumns = useMemo(
    () => resourceColumns(resources?.items ?? []),
    [resources],
  );
  const visibleAccounts = useMemo(
    () =>
      accounts.filter((account) => {
        const source =
          filterField === "account_name"
            ? account.account_name
            : account.access_key_id;
        const matchesKeyword =
          !keyword.trim() ||
          source.toLowerCase().includes(keyword.trim().toLowerCase());
        const matchesGroup =
          !groupFilter || (account.group_name || "") === groupFilter;
        const matchesStatus =
          statusFilter === "all" ||
          (statusFilter === "1" ? account.enabled : !account.enabled);
        const matchesCloud = !cloudFilter || account.cloud_type === cloudFilter;
        return matchesKeyword && matchesGroup && matchesStatus && matchesCloud;
      }),
    [accounts, keyword, filterField, groupFilter, statusFilter, cloudFilter],
  );
  const pagedAccounts = visibleAccounts.slice((accountPage - 1) * pageSize, accountPage * pageSize);
  const pagedAccountIds = pagedAccounts.map((account) => account.id);
  const allPagedAccountsSelected = pagedAccountIds.length > 0 && pagedAccountIds.every((id) => selectedAccountIds.has(id));
  function toggleAccountSelection(id: number) {
    setSelectedAccountIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function togglePagedAccountSelection() {
    setSelectedAccountIds((current) => {
      const next = new Set(current);
      if (allPagedAccountsSelected) pagedAccountIds.forEach((id) => next.delete(id));
      else pagedAccountIds.forEach((id) => next.add(id));
      return next;
    });
  }
  const groups = useMemo(
    () =>
      Array.from(
        new Set(
          accounts
            .map((account) => account.group_name)
            .filter(Boolean) as string[],
        ),
      ),
    [accounts],
  );
  const serverRegions = useMemo(() => {
    const regions = new Map<
      string,
      { name: string; items: Record<string, unknown>[] }
    >();
    for (const item of resources?.items ?? []) {
      const id = String(item._region_id || item.RegionId || "未知地域");
      const current = regions.get(id) || {
        name: String(item._region_name || id),
        items: [],
      };
      current.items.push(item);
      regions.set(id, current);
    }
    return Array.from(regions.entries());
  }, [resources]);
  const domainItems = useMemo(
    () =>
      (resources?.items ?? []).filter((item) => {
        const key = domainKeyword.trim().toLowerCase();
        return (
          !key ||
          String(item.DomainName || "")
            .toLowerCase()
            .includes(key) ||
          String(item.RegistrantOrganization || "")
            .toLowerCase()
            .includes(key)
        );
      }),
    [resources, domainKeyword],
  );
  const summaryPanel = (
    <div className="summary-reference">
      <div className="server-toolbar summary-source-toolbar">
        <span>{active?.source === "cache" ? `当前展示本地缓存${summary?.cached_at ? `，更新于 ${formatAssetDate(summary.cached_at)}` : ""}` : "当前展示实时拉取结果，资源缓存已更新"}</span>
      </div>
      <section className="summary-block-section">
        <h3><UserRound size={15} aria-hidden="true" />账号信息</h3>
        <div className="summary-info-grid">
          <div><span>{active?.account.cloud_type === "tencent" ? "腾讯云 AppId：" : "账号ID："}</span><strong>{displayValue(summary?.account_id)}</strong></div>
          <div><span>账号类型：</span><strong>{displayValue(summary?.account_type)}</strong></div>
        </div>
      </section>
      <section className="summary-block-section">
        <h3><Globe2 size={15} aria-hidden="true" />账户余额</h3>
        <div className="summary-balance-grid">
          <div className="summary-balance-item">
            <strong className="value-orange">{formatMoney(summary?.available_amount)}</strong>
            <span>可用余额(元)</span>
          </div>
          <div className="summary-balance-item">
            <strong className="value-green">{formatMoney(summary?.available_cash_amount)}</strong>
            <span>现金余额(元)</span>
          </div>
          <div className="summary-balance-item">
            <strong className="value-blue">{formatMoney(summary?.credit_amount)}</strong>
            <span>{active?.account.cloud_type === "tencent" ? "赠送金/代金券余额(元)" : "信用额度(元)"}</span>
          </div>
        </div>
      </section>
      <section className="summary-block-section">
        <h3><List size={15} aria-hidden="true" />消费统计</h3>
        <div className="summary-consume-grid">
          <div className="summary-consume-item">
            <strong className="value-pink">{formatMoney(summary?.month_consume)}</strong>
            <span>本月消费(元)</span>
          </div>
          <div className="summary-consume-item">
            <strong className="value-purple">{formatMoney(summary?.month_bill)}</strong>
            <span>本月账单(元)</span>
          </div>
        </div>
      </section>
      <section className="summary-block-section">
        <h3><Server size={15} aria-hidden="true" />资源统计</h3>
        <div className="summary-resource-grid">
          <div className="summary-resource-item">
            <strong className="value-blue">{displayValue(summary?.ecs_count) || 0}</strong>
            <span>{active?.account.cloud_type === "tencent" ? "CVM服务器" : "ECS服务器"}</span>
          </div>
          <div className="summary-resource-item">
            <strong className="value-gray">{displayValue(summary?.swas_count) || 0}</strong>
            <span>轻量服务器</span>
          </div>
          <div className="summary-resource-item">
            <strong className="value-green">{displayValue(summary?.rds_count) || 0}</strong>
            <span>云数据库</span>
          </div>
          <div className="summary-resource-item">
            <strong className="value-pink">{displayValue(summary?.redis_count) || 0}</strong>
            <span>云Redis</span>
          </div>
          <div className="summary-resource-item">
            <strong className="value-green">{displayValue(summary?.oss_count) || 0}</strong>
            <span>对象存储桶</span>
          </div>
          <div className="summary-resource-item">
            <strong className="value-purple">{displayValue(summary?.domain_count) || 0}</strong>
            <span>域名</span>
          </div>
          <div className="summary-resource-item">
            <strong className="value-orange">{displayValue(summary?.dns_record_count) || 0}</strong>
            <span>DNS记录</span>
          </div>
        </div>
      </section>
    </div>
  );
  const serverPanel = (
    <div className="server-reference">
      <div className="server-toolbar">
        <button
          className="layui-btn"
          disabled={loading}
          onClick={() => active && void pullLatestResources(active.account, "ecs")}
        >
          <RefreshCw className={loading ? "spin" : undefined} size={14} />
          {loading ? "拉取中…" : "实时拉取"}
        </button>
        <span>{active?.source === "cache" ? `当前展示本地缓存${resources?.fetched_at ? `，更新于 ${formatAssetDate(resources.fetched_at)}` : ""}` : "当前展示实时拉取结果，已同步到本地缓存"}</span>
      </div>
      <div className="server-summary">
        <span>
          地区数量：<strong>{serverRegions.length}</strong>
        </span>
        <span>
          服务器总数：<strong>{resources?.items.length || 0}</strong>
        </span>
        <span className="running">
          运行中：
          <strong>
            {
              (resources?.items || []).filter(
                (item) => String(item.Status || item.InstanceStatus || "").toUpperCase() === "RUNNING",
              ).length
            }
          </strong>
        </span>
        <span className="stopped">
          已停止：
          <strong>
            {
              (resources?.items || []).filter(
                (item) => String(item.Status || item.InstanceStatus || "").toUpperCase() === "STOPPED",
              ).length
            }
          </strong>
        </span>
      </div>
      {serverRegions.length === 0 ? (
        <div className="server-empty">
          <Cloud size={42} />
          <p>{active?.source === "cache" ? "本地缓存中暂无 ECS 服务器，请点击“实时拉取”获取最新数据" : "该账号下没有找到 ECS 服务器"}</p>
        </div>
      ) : (
        serverRegions.map(([regionId, region]) => (
          <div className="region-section" key={regionId}>
            <div className="region-title">
              {region.name} ({regionId}) - {region.items.length}台
            </div>
            {region.items.map((item, index) => (
              <ServerCard
                key={String(item.InstanceId || index)}
                account={active?.account!}
                item={item}
                displayName={assetDisplayNames[`${active?.account.id}:ecs:${String(item.InstanceId || index)}`]}
                onDisplayNameChange={(value) => {
                  const key = `${active?.account.id}:ecs:${String(item.InstanceId || index)}`;
                  setAssetDisplayNames((current) => {
                    const next = { ...current };
                    if (value) next[key] = value;
                    else delete next[key];
                    return next;
                  });
                }}
                onStatus={() => active && void pullLatestResources(active.account, "ecs")}
                onNotice={setStatus}
                onConfirm={requestConfirm}
                onPrompt={requestPrompt}
                onSshLogin={() => {
                  if (!active) return;
                  const instanceId = String(item.InstanceId || index);
                  void openSshClient({
                    account_id: active.account.id,
                    resource_type: "ecs",
                    asset_key: instanceId,
                    region_id: String(item._region_id || item.RegionId || active.account.region_id || ""),
                    payload: item,
                    fetched_at: resources?.fetched_at || Date.now(),
                  }, active.account);
                }}
              />
            ))}
          </div>
        ))
      )}
    </div>
  );
  const swasPanel = (
    <div className="swas-reference">
      <div className="server-toolbar">
        <button
          className="layui-btn layui-btn-warm"
          disabled={loading}
          onClick={() => active && void pullLatestResources(active.account, "swas")}
        >
          <RefreshCw className={loading ? "spin" : undefined} size={14} />
          {loading ? "拉取中…" : "实时拉取"}
        </button>
        <span>轻量应用服务器按地域展示</span>
      </div>
      <div className="server-summary">
        <span>
          实例总数：<strong>{resources?.items.length || 0}</strong>
        </span>
        <span className="running">
          运行中：
          <strong>
            {
              (resources?.items || []).filter((item) =>
                String(item.Status || item.InstanceStatus)
                  .toLowerCase()
                  .includes("running"),
              ).length
            }
          </strong>
        </span>
      </div>
      {(resources?.errors?.length ?? 0) > 0 && (
        <div className="error-list">
          {resources?.errors.map((error) => (
            <div key={error}>部分地域读取失败：{error}</div>
          ))}
        </div>
      )}
      {(resources?.items || []).length === 0 ? (
        <div className="detail-empty">
          <Cloud size={36} />
          暂无轻量应用服务器
        </div>
      ) : (
        <div className="swas-grid">
          {resources!.items.map((item, index) => (
            <SwasCard
              account={active?.account!}
              item={item}
              onRefresh={() => active && void pullLatestResources(active.account, "swas")}
              onNotice={setStatus}
              onConfirm={requestConfirm}
              onSshLogin={() => {
                if (!active) return;
                const instanceId = String(item.InstanceId || item.InstanceName || index);
                void openSshClient({
                  account_id: active.account.id,
                  resource_type: "swas",
                  asset_key: instanceId,
                  region_id: String(item._region_id || item.RegionId || active.account.region_id || ""),
                  payload: item,
                  fetched_at: resources?.fetched_at || Date.now(),
                }, active.account);
              }}
              key={String(item.InstanceId || item.InstanceName || index)}
            />
          ))}
        </div>
      )}
    </div>
  );
  const rdsPanel = (
    <div className="rds-reference">
      <div className="server-toolbar">
        <button
          className="layui-btn layui-btn-warm"
          disabled={loading}
          onClick={() => active && void pullLatestResources(active.account, "rds")}
        >
          <RefreshCw className={loading ? "spin" : undefined} size={14} />
          {loading ? "拉取中…" : "实时拉取"}
        </button>
        <span>云数据库按地域展示</span>
      </div>
      <div className="server-summary">
        <span>
          实例总数：<strong>{resources?.items.length || 0}</strong>
        </span>
        <span className="running">
          运行中：
          <strong>
            {
              (resources?.items || []).filter(
                (item) =>
                  String(item.DBInstanceStatus).toLowerCase() === "running",
              ).length
            }
          </strong>
        </span>
        <span className="stopped">
          已停止：
          <strong>
            {
              (resources?.items || []).filter(
                (item) =>
                  String(item.DBInstanceStatus).toLowerCase() === "stopped",
              ).length
            }
          </strong>
        </span>
      </div>
      {(resources?.items || []).length === 0 ? (
        <div className="detail-empty">
          <Database size={36} />
          暂无云数据库实例
        </div>
      ) : (
        <div>
          {serverRegions.map(([regionId, region]) => (
            <div className="region-section" key={regionId}>
              <div className="region-title rds-region-title">
                {region.name} ({regionId}) - {region.items.length}个
              </div>
              <div className="rds-grid">
                {region.items.map((item, index) => (
                  <RdsCard
                account={active?.account!}
                    item={item}
                    key={String(item.DBInstanceId || index)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
  const redisPanel = (
    <div className="redis-reference">
      <div className="server-toolbar">
        <button
          className="layui-btn layui-btn-warm"
          disabled={loading}
          onClick={() => active && void pullLatestResources(active.account, "redis")}
        >
          <RefreshCw className={loading ? "spin" : undefined} size={14} />
          {loading ? "拉取中…" : "实时拉取"}
        </button>
        <span>Redis 实例按地域展示</span>
      </div>
      <div className="server-summary">
        <span>
          实例总数：<strong>{resources?.items.length || 0}</strong>
        </span>
        <span className="running">
          运行中：
          <strong>
            {
              (resources?.items || []).filter(
                (item) =>
                  String(item.InstanceStatus).toLowerCase() === "normal",
              ).length
            }
          </strong>
        </span>
        <span>
          总内存：
          <strong>
            {(resources?.items || []).reduce(
              (sum, item) => sum + Number(item.Capacity || 0),
              0,
            )}{" "}
            MB
          </strong>
        </span>
      </div>
      {(resources?.items || []).length === 0 ? (
        <div className="detail-empty">
          <Cloud size={36} />
          暂无云 Redis 实例
        </div>
      ) : (
        <div>
          {serverRegions.map(([regionId, region]) => (
            <div className="region-section" key={regionId}>
              <div className="region-title redis-region-title">
                {region.name} ({regionId}) - {region.items.length}个
              </div>
              <div className="redis-grid">
                {region.items.map((item, index) => (
                  <RedisCard
                account={active?.account!}
                    item={item}
                    onRefresh={() => active && void pullLatestResources(active.account, "redis")}
                    key={String(item.InstanceId || index)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
  const ossPanel = (
    <div className="oss-reference">
      <div className="server-toolbar">
        <button
          className="layui-btn layui-btn-warm"
          disabled={loading}
          onClick={() => active && void pullLatestResources(active.account, "oss")}
        >
          <RefreshCw className={loading ? "spin" : undefined} size={14} />
          {loading ? "拉取中…" : "实时拉取"}
        </button>
        <span>对象存储桶列表</span>
      </div>
      <div className="server-summary">
        <span>
          存储桶总数：<strong>{resources?.items.length || 0}</strong>
        </span>
      </div>
      {(resources?.items || []).length === 0 ? (
        <div className="detail-empty">
          <Cloud size={36} />
          暂无对象存储桶
        </div>
      ) : (
        <div className="oss-grid">
          {resources!.items.map((item, index) => (
            <BucketCard
              account={active?.account!}
              item={item}
              key={String(item.Name || index)}
              quickAction={ossQuickTool?.accountId === active?.account.id && ossQuickTool?.bucket === String(item.Name || "") ? ossQuickTool?.kind ?? null : null}
              onQuickActionOpened={() => setOssQuickTool(null)}
              onConfirm={requestConfirm}
              onPrompt={requestPrompt}
            />
          ))}
        </div>
      )}
    </div>
  );
  const esaSites = resources?.items || [];
  const esaVisibleSites = esaSites.filter((item) => {
    const keyword = esaSiteKeyword.trim().toLowerCase();
    return !keyword || [item.SiteName, item.DomainName, item.SiteId, item.Name].some((value) => String(value || "").toLowerCase().includes(keyword));
  });
  const esaTrendPoints = esaOverview?.trend[esaTrend] || [];
  const esaTrendMax = Math.max(1, ...esaTrendPoints.map((point) => point.value));
  const esaChartPath = esaTrendPoints.map((point, index) => {
    const x = esaTrendPoints.length === 1 ? 36 : 36 + (index / (esaTrendPoints.length - 1)) * 688;
    const y = 172 - (point.value / esaTrendMax) * 138;
    return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const esaTrendOptions: { value: keyof EsaOverview["trend"]; label: string }[] = [
    { value: "traffic", label: "流量" }, { value: "requests", label: "请求数" }, { value: "page_view", label: "PV" },
  ];
  const openEsaConsole = () => {
    const cloudType = active?.account.cloud_type;
    const target = cloudType === "tencent"
      ? "https://console.cloud.tencent.com/edgeone"
      : cloudType === "volcengine"
        ? "https://console.volcengine.com/cdn/"
        : "https://esa.console.aliyun.com/";
    const label = cloudType === "tencent" ? "腾讯云 EdgeOne" : cloudType === "volcengine" ? "火山引擎 CDN" : "阿里云 ESA";
    window.open(target, "_blank", "noopener,noreferrer");
    setStatus(`已打开${label}控制台`);
  };
  const esaPanel = (
    <div className="esa-reference">
      <div className="esa-tabs">
        <button className={esaTab === "overview" ? "active" : ""} onClick={() => setEsaTab("overview")}>数据概览</button>
        <button className={esaTab === "sites" ? "active" : ""} onClick={() => setEsaTab("sites")}>站点列表</button>
        <button className={esaTab === "functions" ? "active" : ""} onClick={() => setEsaTab("functions")}>函数和 Pages</button>
      </div>
      <div className="esa-head">
        <div><h3>边缘安全加速</h3><small>{active?.source === "live" && esaOverview ? "实时数据" : "本地站点缓存"}</small></div>
        <button className="layui-btn layui-btn-primary" disabled={loading} onClick={() => active && void pullLatestEsaOverview(active.account)}>
          <RefreshCw className={loading ? "spin" : undefined} size={14} />{loading ? "拉取中…" : "实时拉取"}
        </button>
      </div>
      {esaTab === "overview" && <>
        <div className="esa-overview-toolbar">
          <label>站点<select value={esaSelectedSiteId} onChange={(event) => { setEsaSelectedSiteId(event.target.value); setEsaOverview(null); }}><option value="">全部站点</option>{(esaOverview?.site_options || esaSites.map((site) => ({ id: String(site.SiteId || ""), name: displayValue(site.SiteName || site.DomainName || site.Name) }))).map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
          <div className="esa-range-tabs">{[["today", "今日"], ["yesterday", "昨日"], ["week", "近 7 日"], ["month", "近 30 日"]].map(([value, label]) => <button key={value} className={esaRange === value ? "active" : ""} onClick={() => { setEsaRange(value); setEsaOverview(null); }}>{label}</button>)}</div>
          <span>{esaOverview ? `${esaOverview.range_label}实时统计` : "选择范围后点击实时拉取"}</span>
        </div>
        <div className="metric-grid">
          <div className="metric-card"><div className="label">边缘响应流量</div><div className="value">{esaOverview ? formatBytes(esaOverview.traffic) : "-"}</div><div className="hint">{esaOverview?.range_label || "本地缓存未包含统计"}</div></div>
          <div className="metric-card"><div className="label">总请求数</div><div className="value">{esaOverview ? formatMetric(esaOverview.requests) : "-"}</div><div className="hint">{esaOverview?.range_label || "本地缓存未包含统计"}</div></div>
          <div className="metric-card"><div className="label">WAF 防护请求数</div><div className="value">{esaOverview ? formatMetric(esaOverview.defence_requests) : "-"}</div><div className="hint">已拦截的 WAF 请求</div></div>
        </div>
        <div className="esa-chart-panel">
          <div className="esa-chart-head"><strong>{esaTrendOptions.find((item) => item.value === esaTrend)?.label}趋势</strong><div className="esa-trend-tabs">{esaTrendOptions.map((item) => <button key={item.value} className={esaTrend === item.value ? "active" : ""} onClick={() => setEsaTrend(item.value)}>{item.label}</button>)}</div></div>
          {esaOverview ? <><svg className="esa-chart" viewBox="0 0 760 210" preserveAspectRatio="none" role="img" aria-label="ESA 趋势图"><line x1="36" x2="724" y1="172" y2="172" /><line x1="36" x2="724" y1="103" y2="103" /><line x1="36" x2="724" y1="34" y2="34" />{esaChartPath && <path className="esa-chart-line" d={esaChartPath} />}</svg><div className="esa-chart-axis"><span>{formatEsaTime(esaTrendPoints[0]?.time || "")}</span><span>{formatEsaTime(esaTrendPoints[Math.floor(esaTrendPoints.length / 2)]?.time || "")}</span><span>{formatEsaTime(esaTrendPoints[esaTrendPoints.length - 1]?.time || "")}</span></div></> : <div className="esa-chart-empty">实时拉取后显示趋势数据</div>}
        </div>
        <div className="site-summary">已接入 <b>{esaOverview?.site_count ?? esaSites.length}</b> 个站点，其中 <b>{esaOverview?.active_count ?? esaSites.filter((item) => String(item.Status || "").toLowerCase() === "active").length}</b> 个已启用。</div>
      </>}
      {esaTab === "sites" && <div className="esa-sites">
        <div className="esa-sites-toolbar"><div className="site-summary">本地缓存共 <b>{esaSites.length}</b> 个站点</div><label className="esa-site-search"><Search size={14} /><input value={esaSiteKeyword} onChange={(event) => setEsaSiteKeyword(event.target.value)} placeholder="搜索站点或站点 ID" /></label></div>
        {esaVisibleSites.length ? <div className="resource-table-wrap"><table><thead><tr><th>站点</th><th>站点 ID</th><th>接入方式</th><th>覆盖范围</th><th>状态</th><th>套餐</th><th>操作</th></tr></thead><tbody>{esaVisibleSites.map((item, index) => <tr key={String(item.SiteId || index)}><td>{displayValue(item.SiteName || item.DomainName || item.Name)}</td><td><code>{displayValue(item.SiteId || item.Id)}</code></td><td>{displayValue(item.AccessType)}</td><td>{displayValue(item.Coverage || item.Region)}</td><td>{cloudStatusText(item.Status || item.SiteStatus)}</td><td>{displayValue(item.PlanName || item.Plan)}</td><td><button className="table-action" onClick={openEsaConsole}>控制台</button></td></tr>)}</tbody></table></div> : <div className="detail-empty"><Cloud size={34} />暂无匹配的边缘站点</div>}
      </div>}
      {esaTab === "functions" && <div className="function-panel"><h3>边缘函数和 Pages</h3><p>函数、Pages 项目及路由配置由云厂商边缘控制台统一管理。</p><button className="layui-btn" onClick={openEsaConsole}>打开边缘控制台</button></div>}
    </div>
  );
  const domainPanel = (
    <div className="domain-reference">
      <div className="domain-toolbar">
        <input
          value={domainKeywordDraft}
          onChange={(event) => setDomainKeywordDraft(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && searchDomains()}
          placeholder="搜索域名/持有者"
        />
        <button
          className="layui-btn"
          disabled={domainSearchLoading}
          onClick={searchDomains}
        >
          <RefreshCw className={domainSearchLoading ? "spin" : undefined} size={14} />
          {domainSearchLoading ? "筛选中…" : "搜索"}
        </button>
        <button
          className="layui-btn layui-btn-primary"
          disabled={loading}
          onClick={() => active && void pullLatestResources(active.account, "domain")}
        >
          <RefreshCw className={loading ? "spin" : undefined} size={14} />
          {loading ? "拉取中…" : "实时拉取"}
        </button>
      </div>
      <div className="domain-summary">
        <span>
          域名总数：<strong>{domainItems.length}</strong>
        </span>
        <span>
          解析记录：
          <strong className="blue-text">
            {domainItems.reduce(
              (sum, item) => sum + Number(item.RecordCount || 0),
              0,
            )}
          </strong>
        </span>
        <span>
          即将到期：
          <strong className="orange-text">
            {
              domainItems.filter((item) => {
                const days = daysUntil(item.ExpirationDate);
                return days !== null && days >= 0 && days <= 90;
              }).length
            }
          </strong>
        </span>
        <span>
          已过期：
          <strong className="red-text">
            {
              domainItems.filter(
                (item) => (daysUntil(item.ExpirationDate) ?? 0) < 0,
              ).length
            }
          </strong>
        </span>
        <span>
          未实名：
          <strong className="gray-text">
            {
              domainItems.filter(
                (item) =>
                  item.DomainAuditStatus &&
                  item.DomainAuditStatus !== "SUCCEED",
              ).length
            }
          </strong>
        </span>
      </div>
      {domainItems.length === 0 ? (
        <div className="domain-empty">
          <Globe2 size={42} />
          <p>暂无域名</p>
        </div>
      ) : (
        domainItems.map((item, index) => {
          const [status, statusClass] = domainStatus(item);
          const days = daysUntil(item.ExpirationDate);
          const dns = displayDnsServers(item.DnsServers);
          return (
            <article
              className="domain-card"
              key={String(item.DomainName || index)}
            >
              <div className="domain-header">
                <div className="domain-name">
                  ◉ {displayValue(item.DomainName)}
                  {item.NotInDns ? (
                    <span className="dns-tag dns-not-added">未添加DNS解析</span>
                  ) : dns.includes("alidns") || dns.includes("hichina") ? (
                    <span className="dns-tag dns-aliyun">
                      {dns.includes("alidns") ? "阿里云DNS" : "万网DNS"}
                    </span>
                  ) : dns ? (
                    <span className="dns-tag dns-other">第三方DNS</span>
                  ) : null}
                  {Boolean(item.DomainType) && (
                    <span className="dns-tag domain-type-tag">
                      {displayValue(item.DomainType)}
                    </span>
                  )}
                  {Boolean(item.RegistrantType) && (
                    <span className="registrant-type">
                      {String(item.RegistrantType) === "1" ? "个人" : "企业"}
                    </span>
                  )}
                  {Boolean(item.DomainAuditStatus) && (
                    <span
                      className={`dns-tag ${item.DomainAuditStatus === "SUCCEED" ? "audit-succeed" : item.DomainAuditStatus === "AUDITING" ? "audit-auditing" : "audit-nonaudit"}`}
                    >
                      {item.DomainAuditStatus === "SUCCEED"
                        ? "已认证"
                        : item.DomainAuditStatus === "AUDITING"
                          ? "审核中"
                          : "未认证"}
                    </span>
                  )}
                </div>
                <span className={`domain-status ${statusClass}`}>{status}</span>
              </div>
              <div className="domain-info">
                {Boolean(item.RegistrantOrganization) && (
                  <div>
                    <span>域名持有者：</span>
                    <b>{displayValue(item.RegistrantOrganization)}</b>
                  </div>
                )}
                {Boolean(item.RegistrationDate) && (
                  <div>
                    <span>注册时间：</span>
                    {displayValue(item.RegistrationDate)}
                  </div>
                )}
                {Boolean(item.ExpirationDate) && (
                  <div>
                    <span>到期时间：</span>
                    {displayValue(item.ExpirationDate)}{" "}
                    {days !== null && days < 90 && (
                      <b
                        className={
                          days < 0 ? "expire-danger" : "expire-warning"
                        }
                      >
                        （
                        {days < 0
                          ? `已过期 ${Math.abs(days)} 天`
                          : `${days} 天后到期`}
                        ）
                      </b>
                    )}
                  </div>
                )}
                <div>
                  <span>解析记录数：</span>
                  <b className="blue-text">
                    {displayValue(item.RecordCount || 0)} 条
                  </b>
                </div>
                {dns && (
                  <div>
                    <span>DNS服务器：</span>
                    {dns}
                  </div>
                )}
                {Boolean(item.CreateTime) && (
                  <div>
                    <span>DNS添加时间：</span>
                    {displayValue(item.CreateTime)}
                  </div>
                )}
                {Boolean(item.VersionCode) && (
                  <div>
                    <span>DNS版本：</span>
                    {displayValue(item.VersionCode)}
                  </div>
                )}
              </div>
              <div className="domain-actions">
                <button
                  className="layui-btn layui-btn-normal"
                  onClick={() => {
                    const tool = {
                      kind: "dns" as const,
                      account: active?.account!,
                      domain: String(item.DomainName || ""),
                    };
                    setDomainTool(tool);
                    void loadDomainTool(tool);
                  }}
                >
                  解析管理
                </button>
                {active?.account.cloud_type === "aliyun" && <button
                  className="layui-btn"
                  onClick={() => {
                    const tool = {
                      kind: "logs" as const,
                      account: active?.account!,
                      domain: String(item.DomainName || ""),
                    };
                    setDomainTool(tool);
                    void loadDomainTool(tool);
                  }}
                >
                  操作日志
                </button>}
                {active?.account.cloud_type === "aliyun" && <button
                  className="layui-btn layui-btn-primary"
                  onClick={() => {
                    const tool = {
                      kind: "whois" as const,
                      account: active?.account!,
                      domain: String(item.DomainName || ""),
                    };
                    setDomainTool(tool);
                    void loadDomainTool(tool);
                  }}
                >
                  WHOIS
                </button>}
              </div>
            </article>
          );
        })
      )}
    </div>
  );

  const selectedResourceAccount = accounts.find((account) => account.id === resourceAccountId) ?? null;
  const visibleLocalAssets = useMemo(() => {
    const order = new Map(assetOrder.map((key, index) => [key, index]));
    return localAssets
      .filter((asset) => {
        const payload = asset.payload || {};
        const label = String(payload.InstanceName || payload.DBInstanceDescription || payload.SiteName || payload.DomainName || payload.Name || asset.asset_key);
        const region = String(asset.region_id || payload.RegionId || payload.Location || "");
        const status = String(payload.Status || payload.InstanceStatus || payload.DBInstanceStatus || payload.DomainStatus || "");
        const note = assetNotes[assetFavoriteKey(asset)] || "";
        return (resourceAccountId === null || asset.account_id === resourceAccountId)
          && (!resourceTypeFilter || asset.resource_type === resourceTypeFilter)
          && (!assetKeyword || `${label} ${asset.asset_key} ${note}`.toLowerCase().includes(assetKeyword.toLowerCase()))
          && (!assetRegionFilter || region === assetRegionFilter)
          && (!assetStatusFilter || status === assetStatusFilter);
      })
      .sort((left, right) => (order.get(assetFavoriteKey(left)) ?? Number.MAX_SAFE_INTEGER) - (order.get(assetFavoriteKey(right)) ?? Number.MAX_SAFE_INTEGER));
  }, [localAssets, assetOrder, assetNotes, resourceAccountId, resourceTypeFilter, assetKeyword, assetRegionFilter, assetStatusFilter]);
  const pagedLocalAssets = visibleLocalAssets.slice((assetPage - 1) * pageSize, assetPage * pageSize);
  const favoriteAssets = useMemo(() => {
    const keys = new Set(favoriteAssetKeys);
    return localAssets.filter((asset) => keys.has(assetFavoriteKey(asset)));
  }, [localAssets, favoriteAssetKeys]);
  const visibleFavoriteAssets = useMemo(() => {
    const order = new Map(favoriteAssetOrder.map((key, index) => [key, index]));
    return favoriteAssets.filter((asset) => {
    const payload = asset.payload || {};
    const account = accounts.find((item) => item.id === asset.account_id);
    const label = String(payload.InstanceName || payload.DBInstanceDescription || payload.SiteName || payload.DomainName || payload.Name || asset.asset_key);
    const region = String(asset.region_id || payload.RegionId || payload.Location || "");
    return (!favoriteTypeFilter || asset.resource_type === favoriteTypeFilter)
      && (!favoriteKeyword || `${label} ${asset.asset_key} ${account?.account_name || ""}`.toLowerCase().includes(favoriteKeyword.toLowerCase()))
      && (!favoriteRegionFilter || region === favoriteRegionFilter);
    }).sort((left, right) => (order.get(assetFavoriteKey(left)) ?? Number.MAX_SAFE_INTEGER) - (order.get(assetFavoriteKey(right)) ?? Number.MAX_SAFE_INTEGER));
  }, [favoriteAssets, favoriteAssetOrder, accounts, favoriteTypeFilter, favoriteKeyword, favoriteRegionFilter]);
  const pagedFavoriteAssets = visibleFavoriteAssets.slice((favoritePage - 1) * pageSize, favoritePage * pageSize);
  const managedHostGroups = useMemo(() => {
    const order = new Map(managedHostGroupOrder.map((group, index) => [group, index]));
    return Array.from(new Set(managedHosts.map((host) => host.group_name || "未分组")))
      .sort((left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right));
  }, [managedHosts, managedHostGroupOrder]);
  const visibleManagedHosts = useMemo(() => {
    const order = new Map(managedHostOrder.map((id, index) => [id, index]));
    const keyword = managedHostKeyword.trim().toLowerCase();
    return managedHosts.filter((host) => {
      return (!managedHostGroup || (host.group_name || "未分组") === managedHostGroup)
        && (!keyword || `${host.name} ${host.host} ${host.username} ${host.tags || ""}`.toLowerCase().includes(keyword));
    }).sort((left, right) => (order.get(String(left.id)) ?? Number.MAX_SAFE_INTEGER) - (order.get(String(right.id)) ?? Number.MAX_SAFE_INTEGER));
  }, [managedHosts, managedHostOrder, managedHostGroup, managedHostKeyword]);
  const panelGroups = useMemo(() => Array.from(new Set(panelConnections.map((panel) => panel.group_name || "未分组"))).sort(), [panelConnections]);
  const visiblePanels = useMemo(() => panelConnections.filter((panel) => {
    const keyword = panelKeyword.trim().toLowerCase();
    return (!panelGroup || (panel.group_name || "未分组") === panelGroup)
      && (!keyword || `${panel.name} ${panel.panel_url} ${panel.remark || ""}`.toLowerCase().includes(keyword));
  }), [panelConnections, panelGroup, panelKeyword]);
  const openLocalDomainTool = (asset: LocalAsset, account: Account, kind: DomainTool["kind"]) => {
    const payload = asset.payload || {};
    const tool = {
      kind,
      account,
      domain: String(payload.DomainName || payload.Name || asset.asset_key),
    };
    setDomainTool(tool);
    void loadDomainTool(tool);
  };
  const toggleAssetFavorite = (asset: LocalAsset) => {
    const key = assetFavoriteKey(asset);
    setFavoriteAssetKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
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
  const logRows = useMemo(() => accounts.flatMap((account) => localAssets.filter((asset) => asset.account_id === account.id && asset.fetched_at > operationLogClearedAt).map((asset) => ({ account, asset, action: "获取并保存资产" }))).filter((row) => (!logTypeFilter || row.asset.resource_type === logTypeFilter) && (!logFilter || `${row.account.account_name} ${row.asset.resource_type} ${row.action}`.toLowerCase().includes(logFilter.toLowerCase()))).sort((a, b) => b.asset.fetched_at - a.asset.fetched_at), [accounts, localAssets, operationLogClearedAt, logTypeFilter, logFilter]);
  const pagedLogRows = logRows.slice((logPage - 1) * pageSize, logPage * pageSize);
  const filteredApiLogs = useMemo(() => apiLogs.filter((log) => !logFilter || `${log.account_name || ""} ${log.endpoint} ${log.action} ${log.status}`.toLowerCase().includes(logFilter.toLowerCase())), [apiLogs, logFilter]);
  const pagedApiLogs = filteredApiLogs.slice((apiLogPage - 1) * pageSize, apiLogPage * pageSize);
  const accountResourceActions = (account: Account) => {
    return syncAssetTypes(account)
      .map(([resourceType], order) => ({
        resourceType,
        count: localAssets.filter((asset) => asset.account_id === account.id && asset.resource_type === resourceType).length,
        order,
      }))
      .sort((left, right) => right.count - left.count || left.order - right.order);
  };

  return (
    <div className="app-shell ide-theme" ref={appShellRef} style={{ "--app-sidebar-width": `${appSidebarWidth}px` } as CSSProperties}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <div className="ide-topbar" role="banner">
        <div className="ide-topbar-brand" onMouseDown={handleTitlebarMouseDown} onDoubleClick={handleTitlebarDoubleClick}><Cloud size={15} /><strong>云枢 Tools</strong><span>本地多云资源管理</span></div>
        <div className="ide-topbar-drag-region" aria-hidden="true" onMouseDown={handleTitlebarMouseDown} onDoubleClick={handleTitlebarDoubleClick} />
        <div className="ide-topbar-actions">
          <div className="ide-topbar-context"><span className="ide-topbar-dot" />LOCAL</div>
          {runningInTauri && <div className="ide-window-controls" aria-label="窗口控制">
            <button type="button" aria-label="最小化窗口" title="最小化" onClick={() => void performWindowAction("minimize")}><Minus size={14} /></button>
            <button type="button" aria-label="最大化或还原窗口" title="最大化或还原" onClick={() => void performWindowAction("toggleMaximize")}><Square size={12} /></button>
            <button type="button" className="ide-window-close" aria-label="关闭窗口" title="关闭" onClick={() => void performWindowAction("close")}><X size={15} /></button>
          </div>}
        </div>
      </div>
      <aside style={{ flexBasis: appSidebarWidth, width: appSidebarWidth }}>
        <div className="brand">
          <div className="brand-mark">
            <img src="/cloudhub-logo.png" alt="云枢 Tools" />
          </div>
          <div>
            <strong>
              云枢 Tools <span className="brand-version">v{appVersion}</span>
              {runningInTauri && updateState.phase === "available" && <button type="button" className="brand-update-button" aria-label={`发现新版本 v${updateState.version}`} title={`发现新版本 v${updateState.version}，点击更新`} onClick={() => void installUpdate()}><ArrowUpCircle size={16} /></button>}
              {isDevelopmentBuild ? <span className="brand-dev-badge">本地开发版</span> : null}
            </strong>
            <small>本地多云资源管家</small>
          </div>
        </div>
        <nav aria-label="主导航">
          <button type="button" className={section === "accounts" ? "nav-active" : ""} aria-current={section === "accounts" ? "page" : undefined} onClick={() => setSection("accounts")}>
            <Database size={18} />
            账号管理
          </button>
          <button type="button" className={section === "resources" ? "nav-active" : ""} aria-current={section === "resources" ? "page" : undefined} onClick={() => { setSection("resources"); void loadLocalAssets(); }}>
            <Server size={18} />
            资产管理
          </button>
          <button type="button" className={section === "favorites" ? "nav-active" : ""} aria-current={section === "favorites" ? "page" : undefined} onClick={() => { setSection("favorites"); void loadLocalAssets(); }}>
            <Star size={18} />
            我的收藏
          </button>
          <button type="button" className={section === "panels" ? "nav-active" : ""} aria-current={section === "panels" ? "page" : undefined} onClick={() => { setSection("panels"); void loadPanelConnections(); }}>
            <Monitor size={18} />
            面板管理
          </button>
          <button type="button" className={section === "servers" ? "nav-active" : ""} aria-current={section === "servers" ? "page" : undefined} onClick={() => { setSection("servers"); void loadManagedHosts(); }}>
            <Terminal size={18} />
            终端管理
          </button>
          <button type="button" className={section === "logs" ? "nav-active" : ""} aria-current={section === "logs" ? "page" : undefined} onClick={() => setSection("logs")}>
            <FileText size={18} />
            操作日志
          </button>
          <button type="button" className={section === "api_logs" ? "nav-active" : ""} aria-current={section === "api_logs" ? "page" : undefined} onClick={() => { setSection("api_logs"); void loadApiLogs(); }}>
            <Terminal size={18} />
            API日志
          </button>
          <button type="button" className={section === "settings" ? "nav-active" : ""} aria-current={section === "settings" ? "page" : undefined} onClick={() => setSection("settings")}>
            <Settings size={18} />
            系统设置
          </button>
        </nav>
      </aside>
      <div className="app-sidebar-resizer" role="separator" aria-label="调整主导航宽度" aria-orientation="vertical" onPointerDown={startAppSidebarResize} />
      <main id="main-content">
        <nav className="mobile-nav-bar" aria-label="移动端主导航">
          <div className="mobile-nav-scroll">
            <button type="button" className={section === "accounts" ? "nav-active" : ""} aria-current={section === "accounts" ? "page" : undefined} onClick={() => setSection("accounts")}><Database size={16} /><span>账号</span></button>
            <button type="button" className={section === "resources" ? "nav-active" : ""} aria-current={section === "resources" ? "page" : undefined} onClick={() => { setSection("resources"); void loadLocalAssets(); }}><Server size={16} /><span>资产</span></button>
            <button type="button" className={section === "favorites" ? "nav-active" : ""} aria-current={section === "favorites" ? "page" : undefined} onClick={() => { setSection("favorites"); void loadLocalAssets(); }}><Star size={16} /><span>收藏</span></button>
            <button type="button" className={section === "panels" ? "nav-active" : ""} aria-current={section === "panels" ? "page" : undefined} onClick={() => { setSection("panels"); void loadPanelConnections(); }}><Monitor size={16} /><span>面板</span></button>
            <button type="button" className={section === "servers" ? "nav-active" : ""} aria-current={section === "servers" ? "page" : undefined} onClick={() => { setSection("servers"); void loadManagedHosts(); }}><Terminal size={16} /><span>终端</span></button>
            <button type="button" className={section === "logs" ? "nav-active" : ""} aria-current={section === "logs" ? "page" : undefined} onClick={() => setSection("logs")}><FileText size={16} /><span>操作日志</span></button>
            <button type="button" className={section === "api_logs" ? "nav-active" : ""} aria-current={section === "api_logs" ? "page" : undefined} onClick={() => { setSection("api_logs"); void loadApiLogs(); }}><Terminal size={16} /><span>API 日志</span></button>
            <button type="button" className={section === "settings" ? "nav-active" : ""} aria-current={section === "settings" ? "page" : undefined} onClick={() => setSection("settings")}><Settings size={16} /><span>设置</span></button>
          </div>
        </nav>
        {status && <div className="toast-notice" role="status" aria-live="polite" aria-atomic="true">{status}</div>}
        <div className={`account-section ${section === "accounts" ? "" : "section-hidden"}`}>
        <header>
          <div>
            <span className="eyebrow">LOCAL CONSOLE</span>
            <h1>云账号管理</h1>
            <p>多云账号、密钥和已获取资源都加密保存在当前设备。</p>
          </div>
        </header>
        <section className="stats">
          <div>
            <span>云账号</span>
            <strong>{accounts.length}</strong>
            <small>本地管理</small>
          </div>
          <div>
            <span>已启用</span>
            <strong>{accounts.filter((a) => a.enabled).length}</strong>
            <small>可调用</small>
          </div>
          <div>
            <span>资源总数</span>
            <strong>{localAssets.length}</strong>
            <small>已获取资产</small>
          </div>
        </section>
        <section className="panel">
          <div className="layui-toolbar">
            <select
              value={filterField}
              aria-label="关键词字段"
              onChange={(e) =>
                setFilterField(
                  e.target.value as "account_name" | "access_key_id",
                )
              }
            >
              <option value="account_name">账号名称</option>
              <option value="access_key_id">AccessKeyId</option>
            </select>
            <input
              className="account-keyword-input"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void load()}
              placeholder="请输入关键词"
              aria-label="关键词"
            />
            <label>分组：</label>
            <select
              className="account-group-filter"
              aria-label="按分组筛选"
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
            >
              <option value="">全部分组</option>
              {groups.map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </select>
            <label>状态：</label>
            <select
              className="account-status-filter"
              aria-label="按状态筛选"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="1">启用</option>
              <option value="0">禁用</option>
              <option value="all">全部</option>
            </select>
            <label>云类型：</label>
            <select
              className="account-cloud-filter"
              aria-label="按云类型筛选"
              value={cloudFilter}
              onChange={(e) => setCloudFilter(e.target.value)}
            >
              <option value="">全部</option>
              {cloudProviders.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}
              {accounts.some((account) => account.cloud_type === "other") && <option value="other">未接入云（历史账号）</option>}
            </select>
            <button
              type="button"
              className="layui-btn layui-btn-search account-search-button"
              title="按当前条件搜索账号"
              aria-label="搜索账号"
              disabled={accountSearchLoading}
              onClick={() => void load()}
            >
              <RefreshCw className={accountSearchLoading ? "spin" : undefined} size={14} />
              {accountSearchLoading ? "查询中…" : "搜索"}
            </button>
            <button
              type="button"
              className="layui-btn account-add-button"
              title="添加云账号"
              aria-label="添加云账号"
              onClick={() => {
              setDraft(empty);
                setShowSecret(false);
                setDialog(true);
              }}
            >
              <Plus size={14} />
              添加
            </button>
            <button
              type="button"
              className="layui-btn account-group-button"
              title="账号分组跟随账号编辑"
              aria-label="分组管理"
              onClick={() => setStatus("分组管理：本地分组跟随账号编辑")}
            >
              分组管理
            </button>
            <button
              type="button"
              className="layui-btn account-export-button"
              title={selectedAccountIds.size ? `导出已勾选 ${selectedAccountIds.size} 个账号` : "导出全部账号"}
              aria-label="导出账号"
              onClick={() => void exportAccounts()}
            >
              <Download size={14} />
              {selectedAccountIds.size ? `导出已勾选 (${selectedAccountIds.size})` : "导出全部"}
            </button>
            <label className="layui-btn layui-btn-import account-import-button" title="导入账号 JSON">
              导入
              <input
                type="file"
                accept=".json,application/json"
                onChange={(e) =>
                  e.target.files?.[0] && void importAccounts(e.target.files[0])
                }
                disabled={importing}
              />
            </label>
          </div>
          {accounts.length === 0 ? (
            <div className="empty">
              <Cloud size={40} />
              <h3>还没有云账号</h3>
              <p>添加一个阿里云 RAM 账号开始管理。</p>
              <button
                className="primary"
                onClick={() => {
                  setDraft(empty);
                  setDialog(true);
                }}
              >
                <Plus size={17} />
                添加第一个账号
              </button>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="account-select"><input aria-label="全选当前页账号" type="checkbox" checked={allPagedAccountsSelected} onChange={togglePagedAccountSelection} /></th>
                    <th>云类型 / AccessKeyId</th>
                    <th>账号名称 / 添加时间</th>
                    <th>分组</th>
                    <th>备注</th>
                    <th>状态</th>
                    <th className="account-resources-column">资源</th>
                    <th className="account-actions-column">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedAccounts.map((account) => {
                    const resourceActions = accountResourceActions(account);
                    const primaryResourceActions = resourceActions.slice(0, 3);
                    const moreResourceActions = resourceActions.slice(3);
                    return <tr key={account.id}>
                      <td className="account-select"><input aria-label={`选择账号 ${account.account_name}`} type="checkbox" checked={selectedAccountIds.has(account.id)} onChange={() => toggleAccountSelection(account.id)} /></td>
                      <td>
                        <div className="account-cloud-credential">
                          <span className={`cloud-type cloud-type-text ${account.cloud_type}`}>
                            {cloudProvider(account.cloud_type).label}
                          </span>
                          <code>
                            {account.access_key_id.length > 10
                              ? `${account.access_key_id.slice(0, 6)}****${account.access_key_id.slice(-4)}`
                              : account.access_key_id}
                          </code>
                        </div>
                      </td>
                      <td>
                        <div className="account-name">
                          <span className={`avatar cloud-avatar ${account.cloud_type}`}>{cloudProvider(account.cloud_type).avatar}</span>
                          <div>
                            <strong>{account.account_name}</strong>
                            <small>{new Date(account.created_at).toLocaleString("zh-CN")}</small>
                          </div>
                        </div>
                      </td>
                      <td>{account.group_name || ""}</td>
                      <td>{account.remark || ""}</td>
                      <td>
                        <button
                          className={`status-switch ${account.enabled ? "checked" : ""}`}
                          onClick={async () => {
                            try {
                              const input = {
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
                              };
                              if (runningInTauri) await invoke("save_account", { input });
                              else await webApi("/api/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
                              await load();
                            } catch (error) {
                              setStatus(String(error));
                            }
                          }}
                        >
                          {account.enabled ? "启用" : "禁用"}
                        </button>
                      </td>
                      <td className="account-resources-cell">
                        {supportsResourceSync(account) ? <div className="resource-actions account-resource-actions">
                          {primaryResourceActions.map(({ resourceType, count }) => <button
                            key={resourceType}
                            type="button"
                            className={resourceType === "domain" ? "purple" : "blue"}
                            title={`查看${accountResourceActionLabels[resourceType]}资产（已获取 ${count} 项）`}
                            aria-label={`查看 ${account.account_name} ${accountResourceActionLabels[resourceType]}资产，已获取 ${count} 项`}
                            onClick={() => openAccountResource(account, resourceType)}
                          >
                            {accountResourceActionLabels[resourceType]}
                          </button>)}
                          {moreResourceActions.length > 0 && <span className={`more-wrap ${moreId === account.id ? "more-open" : ""}`}>
                            <button
                              type="button"
                              className="action-text more-trigger"
                              title="更多资产类型"
                              aria-label={`更多 ${account.account_name} 资产操作`}
                              onClick={(event) => {
                                if (moreId === account.id) {
                                  setMoreId(null);
                                  setMorePosition(null);
                                  return;
                                }
                                const rect = event.currentTarget.getBoundingClientRect();
                                const menuHeight = Math.min(280, 14 + moreResourceActions.length * 38);
                                const top = rect.bottom + menuHeight > window.innerHeight ? Math.max(8, rect.top - menuHeight - 6) : rect.bottom + 6;
                                setMoreId(account.id);
                                setMorePosition({ top, left: Math.max(8, Math.min(window.innerWidth - 182, rect.right - 174)) });
                              }}
                            >
                              <MoreHorizontal size={17} />
                            </button>
                            {moreId === account.id && (
                              <div className="more-menu" style={morePosition ? { position: "fixed", top: morePosition.top, left: morePosition.left, right: "auto" } : undefined}>
                                {moreResourceActions.map(({ resourceType, count }) => (
                                  <button
                                    key={resourceType}
                                    title={`查看${accountResourceActionLabels[resourceType]}资产（已获取 ${count} 项）`}
                                    aria-label={`查看 ${account.account_name} ${accountResourceActionLabels[resourceType]}资产，已获取 ${count} 项`}
                                    onClick={() => openAccountResource(account, resourceType)}
                                  >
                                    {accountResourceActionLabels[resourceType]}
                                  </button>
                                ))}
                              </div>
                            )}
                          </span>}
                        </div> : <span className="account-resource-muted">—</span>}
                      </td>
                      <td className="account-actions-cell">
                        <div className="resource-actions account-actions">
                          {supportsResourceSync(account) ? <>
                            <button
                              type="button"
                              className="teal"
                              title="选择资产类型并同步到本地"
                              aria-label={`获取 ${account.account_name} 资产`}
                              onClick={() => {
                                setSyncTypes(syncAssetTypes(account).map(([value]) => value));
                                setSyncAccount(account);
                              }}
                            >
                              获取资产
                            </button>
                            <button
                              type="button"
                              className="orange"
                              title="打开账号资产汇总"
                              aria-label={`打开 ${account.account_name} 资产汇总`}
                              onClick={() => void openCachedSummary(account)}
                            >
                              汇总
                            </button>
                          </> : <span className="action-text">仅保留历史账号</span>}
                          <button
                            type="button"
                            className="action-text"
                            title={`修改 ${account.account_name}`}
                            aria-label={`修改 ${account.account_name}`}
                            onClick={() => edit(account)}
                          >
                            修改
                          </button>
                          <button
                            type="button"
                            className="action-text danger"
                            title={`删除 ${account.account_name}`}
                            aria-label={`删除 ${account.account_name}`}
                            onClick={() => void remove(account.id)}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="pagination"><span>共 {visibleAccounts.length} 条记录</span><button disabled={accountPage <= 1} onClick={() => setAccountPage((value) => Math.max(1, value - 1))}>‹</button><strong>{accountPage}</strong><button disabled={accountPage >= Math.max(1, Math.ceil(visibleAccounts.length / pageSize))} onClick={() => setAccountPage((value) => value + 1)}>›</button></div>
        </section>
        {domainTool && createPortal(
          <div
            className="resource-modal-backdrop domain-tool-backdrop"
            onClick={() => { setDomainTool(null); setDomainToolMaximized(false); }}
          >
            <section
              className={`detail-panel resource-modal domain-tool-modal${domainToolMaximized ? " is-maximized" : ""}`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="detail-toolbar">
                <div>
                  <span className="eyebrow">
                    {domainTool.account.account_name}
                  </span>
                  <h2>
                    {domainTool.kind === "dns"
                      ? `【${domainTool.domain}】解析管理`
                      : domainTool.kind === "logs"
                        ? `【${domainTool.domain}】操作日志`
                        : `【${domainTool.domain}】WHOIS`}
                  </h2>
                </div>
                <div className="detail-toolbar-actions">
                  <button
                    className="secondary"
                    title={domainToolMaximized ? "还原窗口" : "放大到全屏"}
                    onClick={() => setDomainToolMaximized((value) => !value)}
                  >
                    {domainToolMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                    {domainToolMaximized ? "还原" : "放大"}
                  </button>
                  <button
                    className="secondary"
                    disabled={domainToolLoading}
                    onClick={() => void loadDomainTool(domainTool)}
                  >
                    <RefreshCw className={domainToolLoading ? "spin" : undefined} size={15} />
                    {domainToolLoading ? "刷新中…" : "刷新"}
                  </button>
                  <button
                    className="close-detail"
                    onClick={() => { setDomainTool(null); setDomainToolMaximized(false); }}
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
              <div className="domain-tool-body">
                {domainTool.kind !== "whois" && (
                  <div className="domain-tool-filter">
                    {domainTool.kind === "dns" && (
                      <select
                        value={domainToolDraftType}
                        onChange={(event) =>
                          setDomainToolDraftType(event.target.value)
                        }
                      >
                        <option value="">全部类型</option>
                        <option value="A">A</option>
                        <option value="AAAA">AAAA</option>
                        <option value="CNAME">CNAME</option>
                        <option value="MX">MX</option>
                        <option value="TXT">TXT</option>
                        <option value="NS">NS</option>
                      </select>
                    )}
                    <input
                      value={domainToolDraftFilter}
                      onChange={(event) =>
                        setDomainToolDraftFilter(event.target.value)
                      }
                      placeholder={
                        domainTool.kind === "dns"
                          ? "搜索主机记录"
                          : "搜索关键词"
                      }
                    />
                    <button
                      className="layui-btn layui-btn-sm"
                      disabled={domainToolLoading}
                      onClick={searchDomainTool}
                    >
                      <RefreshCw className={domainToolLoading ? "spin" : undefined} size={14} />
                      {domainToolLoading ? "查询中…" : "查询"}
                    </button>
                  </div>
                )}
                {domainTool.kind === "dns" && !["tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu"].includes(domainTool.account.cloud_type) && (
                  <div className="domain-tool-actions">
                    <span className="quick-add-label">快速添加：</span>
                    {[
                      { label: "@记录", type: "A", rr: "@" },
                      { label: "www记录", type: "A", rr: "www" },
                      { label: "www CNAME", type: "CNAME", rr: "www" },
                      { label: "MX记录", type: "MX", rr: "@" },
                      { label: "TXT记录", type: "TXT", rr: "@" },
                    ].map((item) => (
                      <button
                        key={item.label}
                        className="quick-add-btn"
                        onClick={() => void dnsQuickAdd(item.type, item.rr)}
                      >
                        {item.label}
                      </button>
                    ))}
                    <button
                      className="layui-btn layui-btn-normal dns-add-btn"
                      onClick={() => void dnsAdd()}
                    >
                      ＋ 添加记录
                    </button>
                    <span className="domain-tool-count">
                      共{" "}
                      {Array.isArray(domainToolData?.items)
                        ? domainToolData!.items.length
                        : 0}{" "}
                      条
                    </span>
                  </div>
                )}
                {domainToolLoading && !domainToolData && (
                  <div className="detail-empty">
                    <RefreshCw className="spin" size={24} />
                    正在读取…
                  </div>
                )}
                {domainToolError && (
                  <div className="error-list">
                    <div>{domainToolError}</div>
                  </div>
                )}
                {!domainToolError &&
                  domainTool.kind === "whois" && (
                    <pre className="whois-result">
                      {String(domainToolData?.text || "暂无 WHOIS 信息")}
                    </pre>
                  )}
                {!domainToolError &&
                  domainTool.kind !== "whois" &&
                  (Array.isArray(domainToolData?.items) &&
                  domainToolData!.items.length > 0 ? (
                    <div className="resource-table-wrap dns-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            {(domainTool.kind === "dns"
                              ? [
                                  "类型",
                                  "主机记录",
                                  "记录值",
                                  "TTL",
                                  "优先级",
                                  "线路",
                                  "状态",
                                  "操作",
                                ]
                              : ["ActionTime", "Action", "Message", "ClientIp"]
                            ).map((key) => (
                              <th key={key}>{key}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(
                            domainToolData!.items as Record<string, unknown>[]
                          ).map((row, index) => (
                            <tr key={index}>
                              {domainTool.kind === "dns" ? (
                                <>
                                  <td>
                                    <span className={`dns-type-tag dns-type-${String(row.Type || "").toLowerCase()}`}>
                                      {displayValue(row.Type)}
                                    </span>
                                  </td>
                                  <td onClick={() => setDnsInlineEdit({ recordId: String(row.RecordId), field: "RR" })}>
                  {dnsInlineEdit?.recordId === String(row.RecordId) && dnsInlineEdit.field === "RR" ? (
                    <input
                      autoFocus
                      className="cell-input"
                      defaultValue={String(row.RR ?? "")}
                      onBlur={(e) => void updateDnsField(row, "RR", e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                        if (e.key === "Escape") setDnsInlineEdit(null);
                      }}
                    />
                  ) : (
                    <span className="cell-view">{displayValue(row.RR)}</span>
                  )}
                </td>
                                  <td className="dns-value-cell" title={String(displayValue(row.Value))} onClick={() => setDnsInlineEdit({ recordId: String(row.RecordId), field: "Value" })}>
                  {dnsInlineEdit?.recordId === String(row.RecordId) && dnsInlineEdit.field === "Value" ? (
                    <input
                      autoFocus
                      className="cell-input"
                      defaultValue={String(row.Value ?? "")}
                      onBlur={(e) => void updateDnsField(row, "Value", e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                        if (e.key === "Escape") setDnsInlineEdit(null);
                      }}
                    />
                  ) : (
                    <span className="cell-view">{displayValue(row.Value)}</span>
                  )}
                </td>
                                  <td onClick={() => setDnsInlineEdit({ recordId: String(row.RecordId), field: "TTL" })}>
                  {dnsInlineEdit?.recordId === String(row.RecordId) && dnsInlineEdit.field === "TTL" ? (
                    <select
                      autoFocus
                      className="cell-input"
                      defaultValue={String(row.TTL ?? 600)}
                      onBlur={(e) => void updateDnsField(row, "TTL", e.target.value)}
                      onChange={(e) => { void updateDnsField(row, "TTL", e.target.value); }}
                    >
                      {[60,120,300,600,1800,3600,43200,86400].map((t) => <option key={t} value={String(t)}>{t}秒</option>)}
                    </select>
                  ) : (
                    <span className="cell-view">{displayValue(row.TTL)}{row.TTL ? "秒" : ""}</span>
                  )}
                </td>
                                  <td onClick={() => setDnsInlineEdit({ recordId: String(row.RecordId), field: "Priority" })}>
                  {dnsInlineEdit?.recordId === String(row.RecordId) && dnsInlineEdit.field === "Priority" ? (
                    <input
                      autoFocus
                      type="number"
                      className="cell-input"
                      defaultValue={String(row.Priority ?? 10)}
                      onBlur={(e) => void updateDnsField(row, "Priority", e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                        if (e.key === "Escape") setDnsInlineEdit(null);
                      }}
                    />
                  ) : (
                    <span className="cell-view">{row.Priority ? displayValue(row.Priority) : "-"}</span>
                  )}
                </td>
                                  <td onClick={() => setDnsInlineEdit({ recordId: String(row.RecordId), field: "Line" })}>
                  {dnsInlineEdit?.recordId === String(row.RecordId) && dnsInlineEdit.field === "Line" ? (
                    <select
                      autoFocus
                      className="cell-input"
                      defaultValue={String(row.Line ?? "default")}
                      onBlur={(e) => void updateDnsField(row, "Line", e.target.value)}
                      onChange={(e) => { void updateDnsField(row, "Line", e.target.value); }}
                    >
                      <option value="default">默认</option>
                      <option value="telecom">电信</option>
                      <option value="unicom">联通</option>
                      <option value="mobile">移动</option>
                      <option value="oversea">境外</option>
                      <option value="edu">教育网</option>
                      <option value="search">搜索引擎</option>
                    </select>
                  ) : (
                    <span className="cell-view">{displayValue(row.Line)}</span>
                  )}
                </td>
                                  <td onClick={() => void dnsRowAction(row, "toggle")}>
                                    {(() => {
                                      const s = String(row.Status || "").toUpperCase();
                                      const enabled = s === "ENABLE";
                                      return (
                                        <span className={`dns-status ${enabled ? "on" : "off"}`}>
                                          <span className="dns-status-dot" />{enabled ? "正常" : "暂停"}
                                        </span>
                                      );
                                    })()}
                                  </td>
                                  <td>
                                    <div className="dns-actions">
                                      <button
                                        className="dns-action-btn edit"
                                        disabled={["tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu"].includes(domainTool.account.cloud_type)}
                                        onClick={() =>
                                          void dnsRowAction(row, "edit")
                                        }
                                      >
                                        编辑
                                      </button>
                                      <button
                                        className="dns-action-btn warn"
                                        disabled={["tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu"].includes(domainTool.account.cloud_type)}
                                        onClick={() =>
                                          void dnsRowAction(row, "toggle")
                                        }
                                      >
                                        {String(row.Status).toUpperCase() ===
                                        "ENABLE"
                                          ? "暂停"
                                          : "启用"}
                                      </button>
                                      <button
                                        className="dns-action-btn danger"
                                        disabled={["tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu"].includes(domainTool.account.cloud_type)}
                                        onClick={() =>
                                          void dnsRowAction(row, "delete")
                                        }
                                      >
                                        删除
                                      </button>
                                    </div>
                                  </td>
                                </>
                              ) : (
                                (["ActionTime", "Action", "Message", "ClientIp"] as const).map((key) => (
                                  <td key={key}>{displayValue(row[key])}</td>
                                ))
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {domainToolTotal > domainToolPageSize && (
                        <div className="pagination dns-pagination">
                          <span>
                            共 {domainToolTotal} 条 / 第 {domainToolPage} 页
                          </span>
                          <button
                            disabled={domainToolPage <= 1}
                            onClick={() =>
                              setDomainToolPage((value) => Math.max(1, value - 1))
                            }
                          >
                            ‹
                          </button>
                          <strong>{domainToolPage}</strong>
                          <button
                            disabled={
                              domainToolPage >=
                              Math.max(1, Math.ceil(domainToolTotal / domainToolPageSize))
                            }
                            onClick={() =>
                              setDomainToolPage((value) => value + 1)
                            }
                          >
                            ›
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="detail-empty">
                      <Globe2 size={28} />
                      <span>
                        {domainTool.kind === "dns"
                          ? "暂无解析记录"
                          : "暂无操作日志"}
                      </span>
                    </div>
                  ))}
              </div>
            </section>
          </div>
        , document.body)}
        {dnsEditor && createPortal(
          <DnsEditorDialog
            preset={dnsEditor.preset}
            row={dnsEditor.row}
            mode={dnsEditor.mode}
            onCancel={() => setDnsEditor(null)}
            onSubmit={submitDnsEditor}
          />,
          document.body,
        )}
        {active && createPortal(
          <div
            className="resource-modal-backdrop"
            onClick={() => { setActive(null); setActiveMaximized(false); }}
          >
            <section
              className={`detail-panel resource-modal${activeMaximized ? " is-maximized" : ""}`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="detail-toolbar">
                <div>
                  <span className="eyebrow">{active.account.account_name}</span>
                  <h2>{activeTitle}</h2>
                </div>
                <div className="detail-toolbar-actions">
                  <button
                    className="secondary"
                    title={activeMaximized ? "还原窗口" : "放大到全屏"}
                    onClick={() => setActiveMaximized((value) => !value)}
                  >
                    {activeMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                    {activeMaximized ? "还原" : "放大"}
                  </button>
                  <button
                    className="secondary"
                    onClick={() => active.view === "summary" ? void pullLatestSummary(active.account) : active.view === "esa" ? void pullLatestEsaOverview(active.account) : void pullLatestResources(active.account, active.view)}
                  >
                    <RefreshCw size={15} />
                    实时拉取
                  </button>
                  <button
                    className="close-detail"
                    onClick={() => { setActive(null); setActiveMaximized(false); }}
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
              {loading ? (
                <div className="loading-overlay">
                  <span className="loading-text">加载中…</span>
                </div>
              ) : active.view === "summary" ? (
                summaryPanel
              ) : active.view === "ecs" ? (
                serverPanel
              ) : active.view === "swas" ? (
                swasPanel
              ) : active.view === "rds" ? (
                rdsPanel
              ) : active.view === "redis" ? (
                redisPanel
              ) : active.view === "oss" ? (
                ossPanel
              ) : active.view === "esa" ? (
                esaPanel
              ) : active.view === "domain" ? (
                domainPanel
              ) : (
                <div>
                  {(resources?.errors?.length ?? 0) > 0 && (
                    <div className="error-list">
                      {resources?.errors.map((error) => (
                        <div key={error}>部分区域读取失败：{error}</div>
                      ))}
                    </div>
                  )}
                  {resources?.items?.length ? (
                    <div className="resource-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            {tableColumns.map((key) => (
                              <th key={key}>{columnLabel(key)}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {resources.items.map((item, index) => (
                            <tr key={index}>
                              {tableColumns.map((key) => (
                                <td key={key}>{displayValue(item[key])}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="detail-empty">
                      <Cloud size={28} />
                      <span>暂未读取到资源</span>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        , document.body)}
        </div>
        {section === "favorites" && (
          <section className="favorites-page">
            <header>
              <div>
                <span className="eyebrow">MY COLLECTIONS</span>
                <h1>我的收藏</h1>
                <p>收藏重要云资源，方便快速访问和管理。</p>
              </div>
            </header>
            <div className="local-asset-summary favorite-asset-summary">
              {assetTypes.filter(([value]) => favoriteAssets.some((item) => item.resource_type === value)).map(([value, label]) => <button type="button" className={`asset-summary-card ${favoriteTypeFilter === value ? "active" : ""}`} key={value} onClick={() => setFavoriteTypeFilter(favoriteTypeFilter === value ? null : value)}><span>{label}</span><strong>{favoriteAssets.filter((item) => item.resource_type === value).length}</strong><small>点击查看</small></button>)}
            </div>
            <section className="favorite-toolbar">
              <div className="favorite-type-tabs"><button type="button" className={!favoriteTypeFilter ? "active" : ""} onClick={() => setFavoriteTypeFilter(null)}>全部 ({favoriteAssets.length})</button>{assetTypes.map(([value, label]) => <button type="button" className={favoriteTypeFilter === value ? "active" : ""} key={value} onClick={() => setFavoriteTypeFilter(value)}>{label} ({favoriteAssets.filter((item) => item.resource_type === value).length})</button>)}</div>
              <label className="favorite-search"><Search size={16} /><input value={favoriteKeyword} onChange={(event) => setFavoriteKeyword(event.target.value)} placeholder="搜索资源名称 / ID / 账号" /></label>
              <select value={favoriteRegionFilter} onChange={(event) => setFavoriteRegionFilter(event.target.value)}><option value="">全部地域</option>{Array.from(new Set(favoriteAssets.map((asset) => asset.region_id || String(asset.payload?.RegionId || asset.payload?.Location || "")).filter(Boolean))).map((region) => <option key={region} value={region}>{region}</option>)}</select>
            </section>
            {visibleFavoriteAssets.length ? <div className="favorite-card-grid">
              {pagedFavoriteAssets.map((asset) => {
                const account = accounts.find((item) => item.id === asset.account_id);
                const payload = asset.payload || {};
                const title = displayValue(payload.InstanceName || payload.DBInstanceDescription || payload.SiteName || payload.DomainName || payload.Name || asset.asset_key);
                const region = displayValue(asset.region_id || payload.RegionId || payload.Location);
                const status = cloudStatusText(payload.Status || payload.InstanceStatus || payload.DBInstanceStatus || payload.DomainStatus);
                const expiry = payload.ExpiredTime || payload.ExpirationTime || payload.ExpirationDate || payload.ExpireTime || payload.ExpireDate || payload.EndTime;
                const assetKey = assetFavoriteKey(asset);
                const assetNote = assetNotes[assetKey] || "";
                const isServer = asset.resource_type === "ecs" || asset.resource_type === "swas";
                const detailRows = asset.resource_type === "domain"
                    ? [["注册商", displayValue(payload.RegistrantOrganization || payload.Registrant || payload.RegistrantName)], ["到期时间", formatAssetDate(expiry)], ["地域", region]]
                    : asset.resource_type === "oss"
                      ? [["地域", region], ["存储类型", displayValue(payload.StorageClass)], ["创建时间", formatAssetDate(payload.CreationDate || payload.CreationTime)]]
                      : [["地域", region], ["版本 / 引擎", displayValue(payload.EngineVersion || payload.Engine || payload.Version)], ["到期时间", formatAssetDate(expiry)]];
                return <article className={`favorite-resource-card${draggedFavoriteKey === assetKey ? " is-favorite-dragging" : ""}`} key={assetKey} data-favorite-asset-key={assetKey}>
                  <div className="favorite-card-account"><button type="button" className="favorite-card-drag-handle" aria-label={`拖动排序 ${title}`} title="拖动排序" onPointerDown={(event) => startFavoriteCardDrag(event, assetKey)}><GripVertical size={16} /></button><span className={`avatar cloud-avatar ${account?.cloud_type || "other"}`}>{cloudProvider(account?.cloud_type || "other").avatar}</span><span>{account?.account_name || `账号 ${asset.account_id}`}</span></div>
                  <div className="favorite-card-note"><span>备注</span>{editingAssetNote?.key === assetKey ? <input value={editingAssetNote.value} autoFocus onChange={(event) => setEditingAssetNote((current) => current?.key === assetKey ? { ...current, value: event.target.value } : current)} onBlur={() => saveAssetNote(assetKey)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditingAssetNote(null); }} aria-label="资产备注" placeholder="添加备注" /> : <button type="button" className={assetNote ? "has-note" : ""} onClick={() => setEditingAssetNote({ key: assetKey, value: assetNote, initial: assetNote })}>{assetNote || "添加备注"}</button>}</div>
                  <div className="favorite-card-head"><div><h2 title={title}>{title}</h2><small>{asset.asset_key}</small></div><button type="button" className="asset-favorite-button is-favorite" title="取消收藏" aria-label="取消收藏" onClick={() => toggleAssetFavorite(asset)}><BookmarkCheck size={18} /></button></div>
                  {isServer && account
                    ? <FavoriteServerDetails asset={asset} account={account} onCopyIp={(address) => void copyAssetIp(address)} />
                    : <div className="favorite-card-details">{detailRows.map(([label, value]) => <div key={label}><span>{label}：</span><div className="favorite-detail-value"><strong title={String(value)}>{value}</strong>{label === "IP 地址" && value !== "-" && <button type="button" className="favorite-ip-copy" title="复制 IP 地址" aria-label="复制 IP 地址" onClick={() => void copyAssetIp(String(value))}><Copy size={14} /></button>}</div></div>)}</div>}
                  <div className="favorite-card-meta"><span className={`favorite-resource-type ${asset.resource_type}`}>{assetTypes.find(([value]) => value === asset.resource_type)?.[1] || asset.resource_type}</span><span className="favorite-status">{status}</span>{isServer && account && <button type="button" className="favorite-status-refresh" title="刷新服务器状态" disabled={favoriteRefreshingKey !== null} onClick={() => void refreshFavoriteAsset(asset, account)}><RefreshCw size={13} className={favoriteRefreshingKey === assetKey ? "spin" : ""} />{favoriteRefreshingKey === assetKey ? "刷新中" : "刷新"}</button>}</div>
                  <div className="favorite-card-actions">{renderAssetActions(asset, account)}</div>
                </article>;
              })}
            </div> : <div className="favorite-empty"><Star size={42} /><h3>{favoriteAssets.length ? "没有符合条件的收藏" : "还没有收藏资源"}</h3><p>{favoriteAssets.length ? "调整筛选条件后再试。" : "前往资源管理，点击操作列的星标即可收藏资源。"}</p><button className="secondary" onClick={() => { setSection("resources"); void loadLocalAssets(); }}>前往资源管理</button></div>}
            {visibleFavoriteAssets.length > 0 && <div className="pagination favorite-pagination"><span>共 {visibleFavoriteAssets.length} 条收藏</span><button disabled={favoritePage <= 1} onClick={() => setFavoritePage((value) => Math.max(1, value - 1))}>‹</button><strong>{favoritePage}</strong><button disabled={favoritePage >= Math.max(1, Math.ceil(visibleFavoriteAssets.length / pageSize))} onClick={() => setFavoritePage((value) => value + 1)}>›</button></div>}
          </section>
        )}
        {section === "panels" && (
          <section className="panel-management-page">
            <header>
              <div><h1>面板管理</h1><p>统一绑定和管理多台宝塔或 aaPanel 面板；API 密钥仅加密保存在当前设备。</p></div>
            </header>
            <section className="managed-server-toolbar panel-management-toolbar">
              <div className="panel-toolbar-primary">
                <label className="managed-host-search" title="搜索面板"><Search size={16} /><input aria-label="搜索面板" value={panelKeyword} onChange={(event) => setPanelKeyword(event.target.value)} placeholder="搜索面板名称、IP 地址或备注" /></label>
                <select aria-label="面板分组" title="按分组筛选面板" value={panelGroup} disabled={panelSorting} onChange={(event) => setPanelGroup(event.target.value)}><option value="">全部分组</option>{panelGroups.map((group) => <option key={group} value={group}>{group}</option>)}</select>
                <button type="button" className="secondary" title="刷新所有面板状态" disabled={panelLoadingId !== null} onClick={() => void refreshAllPanelConnections()}><RefreshCw size={15} className={panelLoadingId !== null ? "spin" : ""} />{panelLoadingId !== null ? "刷新中" : "刷新"}</button>
                <button type="button" className="layui-btn panel-toolbar-add" title="添加新的面板连接" onClick={() => openPanelDialog()}><Plus size={15} />添加面板</button>
                <button type="button" className="secondary" title={selectedPanelIds.size ? `导出已选 ${selectedPanelIds.size} 个面板` : "导出全部面板"} disabled={!panelConnections.length} onClick={() => void exportPanels()}><Download size={15} />导出{selectedPanelIds.size ? ` (${selectedPanelIds.size})` : "全部"}</button>
                <label className="layui-btn panel-toolbar-import" title="导入面板 JSON"><Upload size={15} />{panelImporting ? "导入中" : "导入"}<input ref={panelImportInputRef} type="file" accept="application/json,.json" disabled={panelImporting} onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) void importPanels(file); }} /></label>
              </div>
              <div className="panel-toolbar-secondary">
                <label className="panel-toolbar-option" title="在地址和列表中隐藏 IP"><input type="checkbox" checked={hidePanelIps} onChange={(event) => setHidePanelIps(event.target.checked)} />隐藏 IP</label>
                <label className="panel-toolbar-option panel-refresh-mode"><span>监控刷新</span><select value={panelRefreshSeconds} onChange={(event) => setPanelRefreshSeconds(Number(event.target.value))} aria-label="监控资源刷新间隔" title="监控资源刷新间隔"><option value={0}>关闭</option><option value={5}>5 秒</option><option value={10}>10 秒</option><option value={30}>30 秒</option><option value={60}>60 秒</option></select></label>
                <label className="panel-toolbar-option panel-open-mode"><span>打开面板</span><select value={panelOpenMode} onChange={(event) => setPanelOpenMode(event.target.value as "browser" | "copy")} aria-label="打开面板方式" title="打开面板方式"><option value="browser">默认浏览器打开</option><option value="copy">复制临时 URL</option></select></label>
                <button type="button" className={`panel-sort-button${panelSorting ? " is-sorting" : ""}`} title={panelSorting ? "退出面板排序" : "调整面板顺序"} onClick={() => { setPanelSorting((value) => !value); setDraggedPanelId(null); }}><GripVertical size={15} />{panelSorting ? "退出排序" : "排序"}</button>
                <span className="panel-toolbar-count">共 {panelConnections.length} 台服务器</span>
              </div>
            </section>
            {visiblePanels.length ? <div className={`panel-monitor-scroll${panelSorting ? " is-sorting" : ""}`}><div className="panel-monitor-table"><div className="panel-monitor-table-head"><span>{panelSorting ? "排序" : <input type="checkbox" aria-label="选择全部当前面板" checked={visiblePanels.length > 0 && visiblePanels.every((panel) => selectedPanelIds.has(panel.id))} onChange={toggleAllVisiblePanels} />}</span><span>服务器信息</span><span>状态</span><span>资源监控</span><span>操作</span></div>{visiblePanels.map((panel) => {
              const summary = panel.summary || {};
              const value = (key: string) => { const entry = summary[key]; return entry == null || entry === "" ? "-" : typeof entry === "string" || typeof entry === "number" ? String(entry) : "-"; };
              const sourceAccount = panel.source_account_id ? accounts.find((account) => account.id === panel.source_account_id) : undefined;
              const sourceAsset = sourceAccount && panel.source_asset_key ? localAssets.find((asset) => asset.account_id === sourceAccount.id && asset.asset_key === panel.source_asset_key) : undefined;
              const canSsh = Boolean(sourceAccount && sourceAsset);
              const canReboot = Boolean(sourceAccount && sourceAsset && (sourceAsset.resource_type === "ecs" || sourceAsset.resource_type === "swas"));
              const cpu = panelCpuInfo(summary.cpu);
              const memory = panelMemoryInfo(summary.mem);
              const diskItems = panelDiskItems(summary.disk);
              const disk = panelDiskInfo(summary.disk);
              const panelDisksExpanded = expandedPanelDisks.has(panel.id);
              const network = panelNetworkInfo(summary.network);
              const metrics = [
                { label: "负载", detail: panelLoadText(summary.load), percent: null },
                { label: "网络", detail: <><span className="panel-network-rate up"><ArrowUp size={13} />{network.up}</span><span className="panel-network-rate down"><ArrowDown size={13} />{network.down}</span></>, percent: null },
                { label: "CPU", detail: cpu.detail, percent: cpu.percent },
                { label: "内存", detail: memory.detail, percent: memory.percent },
                { label: "磁盘", detail: disk.detail, percent: disk.percent },
              ];
              return <article className={`panel-monitor-row ${panel.status}${panelSorting ? " is-sorting" : ""}${draggedPanelId === panel.id ? " is-dragging" : ""}`} key={panel.id} data-panel-id={panel.id}>
                <div className="panel-row-order">{panelSorting ? <button type="button" className="panel-drag-handle" title="拖动排序" aria-label={`拖动排序 ${panel.name}`} onPointerDown={(event) => startPanelDrag(event, panel.id)}><GripVertical size={18} /></button> : <input aria-label={`选择面板 ${panel.name}`} type="checkbox" checked={selectedPanelIds.has(panel.id)} onChange={() => togglePanelSelection(panel.id)} />}</div>
                <div className="panel-row-server"><div className="panel-row-note"><span>备注</span>{editingPanelRemark?.id === panel.id ? <input value={editingPanelRemark.value} autoFocus onChange={(event) => setEditingPanelRemark((current) => current?.id === panel.id ? { ...current, value: event.target.value } : current)} onBlur={() => void savePanelRemark(panel)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditingPanelRemark(null); }} aria-label={`${panel.name} 的备注`} placeholder="添加备注" /> : <button type="button" aria-label={`编辑 ${panel.name} 的备注`} className={panel.remark ? "has-note" : ""} onClick={() => setEditingPanelRemark({ id: panel.id, value: panel.remark || "", initial: panel.remark || "" })}>{panel.remark || "添加备注"}</button>}</div><div className="panel-row-address"><i className={panel.status} /><strong title={hidePanelIps ? undefined : panel.panel_url}>{hidePanelIps ? hiddenPanelAddress(panel.panel_url) : panelAddress(panel.panel_url)}</strong><button type="button" title="复制面板地址" aria-label={`复制 ${panel.name} 的面板地址`} onClick={() => void copyPanelAddress(panel)}><Copy size={15} /></button><button type="button" title="编辑面板" aria-label={`编辑 ${panel.name}`} onClick={() => openPanelDialog(panel)}><Settings size={15} /></button></div><div className="panel-row-details"><span>名称：{panel.name}</span><span>来源：{panel.group_name || "-"}</span></div></div>
                <div className="panel-row-status"><span className={`managed-server-status ${panel.status}`}>{panel.status === "online" ? "在线" : panel.status === "offline" ? "离线" : "未检测"}</span><small>{value("version") === "-" ? "版本未获取" : value("version")}</small><small>{panel.last_checked_at ? `同步于 ${formatChineseDateTime(panel.last_checked_at)}` : "尚未同步"}</small>{panel.status === "offline" && panel.last_error && <em title={panel.last_error}>连接失败</em>}</div>
                <div className="panel-row-metrics">{metrics.map((metric) => <div className={`panel-resource-metric ${metric.label === "磁盘" ? "is-disk-metric" : ""}`} key={metric.label}>{metric.label === "磁盘" ? <div className="panel-disk-label"><span>磁盘</span>{diskItems.length > 1 && <button type="button" className="panel-disk-toggle" title={panelDisksExpanded ? "收起磁盘分区" : "展开全部磁盘分区"} aria-label={panelDisksExpanded ? "收起磁盘分区" : "展开全部磁盘分区"} aria-expanded={panelDisksExpanded} onClick={() => setExpandedPanelDisks((current) => { const next = new Set(current); if (next.has(panel.id)) next.delete(panel.id); else next.add(panel.id); return next; })}>{panelDisksExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>}</div> : <span>{metric.label}</span>}{metric.label === "磁盘" ? <strong title={`${disk.path} ${metric.detail}`}>{disk.path !== "-" ? `[${disk.path}] ` : ""}{metric.detail}</strong> : typeof metric.detail === "string" ? <strong title={metric.detail}>{metric.detail}</strong> : <strong className="panel-network-detail">{metric.detail}</strong>}{metric.percent !== null ? <i title={`${metric.label} ${Math.round(metric.percent)}%`}><b style={{ width: `${metric.percent}%` }} /></i> : <i className="panel-metric-idle" />}{metric.label === "磁盘" && panelDisksExpanded && diskItems.slice(1).length > 0 && <div className="panel-disk-volumes">{diskItems.slice(1).map((volume) => <div className="panel-disk-volume" key={`${panel.id}-${volume.path}`}><span>{volume.path}</span><strong title={volume.detail}>{volume.detail}</strong>{volume.percent !== null && <i title={`${volume.path} ${Math.round(volume.percent)}%`}><b style={{ width: `${volume.percent}%` }} /></i>}</div>)}</div>}</div>)}</div>
                <div className="panel-row-actions"><button type="button" className="panel-action-button panel-open-button" title="在浏览器中打开面板" aria-label={`打开 ${panel.name}`} disabled={panelOpeningId !== null} onClick={() => void openPanelTemporaryLogin(panel)}><Globe2 size={15} />{panelOpeningId === panel.id ? "打开中" : "面板"}</button><button type="button" className="panel-action-button" disabled={!canSsh} title={canSsh ? "通过关联云服务器 SSH 登录" : "关联云服务器后可使用 SSH"} aria-label={`通过 SSH 连接 ${panel.name}`} onClick={() => sourceAccount && sourceAsset && void openSshClient(sourceAsset, sourceAccount)}><Terminal size={15} />SSH</button><button type="button" className="panel-action-button panel-reboot-button" disabled={!canReboot} title={canReboot ? "重启关联云服务器" : "关联云服务器后可重启"} aria-label={`重启 ${panel.name} 关联服务器`} onClick={() => sourceAsset && void rebootLocalAsset(sourceAsset, false)}><RefreshCw size={15} />重启</button><button type="button" className="panel-action-button panel-delete-button" disabled={panelOpeningId !== null} title="移除面板" aria-label={`移除 ${panel.name}`} onClick={() => void deletePanelConnection(panel)}><Trash2 size={16} /></button></div>
              </article>;
            })}</div></div> : <div className="managed-server-empty"><Monitor size={42} /><h3>{panelConnections.length ? "没有符合条件的面板" : "还没有绑定面板"}</h3><p>{panelConnections.length ? "调整搜索或分组条件后再试。" : "添加面板 URL 与 API 密钥，验证成功后即可统一查看并快速进入面板。"}</p></div>}
          </section>
        )}
        {section === "servers" && (
          <section className="managed-servers-page">
            <div ref={terminalWorkbenchRef} className={`terminal-workbench${sshFilePaneCollapsed ? " is-file-pane-collapsed" : ""}`} style={{ gridTemplateColumns: `${terminalHostSidebarWidth}px minmax(0, 1fr)`, "--terminal-host-sidebar-width": `${terminalHostSidebarWidth}px` } as CSSProperties}>
              <aside className="terminal-host-sidebar" aria-label="服务器列表">
                <div className="terminal-host-header"><div className="terminal-host-heading"><Server size={16} /><strong>服务器</strong><span>{visibleManagedHosts.length}</span></div><div className="terminal-host-actions"><button type="button" className="terminal-toolbar-action" title="导出全部服务器（明文 JSON）" aria-label="导出服务器" disabled={!managedHosts.length} onClick={() => void exportManagedHosts()}><Download size={15} />导出</button><label className="terminal-toolbar-action terminal-import-button" title="导入服务器 JSON"><Upload size={15} />{managedHostImporting ? "导入中" : "导入"}<input ref={managedHostImportInputRef} type="file" accept="application/json,.json" disabled={managedHostImporting} onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) void importManagedHosts(file); }} /></label><button type="button" className="terminal-toolbar-action" title="刷新服务器状态" aria-label="刷新服务器" onClick={() => void loadManagedHosts()}><RefreshCw size={16} />刷新</button></div></div>
                <div className="terminal-group-title"><span><List size={15} />分组</span><div className="terminal-group-controls"><select aria-label="服务器分组" value={managedHostGroup} disabled={managedHostSorting} onChange={(event) => setManagedHostGroup(event.target.value)}><option value="">全部分组</option>{managedHostGroups.map((group) => <option key={group} value={group}>{group}</option>)}</select><button type="button" className={managedHostSorting ? "is-sorting" : ""} onClick={() => { setManagedHostSorting((value) => !value); setDraggedManagedHostId(null); setDraggedManagedHostGroup(null); setManagedHostMoreId(null); }}><GripVertical size={14} />{managedHostSorting ? "退出排序" : "排序"}</button></div></div>
                <div className="terminal-host-filter"><label className="terminal-host-search"><Search size={15} /><input value={managedHostKeyword} onChange={(event) => setManagedHostKeyword(event.target.value)} placeholder="搜索服务器 IP / 名称" /></label><button type="button" className="terminal-add-host" onClick={() => openManagedHostDialog()}><Plus size={16} />添加服务器</button></div>
                <div className="terminal-host-tree">
                  {managedHostGroups.map((group) => {
                    const hosts = visibleManagedHosts.filter((host) => (host.group_name || "未分组") === group);
                    if (!hosts.length) return null;
                    const collapsed = !managedHostSorting && collapsedManagedHostGroups.has(group);
                    const personalGroup = /个人|默认/.test(group);
                    return <section className={`terminal-host-group${draggedManagedHostGroup === group ? " is-dragging" : ""}${collapsed ? " is-collapsed" : ""}`} key={group} data-managed-host-group={group}><div className="terminal-host-group-head">{managedHostSorting ? <button type="button" className="terminal-group-drag-handle" title="拖动分组排序" aria-label={`拖动分组排序 ${group}`} onPointerDown={(event) => startManagedHostGroupDrag(event, group)}><GripVertical size={15} /></button> : personalGroup ? <UserRound size={18} /> : <Building2 size={18} />}<button type="button" className="terminal-host-group-toggle" disabled={managedHostSorting} onClick={() => setCollapsedManagedHostGroups((current) => { const next = new Set(current); if (next.has(group)) next.delete(group); else next.add(group); return next; })}><strong>{group}</strong><span>{hosts.length}</span>{collapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}</button></div>{!collapsed && hosts.map((host) => <article className={`terminal-host-card${terminalSelectedHostId === host.id ? " active" : ""}${managedHostSorting ? " is-sorting" : ""}${draggedManagedHostId === host.id ? " is-dragging" : ""}`} key={host.id} data-managed-host-id={host.id}>{managedHostSorting && <button type="button" className="terminal-host-drag-handle" title="拖动排序" aria-label={`拖动排序 ${host.name}`} onPointerDown={(event) => startManagedHostDrag(event, host.id)}><GripVertical size={16} /></button>}<button type="button" className="terminal-host-card-main" title={host.platform === "windows" ? "打开 Windows 远程桌面" : "打开 SSH 终端"} disabled={managedHostSorting} onClick={(event) => { if (event.detail > 1) return; setTerminalSelectedHostId(host.id); openManagedHostSsh(host); }}><span className="terminal-host-platform"><Monitor size={25} /><i className={host.status} /></span><span className="terminal-host-card-copy"><strong title={host.name}>{host.name}</strong><small className="terminal-host-card-meta"><span className="terminal-host-card-platform">{host.platform === "windows" ? "RDP" : "SSH"}</span><span className={`terminal-host-card-state ${host.status}`}>{host.status === "online" ? "在线" : host.status === "offline" ? "离线" : "未检测"}</span><span className="terminal-host-address">{host.host}</span></small></span></button>{!managedHostSorting && <div className="terminal-host-card-actions"><button type="button" title="更多操作" aria-label={`${host.name} 的更多操作`} aria-expanded={managedHostMoreId === host.id} onClick={(event) => { event.stopPropagation(); setManagedHostMoreId((current) => current === host.id ? null : host.id); }}><MoreVertical size={20} /></button>{managedHostMoreId === host.id && <div className="terminal-host-more-menu"><button type="button" onClick={() => { setManagedHostMoreId(null); openManagedHostDialog(host); }}><Settings size={14} />编辑</button>{host.platform !== "windows" && <button type="button" disabled={managedHostLoadingId !== null} onClick={() => { setManagedHostMoreId(null); void probeManagedHost(host.id); }}><RefreshCw size={14} />刷新</button>}<button type="button" className="danger" onClick={() => { setManagedHostMoreId(null); void deleteManagedHost(host); }}><Trash2 size={14} />移除</button></div>}</div>}</article>)}</section>;
                  })}
                   {!visibleManagedHosts.length && <div className="terminal-host-empty"><Server size={30} /><p>{managedHosts.length ? "没有匹配的服务器" : "添加服务器后即可开始连接"}</p><button type="button" className="terminal-host-empty-action" onClick={() => openManagedHostDialog()}><Plus size={14} />添加服务器</button></div>}
                </div>
              </aside>
              <div className="terminal-host-resizer" role="separator" aria-label="调整服务器列表宽度" aria-orientation="vertical" onPointerDown={startTerminalHostSidebarResize} />
              <section className="terminal-stage">
                <div className="terminal-tabs" role="tablist" aria-label="SSH 终端标签">
                  {terminalTabs.map((tab) => {
                    const label = tab.target.managedHostId ? managedHosts.find((host) => host.id === tab.target.managedHostId)?.name || "SSH 终端" : displayValue(tab.target.asset.payload.InstanceName || tab.target.asset.asset_key);
                    const activeTab = tab.id === activeTerminalTabId;
                    return <div className={`terminal-tab${activeTab ? " active" : ""}`} key={tab.id} role="presentation"><button type="button" className="terminal-tab-select" role="tab" aria-selected={activeTab} title={`${label} · ${tab.username}@${tab.host}`} onClick={() => activateTerminalTab(tab)}><Terminal size={15} /><span>{label}</span><i /></button><button type="button" className="terminal-tab-close" title={`关闭 ${label}`} aria-label={`关闭 ${label}`} onClick={() => void closeTerminalTab(tab.id)}><X size={14} /></button></div>;
                  })}
                  {sshSessionId && <button type="button" title={sshFilePaneCollapsed ? "展开文件管理" : "收起文件管理"} aria-label={sshFilePaneCollapsed ? "展开文件管理" : "收起文件管理"} onClick={() => setSshFilePaneCollapsed((value) => !value)}>{sshFilePaneCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}</button>}
                </div>
                {sshSessionId ? <div className="terminal-session-shell"><div className="ssh-terminal-meta"><span>{sshUsername}@{sshHost}:{sshPort}</span><span className="ssh-connected">已连接</span><button type="button" className="ssh-terminal-command" title="命令补全 (Tab)" aria-label="命令补全 (Tab)" onClick={completeSshCommand}><Keyboard size={16} /></button><span className="ssh-terminal-theme"><button type="button" className="ssh-terminal-command" title="终端配色" aria-label="终端配色" aria-expanded={terminalThemeMenuOpen} onClick={() => setTerminalThemeMenuOpen((value) => !value)}><Palette size={16} /></button>{terminalThemeMenuOpen && <span className="ssh-terminal-theme-menu">{(Object.entries(terminalThemes) as [TerminalThemeName, typeof terminalThemes[TerminalThemeName]][]).map(([name, theme]) => <button type="button" className={terminalThemeName === name ? "active" : ""} key={name} onClick={() => { setTerminalThemeName(name); setTerminalThemeMenuOpen(false); }}>{theme.label}</button>)}</span>}</span><button className="ssh-clear-button" onClick={() => sshTerminalRef.current?.clear()}>清屏</button><button className="ssh-disconnect-button" onClick={() => void closeSshClient()}>断开</button></div><div ref={sshWorkspaceRef} className="ssh-terminal-workspace" style={{ gridTemplateColumns: `minmax(360px, 1fr) 8px minmax(330px, ${sshFilePaneWidth}px)` }}><div className="ssh-terminal-viewport" ref={sshTerminalHostRef} aria-label="SSH 终端" /><div className="ssh-file-resizer" role="separator" aria-label="调整文件管理面板宽度" aria-orientation="vertical" onPointerDown={startSshFileResize} /> <aside className={`ssh-file-manager${sshFileDragActive ? " is-dragging" : ""}`} aria-label="远程文件管理" onDragEnter={(event) => { event.preventDefault(); setSshFileDragActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setSshFileDragActive(false); }} onDrop={(event) => { event.preventDefault(); setSshFileDragActive(false); void uploadSshFiles(event.dataTransfer.files); }}><div className="ssh-file-toolbar"><button type="button" title="返回上级目录" disabled={sshFilesLoading || sshFilePath === "/"} onClick={() => void loadSshFiles(parentSshPath(sshFilePath))}><ChevronLeft size={16} /></button><input className="ssh-file-path" value={sshFilePath} onChange={(event) => setSshFilePath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void loadSshFiles(event.currentTarget.value); }} aria-label="远程目录路径" /><button type="button" title="刷新目录" disabled={sshFilesLoading} onClick={() => void loadSshFiles()}><RefreshCw size={15} className={sshFilesLoading ? "spin" : ""} /></button></div><div className="ssh-file-actions"><button type="button" title="上传文件" disabled={sshFilesLoading} onClick={() => sshUploadInputRef.current?.click()}><Upload size={15} />上传</button><button type="button" title="新建文件夹" disabled={sshFilesLoading} onClick={() => void makeSshDirectory()}><FolderPlus size={15} />新建</button><input ref={sshUploadInputRef} className="ssh-file-upload-input" type="file" multiple onChange={(event) => { const files = event.currentTarget.files; event.currentTarget.value = ""; if (files?.length) void uploadSshFiles(files); }} /></div>{sshFileEditor ? <div className="ssh-file-editor"><div className="ssh-file-editor-head"><span title={sshFileEditor.path}>{sshFileEditor.path}</span><button type="button" title="关闭编辑器" onClick={() => setSshFileEditor(null)}><X size={15} /></button></div><textarea value={sshFileEditor.content} spellCheck={false} onChange={(event) => setSshFileEditor((current) => current ? { ...current, content: event.target.value } : current)} /><div className="ssh-file-editor-actions"><button type="button" onClick={() => setSshFileEditor(null)}>关闭</button><button type="button" className="primary" disabled={sshFileSaving} onClick={() => void saveSshFile()}><Save size={15} />{sshFileSaving ? "保存中" : "保存"}</button></div></div> : <div className="ssh-file-list"><div className="ssh-file-list-head"><span>名称</span><span>大小</span><span>权限 / 所有者</span></div>{sshFiles.map((entry) => <div className="ssh-file-row" key={entry.path} onDoubleClick={() => void openSshFile(entry)}><button type="button" className="ssh-file-name" title={`${entry.isDir ? "进入目录" : "打开文本文件"}：${entry.name}`} onClick={() => void openSshFile(entry)}>{entry.isDir ? <FolderOpen size={16} /> : <FileCode2 size={16} />}<span>{entry.name}</span></button><span>{entry.isDir ? "文件夹" : sshFileSize(entry.size)}</span><span>{entry.mode}/{entry.owner}</span><div className="ssh-file-row-actions">{entry.isFile && <button type="button" className="ssh-file-download" title="下载到本机并定位文件" onClick={() => void downloadSshFile(entry)}><Download size={14} /><span>下载</span></button>}<button type="button" title="删除" className="danger" onClick={() => void deleteSshEntry(entry)}><Trash2 size={14} /></button></div></div>)}{!sshFilesLoading && sshFiles.length === 0 && <div className="ssh-file-empty">此目录为空</div>}{sshFilesLoading && <div className="ssh-file-empty">正在读取目录…</div>}</div>}{sshFileError && <div className="ssh-file-error">{sshFileError}</div>}</aside></div>{sshError && <div className="error-list ssh-error">{sshError}</div>}</div> : <div className="terminal-stage-empty"><Terminal size={54} /><h1>选择一台服务器开始连接</h1><p>从左侧服务器列表打开 SSH 终端，连接后可在右侧直接浏览和管理远程文件。</p><button className="layui-btn layui-btn-normal" onClick={() => openManagedHostDialog()}><Plus size={16} />添加服务器</button></div>}
              </section>
            </div>
          </section>
        )}
        {section === "servers" && sshTarget && !sshSessionId && (
          <div className="terminal-connect-backdrop">
            <form className="terminal-connect-card" onSubmit={(event) => { event.preventDefault(); void connectSshClient(); }}>
              <div className="terminal-connect-card-head"><div><span className="eyebrow">{sshPlatform === "windows" ? "REMOTE DESKTOP" : "SSH CONNECTION"}</span><h2><Terminal size={18} />连接 {displayValue(sshTarget.asset.payload.InstanceName || sshTarget.asset.asset_key)}</h2></div><button type="button" className="close" title="关闭连接" onClick={() => void closeSshClient()}><X size={19} /></button></div>
              <div className="terminal-connect-fields"><div className="ssh-choice-row ssh-platform-row"><span>操作系统</span><div className="ssh-segmented"><button type="button" className={sshPlatform === "linux" ? "active" : ""} onClick={() => void setRemotePlatform("linux")}>Linux</button><button type="button" className={sshPlatform === "windows" ? "active" : ""} onClick={() => void setRemotePlatform("windows")}>Windows</button></div></div><label>主机<input value={sshHost} onChange={(event) => setSshHost(event.target.value)} placeholder="公网 IP 或域名" autoFocus /></label><label>{sshPlatform === "windows" ? "RDP 端口" : "SSH 端口"}<input type="number" min={1} max={65535} value={sshPort} onChange={(event) => setSshPort(Number(event.target.value) || (sshPlatform === "windows" ? 3389 : 22))} /></label><label className="terminal-connect-user">{sshPlatform === "windows" ? "RDP 用户名" : "SSH 用户名"}<input value={sshUsername} onChange={(event) => setSshUsername(event.target.value)} placeholder={sshPlatform === "windows" ? "administrator" : "root"} /></label><label className="terminal-connect-password">{sshPlatform === "windows" ? "密码（可选）" : "密码"}<span className="ssh-password-wrap"><input type={showSshPassword ? "text" : "password"} value={sshPassword} onChange={(event) => setSshPassword(event.target.value)} placeholder={sshPlatform === "windows" ? (sshPasswordSaved ? "已保存本地记录" : "由 Windows 远程桌面验证") : (sshPasswordSaved ? "已保存密码，可直接连接" : "请输入 SSH 密码")} autoComplete="current-password" /><button type="button" className="ssh-password-toggle" disabled={sshPasswordRevealing} title={sshPasswordRevealing ? "正在读取密码" : showSshPassword ? "隐藏密码" : sshPasswordSaved ? "读取当前保存密码" : "显示密码"} aria-label={sshPasswordRevealing ? "正在读取密码" : showSshPassword ? "隐藏密码" : sshPasswordSaved ? "读取当前保存密码" : "显示密码"} onClick={() => void toggleSshPasswordVisibility()}>{sshPasswordRevealing ? <RefreshCw size={16} className="spin" /> : showSshPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label></div>
              {sshError && <div className="error-list ssh-error">{sshError}</div>}
              <div className="terminal-connect-actions">{sshPlatform === "linux" ? <button type="button" className="secondary" disabled={sshTesting || sshConnecting} onClick={() => void testSshConnection()}>{sshTesting ? "测试中…" : "测试连接"}</button> : <span />}<button type="button" className="secondary" onClick={() => void closeSshClient()}>取消</button><button type="submit" className="layui-btn layui-btn-normal" disabled={sshTesting || sshConnecting}>{sshConnecting ? (sshPlatform === "windows" ? "启动中…" : "连接中…") : sshPlatform === "windows" ? "打开远程桌面" : "连接"}</button></div>
            </form>
          </div>
        )}
        {section === "resources" && (
          <section className="local-resource-page">
            <header>
              <div>
                <span className="eyebrow">LOCAL ASSETS</span>
                <h1>资源管理</h1>
                <p>所有资产来自本地 SQLite，不会在此页面实时请求云端。</p>
              </div>
            </header>
            <div className="resource-account-switcher"><span>当前账号</span><select aria-label="当前资源账号" title="切换资源账号" value={resourceAccountId ?? "all"} onChange={(event) => { const value = event.target.value; setResourceAccountId(value === "all" ? null : Number(value)); setResourceTypeFilter(null); }}><option value="all">全部账号（汇总）</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.account_name} · {account.access_key_id}</option>)}</select>{selectedResourceAccount && <strong>{selectedResourceAccount.account_name}</strong>}</div>
            <div className="local-asset-summary">
              {assetTypes.map(([value, label]) => <button type="button" className={`asset-summary-card asset-summary-tile ${resourceTypeFilter === value ? "active" : ""}`} key={value} title={`筛选${label}资产`} aria-pressed={resourceTypeFilter === value} onClick={() => setResourceTypeFilter(resourceTypeFilter === value ? null : value)}><span>{label}</span><strong>{localAssets.filter((item) => (resourceAccountId === null || item.account_id === resourceAccountId) && item.resource_type === value).length}</strong><small>点击查看</small></button>)}
            </div>
            <section className="panel local-assets-panel">
              <div className="asset-list-toolbar"><input className="asset-list-search" aria-label="搜索资产" value={assetKeyword} onChange={(event) => setAssetKeyword(event.target.value)} placeholder="请输入资产名称 / ID / 账号" /><select className="asset-type-filter" aria-label="按资产类型筛选" value={resourceTypeFilter || ""} onChange={(event) => setResourceTypeFilter(event.target.value || null)}><option value="">全部类型</option>{assetTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select className="asset-region-filter" aria-label="按地域筛选" value={assetRegionFilter} onChange={(event) => setAssetRegionFilter(event.target.value)}><option value="">全部地域</option>{Array.from(new Set(localAssets.map((asset) => asset.region_id || String(asset.payload?.RegionId || asset.payload?.Location || "")).filter(Boolean))).map((region) => <option key={region} value={region}>{region}</option>)}</select><select className="asset-status-filter" aria-label="按状态筛选" value={assetStatusFilter} onChange={(event) => setAssetStatusFilter(event.target.value)}><option value="">全部状态</option>{Array.from(new Set(localAssets.map((asset) => String(asset.payload?.Status || asset.payload?.InstanceStatus || asset.payload?.DBInstanceStatus || asset.payload?.DomainStatus || "")).filter(Boolean))).map((status) => <option key={status} value={status}>{cloudStatusText(status)}</option>)}</select></div>
              {visibleLocalAssets.length ? <div className="table-wrap"><table><thead><tr><th className="asset-order-column"><span className="sr-only">排序</span></th><th>资源类型</th><th>资产名称 / ID</th><th>到期时间</th><th>账号信息</th><th>地域</th><th>状态</th><th className="asset-actions-column">操作</th></tr></thead><tbody>
                {pagedLocalAssets.map((asset, index) => {
                  const account = accounts.find((item) => item.id === asset.account_id);
                  const payload = asset.payload || {};
                  const assetRowKey = `${asset.account_id}:${asset.resource_type}:${asset.asset_key}`;
                  const serverName = displayValue(payload.InstanceName || asset.asset_key);
                  const canEditServerName = asset.resource_type === "ecs" && Boolean(account && (account.cloud_type === "aliyun" || account.cloud_type === "tencent"));
                  const accessKey = account?.access_key_id || "";
                  const maskedKey = accessKey.length > 8 ? `${accessKey.slice(0, 4)}****${accessKey.slice(-4)}` : accessKey || "-";
                  const expiry = payload.ExpiredTime || payload.ExpirationTime || payload.ExpirationDate || payload.ExpirationTime || payload.ExpireTime || payload.ExpireDate || payload.EndTime;
                  const domainActions = asset.resource_type === "domain" && account && !["oracle", "huawei", "baidu", "ucloud", "aws", "azure", "gcp", "jdcloud", "qingcloud", "ksyun"].includes(account.cloud_type) ? (
                    <div className="asset-action-buttons domain-asset-actions">
                      <button type="button" className="asset-domain-dns-button" title="打开域名解析管理" onClick={() => openLocalDomainTool(asset, account, "dns")}>解析管理</button>
                      <button type="button" className="asset-domain-log-button" title="查看域名操作日志" onClick={() => openLocalDomainTool(asset, account, "logs")}>操作日志</button>
                      <button type="button" className="asset-domain-whois-button" title="查看 WHOIS 信息" onClick={() => openLocalDomainTool(asset, account, "whois")}>WHOIS</button>
                    </div>
                  ) : null;
                  const ossActions = asset.resource_type === "oss" && account && !["volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud", "qiniu", "aws", "azure", "gcp", "jdcloud", "qingcloud", "ksyun"].includes(account.cloud_type) ? (
                    <div className="asset-action-buttons oss-asset-actions">
                      <button type="button" className="asset-oss-files-button" title="查看对象文件列表" onClick={() => void openOssQuickTool(account, asset, "files")}>文件列表</button>
                      <button type="button" className="asset-oss-stat-button" title="查看对象存储容量统计" onClick={() => void openOssQuickTool(account, asset, "stat")}>容量统计</button>
                    </div>
                  ) : null;
                  const serverActions = (asset.resource_type === "ecs" || asset.resource_type === "swas") ? renderAssetActions(asset, account) : null;
                  const assetNote = assetNotes[assetRowKey] || "";
                  return <tr key={`${asset.account_id}-${asset.resource_type}-${asset.asset_key}-${index}`} className={draggedAssetKey === assetRowKey ? "is-asset-dragging" : ""} data-asset-row-key={assetRowKey}>
                    <td className="asset-order-cell"><button type="button" className="asset-drag-handle" aria-label={`拖动排序 ${serverName}`} title="拖动排序" onPointerDown={(event) => startAssetDrag(event, assetRowKey)}><GripVertical size={17} /></button></td>
                    <td>{assetTypes.find(([value]) => value === asset.resource_type)?.[1] || asset.resource_type}</td>
                    <td><div className="asset-name-cell"><div className="asset-note-line">{editingAssetNote?.key === assetRowKey ? <input className="asset-note-editor" value={editingAssetNote.value} autoFocus onChange={(event) => setEditingAssetNote((current) => current?.key === assetRowKey ? { ...current, value: event.target.value } : current)} onBlur={() => saveAssetNote(assetRowKey)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditingAssetNote(null); }} aria-label="资产备注" placeholder="添加备注" /> : <button type="button" className={`asset-note-button${assetNote ? " has-note" : ""}`} onClick={() => setEditingAssetNote({ key: assetRowKey, value: assetNote, initial: assetNote })}>{assetNote || "添加备注"}</button>}</div><div className="asset-name-primary">{canEditServerName && account ? (
                      editingAssetName?.key === assetRowKey ? <input className="asset-name-editor" value={editingAssetName.value} autoFocus disabled={savingAssetName === assetRowKey} onChange={(event) => setEditingAssetName((current) => current?.key === assetRowKey ? { ...current, value: event.target.value } : current)} onBlur={() => void saveServerName(asset, account, assetRowKey)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditingAssetName(null); }} aria-label="服务器名称" /> : <button type="button" className="asset-name-edit-button" title="点击修改服务器名称" onClick={() => setEditingAssetName({ key: assetRowKey, value: serverName === "-" ? "" : serverName, initial: serverName === "-" ? "" : serverName })}><strong>{serverName}</strong></button>
                    ) : <strong>{displayValue(payload.InstanceName || payload.DBInstanceDescription || payload.SiteName || payload.DomainName || payload.Name || asset.asset_key)}</strong>}<button type="button" className={`asset-favorite-button asset-name-favorite ${favoriteAssetKeys.includes(assetFavoriteKey(asset)) ? "is-favorite" : ""}`} title={favoriteAssetKeys.includes(assetFavoriteKey(asset)) ? "取消收藏" : "收藏资源"} aria-label={favoriteAssetKeys.includes(assetFavoriteKey(asset)) ? "取消收藏" : "收藏资源"} onClick={() => toggleAssetFavorite(asset)}>{favoriteAssetKeys.includes(assetFavoriteKey(asset)) ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}</button></div><small className="asset-subline">{asset.asset_key}</small></div></td>
                    <td>{formatAssetDate(expiry)}</td>
                    <td><div className="asset-account-name"><span className={`avatar cloud-avatar ${account?.cloud_type || "other"}`}>{cloudProvider(account?.cloud_type || "other").avatar}</span><strong>{account?.account_name || `账号 ${asset.account_id}`}</strong></div><small className="asset-subline">{cloudProvider(account?.cloud_type || "other").label} · {maskedKey}</small><small className="asset-subline">{account?.group_name || "未分组"}</small></td>
                    <td>{displayValue(asset.region_id || payload.RegionId || payload.Location)}</td>
                    <td>{cloudStatusText(payload.Status || payload.InstanceStatus || payload.DBInstanceStatus || payload.DomainStatus)}</td>
                    <td className="asset-actions-cell">{domainActions || ossActions || serverActions || <span className="asset-action-muted">—</span>}</td>
                  </tr>;
                })}
              </tbody></table></div> : <div className="empty"><Server size={40} /><h3>暂无本地资产</h3><p>请到账号管理，勾选资产类型并点击“获取资产”。</p></div>}
              {visibleLocalAssets.length > 0 && <div className="pagination"><span>共 {visibleLocalAssets.length} 条记录</span><button disabled={assetPage <= 1} onClick={() => setAssetPage((value) => Math.max(1, value - 1))}>‹</button><strong>{assetPage}</strong><button disabled={assetPage >= Math.max(1, Math.ceil(visibleLocalAssets.length / pageSize))} onClick={() => setAssetPage((value) => value + 1)}>›</button></div>}
            </section>
          </section>
        )}
        {sshTarget && section !== "servers" && !sshTarget.managedHostId && (
          <div className="resource-modal-backdrop ssh-modal-backdrop">
            <section className={`detail-panel resource-modal ssh-modal${sshModalMaximized ? " is-maximized" : ""}${!sshSessionId ? " is-connect" : ""}`} onClick={(event) => event.stopPropagation()}>
              <div className="detail-toolbar">
                <div><span className="eyebrow">{sshTarget.direct ? "QUICK CONNECT" : sshTarget.asset.resource_type === "swas" ? "LIGHTHOUSE" : "SERVER"}</span><h2><Terminal size={18} /> {sshTarget.direct ? "快速连接" : `${sshPlatform === "windows" ? "RDP 登录" : "SSH 登录"} · ${displayValue(sshTarget.asset.payload.InstanceName || sshTarget.asset.asset_key)}`}</h2></div>
                <div className="detail-toolbar-actions">{sshSessionId && <button className="close-detail" type="button" title={sshModalMaximized ? "退出全屏" : "全屏"} aria-label={sshModalMaximized ? "退出全屏" : "全屏"} onClick={() => setSshModalMaximized((value) => !value)}>{sshModalMaximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>}<button className="close-detail" type="button" title="关闭 SSH" onClick={() => void closeSshClient()}><X size={20} /></button></div>
              </div>
              {!sshSessionId ? (
                <form className="ssh-connect-form" onSubmit={(event) => { event.preventDefault(); void connectSshClient(); }}>
                  <div className="ssh-form-grid">
                    <div className="ssh-choice-row ssh-platform-row"><span>操作系统</span><div className="ssh-segmented"><button type="button" className={sshPlatform === "linux" ? "active" : ""} onClick={() => void setRemotePlatform("linux")}>Linux</button><button type="button" className={sshPlatform === "windows" ? "active" : ""} onClick={() => void setRemotePlatform("windows")}>Windows</button></div></div>
                    <label className="ssh-form-host">主机<input value={sshHost} onChange={(event) => setSshHost(event.target.value)} placeholder="公网 IP 或域名" autoFocus /></label>
                    <label>端口<input type="number" min={1} max={65535} value={sshPort} onChange={(event) => setSshPort(Number(event.target.value) || (sshPlatform === "windows" ? 3389 : 22))} /></label>
                    <label>用户名<input value={sshUsername} onChange={(event) => setSshUsername(event.target.value)} placeholder={sshPlatform === "windows" ? "administrator" : "root"} /></label>
                    {sshPlatform === "linux" && <div className="ssh-choice-row ssh-auth-row"><span>验证方式</span><div className="ssh-segmented"><button type="button" className={sshAuthMethod === "password" ? "active" : ""} onClick={() => setSshAuthMethod("password")}>密码验证</button><button type="button" className={sshAuthMethod === "private_key" ? "active" : ""} onClick={() => { setSshAuthMethod("private_key"); setShowSshPassword(false); }}>私钥验证</button></div></div>}
                    {sshPlatform === "windows" || sshAuthMethod === "password" ? <label className="ssh-form-password">{sshPlatform === "windows" ? "密码（可选）" : "密码"}<span className="ssh-password-wrap"><input type={showSshPassword ? "text" : "password"} value={sshPassword} onChange={(event) => setSshPassword(event.target.value)} placeholder={sshPlatform === "windows" ? (sshPasswordSaved ? "已保存本地记录" : "由 Windows 远程桌面验证") : (sshPasswordSaved ? "已保存密码，可直接连接" : "请输入 SSH 密码")} autoComplete="current-password" /><button type="button" className="ssh-password-toggle" disabled={sshPasswordRevealing} title={sshPasswordRevealing ? "正在读取密码" : showSshPassword ? "隐藏密码" : sshPasswordSaved ? "读取当前保存密码" : "显示密码"} aria-label={sshPasswordRevealing ? "正在读取密码" : showSshPassword ? "隐藏密码" : sshPasswordSaved ? "读取当前保存密码" : "显示密码"} onClick={() => void toggleSshPasswordVisibility()}>{sshPasswordRevealing ? <RefreshCw size={16} className="spin" /> : showSshPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label> : <><label className="ssh-form-password">私钥<textarea value={sshPrivateKey} onChange={(event) => setSshPrivateKey(event.target.value)} placeholder={sshPasswordSaved ? "已保存私钥，可直接连接或粘贴替换" : "粘贴 OpenSSH、PKCS#8 或 PEM 格式私钥"} spellCheck={false} /></label><label className="ssh-form-passphrase">私钥口令<input type="password" value={sshKeyPassphrase} onChange={(event) => setSshKeyPassphrase(event.target.value)} placeholder="未加密私钥可留空" autoComplete="off" /></label></>}
                    {sshPlatform === "linux" && <label className="ssh-proxy-field">代理<select value=""><option value="">不使用代理</option></select></label>}
                  </div>
                  {(sshPlatform === "windows" || sshAuthMethod === "password") && !sshTarget.direct && <div className="ssh-save-row"><label className="toggle"><input type="checkbox" checked={sshSavePassword} onChange={(event) => setSshSavePassword(event.target.checked)} /><span>{sshPlatform === "windows" ? "保存连接资料到本机" : "保存密码到本机"}</span></label>{sshPasswordSaved && <button type="button" className="ssh-clear-button" onClick={() => void clearSavedSshConnection()}>清除已保存配置</button>}</div>}
                  {sshError && <div className="error-list ssh-error">{sshError}</div>}
                  <div className="modal-actions ssh-connect-actions">{sshPlatform === "linux" ? <button type="button" className="secondary" disabled={sshTesting || sshConnecting} onClick={() => void testSshConnection()}>{sshTesting ? "测试中…" : "测试连接"}</button> : <span />}<span /><button type="button" className="secondary" onClick={() => void closeSshClient()}>取消</button><button type="submit" className="layui-btn layui-btn-normal" disabled={sshTesting || sshConnecting}>{sshConnecting ? "启动中…" : sshPlatform === "windows" ? "打开远程桌面" : "连接"}</button></div>
                </form>
              ) : (
                <div className="ssh-terminal-shell">
                  <div className="ssh-terminal-meta"><span>{sshUsername}@{sshHost}:{sshPort}</span><span className="ssh-connected">已连接</span><button type="button" className="ssh-terminal-command" title="命令补全 (Tab)" aria-label="命令补全 (Tab)" onClick={completeSshCommand}><Keyboard size={16} /></button><button className="ssh-clear-button" onClick={() => sshTerminalRef.current?.clear()}>清屏</button><button className="ssh-disconnect-button" onClick={() => void closeSshClient()}>断开</button></div>
                  <div ref={sshWorkspaceRef} className={`ssh-terminal-workspace${sshFilePaneCollapsed ? " is-file-pane-collapsed" : ""}`} style={{ gridTemplateColumns: sshFilePaneCollapsed ? "minmax(0, 1fr) 0 0" : `minmax(360px, 1fr) 8px minmax(360px, ${sshFilePaneWidth}px)` }}>
                    <div className="ssh-terminal-viewport" ref={sshTerminalHostRef} aria-label="SSH 终端" />
                    {!sshFilePaneCollapsed && <div className="ssh-file-resizer" role="separator" aria-label="调整文件管理面板宽度" aria-orientation="vertical" onPointerDown={startSshFileResize} />}
                    {!sshFilePaneCollapsed && <aside className={`ssh-file-manager${sshFileDragActive ? " is-dragging" : ""}`} aria-label="远程文件管理" onDragEnter={(event) => { event.preventDefault(); setSshFileDragActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setSshFileDragActive(false); }} onDrop={(event) => { event.preventDefault(); setSshFileDragActive(false); void uploadSshFiles(event.dataTransfer.files); }}>
                      <div className="ssh-file-toolbar">
                        <button type="button" title="返回上级目录" disabled={sshFilesLoading || sshFilePath === "/"} onClick={() => void loadSshFiles(parentSshPath(sshFilePath))}><ChevronLeft size={16} /></button>
                        <input className="ssh-file-path" value={sshFilePath} onChange={(event) => setSshFilePath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void loadSshFiles(event.currentTarget.value); }} aria-label="远程目录路径" />
                        <button type="button" title="刷新目录" disabled={sshFilesLoading} onClick={() => void loadSshFiles()}><RefreshCw size={15} className={sshFilesLoading ? "spin" : ""} /></button>
                        <button type="button" title="收起文件管理" aria-label="收起文件管理" onClick={() => setSshFilePaneCollapsed(true)}><PanelRightClose size={16} /></button>
                      </div>
                      <div className="ssh-file-actions">
                        <button type="button" title="上传文件" disabled={sshFilesLoading} onClick={() => sshUploadInputRef.current?.click()}><Upload size={15} />上传</button>
                        <button type="button" title="新建文件夹" disabled={sshFilesLoading} onClick={() => void makeSshDirectory()}><FolderPlus size={15} />新建</button>
                        <input ref={sshUploadInputRef} className="ssh-file-upload-input" type="file" multiple onChange={(event) => { const files = event.currentTarget.files; event.currentTarget.value = ""; if (files?.length) void uploadSshFiles(files); }} />
                      </div>
                      {sshFileEditor ? (
                        <div className="ssh-file-editor">
                          <div className="ssh-file-editor-head"><span title={sshFileEditor.path}>{sshFileEditor.path}</span><button type="button" title="关闭编辑器" onClick={() => setSshFileEditor(null)}><X size={15} /></button></div>
                          <textarea value={sshFileEditor.content} spellCheck={false} onChange={(event) => setSshFileEditor((current) => current ? { ...current, content: event.target.value } : current)} />
                          <div className="ssh-file-editor-actions"><button type="button" onClick={() => setSshFileEditor(null)}>关闭</button><button type="button" className="primary" disabled={sshFileSaving} onClick={() => void saveSshFile()}><Save size={15} />{sshFileSaving ? "保存中" : "保存"}</button></div>
                        </div>
                      ) : (
                        <div className="ssh-file-list">
                          <div className="ssh-file-list-head"><span>名称</span><span>大小</span><span>权限 / 所有者</span></div>
                          {sshFiles.map((entry) => <div className="ssh-file-row" key={entry.path} onDoubleClick={() => void openSshFile(entry)}>
                            <button type="button" className="ssh-file-name" title={`${entry.isDir ? "进入目录" : "打开文本文件"}：${entry.name}`} onClick={() => void openSshFile(entry)}>{entry.isDir ? <FolderOpen size={16} /> : <FileCode2 size={16} />}<span>{entry.name}</span></button>
                            <span>{entry.isDir ? "文件夹" : sshFileSize(entry.size)}</span><span>{entry.mode}/{entry.owner}</span>
                            <div className="ssh-file-row-actions">{entry.isFile && <button type="button" className="ssh-file-download" title="下载到本机并定位文件" onClick={() => void downloadSshFile(entry)}><Download size={14} /><span>下载</span></button>}<button type="button" title="删除" className="danger" onClick={() => void deleteSshEntry(entry)}><Trash2 size={14} /></button></div>
                          </div>)}
                          {!sshFilesLoading && sshFiles.length === 0 && <div className="ssh-file-empty">此目录为空</div>}
                          {sshFilesLoading && <div className="ssh-file-empty">正在读取目录…</div>}
                        </div>
                      )}
                      {sshFileError && <div className="ssh-file-error">{sshFileError}</div>}
                    </aside>}
                    {sshFilePaneCollapsed && <button type="button" className="ssh-file-reveal-tab" title="展开文件管理" aria-label="展开文件管理" onClick={() => setSshFilePaneCollapsed(false)}><PanelRightOpen size={18} /></button>}
                  </div>
                  {sshError && <div className="error-list ssh-error">{sshError}</div>}
                </div>
              )}
            </section>
          </div>
        )}
        {section === "logs" && (
          <section className="utility-page">
            <header><div><span className="eyebrow">AUDIT TRAIL</span><h1>操作日志</h1><p>记录本机账号和资产管理操作，日志只保存在当前设备。</p></div></header>
            <section className="panel utility-panel"><div className="utility-toolbar log-toolbar"><input value={logFilter} onChange={(event) => setLogFilter(event.target.value)} placeholder="搜索账号、资源类型或操作" /><select value={logTypeFilter} onChange={(event) => setLogTypeFilter(event.target.value)}><option value="">全部资源类型</option>{assetTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select><option>全部操作状态</option><option>已完成</option></select><button className="secondary" onClick={() => { setLogFilter(""); setLogTypeFilter(""); }}>重置</button><button className="clear-log-button" onClick={() => void clearLogs("operation")}>清空日志</button></div><div className="log-list"><div className="log-head"><span>操作内容</span><span>资源类型</span><span>操作时间</span><span>状态</span></div>
              {pagedLogRows.map((row, index) => <div className="log-row" key={`${row.asset.account_id}-${row.asset.resource_type}-${row.asset.asset_key}-${index}`}><span className="log-dot" /><div><strong>{row.action}</strong><small>{row.account.account_name} · {assetTypes.find(([value]) => value === row.asset.resource_type)?.[1] || row.asset.resource_type} · {row.asset.asset_key}</small></div><span className={`log-type ${row.asset.resource_type}`}>{assetTypes.find(([value]) => value === row.asset.resource_type)?.[1] || row.asset.resource_type}</span><time>{new Date(row.asset.fetched_at).toLocaleString()}</time><span className="log-success" title="操作完成">完成</span></div>)}
              {!logRows.length && <div className="empty"><FileText size={38} /><h3>暂无操作日志</h3><p>获取资产后会在这里显示记录。</p></div>}
              {logRows.length > 0 && <div className="pagination"><span>共 {logRows.length} 条记录</span><button disabled={logPage <= 1} onClick={() => setLogPage((value) => Math.max(1, value - 1))}>‹</button><strong>{logPage}</strong><button disabled={logPage >= Math.max(1, Math.ceil(logRows.length / pageSize))} onClick={() => setLogPage((value) => value + 1)}>›</button></div>}
            </div></section>
          </section>
        )}
        {section === "api_logs" && (
          <section className="utility-page">
            <header><div><span className="eyebrow">API ACTIVITY</span><h1>API日志</h1><p>记录本机客户端发起的云 API 请求与结果。</p></div></header>
            <section className="panel utility-panel"><div className="utility-toolbar log-toolbar"><input value={logFilter} onChange={(event) => setLogFilter(event.target.value)} placeholder="搜索账号、接口或操作" /><button className="secondary" onClick={() => { setLogFilter(""); setApiLogPage(1); }}>重置</button><button className="clear-log-button" onClick={() => void clearLogs("api")}>清空日志</button></div><div className="log-list"><div className="log-head api-log-head"><span aria-hidden="true" /><span>API操作</span><span>接口</span><span>操作时间</span><span>状态</span><span>详情</span></div>
              {pagedApiLogs.map((log) => <div className="log-row api-log-row" key={log.id}><span className={`log-dot ${log.status === "成功" ? "" : "error"}`} /><div><strong>{log.action}</strong><small>{log.account_name || "未知账号"} · {log.endpoint}</small></div><span className="log-type api">{log.endpoint}</span><time>{new Date(log.created_at).toLocaleString()}</time><span className={log.status === "成功" ? "log-success" : "log-failure"}>{log.status}</span><button className="log-detail-button" onClick={() => setApiLogDetail(log)}>查看详情</button></div>)}
              {!filteredApiLogs.length && <div className="empty"><Terminal size={38} /><h3>暂无 API 日志</h3><p>调用云厂商接口后会在这里显示记录。</p></div>}
              {filteredApiLogs.length > 0 && <div className="pagination"><span>共 {filteredApiLogs.length} 条记录</span><button disabled={apiLogPage <= 1} onClick={() => setApiLogPage((value) => Math.max(1, value - 1))}>‹</button><strong>{apiLogPage}</strong><button disabled={apiLogPage >= Math.max(1, Math.ceil(filteredApiLogs.length / pageSize))} onClick={() => setApiLogPage((value) => value + 1)}>›</button></div>}
            </div></section>
          </section>
        )}
        {section === "settings" && (
          <section className="utility-page">
            <header><div><span className="eyebrow">LOCAL PREFERENCES</span><h1>系统设置</h1><p>管理本地客户端的显示和数据行为。</p></div></header>
            <section className="settings-grid">
              <div className="settings-card"><div className="settings-icon blue"><Database size={22} /></div><div className="settings-copy"><strong>本地模式</strong><small>所有账号密钥和资产保存在本机 SQLite</small></div><span className="setting-state on">✓ 已启用</span></div>
              <div className="settings-card"><div className="settings-icon cyan"><Cloud size={22} /></div><div className="settings-copy"><strong>自动刷新资产</strong><small>进入资源管理时读取本地缓存，不主动上传数据</small></div><label className="setting-switch"><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /><span /></label></div>
              <div className="settings-card"><div className="settings-icon purple"><Monitor size={22} /></div><div className="settings-copy"><strong>紧凑显示</strong><small>减少表格行高，适合小窗口查看</small></div><label className="setting-switch"><input type="checkbox" checked={compactMode} onChange={(event) => setCompactMode(event.target.checked)} /><span /></label></div>
              <div className="settings-card"><div className="settings-icon blue"><List size={22} /></div><div className="settings-copy"><strong>每页显示条数</strong><small>账号、资源和操作日志列表统一使用此分页大小</small></div><select className="settings-select" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}><option value={10}>10 条</option><option value={20}>20 条</option><option value={50}>50 条</option><option value={100}>100 条</option></select></div>
              <div className="settings-card"><div className="settings-icon purple"><Database size={22} /></div><div className="settings-copy"><strong>数据库位置</strong><small>系统应用数据目录 / CloudHubTools / cloudhub_tools.sqlite3</small></div><button className="secondary settings-link" onClick={() => void openDataDirectory()}><FolderOpen size={16} />打开目录</button></div>
              <div className="settings-card"><div className="settings-icon amber"><Terminal size={22} /></div><div className="settings-copy"><strong>GitHub 开源仓库</strong><small>https://github.com/wlphp/cloudhub-tools</small></div><a className="secondary settings-link" href="https://github.com/wlphp/cloudhub-tools" target="_blank" rel="noreferrer">访问仓库 ↗</a></div>
              <div className="settings-card"><div className="settings-icon blue"><Download size={22} /></div><div className="settings-copy"><strong>客户端更新</strong><small>{!runningInTauri ? `当前版本 v${appVersion}；自动更新仅在桌面客户端可用` : updateState.phase === "available" ? `当前 v${appVersion}，最新 v${updateState.version}${updateState.notes ? "，可下载并安装" : ""}` : updateState.phase === "downloading" ? `当前 v${appVersion}，正在下载 v${updateState.version}` : updateState.phase === "ready" ? `v${updateState.version} 已安装，正在重新启动` : updateState.phase === "current" ? `当前 v${appVersion} 已是最新版本` : updateState.phase === "error" ? `当前 v${appVersion}；${updateState.message}` : `当前版本 v${appVersion}，启动时会自动检查新版本`}</small></div><div className="settings-update-actions">{runningInTauri && updateState.phase === "downloading" ? <span className="setting-state on">{updateState.total ? `${Math.min(100, Math.round((updateState.downloaded / updateState.total) * 100))}%` : "下载中"}</span> : runningInTauri && updateState.phase === "checking" ? <span className="setting-state on">检查中</span> : runningInTauri && updateState.phase === "available" ? <button className="secondary settings-link" onClick={() => void installUpdate()}><Download size={16} />下载并安装</button> : runningInTauri ? <button className="secondary settings-link" onClick={() => void checkForUpdates()}><RefreshCw size={16} />检查更新</button> : <span className="setting-state">桌面端</span>}</div></div>
            </section>
          </section>
        )}
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
        {managedHostDialog && (
          <div className="modal-backdrop">
            <form className="modal managed-host-modal" onSubmit={saveManagedHost} onClick={(event) => event.stopPropagation()}>
              <div className="modal-head"><div><span className="eyebrow">MANAGED SERVER</span><h2>{managedHostDraft.id ? "编辑服务器" : "添加服务器"}</h2></div><button type="button" className="close" disabled={managedHostSaving} onClick={() => setManagedHostDialog(false)}><X size={20} /></button></div>
              <p className="security-tip">{managedHostDraft.platform === "windows" ? "RDP 连接资料会使用本机密钥加密保存，打开连接时将调用 Windows 远程桌面。" : managedHostDraft.auth_method === "private_key" ? "SSH 私钥与可选口令会使用本机密钥加密保存。首次成功连接时会记录服务器主机指纹。" : "SSH 密码会使用本机密钥加密保存。首次成功连接时会记录服务器主机指纹，后续变化将被拒绝。"}</p>
              <label>服务器名称<input required value={managedHostDraft.name} onChange={(event) => setManagedHostDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如：生产 Web 01" autoFocus /></label>
              <div className="managed-host-choice"><span>操作系统</span><div className="ssh-segmented"><button type="button" className={managedHostDraft.platform === "linux" ? "active" : ""} onClick={() => setManagedHostDraft((current) => ({ ...current, platform: "linux", auth_method: "password", port: current.port === 3389 ? 22 : current.port, username: current.username === "administrator" ? "root" : current.username }))}>Linux</button><button type="button" className={managedHostDraft.platform === "windows" ? "active" : ""} onClick={() => setManagedHostDraft((current) => ({ ...current, platform: "windows", auth_method: "password", port: current.port === 22 ? 3389 : current.port, username: current.username === "root" ? "administrator" : current.username }))}>Windows</button></div></div>
              <div className="form-grid"><label>主机 / IP<input required value={managedHostDraft.host} onChange={(event) => setManagedHostDraft((current) => ({ ...current, host: event.target.value }))} placeholder="203.0.113.10 或 server.example.com" /></label><label>{managedHostDraft.platform === "windows" ? "RDP 端口" : "SSH 端口"}<input required type="number" min={1} max={65535} value={managedHostDraft.port} onChange={(event) => setManagedHostDraft((current) => ({ ...current, port: Number(event.target.value) || (current.platform === "windows" ? 3389 : 22) }))} /></label><label>{managedHostDraft.platform === "windows" ? "RDP 用户名" : "SSH 用户名"}<input required value={managedHostDraft.username} onChange={(event) => setManagedHostDraft((current) => ({ ...current, username: event.target.value }))} placeholder={managedHostDraft.platform === "windows" ? "administrator" : "root"} /></label></div>
              {managedHostDraft.platform === "linux" && <div className="managed-host-choice"><span>验证方式</span><div className="ssh-segmented"><button type="button" className={managedHostDraft.auth_method === "password" ? "active" : ""} onClick={() => setManagedHostDraft((current) => ({ ...current, auth_method: "password" }))}>密码验证</button><button type="button" className={managedHostDraft.auth_method === "private_key" ? "active" : ""} onClick={() => setManagedHostDraft((current) => ({ ...current, auth_method: "private_key", password: "" }))}>私钥验证</button></div></div>}
              {managedHostDraft.platform === "windows" || managedHostDraft.auth_method === "password" ? <label>{managedHostDraft.platform === "windows" ? "RDP 密码（可选）" : "SSH 密码"}<input required={managedHostDraft.platform === "linux" && !managedHostDraft.id} type="password" value={managedHostDraft.password} onChange={(event) => setManagedHostDraft((current) => ({ ...current, password: event.target.value }))} placeholder={managedHostDraft.platform === "windows" ? "留空时由 Windows 远程桌面验证" : managedHostDraft.id ? "留空则保留已保存密码" : "首次添加必填"} autoComplete="new-password" /></label> : <><label>SSH 私钥<textarea required={!managedHostDraft.id} rows={5} value={managedHostDraft.private_key} onChange={(event) => setManagedHostDraft((current) => ({ ...current, private_key: event.target.value }))} placeholder={managedHostDraft.id ? "留空则保留已保存私钥" : "粘贴 OpenSSH、PKCS#8 或 PEM 格式私钥"} spellCheck={false} /></label><label>私钥口令（可选）<input type="password" value={managedHostDraft.key_passphrase} onChange={(event) => setManagedHostDraft((current) => ({ ...current, key_passphrase: event.target.value }))} placeholder="未加密私钥可留空" autoComplete="off" /></label></>}
              <div className="form-grid"><label>分组<input value={managedHostDraft.group_name} onChange={(event) => setManagedHostDraft((current) => ({ ...current, group_name: event.target.value }))} placeholder="生产 / 测试 / 个人" /></label><label>标签<input value={managedHostDraft.tags} onChange={(event) => setManagedHostDraft((current) => ({ ...current, tags: event.target.value }))} placeholder="web, nginx, cn" /></label></div>
              <label>备注<textarea rows={2} value={managedHostDraft.remark} onChange={(event) => setManagedHostDraft((current) => ({ ...current, remark: event.target.value }))} placeholder="可选" /></label>
              <div className="modal-actions"><button type="button" className="secondary" disabled={managedHostSaving} onClick={() => setManagedHostDialog(false)}>取消</button><button type="submit" className="layui-btn layui-btn-normal" disabled={managedHostSaving}>{managedHostSaving ? "保存中…" : managedHostDraft.id ? "保存修改" : "加入服务器管理"}</button></div>
            </form>
          </div>
        )}
        {apiLogDetail && (
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
        {assetDetail && (
          <div className="modal-backdrop" onClick={() => setAssetDetail(null)}>
            <section className="modal asset-detail-modal" onClick={(event) => event.stopPropagation()}>
              <div className="modal-head"><div><span className="eyebrow">SERVER DETAIL</span><h2>{displayValue(assetDetail.asset.payload.InstanceName || assetDetail.asset.asset_key)}</h2></div><button className="close" title="关闭详情" onClick={() => setAssetDetail(null)}><X size={20} /></button></div>
              <div className="asset-detail-meta"><span className={`avatar cloud-avatar ${assetDetail.account.cloud_type}`}>{cloudProvider(assetDetail.account.cloud_type).avatar}</span><span>{assetDetail.account.account_name}</span><span>{assetTypes.find(([value]) => value === assetDetail.asset.resource_type)?.[1] || assetDetail.asset.resource_type}</span><span>{assetDetail.asset.region_id || String(assetDetail.asset.payload.RegionId || assetDetail.asset.payload.Location || "未标注地域")}</span></div>
              <div className="asset-detail-list">{Object.entries(assetDetail.asset.payload).filter(([key]) => !key.startsWith("_")).map(([key, value]) => <div key={key}><span>{columnLabel(key)}</span><strong title={displayValue(value)}>{displayValue(value)}</strong></div>)}</div>
              <div className="modal-actions"><button className="secondary" onClick={() => setAssetDetail(null)}>关闭</button></div>
            </section>
          </div>
        )}
        {syncAccount && (
          <div className="modal-backdrop">
            <section className="modal asset-sync-modal">
              <div className="modal-head"><div><span className="eyebrow">LOCAL SYNC</span><h2>获取账号资产</h2></div><button className="close" onClick={() => setSyncAccount(null)}><X size={20} /></button></div>
              <p className="security-tip">选择要从{cloudProvider(syncAccount.cloud_type).label}获取并保存到本地 SQLite 的资产类型。当前支持{providerSyncDescription(syncAccount.cloud_type)}。</p>
              <div className="asset-check-grid">{syncAssetTypes(syncAccount).map(([value, label]) => <label key={value} className="asset-check"><input type="checkbox" checked={syncTypes.includes(value)} onChange={(event) => setSyncTypes((current) => event.target.checked ? [...new Set([...current, value])] : current.filter((item) => item !== value))} /><span>{syncAccount.cloud_type === "tencent" && value === "ecs" ? "CVM服务器" : label}</span></label>)}</div>
              <div className="asset-sync-account">账号：{syncAccount.account_name}</div>
              {syncResult && <div className={`asset-sync-result ${syncResultLevel}`} role="status" aria-atomic="true"><strong>{syncResultLevel === "has-errors" ? "获取失败" : syncResultLevel === "warning" ? "获取完成（含提示）" : "获取成功并已保存到本地"}</strong><span>共保存 {syncResult.fetched} 项资产</span><div className="asset-result-counts">{syncTypes.map((type) => <span key={type}>{assetTypes.find(([value]) => value === type)?.[1] || type}：{syncResult.counts[type] ?? 0} 个</span>)}</div>{showOracleDatabasePermissionHint && <div className="asset-sync-guidance"><AlertTriangle size={16} /><div><strong>云数据库未获取</strong><span>当前 OCI 密钥缺少数据库读取权限。请在 OCI IAM 为用户或所属组授予目标资源组的 <code>read database-family</code>，或配置更精细的 DB System 只读策略后重新获取。</span></div></div>}{syncResult.errors.length > 0 && <div className="asset-sync-errors">{syncResult.errors.map((error, index) => <div key={`${error}-${index}`}>{error}</div>)}</div>}</div>}
              <div className="modal-actions"><button className="secondary" onClick={() => { setSyncAccount(null); setSyncResult(null); }}>{syncResult ? "关闭" : "取消"}</button><button className="primary" disabled={syncing || syncTypes.length === 0} onClick={() => void syncAssets(syncAccount)}>{syncing ? "获取中…" : supportsResourceSync(syncAccount) ? (syncResult ? "重新获取" : "开始获取并保存") : "查看接入状态"}</button></div>
            </section>
          </div>
        )}
        <footer>
          <span />
        </footer>
      </main>
      {dialog && (
        <div className="modal-backdrop">
          <form className="modal" onSubmit={save}>
            <div className="modal-head">
              <div>
                <span className="eyebrow">ACCOUNT</span>
                <h2>{draft.id ? "编辑云账号" : "添加云账号"}</h2>
              </div>
              <button
                type="button"
                className="close"
                onClick={() => setDialog(false)}
              >
                <X size={20} />
              </button>
            </div>
            <p className="security-tip account-key-tip">
              <span>{cloudProvider(draft.cloud_type).secretLabel} 会加密保存在本机。当前支持{providerSyncDescription(draft.cloud_type)}。</span>
              {draft.cloud_type === "aliyun" && <a href="https://ram.console.aliyun.com/profile/access-keys?userCode=jdeqlgm5" target="_blank" rel="noreferrer">获取阿里云 AccessKey ↗</a>}
              {draft.cloud_type === "vultr" && <a href="https://my.vultr.com/settings/#settingsapi" target="_blank" rel="noreferrer">获取 Vultr API Key ↗</a>}
              {draft.cloud_type === "tencent" && <a href="https://console.cloud.tencent.com/cam/capi" target="_blank" rel="noreferrer">获取腾讯云密钥 ↗</a>}
              {draft.cloud_type === "volcengine" && <a href="https://console.volcengine.com/iam/keymanage/" target="_blank" rel="noreferrer">获取火山引擎密钥 ↗</a>}
              {draft.cloud_type === "oracle" && <a href="https://docs.oracle.com/iaas/Content/API/Concepts/apisigningkey.htm" target="_blank" rel="noreferrer">配置 OCI API Key ↗</a>}
            </p>
            <label>
              账号名称
              <input
                required
                value={draft.account_name}
                onChange={(e) =>
                  setDraft({ ...draft, account_name: e.target.value })
                }
                placeholder="例如：公司主账号"
              />
            </label>
            <div className="form-grid">
              <label>
                云类型
                <select value={draft.cloud_type} onChange={(e) => setDraft({ ...draft, cloud_type: e.target.value, region_id: draft.region_id || cloudProvider(e.target.value).regionPlaceholder })}>
                  {draft.cloud_type === "other" && <option value="other" disabled>未接入云（历史账号）</option>}
                  {cloudProviders.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}
                </select>
              </label>
              <label>
                分组
                <input
                  value={draft.group_name}
                  onChange={(e) =>
                    setDraft({ ...draft, group_name: e.target.value })
                  }
                  placeholder="公司 / 个人 / 测试"
                />
              </label>
              <label>
                {draft.cloud_type === "baidu" ? "偏好地域（自动扫描全部 BCC 地域）" : "默认地域"}
                <input
                  value={draft.region_id}
                  onChange={(e) =>
                    setDraft({ ...draft, region_id: e.target.value })
                  }
                  placeholder={cloudProvider(draft.cloud_type).regionPlaceholder}
                />
              </label>
              <label>
                排序号
                <input
                  type="number"
                  min="0"
                  value={draft.sort_order}
                  onChange={(e) => setDraft({ ...draft, sort_order: Math.max(0, Number(e.target.value) || 0) })}
                  placeholder="数字越小越靠前"
                />
              </label>
            </div>
            <label>
              {cloudProvider(draft.cloud_type).idLabel}
              <input
                required={draft.cloud_type !== "vultr"}
                value={draft.access_key_id}
                onChange={(e) =>
                  setDraft({ ...draft, access_key_id: e.target.value })
                }
                placeholder={draft.cloud_type === "vultr" ? "留空将使用账号名称，仅用于本地识别" : undefined}
              />
            </label>
            {draft.cloud_type === "oracle" && <div className="form-grid">
              <label>Tenancy OCID<input required value={draft.tenancy_ocid} onChange={(e) => setDraft({ ...draft, tenancy_ocid: e.target.value })} placeholder="ocid1.tenancy..." /></label>
              <label>Key Fingerprint<input required value={draft.key_fingerprint} onChange={(e) => setDraft({ ...draft, key_fingerprint: e.target.value })} placeholder="aa:bb:cc:..." /></label>
            </div>}
            {draft.cloud_type === "azure" && <div className="form-grid">
              <label>Tenant ID<input required value={draft.tenant_id} onChange={(e) => setDraft({ ...draft, tenant_id: e.target.value })} placeholder="Microsoft Entra tenant GUID" /></label>
              <label>Subscription ID<input required value={draft.subscription_id} onChange={(e) => setDraft({ ...draft, subscription_id: e.target.value })} placeholder="Azure subscription GUID" /></label>
            </div>}
            {draft.cloud_type === "gcp" && <label>Project ID<input required value={draft.project_id} onChange={(e) => setDraft({ ...draft, project_id: e.target.value })} placeholder="Google Cloud project ID" /></label>}
            <label>
              {cloudProvider(draft.cloud_type).secretLabel}
                <span className="secret-input-wrap"><input
                  required={!draft.id}
                  type={showSecret ? "text" : "password"}
                  value={draft.access_key_secret}
                  onChange={(e) =>
                    setDraft({ ...draft, access_key_secret: e.target.value })
                  }
                  placeholder={draft.id ? "留空表示不修改" : `请输入 ${cloudProvider(draft.cloud_type).secretLabel}`}
                />{draft.cloud_type !== "oracle" && <button type="button" className="secret-eye" aria-label={showSecret ? `隐藏 ${cloudProvider(draft.cloud_type).secretLabel}` : `显示 ${cloudProvider(draft.cloud_type).secretLabel}`} onClick={async () => { if (!showSecret && draft.id && !draft.access_key_secret) { try { const secret = runningInTauri ? await invoke<string>("reveal_account_secret", { id: draft.id }) : await webApi<string>(`/api/account-secret?id=${draft.id}`); setDraft((current) => ({ ...current, access_key_secret: secret })); } catch (error) { setStatus(`读取 Secret 失败：${String(error)}`); return; } } setShowSecret((value) => !value); }}>{showSecret ? <EyeOff size={17} /> : <Eye size={17} />}</button>}</span>
            </label>
            <label>
              备注
              <textarea
                value={draft.remark}
                onChange={(e) => setDraft({ ...draft, remark: e.target.value })}
                rows={3}
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
              />
              <span>启用此账号</span>
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setDialog(false)}
              >
                取消
              </button>
              <button className="primary" type="submit">
                保存账号
              </button>
              {draft.id && ["vultr", "ctyun", "huawei", "baidu", "jdcloud", "ucloud", "qingcloud", "ksyun", "qiniu", "aws", "azure", "gcp"].includes(draft.cloud_type) && <button className="secondary" type="button" disabled={verifyingAccount} onClick={() => void verifyCloudAccount()}>
                {verifyingAccount ? "验证中…" : "验证账号"}
              </button>}
            </div>
          </form>
        </div>
      )}
      {confirmRequest && createPortal(
        <div className="app-confirm-backdrop" onClick={() => resolveConfirm(false)}>
          <section className="app-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message" onClick={(event) => event.stopPropagation()}>
            <div className="app-confirm-icon"><AlertTriangle size={20} /></div>
            <div className="app-confirm-copy"><span className="eyebrow">PLEASE CONFIRM</span><h2 id="confirm-title">确认操作</h2><p id="confirm-message">{confirmRequest.message}</p></div>
            <div className="app-confirm-actions"><button type="button" className="secondary" autoFocus onClick={() => resolveConfirm(false)}>取消</button><button type="button" className="primary app-confirm-primary" onClick={() => resolveConfirm(true)}>确认</button></div>
          </section>
        </div>,
        document.body,
      )}
      {promptRequest && createPortal(
        <div className="app-confirm-backdrop" onClick={() => resolvePrompt(null)}>
          <form className="app-confirm-dialog app-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-title" aria-describedby="prompt-message" onSubmit={(event) => { event.preventDefault(); resolvePrompt(promptValue); }} onClick={(event) => event.stopPropagation()}>
            <div className="app-confirm-icon"><AlertTriangle size={20} /></div>
            <div className="app-confirm-copy"><span className="eyebrow">INPUT REQUIRED</span><h2 id="prompt-title">请输入内容</h2><p id="prompt-message">{promptRequest.message}</p><input aria-label="需要输入的内容" value={promptValue} autoFocus onChange={(event) => setPromptValue(event.target.value)} /></div>
            <div className="app-confirm-actions"><button type="button" className="secondary" onClick={() => resolvePrompt(null)}>取消</button><button type="submit" className="primary app-confirm-primary">确定</button></div>
          </form>
        </div>,
        document.body,
      )}
    </div>
  );
}

export default App;
