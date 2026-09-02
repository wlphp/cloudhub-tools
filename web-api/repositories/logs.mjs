import { database } from "../core/database.mjs";

export function listApiLogs() {
  return database().prepare("SELECT l.id,l.account_id,a.account_name,l.endpoint,l.action,l.request_params,l.response_params,l.status,l.message,l.created_at FROM api_logs l LEFT JOIN cloud_accounts a ON a.id=l.account_id ORDER BY l.created_at DESC LIMIT 500").all();
}

export function clearApiLogs() {
  return database().prepare("DELETE FROM api_logs").run();
}

export function clearOperationLogs() {
  return database().prepare("DELETE FROM operation_logs").run();
}
