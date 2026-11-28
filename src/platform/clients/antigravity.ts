import { invoke, normalizePlatformError, runningInTauri } from "../api";

export interface AntigravityModelQuota {
  name: string;
  percentage: number;
  resetTime: string;
  displayName?: string | null;
}

export interface AntigravityQuotaBucket {
  bucketId: string;
  window: string;
  remainingFraction: number;
  resetTime: string;
  displayName?: string | null;
}

export interface AntigravityQuotaGroup {
  displayName: string;
  models?: string[];
  buckets: AntigravityQuotaBucket[];
}

export interface AntigravityQuotaData {
  models: AntigravityModelQuota[];
  quotaGroups: AntigravityQuotaGroup[];
  lastUpdated: number;
  isForbidden: boolean;
  forbiddenReason?: string | null;
  subscriptionTier?: string | null;
}

export type AntigravityTier = "FREE" | "PRO" | "ULTRA" | "ENTERPRISE";
export type AntigravityAccountType = "personal" | "gcp";
export type AntigravitySwitchTarget = "antigravity" | "ide" | "jeb" | "cli";

export interface AntigravityDeviceProfile {
  machineId: string;
  macMachineId: string;
  devDeviceId: string;
  sqmId: string;
}

export interface AntigravityDeviceHistory {
  fingerprintId: string;
  createdAt: number;
  profile: AntigravityDeviceProfile;
}

export function sameAntigravityDeviceProfile(a?: AntigravityDeviceProfile | null, b?: AntigravityDeviceProfile | null) {
  return !!a && !!b && a.machineId === b.machineId && a.macMachineId === b.macMachineId
    && a.devDeviceId === b.devDeviceId && a.sqmId === b.sqmId;
}

export interface AntigravityWarmupResult {
  ok: boolean;
  latencyMs: number;
  modelUsed?: string | null;
  detail: string;
  state: AntigravityState;
}

export interface AntigravityAccount {
  id: number;
  email: string;
  name?: string | null;
  projectId?: string | null;
  oauthClientKey?: string | null;
  subscriptionTier: string;
  priority: number;
  geminiPriority?: number | null;
  claudePriority?: number | null;
  proxyDisabled: boolean;
  proxyUrl?: string | null;
  disabled: boolean;
  disabledReason?: string | null;
  customLabel: string;
  note: string;
  tags: string[];
  quota: AntigravityQuotaData;
  deviceProfile?: AntigravityDeviceProfile | null;
  deviceHistory?: AntigravityDeviceHistory[];
  hasRefreshToken: boolean;
  lastError?: string | null;
  sortOrder?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AntigravityState {
  accounts: AntigravityAccount[];
  currentAccountId: number | null;
  targetCurrentIds?: Partial<Record<AntigravitySwitchTarget, number>>;
}

export interface AntigravitySwitchResult {
  target: AntigravitySwitchTarget;
  appliedToClient: boolean;
  detail: string;
  state: AntigravityState;
}

export interface AntigravityImportResult {
  total: number;
  success: number;
  failed: number;
  errors: string[];
  state: AntigravityState;
}

export interface AntigravityRefreshAllResult {
  total: number;
  success: number;
  failed: number;
  state: AntigravityState;
}

const PREVIEW_STORAGE_KEY = "cloudhub.antigravity.preview-state.v1";

interface PreviewRecord {
  account: AntigravityAccount;
  refreshToken: string;
}

interface PreviewStore {
  nextId: number;
  currentAccountId: number | null;
  targetCurrentIds?: Partial<Record<AntigravitySwitchTarget, number>>;
  records: PreviewRecord[];
}

function readPreviewStore(): PreviewStore {
  try {
    const raw = localStorage.getItem(PREVIEW_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PreviewStore;
      if (parsed && Array.isArray(parsed.records)) return parsed;
    }
  } catch { /* ignore */ }
  return { nextId: 1, currentAccountId: null, targetCurrentIds: {}, records: [] };
}

function writePreviewStore(store: PreviewStore): AntigravityState {
  const targetCurrentIds: Partial<Record<AntigravitySwitchTarget, number>> = { ...(store.targetCurrentIds ?? {}) };
  if (store.currentAccountId != null && Object.keys(targetCurrentIds).length === 0) {
    targetCurrentIds.antigravity = store.currentAccountId;
  }
  store.targetCurrentIds = targetCurrentIds;
  try {
    localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(store));
  } catch { /* ignore */ }
  return {
    accounts: [...store.records]
      .map(item => item.account)
      .sort((a, b) => {
        const sa = a.sortOrder && a.sortOrder > 0 ? a.sortOrder : Number.MAX_SAFE_INTEGER;
        const sb = b.sortOrder && b.sortOrder > 0 ? b.sortOrder : Number.MAX_SAFE_INTEGER;
        return sa - sb || a.priority - b.priority || a.createdAt - b.createdAt || a.id - b.id;
      }),
    currentAccountId: store.currentAccountId,
    targetCurrentIds,
  };
}

