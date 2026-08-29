export type Account = {
  id: number;
  account_name: string;
  cloud_type: string;
  group_name?: string;
  access_key_id: string;
  credential_meta?: string | null;
  region_id?: string;
  enabled: boolean;
  remark?: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

export type Draft = {
  id?: number;
  account_name: string;
  cloud_type: string;
  group_name: string;
  access_key_id: string;
  access_key_secret: string;
  tenancy_ocid: string;
  key_fingerprint: string;
  tenant_id: string;
  subscription_id: string;
  project_id: string;
  region_id: string;
  enabled: boolean;
  remark: string;
  sort_order: number;
};

export type TransferAccount = Draft & { id?: number };

export type ResourceResponse = {
  resource_type: string;
  items: Record<string, unknown>[];
  errors: string[];
  fetched_at: number;
};

export type SshFileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  isFile: boolean;
  size: number;
  mode: string;
  owner: string;
  group: string;
  modified: string;
};

export type SshDirectoryListing = { path: string; entries: SshFileEntry[] };

export type ManagedHost = {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  platform: "linux" | "windows" | string;
  auth_method: "password" | "private_key" | string;
  group_name?: string | null;
  tags?: string | null;
  source_account_id?: number | null;
  source_asset_key?: string | null;
  password_saved: boolean;
  private_key_saved: boolean;
  host_key_fingerprint?: string | null;
  status: "online" | "offline" | "unknown" | string;
  last_latency_ms?: number | null;
  metrics: Record<string, unknown>;
  last_checked_at?: number | null;
  last_error?: string | null;
  remark?: string | null;
  created_at: number;
  updated_at: number;
};

export type ManagedHostDraft = {
  id?: number;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  platform: "linux" | "windows";
  auth_method: "password" | "private_key";
  private_key: string;
  key_passphrase: string;
  group_name: string;
  tags: string;
  source_account_id?: number | null;
  source_asset_key?: string | null;
  remark: string;
};

export type PanelConnection = {
  id: number;
  name: string;
  panel_url: string;
  sort_order: number;
  allow_insecure_tls: boolean;
  group_name?: string | null;
  source_account_id?: number | null;
  source_asset_key?: string | null;
  api_key_saved: boolean;
  status: "online" | "offline" | "unknown" | string;
  summary: Record<string, unknown>;
  last_checked_at?: number | null;
  last_error?: string | null;
  remark?: string | null;
  created_at: number;
  updated_at: number;
};

export type PanelConnectionDraft = {
  id?: number;
  name: string;
  panel_url: string;
  sort_order: number;
  api_key: string;
  allow_insecure_tls: boolean;
  group_name: string;
  source_account_id?: number | null;
  source_asset_key?: string | null;
  remark: string;
};

export type EsaTrendPoint = { time: string; value: number };

export type EsaOverview = {
  traffic: number;
  requests: number;
  defence_requests: number;
  site_count: number;
  active_count: number;
  range_label: string;
  trend: Record<"traffic" | "requests" | "page_view", EsaTrendPoint[]>;
  site_options: { id: string; name: string }[];
};

export type LocalAsset = {
  account_id: number;
  resource_type: string;
  asset_key: string;
  region_id?: string | null;
  payload: Record<string, unknown>;
  fetched_at: number;
};

export type ApiLog = {
  id: number;
  account_id?: number | null;
  account_name?: string | null;
  endpoint: string;
  action: string;
  request_params: string;
  response_params?: string | null;
  status: string;
  message?: string | null;
  created_at: number;
};

export type View =
  | "summary"
  | "ecs"
  | "domain"
  | "oss"
  | "rds"
  | "redis"
  | "swas"
  | "esa";

export type DomainTool = {
  kind: "dns" | "logs" | "whois";
  account: Account;
  domain: string;
};

export type SshTarget = {
  account: Account;
  asset: LocalAsset;
  managedHostId?: number;
  direct?: boolean;
};

export type TerminalWorkspaceTab = {
  id: string;
  target: SshTarget;
  host: string;
  port: number;
  username: string;
  sessionId: string;
  output: string;
};

export type SavedSshConnection = {
  host: string;
  port: number;
  username: string;
  passwordSaved: boolean;
};

export type SavedRdpConnection = {
  host: string;
  port: number;
  username: string;
  passwordSaved: boolean;
};

export type SshConnectResult = {
  sessionId: string;
  hostKeyFingerprint: string;
};

export type ConfirmRequest = {
  message: string;
  resolve: (confirmed: boolean) => void;
  tone?: "danger";
  title?: string;
  confirmLabel?: string;
};

export type PromptRequest = {
  message: string;
  resolve: (value: string | null) => void;
};

export type SshAuthMethod = "password" | "private_key";
