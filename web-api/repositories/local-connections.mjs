import { database } from "../core/database.mjs";

function jsonObject(value) {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function listManagedHosts() {
  const rows = database().prepare(`SELECT id,name,host,port,username,platform,auth_method,group_name,tags,
      source_account_id,source_asset_key,
      (password_ciphertext IS NOT NULL AND password_ciphertext<>'') AS password_saved,
      (private_key_ciphertext IS NOT NULL AND private_key_ciphertext<>'') AS private_key_saved,
      status,last_latency_ms,metrics_json,last_checked_at,remark,created_at,updated_at
    FROM managed_hosts ORDER BY COALESCE(group_name,''),name COLLATE NOCASE`).all();
  return rows.map((row) => ({
    id: Number(row.id), name: row.name, host: row.host, port: Number(row.port), username: row.username,
    platform: row.platform, auth_method: row.auth_method, group_name: row.group_name, tags: row.tags,
    source_account_id: row.source_account_id == null ? null : Number(row.source_account_id), source_asset_key: row.source_asset_key,
    password_saved: Boolean(row.password_saved), private_key_saved: Boolean(row.private_key_saved), status: row.status,
    last_latency_ms: row.last_latency_ms == null ? null : Number(row.last_latency_ms), metrics: jsonObject(row.metrics_json),
    last_checked_at: row.last_checked_at == null ? null : Number(row.last_checked_at), remark: row.remark,
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
  }));
}

export function listPanelConnections() {
  const rows = database().prepare(`SELECT id,name,panel_url,sort_order,allow_insecure_tls,group_name,
      source_account_id,source_asset_key,(api_key_ciphertext IS NOT NULL AND api_key_ciphertext<>'') AS api_key_saved,
      status,summary_json,last_checked_at,remark,created_at,updated_at
    FROM panel_connections ORDER BY sort_order ASC,name COLLATE NOCASE`).all();
  return rows.map((row) => ({
    id: Number(row.id), name: row.name, panel_url: row.panel_url, sort_order: Number(row.sort_order),
    allow_insecure_tls: Boolean(row.allow_insecure_tls), group_name: row.group_name,
    source_account_id: row.source_account_id == null ? null : Number(row.source_account_id), source_asset_key: row.source_asset_key,
    api_key_saved: Boolean(row.api_key_saved), status: row.status, summary: jsonObject(row.summary_json),
    last_checked_at: row.last_checked_at == null ? null : Number(row.last_checked_at), remark: row.remark,
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
  }));
}