function extractRawTokens(text: string): string[] {
  const matches = text.match(/1\/\/[A-Za-z0-9\-_./~+]{15,}/g) ?? [];
  return [...new Set(matches)];
}

export function parseAntigravityImportEntries(content: string): { email: string; refresh_token: string }[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  try {
    const raw = JSON.parse(trimmed) as unknown;
    const list: unknown[] = [];
    if (Array.isArray(raw)) {
      list.push(...raw);
    } else if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj.accounts)) list.push(...obj.accounts);
      else if (obj.accounts && typeof obj.accounts === "object") list.push(...Object.values(obj.accounts));
      else if ("refresh_token" in obj || "refreshToken" in obj || "token" in obj) list.push(obj);
      else list.push(...Object.values(obj));
    }
    const out: { email: string; refresh_token: string }[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const email = String(obj.email ?? obj.name ?? "").trim();
      const tokenObj = obj.token && typeof obj.token === "object" ? (obj.token as Record<string, unknown>) : null;
      const refreshToken = String(obj.refresh_token ?? obj.refreshToken ?? tokenObj?.refresh_token ?? tokenObj?.refreshToken ?? "").trim();
      if (refreshToken && !seen.has(refreshToken)) {
        seen.add(refreshToken);
        out.push({ email, refresh_token: refreshToken });
      }
    }
    if (out.length > 0) return out;
  } catch { /* fallback to regex extraction */ }

  return extractRawTokens(trimmed).map(refresh_token => ({ email: "", refresh_token }));
}

export type AntigravityQuotaRefreshLog = {
  id: number;
  createdAt: number;
  durationMs: number;
  source: "single" | "selected" | "all";
  success: boolean;
  requests: { url: string; parameters: Record<string, unknown>; status: number | null; response?: unknown }[];
};

async function runNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (reason) {
    throw normalizePlatformError(reason);
  }
}

