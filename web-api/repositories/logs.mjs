import { database } from "../core/database.mjs";

export function listApiLogs(query = {}) {
  const keyword = String(query.keyword || "").trim();
  const status = String(query.status || "").trim();
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 500));
  const offset = Math.max(0, Number(query.offset) || 0);
  return database().prepare("SELECT l.id,l.account_id,a.account_name,l.endpoint,l.action,l.request_params,l.response_params,l.status,l.message,l.created_at FROM api_logs l LEFT JOIN cloud_accounts a ON a.id=l.account_id WHERE (?1='' OR COALESCE(a.account_name,'') LIKE ?2 OR l.endpoint LIKE ?2 OR l.action LIKE ?2 OR l.status LIKE ?2 OR COALESCE(l.message,'') LIKE ?2) AND (?3='' OR l.status=?3) ORDER BY l.created_at DESC LIMIT ?4 OFFSET ?5").all(keyword, `%${keyword}%`, status, limit, offset);
}

export function clearApiLogs() {
  return database().prepare("DELETE FROM api_logs").run();
}

export function clearOperationLogs() {
  return database().prepare("DELETE FROM operation_logs").run();
}