export const antigravityClient = {
  async list(): Promise<AntigravityState> {
    if (runningInTauri) return runNative("antigravity_list_accounts");
    return writePreviewStore(readPreviewStore());
  },

  async addAccount(input: { email?: string; refreshToken: string; note?: string; customLabel?: string; priority?: number }): Promise<AntigravityState> {
    if (runningInTauri) return runNative("antigravity_add_account", input);
    const token = input.refreshToken.trim();
    if (!token) throw new Error("Refresh Token 不能为空");
    const store = readPreviewStore();
    const now = Date.now();
    const email = (input.email ?? "").trim() || `preview-${store.nextId}@gmail.com`;
    const existing = store.records.find(item => item.account.email === email);
    if (existing) {
      existing.refreshToken = token;
      existing.account.updatedAt = now;
      if (input.note !== undefined) existing.account.note = input.note.trim();
      if (input.customLabel !== undefined) existing.account.customLabel = input.customLabel.trim();
      if (input.priority !== undefined) existing.account.priority = Math.max(1, Math.min(100, input.priority));
    } else {
      const id = store.nextId++;
      store.records.push({
        refreshToken: token,
        account: {
          id,
          email,
          name: null,
          projectId: null,
          oauthClientKey: "antigravity_enterprise",
          subscriptionTier: "FREE",
          priority: Math.max(1, Math.min(100, input.priority ?? 50)),
          proxyDisabled: false,
          disabled: false,
          disabledReason: null,
          customLabel: (input.customLabel ?? "").trim(),
          note: (input.note ?? "").trim(),
          tags: [],
          quota: { models: [], quotaGroups: [], lastUpdated: 0, isForbidden: false },
          hasRefreshToken: true,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    return writePreviewStore(store);
  },

  async importAccounts(content: string, force = false, accountType: AntigravityAccountType = "personal"): Promise<AntigravityImportResult> {
    if (runningInTauri) return runNative("antigravity_import_accounts", { content, force, accountType });
    const entries = parseAntigravityImportEntries(content);
    if (!entries.length) throw new Error("未识别到有效的 Antigravity 账号数据（需包含 refresh_token 或 1//... Token）");
    const store = readPreviewStore();
    const now = Date.now();
    let success = 0;
    const oauthClientKey = accountType === "gcp" ? "antigravity_gcp" : "antigravity_enterprise";
    const defaultTier = accountType === "gcp" ? "ENTERPRISE" : "FREE";
    for (const entry of entries) {
      const email = entry.email || `preview-${store.nextId}@gmail.com`;
      const existing = store.records.find(item => item.account.email === email);
      if (existing) {
        existing.refreshToken = entry.refresh_token;
        existing.account.oauthClientKey = oauthClientKey;
        existing.account.updatedAt = now;
      } else {
        const id = store.nextId++;
        store.records.push({
          refreshToken: entry.refresh_token,
          account: {
            id,
            email,
            name: null,
            projectId: null,
            oauthClientKey,
            subscriptionTier: defaultTier,
            priority: 50,
            proxyDisabled: false,
            disabled: false,
            disabledReason: null,
            customLabel: accountType === "gcp" ? "GCP" : "",
            note: "",
            tags: [],
            quota: { models: [], quotaGroups: [], lastUpdated: 0, isForbidden: false },
            hasRefreshToken: true,
            lastError: null,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      success += 1;
    }
    return { total: entries.length, success, failed: 0, errors: [], state: writePreviewStore(store) };
  },

  async importFile(force = false, accountType: AntigravityAccountType = "personal"): Promise<AntigravityImportResult | null> {
    if (runningInTauri) return runNative("antigravity_import_file", { force, accountType });
    throw new Error("浏览器预览模式不支持原生文件选择器，请使用 Refresh Token 粘贴导入");
  },

  async scanLocalDb(accountType: AntigravityAccountType = "personal"): Promise<AntigravityImportResult> {
    if (runningInTauri) return runNative("antigravity_scan_local_db", { accountType });
    throw new Error("浏览器预览模式无法访问本机 Antigravity IDE / CLI 数据库，请在桌面客户端中使用");
  },

  async importCustomDb(accountType: AntigravityAccountType = "personal"): Promise<AntigravityImportResult | null> {
    if (runningInTauri) return runNative("antigravity_import_custom_db", { accountType });
    throw new Error("浏览器预览模式不支持本地 SQLite 数据库文件选择，请在桌面客户端中使用");
  },

  async exportText(accountIds?: number[]): Promise<string> {
    if (runningInTauri) return runNative("antigravity_export_accounts_text", { accountIds: accountIds?.length ? accountIds : null });
    const store = readPreviewStore();
    const filterSet = accountIds?.length ? new Set(accountIds) : null;
    const entries = store.records
      .filter(item => !filterSet || filterSet.has(item.account.id))
      .map(item => ({ email: item.account.email, refresh_token: item.refreshToken }));
    if (!entries.length) throw new Error("没有可导出的账号");
    return JSON.stringify(entries, null, 2);
  },

  async exportFile(accountIds?: number[]): Promise<boolean> {
    if (runningInTauri) return runNative("antigravity_export_accounts_file", { accountIds: accountIds?.length ? accountIds : null });
    const text = await this.exportText(accountIds);
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "antigravity-accounts.json";
    anchor.click();
    URL.revokeObjectURL(url);
    return true;
  },

  async saveAccountProxy(ids: number[], proxyUrl: string): Promise<AntigravityState> {
    if (runningInTauri) return runNative("antigravity_save_account_proxy", { ids, proxyUrl });
    let normalized: string | null = null;
    if (/[\u0000-\u001f\u007f-\u009f]/.test(proxyUrl) || proxyUrl.trim().length > 512) {
      throw new Error("代理地址过长或包含控制字符");
    }
    if (proxyUrl.trim()) {
      try {
        const url = new URL(proxyUrl.trim());
        if (!/^https?:\/\//i.test(proxyUrl.trim()) || !url.hostname || url.port === "0" ||
            url.username || url.password || url.pathname !== "/" || /[?#]/.test(url.href)) {
          throw new Error();
        }
        normalized = url.href;
      } catch {
        throw new Error("请填写无账号密码的 HTTP/HTTPS 代理地址，例如 http://127.0.0.1:7890");
      }
    }
    const store = readPreviewStore();
    const accounts = store.records.filter(({ account }) => ids.includes(account.id));
    if (!ids.length || accounts.length !== new Set(ids).size) throw new Error("未找到指定账号");
    for (const { account } of accounts) account.proxyUrl = normalized;
    return writePreviewStore(store);
  },

  async listQuotaRefreshLogs(id: number): Promise<AntigravityQuotaRefreshLog[]> {
    if (runningInTauri) return runNative("antigravity_list_quota_refresh_logs", { id });
    return [];
  },

  async refreshQuota(id: number): Promise<AntigravityState> {
    if (runningInTauri) return runNative("antigravity_refresh_quota", { id });
    throw new Error("浏览器预览模式不支持真实 Google 配额刷新，请在桌面客户端中操作");
  },

  async refreshAll(ids?: number[]): Promise<AntigravityRefreshAllResult> {
    if (runningInTauri) return runNative("antigravity_refresh_all", { ids: ids?.length ? ids : null });
    throw new Error("浏览器预览模式不支持真实 Google 配额刷新，请在桌面客户端中操作");
  },

  async saveMetadata(input: { id: number; priority: number; customLabel: string; note: string; tags: string[] }): Promise<AntigravityState> {
    if (runningInTauri) return runNative("antigravity_save_metadata", input);
    const store = readPreviewStore();
    const target = store.records.find(item => item.account.id === input.id);
    if (!target) throw new Error("未找到指定账号");
    target.account.priority = Math.max(1, Math.min(100, input.priority));
    target.account.customLabel = input.customLabel.trim();
    target.account.note = input.note.trim();
    target.account.tags = input.tags;
    target.account.updatedAt = Date.now();
    return writePreviewStore(store);
  },

  async savePriorities(input: {
    id: number;
    priority: number;
    geminiPriority: number | null;
    claudePriority: number | null;
  }): Promise<AntigravityState> {
    if (runningInTauri) return runNative("antigravity_save_priorities", input);
    const store = readPreviewStore();
    const target = store.records.find(item => item.account.id === input.id);
    if (!target) throw new Error("未找到指定账号");
    target.account.priority = Math.max(1, Math.min(100, input.priority));
    target.account.geminiPriority = input.geminiPriority == null ? null : Math.max(1, Math.min(100, input.geminiPriority));
    target.account.claudePriority = input.claudePriority == null ? null : Math.max(1, Math.min(100, input.claudePriority));
    target.account.updatedAt = Date.now();
    return writePreviewStore(store);
  },

  async saveProjectId(id: number, projectId: string): Promise<AntigravityState> {
    if (runningInTauri) return runNative("antigravity_save_project_id", { id, projectId });
    const store = readPreviewStore();
    const target = store.records.find(item => item.account.id === id);
    if (!target) throw new Error("未找到指定账号");
    const trimmed = projectId.trim();
    target.account.projectId = trimmed || null;
    target.account.updatedAt = Date.now();
    return writePreviewStore(store);
  },

  async fetchProjectId(id: number): Promise<AntigravityState> {
    if (runningInTauri) return runNative("antigravity_fetch_project_id", { id });
    throw new Error("浏览器预览模式无法调用 Google Code Assist 自动获取 GCP Project ID，请在桌面客户端中使用，或手动输入保存");
  },

  async saveTags(id: number, tags: string[]): Promise<AntigravityState> {
    if (runningInTauri) return runNative("antigravity_save_tags", { id, tags });
    const store = readPreviewStore();
    const target = store.records.find(item => item.account.id === id);
    if (!target) throw new Error("未找到指定账号");
    const seen = new Set<string>();
    target.account.tags = tags
      .map(t => t.trim())
      .filter(t => {
        if (!t) return false;
        const key = t.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    target.account.updatedAt = Date.now();
    return writePreviewStore(store);
  },

  async readLocalDeviceProfile(target: "antigravity" | "ide"): Promise<AntigravityDeviceProfile> {
    if (runningInTauri) return runNative("antigravity_read_local_device_profile", { target });
    throw new Error("浏览器预览无法读取本机存储。仍可测试生成、绑定和历史恢复。");
  },

  async deviceStorageAction(action: "open" | "restore", target: "antigravity" | "ide"): Promise<void> {
    if (runningInTauri) return runNative("antigravity_device_storage_action", { action, target });
    throw new Error("本机存储操作需要桌面客户端。");
  },

  async saveDeviceProfile(
    id: number,
    profile: AntigravityDeviceProfile,
    deleteHistoryId?: string,
  ): Promise<AntigravityState> {
    if (runningInTauri) return runNative("antigravity_save_device_profile", { id, profile, deleteHistoryId });
    const store = readPreviewStore();
    const target = store.records.find(item => item.account.id === id);
    if (!target) throw new Error("未找到指定账号");
    const cleaned: AntigravityDeviceProfile = {
      machineId: profile.machineId.trim(),
      macMachineId: profile.macMachineId.trim(),
      devDeviceId: profile.devDeviceId.trim(),
      sqmId: profile.sqmId.trim(),
    };
    const history = target.account.deviceHistory ?? [];
    if (deleteHistoryId) {
      if (history.some(entry => entry.fingerprintId === deleteHistoryId && sameAntigravityDeviceProfile(entry.profile, target.account.deviceProfile))) {
        throw new Error("当前绑定的设备指纹不能删除");
      }
      target.account.deviceHistory = history.filter(entry => entry.fingerprintId !== deleteHistoryId);
    } else {
      for (const candidate of [target.account.deviceProfile, cleaned]) {
        if (candidate && Object.values(candidate).some(Boolean) && !history.some(entry => sameAntigravityDeviceProfile(entry.profile, candidate))) {
          history.unshift({ fingerprintId: String(Date.now()) + "-" + history.length, createdAt: Date.now(), profile: candidate });
        }
      }
      target.account.deviceHistory = history;
      target.account.deviceProfile = Object.values(cleaned).some(Boolean) ? cleaned : null;
    }
    return writePreviewStore(store);
  },

  async warmupAccount(id: number): Promise<AntigravityWarmupResult> {
    if (runningInTauri) return runNative("antigravity_warmup_account", { id });
    throw new Error("浏览器预览模式无法发起真实的 Google 连通性探测与配额预热，请在桌面客户端中使用");
  },

  async setCurrent(id: number): Promise<AntigravityState> {
    if (runningInTauri) return runNative("antigravity_set_current", { id });
    const store = readPreviewStore();
    store.currentAccountId = id;
    store.targetCurrentIds = { ...(store.targetCurrentIds ?? {}), antigravity: id };
    return writePreviewStore(store);
  },

  async switchTarget(id: number, target: AntigravitySwitchTarget): Promise<AntigravitySwitchResult> {
    if (runningInTauri) return runNative("antigravity_switch_target", { id, target });
    const store = readPreviewStore();
    store.targetCurrentIds = { ...(store.targetCurrentIds ?? {}), [target]: id };
    if (target === "antigravity") {
      store.currentAccountId = id;
    }
    const labels: Record<AntigravitySwitchTarget, string> = {
      antigravity: "Antigravity",
      ide: "IDE",
      jeb: "JEB",
      cli: "AGY CLI",
    };
    return {
      target,
      appliedToClient: false,
      detail: `浏览器预览调试模式：已标记为 ${labels[target]} 当前账号（未写入本机客户端）`,
      state: writePreviewStore(store),
    };
  },

  async reorderAccounts(orderedIds: number[]): Promise<AntigravityState> {
    if (runningInTauri) return runNative("antigravity_reorder_accounts", { orderedIds });
    const store = readPreviewStore();
    const orderMap = new Map(orderedIds.map((id, index) => [id, index + 1]));
    for (const item of store.records) {
      const nextOrder = orderMap.get(item.account.id);
      if (nextOrder !== undefined) item.account.sortOrder = nextOrder;
    }
    return writePreviewStore(store);
  },

  async deleteAccounts(ids: number[]): Promise<AntigravityState> {
    if (runningInTauri) return runNative("antigravity_delete_accounts", { ids });
    const store = readPreviewStore();
    const set = new Set(ids);
    store.records = store.records.filter(item => !set.has(item.account.id));
    if (store.currentAccountId && set.has(store.currentAccountId)) store.currentAccountId = null;
    if (store.targetCurrentIds) {
      for (const k of Object.keys(store.targetCurrentIds) as AntigravitySwitchTarget[]) {
        const val = store.targetCurrentIds[k];
        if (val != null && set.has(val)) delete store.targetCurrentIds[k];
      }
    }
    return writePreviewStore(store);
  },

  async startOAuth(accountType: AntigravityAccountType = "personal"): Promise<{ token: string; authUrl: string }> {
    if (runningInTauri) return runNative("antigravity_start_oauth", { accountType });
    throw new Error("浏览器预览模式不支持本地 OAuth 回调，请在桌面客户端中使用，或切换到 Refresh Token 粘贴导入");
  },

  async submitOAuthCallback(token: string, input: string): Promise<AntigravityState> {
    if (runningInTauri) return runNative("antigravity_submit_oauth_callback", { token, input });
    throw new Error("浏览器预览模式不支持 OAuth 回调换取 Token，请在桌面客户端中使用");
  },

  async pollOAuth(token: string): Promise<{ status: string; error?: string | null }> {
    return runNative("antigravity_poll_oauth", { token });
  },

  async cancelOAuth(token: string): Promise<void> {
    return runNative("antigravity_cancel_oauth", { token });
  },
};
